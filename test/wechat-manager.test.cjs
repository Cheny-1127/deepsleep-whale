'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createWechatManager}=require('../src/channels/wechat-manager.cjs');
const {fresh,bindingKey}=require('../src/channels/wechat-store.cjs');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let i=0;i<300;i++){if(check())return;await tick();}assert.fail('multi-account condition timed out');}
function harness(t,initial){
  let saved=structuredClone(initial||fresh()),nextBot='bot-b',nextOwner='owner',failStore=false;
  const queues=new Map(),waiting=new Map(),sent=[],runs=[],qrTokens=[];
  const api={validate:value=>value,qr:async(_signal,tokens)=>{qrTokens.push(tokens);return {qrcode:'code',qrcode_img_content:'qr'};},qrStatus:async()=>({status:'confirmed',ilink_bot_id:nextBot,bot_token:'secret-'+nextBot,ilink_user_id:nextOwner,baseurl:'https://ilinkai.weixin.qq.com'}),
    updates:async(account,cursor,signal)=>{const queue=queues.get(account.id)||[];if(queue.length)return {msgs:queue.splice(0),get_updates_buf:'cursor-'+account.id};return new Promise(resolve=>{const done=()=>{waiting.delete(account.id);resolve({});};waiting.set(account.id,done);signal.addEventListener('abort',done,{once:true});});},
    send:async(account,sender,text,context)=>sent.push({account:account.id,sender,text,context})};
  const manager=createWechatManager({store:{available:()=>true,load:()=>structuredClone(saved),save:value=>{if(failStore)throw Error('disk');saved=structuredClone(value);},remove:()=>assert.fail('must not delete shared encrypted storage')},api,makeQr:async()=> 'data:image/png;base64,test',pollDelay:1,loginDelay:1,
    runAgent:options=>{const run={options};run.promise=new Promise((resolve,reject)=>{run.resolve=text=>resolve({text});run.cancel=()=>reject(Error('cancelled'));});runs.push(run);return run;}});
  t.after(()=>manager.close());
  const action=(id,name,value)=>manager.action(name,{connectionId:id,value});
  return {manager,action,sent,runs,qrTokens,get saved(){return saved;},set failStore(value){failStore=value;},set nextBot(value){nextBot=value;},set nextOwner(value){nextOwner=value;},
    push(bot,id,text){if(!queues.has(bot))queues.set(bot,[]);queues.get(bot).push({message_id:id,message_type:1,from_user_id:'owner',to_user_id:bot,context_token:'context-'+bot,item_list:[{type:1,text_item:{text}}]});waiting.get(bot)?.();}};
}
function connected(){const value=fresh();value.enabled=true;value.account={id:'bot-a',owner:'owner',token:'secret-a'};value.allowed=['owner'];value.seen=['old'];value.bindings[bindingKey('bot-a','owner')]={id:'a-binding',clientId:value.clients[0].id,cwd:process.cwd(),threadId:'',automatic:true};return value;}

test('adding and scanning a second connection preserves the original account and survives restart',async t=>{
  const legacy=connected(),h=harness(t,legacy);h.manager.start();
  const first=h.manager.snapshot().selectedConnectionId;
  await h.manager.action('add-connection');const second=h.manager.snapshot().selectedConnectionId;
  assert.notEqual(first,second);await h.action(second,'login');
  await until(()=>h.manager.snapshot().connections.filter(c=>c.account).length===2);
  assert.equal(h.saved.version,3);assert.equal(h.saved.connections[0].state.account.token,'secret-a');
  assert.deepEqual(h.saved.connections[0].state.seen,['old']);assert.equal(h.saved.connections[0].state.enabled,true);
  assert.ok(!JSON.stringify(h.manager.snapshot()).includes('secret-'));
  h.manager.close();const reboot=harness(t,h.saved);reboot.manager.start();
  assert.equal(reboot.manager.snapshot().connections.length,2);
  assert.deepEqual(reboot.saved.connections.map(c=>c.state.account.id),['bot-a','bot-b']);
});

function pair(){const a=connected(),b=connected();b.account={id:'bot-b',owner:'owner',token:'secret-b'};b.bindings={[bindingKey('bot-b','owner')]:{...Object.values(a.bindings)[0],id:'b-binding'}};return {version:3,selectedConnectionId:'a',connections:[{id:'a',state:a},{id:'b',state:b}]};}

test('same sender and message IDs remain isolated, tasks run globally in order and replies use the original account',async t=>{
  const h=harness(t,pair());h.manager.start();
  h.push('bot-a','same-message','任务 A');h.push('bot-b','same-message','任务 B');
  await until(()=>h.saved.connections.every(c=>c.state.jobs.length===1));
  assert.deepEqual(h.manager.snapshot().connections.map(connection=>connection.taskCount),[1,1],'未选中的微信也提供任务数量，不下发任务正文');
  assert.equal(h.runs.length,1);assert.equal(h.runs[0].options.text,'任务 A');
  await h.manager.action('select-connection','b');
  await assert.rejects(h.manager.action('enable',false),/选择/);
  h.runs[0].resolve('回复 A');await until(()=>h.runs.length===2);
  assert.equal(h.runs[1].options.text,'任务 B');h.runs[1].resolve('回复 B');
  await until(()=>h.sent.some(x=>x.text==='回复 A')&&h.sent.some(x=>x.text==='回复 B'));
  assert.deepEqual(h.sent.filter(x=>x.text.startsWith('回复 ')),[
    {account:'bot-a',sender:'owner',text:'回复 A',context:'context-bot-a'},
    {account:'bot-b',sender:'owner',text:'回复 B',context:'context-bot-b'}]);
});

test('pause, forget and late task completion affect only the explicitly selected connection',async t=>{
  const h=harness(t,pair());h.manager.start();
  h.push('bot-a','task-a','任务 A');await until(()=>h.runs.length===1);
  await h.action('b','enable',false);assert.equal(h.saved.connections[0].state.enabled,true);
  await h.action('b','forget');assert.equal(h.saved.connections.length,1);assert.equal(h.saved.connections[0].id,'a');
  h.runs[0].resolve('A 正常完成');await until(()=>h.sent.some(x=>x.text==='A 正常完成'));
  await assert.rejects(h.action('b','enable',true),/不存在/);
  assert.equal(h.manager.snapshot().connections[0].account.id,'bot-a');
});

test('duplicate scans cannot replace or disable an existing connection, and reconnect cannot switch identities',async t=>{
  const h=harness(t,pair());h.manager.start();await h.manager.action('add-connection');const draft=h.manager.snapshot().selectedConnectionId;
  h.nextBot='bot-a';await h.action(draft,'login');
  await until(()=>h.manager.snapshot().error.includes('已接入'));
  assert.equal(h.saved.connections[0].state.account.token,'secret-a');assert.equal(h.saved.connections[0].state.enabled,true);
  assert.equal(h.saved.connections.at(-1).state.account,null);
  h.nextBot='bot-c';h.nextOwner='another-owner';await h.action('a','login');await until(()=>h.manager.snapshot().connections[0].status==='error');
  assert.equal(h.saved.connections[0].state.account.id,'bot-a');
});

test('renewing the same owner replaces a changed bot identity without losing history or desktop bindings',async t=>{
  const initial=pair(),first=initial.connections[0];first.name='工作微信';first.contactNames={owner:'本人'};
  first.state.cursor='old-cursor';first.state.contexts={owner:'old-context'};
  first.state.bindings[bindingKey('bot-a','owner')].threadId='existing-desktop-thread';
  first.state.jobs=[{id:'history',sender:'owner',state:'completed',startedAt:1,exchange:{request:'已有任务',response:'已有结果'}}];
  const h=harness(t,initial),other={...structuredClone(initial.connections[1]),contactNames:{}};
  h.nextBot='bot-renewed';await h.action('a','login');
  await until(()=>h.manager.snapshot().connections[0].status!=='logging-in');
  assert.equal(h.saved.connections[0].state.account.id,'bot-renewed');
  assert.equal(h.saved.connections[0].state.account.token,'secret-bot-renewed');
  assert.deepEqual(h.saved.connections[1],other);
  const renewed=h.saved.connections[0];
  assert.equal(renewed.name,'工作微信');assert.equal(renewed.contactNames.owner,'本人');
  assert.deepEqual(renewed.state.allowed,['owner']);assert.deepEqual(renewed.state.jobs,first.state.jobs);
  assert.deepEqual(renewed.state.clients,first.state.clients);assert.deepEqual(renewed.state.contexts,{});
  assert.ok(!Object.hasOwn(renewed.state.bindings,bindingKey('bot-a','owner')));
  assert.equal(renewed.state.bindings[bindingKey('bot-renewed','owner')].threadId,'existing-desktop-thread');
  assert.deepEqual(h.qrTokens,[['secret-b']],'只带其他连接凭据，当前失效连接应请求新凭据');
  h.push('bot-renewed','after-renewal','/status');await until(()=>h.sent.length>0);
  assert.ok(h.sent.every(item=>item.account==='bot-renewed'));
  h.manager.close();const reboot=harness(t,h.saved);reboot.manager.start();
  assert.equal(reboot.manager.snapshot().connections[0].account.id,'bot-renewed');
});

test('a matching bot ID cannot overwrite the owner, and unknown owners cannot replace a changed bot',async t=>{
  for(const [bot,owner]of [['bot-a','another-owner'],['bot-c','']]){
    const h=harness(t,connected());h.nextBot=bot;h.nextOwner=owner;
    const before=structuredClone(h.saved);await h.action(h.manager.snapshot().selectedConnectionId,'login');
    await until(()=>h.manager.snapshot().status!=='logging-in');
    assert.equal(h.manager.snapshot().status,'error');
    assert.deepEqual(h.saved.connections[0].state.account,before.account);
    assert.deepEqual(h.saved.connections[0].state.bindings,before.bindings);
  }
});

test('invalid containers and storage failures preserve the original file and stop further writes',async t=>{
  const bad=pair();bad.connections[1].id='a';const h=harness(t,bad);h.manager.start();
  assert.match(h.manager.snapshot().error,/标识/);await assert.rejects(h.manager.action('add-connection'),/标识/);assert.deepEqual(h.saved,bad);
  const valid=harness(t,pair());valid.manager.start();const before=structuredClone(valid.saved);valid.failStore=true;
  await assert.rejects(valid.action('a','enable',false),/存储|保存/);await tick();
  assert.deepEqual(valid.saved,before);await assert.rejects(valid.manager.action('add-connection'),/保存/);
});

test('approval tokens and question answers cannot cross accounts even for the same sender',async t=>{
  const h=harness(t,pair());h.manager.start();h.push('bot-a','task','任务');await until(()=>h.runs.length===1);
  let approved=false;
  const decision=h.runs[0].options.onApproval({kind:'command',detail:'pwd',cwd:process.cwd()}).then(value=>{approved=true;return value;});
  await until(()=>h.sent.some(x=>x.text.includes('/allow')));
  const token=h.sent.find(x=>x.text.includes('/allow')).text.match(/\/allow ([\w-]+)/)[1];
  h.push('bot-b','wrong-approval','/allow '+token);await until(()=>h.saved.connections[1].state.seen.length>1);
  assert.equal(approved,false);h.push('bot-a','right-approval','/allow '+token);assert.equal(await decision,true);
  let answered=false;
  const answer=h.runs[0].options.onUserInput({questions:[{id:'q',question:'选哪个？',options:[{label:'继续'},{label:'停止'}]}]}).then(value=>{answered=true;return value;});
  await until(()=>h.sent.some(x=>x.text.includes('选哪个')));
  h.push('bot-b','wrong-answer','1');await until(()=>h.saved.connections[1].state.seen.length>2);
  assert.equal(answered,false);h.push('bot-a','right-answer','1');assert.deepEqual(await answer,{answers:{q:{answers:['继续']}}});
  h.runs[0].resolve('完成');await until(()=>h.sent.some(x=>x.account==='bot-a'&&x.text==='完成'));
});

test('the five-task limit applies across accounts and forgetting the last one preserves clients',async t=>{
  const h=harness(t,pair());h.manager.start();
  for(let i=0;i<6;i++)h.push(i%2?'bot-b':'bot-a','limit-'+i,'任务 '+i);
  await until(()=>h.saved.connections.every(c=>c.state.seen.length===4));
  assert.equal(h.saved.connections.reduce((sum,c)=>sum+c.state.jobs.length,0),5);assert.equal(h.runs.length,1);
  const single=harness(t,connected());single.manager.start();const id=single.manager.snapshot().selectedConnectionId;
  await single.action(id,'forget');assert.equal(single.saved.connections.length,1);
  assert.equal(single.saved.connections[0].state.account,null);assert.deepEqual(single.saved.connections[0].state.clients,connected().clients);
  assert.notEqual(single.saved.connections[0].id,id);
});

test('interrupted jobs in a paused account cannot fill the queue after restart',async t=>{
  const initial=pair();initial.connections[0].state.enabled=false;
  initial.connections[0].state.jobs=Array.from({length:5},(_,i)=>({id:'old-'+i,sender:'owner',state:'queued',startedAt:i,text:'旧排队消息'}));
  const h=harness(t,initial);h.manager.start();h.push('bot-b','new-task','新的任务');
  await until(()=>h.saved.connections[1].state.seen.length===2);
  assert.equal(h.runs.length,1,'restart interruption must release global queue capacity');
});

test('display names persist independently without changing identity, authorization or jobs',async t=>{
  const h=harness(t,pair());h.manager.start();
  await h.action('a','rename-connection','工作微信');await h.action('a','rename-user',{sender:'owner',name:'我自己'});
  await h.action('b','rename-connection','个人微信');await h.action('b','rename-user',{sender:'owner',name:'另一个自己'});
  h.push('bot-a','named-task','测试备注后的任务');await until(()=>h.runs.length===1);
  assert.equal(h.saved.connections[0].name,'工作微信');assert.equal(h.saved.connections[0].state.account.id,'bot-a');
  assert.deepEqual(h.saved.connections[0].state.allowed,['owner']);
  h.runs[0].resolve('完成');await until(()=>h.sent.some(x=>x.text==='完成'));
  h.manager.close();const reboot=harness(t,h.saved);reboot.manager.start();
  assert.deepEqual(reboot.manager.snapshot().connections.map(c=>c.name),['工作微信','个人微信']);
  assert.equal(reboot.manager.snapshot().contactNames.owner,'我自己');
  await reboot.manager.action('select-connection','b');assert.equal(reboot.manager.snapshot().contactNames.owner,'另一个自己');
  const before=structuredClone(reboot.saved);
  await assert.rejects(reboot.action('b','rename-user',{sender:'stranger',name:'陌生人'}),/联系人/);
  await assert.rejects(reboot.action('b','rename-connection','a'.repeat(41)),/40/);
  assert.deepEqual(reboot.saved,before);
  const malformed=pair();malformed.connections[0].contactNames=[];const invalid=harness(t,malformed);
  await assert.rejects(invalid.manager.action('add-connection'),/备注格式/);assert.deepEqual(invalid.saved,malformed);
});
