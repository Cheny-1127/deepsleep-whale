'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createWechatGateway}=require('../src/channels/wechat-gateway.cjs');
const {fresh,bindingKey}=require('../src/channels/wechat-store.cjs');
const {AgentError}=require('../src/agents/agent-error.cjs');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check,attempts=250){for(let i=0;i<attempts;i++){if(check())return;await tick();}assert.fail('gateway condition timed out');}
function harness(t,initial,options={}) {
  const state=initial||fresh();
  if(!initial){state.account={id:'bot',token:'private-token',owner:'owner'};state.allowed=['owner'];state.bindings[bindingKey('bot','owner')]={id:'owner-binding',cwd:process.cwd(),clientId:'',threadId:'',automatic:true};}
  let saved=structuredClone(state),failStore=false,sendError=null,updateError=null;
  const batches=[{}],sent=[],runs=[],pending=[],typing=[];
  const store={available:()=>true,load:()=>structuredClone(saved),save:value=>{if(failStore)throw Error('disk');saved=structuredClone(value);},remove:()=>{saved=fresh();}};
  const api={validate:value=>value,qr:async()=>({qrcode:'private-poll-code',qrcode_img_content:'https://login.example.test/qr'}),
    qrStatus:async()=>({status:'confirmed',ilink_bot_id:'bot',bot_token:'private-token',ilink_user_id:'owner',baseurl:'https://ilinkai.weixin.qq.com'}),
    async updates(_account,_cursor,signal){if(updateError)throw updateError;if(batches.length)return batches.shift();return new Promise(resolve=>{const done=()=>{const i=pending.indexOf(done);if(i>=0)pending.splice(i,1);resolve(batches.shift()||{});};pending.push(done);signal.addEventListener('abort',done,{once:true});});},
    async send(_account,sender,text,context,id){if(sendError)throw sendError;sent.push({sender,text,context,id});},
    async typing(account,sender,enabled,context){typing.push({account:account.id,sender,enabled,context});return true;}};
  const gateway=createWechatGateway({store,api,makeQr:async()=> 'data:image/png;base64,test',pollDelay:1,loginDelay:1,...options,runAgent:options=>{
    const run={options};runs.push(run);run.promise=new Promise((resolve,reject)=>{run.resolve=text=>resolve({text});run.reject=reject;});run.cancel=()=>{run.cancelled=true;run.reject(Error('cancelled'));};return run;
  }});t.after(()=>gateway.close());
  const message=(id,text,sender='owner')=>({message_id:id,message_type:1,from_user_id:sender,to_user_id:'bot',context_token:'ctx-'+id,item_list:[{type:1,text_item:{text}}]});
  function push(...msgs){batches.push({msgs,get_updates_buf:'cursor-'+msgs[0]?.message_id});pending.shift()?.();}
  return {gateway,api,runs,sent,typing,message,push,get saved(){return saved;},set failStore(value){failStore=value;},set sendError(value){sendError=value;},set updateError(value){updateError=value;},async login(){await gateway.action('login');await until(()=>gateway.snapshot().status==='connected');}};
}

test('running client discovery is read-only, works without enabled clients and preserves state on failure',async t=>{
  let fail=false,calls=0;
  const state=fresh();state.clients=[];
  const discovery={clients:[{key:'local',name:'Codex',backend:'codex',binary:'/bin/codex',configHome:'/home/one',available:true}],defaults:{},message:'发现 1 个'};
  const h=harness(t,state,{discoverClients:async()=>{calls++;if(fail)throw Error('无法检测');return discovery;}}),before=structuredClone(h.saved);
  assert.deepEqual(await h.gateway.action('discover-clients'),discovery);assert.equal(calls,1);assert.deepEqual(h.saved,before);assert.equal(h.runs.length,0);
  fail=true;await assert.rejects(h.gateway.action('discover-clients'),/无法检测/);assert.deepEqual(h.saved,before);assert.equal(h.runs.length,0);
});
test('normal tasks and question answers use typing without sending receipt messages',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','检查项目'));await until(()=>h.runs.length===1);await tick();
  assert.deepEqual(h.typing.map(x=>x.enabled),[true]);assert.equal(h.sent.length,0);assert.equal(h.saved.outbox.length,0);
  const answer=h.runs[0].options.onUserInput({questions:[{id:'mode',question:'怎么处理？',options:[{label:'仅分析'},{label:'修复'}]}]});
  await until(()=>h.typing.at(-1)?.enabled===false);await until(()=>h.sent.some(x=>x.text.includes('怎么处理？')));
  h.push(h.message('answer','1'));assert.deepEqual(await answer,{answers:{mode:{answers:['仅分析']}}});
  await until(()=>h.typing.at(-1)?.enabled===true);assert.equal(h.runs.length,1);
  h.runs[0].resolve('分析结果');await until(()=>h.saved.jobs[0].state==='completed'&&h.saved.outbox.length===0);await until(()=>h.typing.at(-1)?.enabled===false);
  assert.deepEqual(h.sent.map(x=>x.text).filter(x=>!x.includes('怎么处理？')),['分析结果']);
});
test('typing refreshes while working and stays stopped through approval and question waits',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const h=harness(t);await h.login();h.push(h.message('task','检查'));await until(()=>h.typing.length===1);
  t.mock.timers.tick(2000);await until(()=>h.typing.length===2);assert.equal(h.typing.at(-1).enabled,true);
  const input=h.runs[0].options.onUserInput({questions:[{id:'q',question:'是否继续？',options:[]}]});
  const approval=h.runs[0].options.onApproval({kind:'command',detail:'pwd',cwd:process.cwd()});
  await until(()=>h.typing.at(-1).enabled===false);const count=h.typing.length;
  t.mock.timers.tick(4000);await tick();assert.equal(h.typing.length,count);
  const notice=[...h.sent.map(x=>x.text),...h.saved.outbox.flatMap(x=>x.parts)].find(x=>x.includes('/allow '));
  h.push(h.message('allow','/allow '+notice.match(/\/allow ([\w-]+)/)[1]));assert.equal(await approval,true);await tick();assert.equal(h.typing.length,count);
  h.push(h.message('answer','继续'));await input;await until(()=>h.typing.at(-1).enabled===true);
  h.runs[0].resolve('完成');await until(()=>!h.gateway.snapshot().active);await until(()=>h.typing.at(-1).enabled===false);
  const stopped=h.typing.length;t.mock.timers.tick(4000);await tick();assert.equal(h.typing.length,stopped);
});
test('typing is stopped on failure, cancellation, pause, expiry, revoke, forget and close',async t=>{
  for(const end of ['failure','stop','pause','expiry','revoke','forget','close'])await t.test(end,async t=>{
    const h=harness(t);await h.login();h.push(h.message('task','检查'));await until(()=>h.typing.length===1);
    if(end==='failure')h.runs[0].reject(new AgentError('TURN_FAILED','turn'));
    else if(end==='stop')h.push(h.message('stop','/stop'));
    else if(end==='pause')await h.gateway.action('enable',false);
    else if(end==='expiry'){h.updateError=Object.assign(Error('expired'),{code:-14});h.push();}
    else if(end==='revoke')await h.gateway.action('remove-user','owner');
    else if(end==='forget')await h.gateway.action('forget');
    else h.gateway.close();
    await until(()=>h.typing.at(-1)?.enabled===false);assert.equal(h.typing.at(-1).account,'bot');assert.equal(h.typing.at(-1).sender,'owner');
  });
});
test('a late typing-start is stopped before the next job starts typing without delaying the jobs',async t=>{
  const h=harness(t);let release;const calls=[];
  h.api.typing=async(_account,_sender,enabled)=>{calls.push(enabled);if(calls.length===1)await new Promise(resolve=>{release=resolve;});};
  await h.login();h.push(h.message('one','第一条'));await until(()=>release);
  h.push(h.message('stop','/stop'));await until(()=>!h.gateway.snapshot().active);
  h.push(h.message('two','第二条'));await until(()=>h.runs.length===2);assert.deepEqual(calls,[true]);
  release();await until(()=>calls.length===3);assert.deepEqual(calls,[true,false,true]);
  h.runs[1].resolve('完成');await until(()=>calls.at(-1)===false);
});
test('typing failures do not fail or replay tasks or add chat messages',async t=>{
  const h=harness(t);h.api.typing=async()=>{throw Error('typing unavailable');};await h.login();
  h.push(h.message('task','检查'));await until(()=>h.runs.length===1);h.runs[0].resolve('结果');await until(()=>h.sent.length===1);
  assert.deepEqual(h.sent.map(x=>x.text),['结果']);assert.equal(h.runs.length,1);assert.equal(h.gateway.snapshot().error,'');
});
test('only the first queued message gets a queue notice while the active job keeps typing',async t=>{
  const h=harness(t);await h.login();h.push(h.message('one','正在处理的任务'));await until(()=>h.typing.length===1);
  h.push(h.message('two','后续问题一'),h.message('three','后续问题二'));
  await until(()=>h.saved.jobs.filter(j=>j.state==='queued').length===2);await until(()=>h.sent.length===1);
  assert.match(h.sent[0].text,/消息已排队/);assert.equal(h.saved.outbox.length,0);assert.deepEqual(h.typing.map(x=>x.enabled),[true]);
});
test('scan login hides credentials; strangers need explicit authorization and a new message',async t=>{
  const h=harness(t);await h.login();
  assert.ok(!JSON.stringify(h.gateway.snapshot()).includes('private-token'));
  h.push(h.message('1','排查','stranger'));await until(()=>h.gateway.snapshot().pending.includes('stranger'));assert.equal(h.runs.length,0);
  await h.gateway.action('allow-user','stranger');await tick();assert.equal(h.runs.length,0);
  h.push(h.message('p','/project '+process.cwd(),'stranger'),h.message('2','重新排查','stranger'));await until(()=>h.runs.length===1);
  h.runs[0].resolve('结论');await until(()=>h.gateway.snapshot().jobs[0].state==='completed');
});
test('dedup and restart never replay work; conversations resume only within their binding',async t=>{
  const h=harness(t);await h.login();const msg=h.message('1','排查一下');h.push(msg,msg);await until(()=>h.runs.length===1);
  h.runs[0].options.onSession('thread-1');h.runs[0].resolve('第一轮完成');await until(()=>!h.gateway.snapshot().active);
  h.push(h.message('2','继续'));await until(()=>h.runs.length===2);assert.equal(h.runs[1].options.session,'thread-1');
  const saved=h.saved;h.gateway.close();const reboot=harness(t,saved);reboot.gateway.start();await tick();
  assert.equal(reboot.runs.length,0);assert.equal(reboot.gateway.snapshot().jobs[0].state,'interrupted');
  assert.ok(!('text' in reboot.saved.jobs.at(-1)));
});
test('delivery failure retains stable IDs, retry sends results without repeating the agent',async t=>{
  const h=harness(t);let attempts=0;const send=h.api.send;h.api.send=(...args)=>{attempts++;return send(...args);};
  h.sendError=Error('offline');await h.login();h.push(h.message('1','排查'));await until(()=>h.runs.length===1);
  h.runs[0].resolve('完成结果');await until(()=>h.gateway.snapshot().outbox===1);const id=h.saved.outbox[0].id;
  h.push();await tick();h.push();await tick();assert.equal(attempts,1,'failed delivery must back off while polling continues');
  h.sendError=null;await h.gateway.action('retry');await until(()=>h.gateway.snapshot().outbox===0);
  assert.equal(h.runs.length,1);assert.equal(h.sent[0].id,id+'-0');assert.equal(h.sent.at(-1).text,'完成结果');assert.equal(h.sent.at(-1).context,'ctx-1');
});
test('task details retain exact questions and full replies after delivery and restart without broadcasting content',async t=>{
  const h=harness(t);await h.login();const request='私密问题\n  保留空格  ',response='私密回复😀\n'.repeat(1000)+'完整结束';
  h.push(h.message('detail',request));await until(()=>h.runs.length===1);
  const id=h.saved.jobs[0].id;h.runs[0].resolve(response);
  await until(()=>!h.gateway.snapshot().active&&h.saved.outbox.length===0,1000);
  assert.equal(h.gateway.snapshot().jobs[0].delivery,'sent');
  assert.ok(!JSON.stringify(h.gateway.snapshot()).includes('私密'));assert.ok(!('text' in h.saved.jobs[0]));
  assert.deepEqual(await h.gateway.action('task-detail',id),{id,request,response});
  h.gateway.close();const reboot=harness(t,h.saved);
  assert.deepEqual(await reboot.gateway.action('task-detail',id),{id,request,response});assert.equal(reboot.runs.length,0);
  const legacy=fresh();legacy.jobs=[{id:'legacy',state:'completed'}];
  assert.deepEqual(await harness(t,legacy).gateway.action('task-detail','legacy'),{id:'legacy',request:null,response:null});
});
test('deleting a chat removes all its records atomically and preserves other chats and bindings',async t=>{
  const state=fresh(),route={clientId:'fixture',threadId:'one',transport:'desktop',settings:{backend:'codex'}},other={clientId:'fixture',threadId:'two'};
  state.jobs=[{id:'one-a',state:'completed',route},{id:'one-b',state:'running',route,checkpoint:{messageId:'original-message',turnId:'original-turn',submitted:true}},{id:'two',state:'completed',route:other}];
  state.bindings={kept:{threadId:'one'}};
  state.outbox=[{id:'reply-one',jobId:'one-a',parts:['one']},{id:'reply-two',jobId:'two',parts:['two']}];
  const h=harness(t,state),key=h.gateway.snapshot().jobs.find(job=>job.id==='one-a').chat.key;
  await assert.rejects(h.gateway.action('delete-chat',key),/任务结束/);assert.equal(h.saved.jobs.length,3);
  h.gateway.close();const ended=structuredClone(state);ended.jobs[1].state='completed';const next=harness(t,ended);
  await next.gateway.action('delete-chat',key);
  assert.deepEqual(next.saved.jobs.map(job=>job.id),['two']);assert.deepEqual(next.saved.outbox.map(item=>item.jobId),['two']);
  assert.deepEqual(next.saved.bindings,state.bindings);assert.equal(next.runs.length,0);
  next.gateway.close();assert.deepEqual(harness(t,next.saved).gateway.snapshot().jobs.map(job=>job.id),['two']);
});
test('deleting a failed task removes only its record and pending reply and preserves dedup',async t=>{
  const h=harness(t);h.sendError=Error('offline');await h.login();
  const message=h.message('delete-failed','失败问题');h.push(message);await until(()=>h.runs.length===1);
  const id=h.saved.jobs[0].id;await assert.rejects(h.gateway.action('delete-task',id),/任务结束/);
  h.runs[0].reject(new AgentError('RPC_REJECTED','turn/start',-32602));
  await until(()=>!h.gateway.snapshot().active&&h.gateway.snapshot().error);
  h.push(h.message('other','另一条问题'));await until(()=>h.runs.length===2);h.runs[1].resolve('另一条回复');await until(()=>!h.gateway.snapshot().active);
  const other=h.saved.jobs[1].id;
  await h.gateway.action('delete-task',id);
  assert.deepEqual(h.saved.jobs.map(job=>job.id),[other]);assert.equal(h.saved.outbox.length,1);assert.equal(h.saved.outbox[0].jobId,other);
  await assert.rejects(h.gateway.action('task-detail',id),/不存在/);
  h.sendError=null;await h.gateway.action('retry');await until(()=>h.saved.outbox.length===0);
  assert.deepEqual(h.sent.map(item=>item.text),['另一条回复']);h.push(message);await tick();assert.equal(h.runs.length,2);
});
test('deleting a failed delivery during retry cannot consume or fail the next task reply',async t=>{
  const state=fresh();state.enabled=true;state.account={id:'bot',token:'test',owner:'owner'};state.allowed=['owner'];
  state.jobs=[{id:'failed-delivery',state:'completed',delivery:'failed',exchange:{request:'第一问',response:'第一答'}},{id:'kept',state:'completed',delivery:'pending'}];
  state.outbox=[{id:'first',jobId:'failed-delivery',sender:'owner',parts:['第一答'],index:0},{id:'second',jobId:'kept',sender:'owner',parts:['第二答'],index:0}];
  const h=harness(t,state),send=h.api.send;let reject;
  h.api.send=(...args)=>args[4]==='first-0'?new Promise((_,fail)=>{reject=fail;}):send(...args);
  h.gateway.start();await until(()=>reject);await h.gateway.action('delete-task','failed-delivery');reject(Error('late offline'));
  await until(()=>h.saved.outbox.length===0);assert.deepEqual(h.sent.map(item=>item.text),['第二答']);assert.equal(h.gateway.snapshot().error,'');
  assert.deepEqual(h.saved.jobs.map(job=>job.id),['kept']);assert.equal(h.saved.jobs[0].delivery,'sent');
  assert.equal(h.gateway.snapshot().jobs[0].canDelete,true);
  await h.gateway.action('delete-task','kept');assert.deepEqual(h.saved.jobs,[]);assert.equal(h.runs.length,0);
  h.gateway.close();assert.deepEqual(harness(t,h.saved).gateway.snapshot().jobs,[]);
});
test('a delivery failure whose status cannot be saved pauses safely without an unhandled rejection',async t=>{
  const h=harness(t);await h.login();h.push(h.message('disk-failure','检查'));await until(()=>h.runs.length===1);
  h.api.send=async()=>{h.failStore=true;throw Error('offline');};h.runs[0].resolve('完整结果');
  await until(()=>h.gateway.snapshot().status==='error');await tick();
  assert.equal(h.gateway.snapshot().enabled,false);assert.match(h.gateway.snapshot().error,/安全保存/);assert.equal(h.runs.length,1);
});
test('long completed results retain all content including the tail beyond 60000 characters',async t=>{
  const h=harness(t);h.sendError=Error('offline');await h.login();
  h.push(h.message('long-result','检查完整结果'));await until(()=>h.runs.length===1);
  const result='完整结果开始\n'+'甲😀乙\n'.repeat(15000)+'\n【完整结果结束】';
  assert.ok(result.length>60000);h.runs[0].resolve(result);
  await until(()=>h.gateway.snapshot().jobs[0].state==='completed');
  const delivery=h.saved.outbox.at(-1);
  delivery.parts.forEach((part,index)=>assert.ok(part.startsWith(`【结果 ${index+1}/${delivery.parts.length}】\n\n`)));
  const reassembled=delivery.parts.map(part=>part.replace(/^【结果 \d+\/\d+】\n\n/,'')).join('');
  assert.equal(reassembled.length,result.length);assert.ok(reassembled===result,'reassembling every numbered part must preserve the full original result');
  assert.ok(delivery.parts.every(part=>Array.from(part).length<=1800));
  assert.equal((await h.gateway.action('task-detail',h.saved.jobs[0].id)).response,result);
  assert.equal(h.runs.length,1);
});
test('restart resumes a partially delivered result with the same part IDs and no agent replay',async t=>{
  const initial=fresh();initial.enabled=true;initial.account={id:'bot',token:'test',owner:'owner'};initial.allowed=['owner'];
  initial.outbox=[{id:'long-result',sender:'owner',parts:['第一段','第二段','【完整结束】'],index:0}];
  const h=harness(t,initial),send=h.api.send,attempted=[];
  h.api.send=async(...args)=>{attempted.push(args[4]);if(args[4]==='long-result-1')throw Error('offline');return send(...args);};
  h.gateway.start();await until(()=>h.gateway.snapshot().error);
  assert.deepEqual(attempted,['long-result-0','long-result-1']);assert.equal(h.saved.outbox[0].index,1);
  h.gateway.close();const reboot=harness(t,h.saved);reboot.gateway.start();await until(()=>reboot.gateway.snapshot().outbox===0);
  assert.deepEqual(reboot.sent.map(item=>item.id),['long-result-1','long-result-2']);
  assert.deepEqual([...h.sent,...reboot.sent].map(item=>item.text),initial.outbox[0].parts);
  assert.equal(reboot.runs.length,0);
});
test('approval belongs to the initiating sender and is single use; stop only cancels owned work',async t=>{
  const h=harness(t);await h.login();h.push(h.message('1','排查'));await until(()=>h.runs.length===1);
  const decision=h.runs[0].options.onApproval({kind:'command',detail:'test command',cwd:process.cwd()});
  await until(()=>h.saved.outbox.some(item=>item.parts[0].includes('/allow'))||h.sent.some(item=>item.text.includes('/allow')));
  const approval=h.saved.outbox.find(item=>item.parts[0].includes('/allow'))?.parts[0]||h.sent.find(item=>item.text.includes('/allow')).text;
  const token=approval.match(/\/allow ([\w-]+)/)[1];
  h.push(h.message('2','/allow '+token,'stranger'));await until(()=>h.gateway.snapshot().pending.includes('stranger'));assert.equal(h.gateway.snapshot().jobs[0].state,'approval');
  h.push(h.message('3','/allow '+token));assert.equal(await decision,true);
  h.push(h.message('4','/stop'));await until(()=>h.runs[0].cancelled);assert.equal(h.runs.length,1);
});
test('question answers select labels or preserve free text and continue the original job',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','需要问答'));await until(()=>h.runs.length===1);
  assert.equal(typeof h.runs[0].options.onUserInput,'function');
  const decision=h.runs[0].options.onUserInput({questions:[
    {id:'mode',header:'处理方式',question:'如何处理？',options:[{label:'仅分析',description:'查看原因'},{label:'修改代码',description:'直接修复'}]},
    {id:'notes',header:'补充',question:'还有哪些要求？',options:[]}
  ]});
  await until(()=>h.saved.jobs[0].state==='question');
  h.push(h.message('question-one','/question'));
  await until(()=>[...h.sent.map(x=>x.text),...h.saved.outbox.flatMap(x=>x.parts)].some(x=>x.includes('如何处理？')&&x.includes('/answer ')));
  const first=[...h.sent.map(x=>x.text),...h.saved.outbox.flatMap(x=>x.parts)].find(x=>x.includes('如何处理？')&&x.includes('/answer '));
  const token=first.match(/\/answer ([\w-]+)/)[1];
  const choice=h.message('answer-one','2');h.push(choice,choice);
  await until(()=>[...h.sent.map(x=>x.text),...h.saved.outbox.flatMap(x=>x.parts)].some(x=>x.includes('还有哪些要求？')));
  h.push(h.message('stale','/answer '+token+' 1'));await tick();assert.equal(h.runs.length,1);
  h.push(h.message('question-two','/question'));
  await until(()=>[...h.sent.map(x=>x.text),...h.saved.outbox.flatMap(x=>x.parts)].some(x=>x.includes('还有哪些要求？')&&x.includes('/answer ')));
  const second=[...h.sent.map(x=>x.text),...h.saved.outbox.flatMap(x=>x.parts)].find(x=>x.includes('还有哪些要求？')&&x.includes('/answer ')).match(/\/answer ([\w-]+)/)[1];
  h.push(h.message('answer-two','/answer '+second+' 保持已有配置，路径 /tmp/example  不要改\n保留换行'));
  assert.deepEqual(await decision,{answers:{mode:{answers:['修改代码']},notes:{answers:['保持已有配置，路径 /tmp/example  不要改\n保留换行']}}});
  assert.equal(h.runs.length,1);assert.equal(h.saved.jobs[0].state,'running');
  h.runs[0].resolve('依据答案完成');await until(()=>h.saved.jobs[0].state==='completed');
});
test('pending questions take precedence over menus and only their sender can answer',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','排查'));await until(()=>h.runs.length===1);
  assert.equal(typeof h.runs[0].options.onUserInput,'function');
  let answered=false;const answer=h.runs[0].options.onUserInput({questions:[{id:'q',question:'是否继续？',options:[{label:'继续'},{label:'停止'}]}]}).then(value=>{answered=true;return value;});
  h.push(h.message('menu','/clients'),h.message('stranger','1','stranger'));await until(()=>h.saved.pending.includes('stranger'));assert.equal(answered,false);
  h.push(h.message('invalid','9'));await tick();assert.equal(answered,false);
  h.push(h.message('answer','1'));assert.deepEqual(await answer,{answers:{q:{answers:['继续']}}});assert.equal(h.runs.length,1);
});
test('a path sent directly answers the pending question without a command prefix or a new task',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','确认项目位置'));await until(()=>h.runs.length===1);
  let response;const answer=h.runs[0].options.onUserInput({questions:[{id:'path',question:'要处理哪个项目？',options:[]}]}).then(value=>{response=value;return value;});
  const text='/Users/you/WorkSpace/my project\n保留现有配置';
  h.push(h.message('path-answer',text));await until(()=>h.saved.seen.includes('path-answer'));await tick();
  assert.deepEqual(response,{answers:{path:{answers:[text]}}});
  await answer;assert.equal(h.runs.length,1);assert.equal(h.saved.jobs[0].state,'running');
});
test('withdrawn questions cannot accept old answers and their unsent prompts are removed',async t=>{
  const h=harness(t);h.sendError=Error('offline');await h.login();h.push(h.message('task','排查'));await until(()=>h.runs.length===1);
  assert.equal(typeof h.runs[0].options.onUserInput,'function');
  const controller=new AbortController(),answer=h.runs[0].options.onUserInput({questions:[{id:'q',question:'桌面问题',options:[]}],signal:controller.signal});
  await until(()=>h.saved.outbox.some(x=>x.questionId));const token=h.saved.outbox.find(x=>x.questionId).questionId;
  controller.abort();assert.equal(await answer,null);assert.equal(h.saved.jobs[0].state,'running');assert.ok(!h.saved.outbox.some(x=>x.questionId));
  h.push(h.message('stale','/answer '+token+' 文字'));await tick();assert.equal(h.runs.length,1);
});
test('resolving a concurrent approval preserves the waiting question',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','排查'));await until(()=>h.runs.length===1);
  const answer=h.runs[0].options.onUserInput({questions:[{id:'q',question:'如何处理？',options:[]}]});
  const approval=h.runs[0].options.onApproval({kind:'command',detail:'pwd',cwd:process.cwd()});
  await until(()=>h.saved.jobs[0].state==='approval');
  const notice=[...h.sent.map(x=>x.text),...h.saved.outbox.flatMap(x=>x.parts)].find(x=>x.includes('/allow '));
  h.push(h.message('deny','/deny '+notice.match(/\/allow ([\w-]+)/)[1]));assert.equal(await approval,false);
  assert.equal(h.saved.jobs[0].state,'question');
  h.push(h.message('answer','仅分析'));assert.deepEqual(await answer,{answers:{q:{answers:['仅分析']}}});assert.equal(h.runs.length,1);
});
test('question timeout stops the owned task and restart discards expired question prompts',async t=>{
  const h=harness(t,undefined,{questionTimeoutMs:25});await h.login();h.push(h.message('task','排查'));await until(()=>h.runs.length===1);
  assert.equal(typeof h.runs[0].options.onUserInput,'function');
  const answer=h.runs[0].options.onUserInput({questions:[{id:'q',question:'等待超时',options:[]}]});
  assert.equal(await answer,null);await until(()=>h.runs[0].cancelled);assert.equal(h.runs.length,1);
  const state=fresh();state.jobs=[{id:'old',state:'question'}];state.outbox=[{id:'stale',sender:'owner',parts:['旧问题'],index:0,questionId:'old-1'}];
  const reboot=harness(t,state);reboot.gateway.start();assert.equal(reboot.gateway.snapshot().jobs[0].state,'interrupted');assert.equal(reboot.gateway.snapshot().outbox,0);
});
test('expired login and storage failure stop execution instead of reconnecting or starting tasks',async t=>{
  const h=harness(t);await h.login();h.failStore=true;h.push(h.message('1','must not run'));await until(()=>!h.gateway.snapshot().enabled);
  assert.equal(h.runs.length,0);assert.match(h.gateway.snapshot().error,/保存/);
  const e=harness(t);await e.login();e.updateError=Object.assign(Error('expired'),{code:-14});e.push();await until(()=>e.gateway.snapshot().status==='expired');assert.equal(e.gateway.snapshot().enabled,false);
});
test('expired QR and cancelled login never install credentials from a late response',async t=>{
  const h=harness(t,fresh());h.api.qrStatus=async()=>({status:'expired'});await h.gateway.action('login');await until(()=>h.gateway.snapshot().status==='error');assert.equal(h.gateway.snapshot().account,null);
  let confirm;h.api.qrStatus=()=>new Promise(resolve=>{confirm=resolve;});await h.gateway.action('login');await until(()=>confirm);
  await h.gateway.action('cancel-login');confirm({status:'confirmed',ilink_bot_id:'late-bot',bot_token:'late-token'});await tick();assert.equal(h.gateway.snapshot().account,null);assert.equal(h.gateway.snapshot().status,'paused');
});
test('resuming after a failed scan clears the old error while the new poll is pending',async t=>{
  const h=harness(t);await h.login();
  h.api.qrStatus=async()=>({status:'expired'});await h.gateway.action('login');
  await until(()=>h.gateway.snapshot().status==='error');
  assert.match(h.gateway.snapshot().error,/过期/);
  const resumed=await h.gateway.action('enable',true);
  assert.equal(resumed.status,'connecting');assert.equal(resumed.error,'');
});
test('scanning again replaces an invalid token and restores inbound and outbound communication for the same bot',async t=>{
  const initial=fresh();initial.enabled=true;initial.account={id:'bot',owner:'owner',token:'invalid-token'};initial.allowed=['owner'];
  const h=harness(t,initial),updates=h.api.updates,send=h.api.send;
  h.api.updates=async(account,...args)=>{if(account.token==='invalid-token')throw Object.assign(Error('invalid token'),{code:-14});return updates(account,...args);};
  h.api.send=async(account,...args)=>{assert.equal(account.token,'renewed-token');return send(account,...args);};
  h.gateway.start();await until(()=>h.gateway.snapshot().status==='expired');
  h.api.qrStatus=async()=>({status:'confirmed',ilink_bot_id:'bot',bot_token:'renewed-token',ilink_user_id:'owner'});
  await h.login();assert.equal(h.saved.account.token,'renewed-token');assert.equal(h.gateway.snapshot().error,'');
  h.push(h.message('recovered-status','/status'));await until(()=>h.sent.length>0);
  assert.equal(h.gateway.snapshot().status,'connected');assert.equal(h.saved.enabled,true);
});
test('invalid login survives restart and cannot be resumed with the stale token',async t=>{
  const h=harness(t);await h.login();h.updateError=Object.assign(Error('invalid token'),{code:-14});h.push();
  await until(()=>h.gateway.snapshot().status==='expired');h.gateway.close();
  const reboot=harness(t,h.saved);
  assert.equal(reboot.gateway.snapshot().status,'expired');
  await assert.rejects(reboot.gateway.action('enable',true),/重新扫码/);
  assert.equal(reboot.saved.enabled,false);
  await reboot.login();assert.equal(reboot.gateway.snapshot().status,'connected');
  assert.equal(reboot.saved.account.stale,undefined);
});
test('already-bound QR terminates with recovery guidance instead of polling until timeout',async t=>{
  const h=harness(t,fresh());let calls=0;
  h.api.qrStatus=async()=>{calls++;return {status:'binded_redirect'};};
  await h.gateway.action('login');await tick();
  assert.equal(h.gateway.snapshot().status,'error');assert.equal(h.gateway.snapshot().qr,null);
  assert.match(h.gateway.snapshot().error,/已有连接|原连接/);assert.equal(calls,1);
});
test('new conversation drops only that sender context and revoked users cannot finish queued work',async t=>{
  const h=harness(t);await h.login();h.push(h.message('1','排查'));await until(()=>h.runs.length===1);h.runs[0].options.onSession('old-thread');h.runs[0].resolve('done');await until(()=>!h.gateway.snapshot().active);
  h.push(h.message('2','/new'));await until(()=>h.saved.bindings[bindingKey('bot','owner')].threadId==='');h.push(h.message('3','继续'));await until(()=>h.runs.length===2);assert.equal(h.runs[1].options.session,undefined);
  h.push(h.message('4','排队'));await until(()=>h.gateway.snapshot().jobs.some(job=>job.state==='queued'));
  await h.gateway.action('remove-user','owner');await until(()=>!h.gateway.snapshot().active);assert.equal(h.runs.length,2);assert.ok(h.runs[1].cancelled);assert.ok(!h.saved.outbox.some(item=>item.sender==='owner'));
});
test('revoking a recipient during delivery cannot discard the next recipients result',async t=>{
  const initial=fresh();initial.enabled=true;initial.account={id:'bot',token:'test',owner:'owner'};initial.allowed=['owner','other'];
  initial.outbox=[{id:'first',sender:'owner',parts:['one'],index:0},{id:'second',sender:'other',parts:['two'],index:0}];
  const h=harness(t,initial),send=h.api.send;let finish;
  h.api.send=async(...args)=>{if(args[1]==='owner')return new Promise(resolve=>{finish=resolve;});return send(...args);};
  h.gateway.start();await until(()=>finish);await h.gateway.action('remove-user','owner');finish();await until(()=>h.gateway.snapshot().outbox===0);
  assert.deepEqual(h.sent.map(item=>item.text),['two']);
});
test('late send failure from a paused connection cannot expire the restored connection',async t=>{
  const initial=fresh();initial.enabled=true;initial.account={id:'bot',token:'test',owner:'owner'};initial.allowed=['owner'];initial.outbox=[{id:'first',sender:'owner',parts:['one'],index:0}];
  const h=harness(t,initial),send=h.api.send;let fail,first=true;
  h.api.send=async(...args)=>{if(first){first=false;return new Promise((_resolve,reject)=>{fail=reject;});}return send(...args);};
  h.gateway.start();await until(()=>fail);await h.gateway.action('enable',false);await h.gateway.action('enable',true);fail(Object.assign(Error('old connection expired'),{code:-14}));
  await tick();h.push();
  await until(()=>h.gateway.snapshot().outbox===0);assert.equal(h.gateway.snapshot().enabled,true);assert.notEqual(h.gateway.snapshot().status,'expired');
});

test('default setup connects without a project and explains how to select a desktop conversation',async t=>{
  const h=harness(t,fresh());await h.login();assert.equal(h.gateway.snapshot().clients[0].backend,'codex');
  h.push(h.message('hello','检查项目'));await until(()=>h.saved.outbox.some(item=>item.parts.join('').includes('/chats'))||h.sent.some(item=>item.text.includes('/chats')));
  assert.equal(h.runs.length,0);assert.deepEqual(h.saved.bindings,{});
});
test('priority is used for new conversations; pinned threads and failures never move to another instance',async t=>{
  const h=harness(t);await h.login();
  const clients=[{...fresh().clients[0],id:'priority',name:'优先 Codex',profile:'priority'},{...fresh().clients[0],id:'other',name:'第二 Codex',profile:'other'}];
  await h.gateway.action('save-clients',clients);
  h.push(h.message('1','检查'));await until(()=>h.runs.length===1);assert.equal(h.runs[0].options.settings.profile,'priority');h.runs[0].options.onSession('priority-thread');h.runs[0].resolve('done');await until(()=>!h.gateway.snapshot().active);
  await h.gateway.action('save-clients',[clients[1],clients[0]]);
  h.push(h.message('2','继续'));await until(()=>h.runs.length===2);assert.equal(h.runs[1].options.settings.profile,'priority');assert.equal(h.runs[1].options.session,'priority-thread');
  h.runs[1].reject(Error('provider unavailable'));await until(()=>!h.gateway.snapshot().active);assert.equal(h.runs.length,2);
  h.push(h.message('3','/new'),h.message('4','新任务'));await until(()=>h.runs.length===3);assert.equal(h.runs[2].options.settings.profile,'other');assert.equal(h.runs[2].options.session,undefined);
});
test('desktop conversation selection is scoped to sender and instance; selections precede subsequent text',async t=>{
  let finishRead;const reads=[];
  const threads=[{id:'desktop-thread',cwd:process.cwd(),name:'桌面里的对话',status:'active'}];
  const h=harness(t,fresh(),{listThreads:async()=>({threads,nextCursor:null}),readThread:async(client,id)=>{reads.push({client,id});return new Promise(resolve=>{finishRead=()=>resolve(threads[0]);});}});
  await h.login();h.push(h.message('list','/chats'),h.message('select','/chat 1'),h.message('task','继续桌面的任务'));await until(()=>finishRead);
  assert.equal(h.runs.length,0);finishRead();await until(()=>h.runs.length===1);assert.equal(h.runs[0].options.session,'desktop-thread');assert.equal(reads[0].client.id,'codex-default');
  assert.equal(h.runs[0].options.transport,'desktop');assert.equal(h.runs[0].options.text,'继续桌面的任务');
  assert.equal(h.gateway.snapshot().jobs[0].chat.name,'桌面里的对话');
  h.push(h.message('s','hello','stranger'));await until(()=>h.gateway.snapshot().pending.includes('stranger'));await h.gateway.action('allow-user','stranger');
  h.push(h.message('s2','/chat 1','stranger'));await until(()=>h.sent.some(item=>item.sender==='stranger')||h.saved.outbox.some(item=>item.sender==='stranger'));assert.equal(h.runs.length,1);
});
test('queries that finish after revoke, pause or client edits cannot install a stale selection',async t=>{
  for(const action of ['remove-user','enable','save-clients']) {
    let finish;const h=harness(t,undefined,{listThreads:async()=>({threads:[{id:'desktop',cwd:process.cwd(),name:'桌面对话'}],nextCursor:null}),readThread:()=>new Promise(resolve=>{finish=resolve;})});
    await h.login();h.push(h.message('list','/chats'),h.message('select','/chat 1'));await until(()=>finish);
    await h.gateway.action(action,action==='remove-user'?'owner':action==='enable'?false:fresh().clients);
    finish({id:'desktop',cwd:process.cwd(),name:'桌面对话',status:'idle'});await tick();
    assert.notEqual(h.saved.bindings[bindingKey('bot','owner')]?.threadId,'desktop');assert.equal(h.runs.length,0);
  }
});
test('queued work freezes its route and shares only its own new conversation',async t=>{
  const h=harness(t);await h.login();h.push(h.message('1','第一条'),h.message('2','第二条'));await until(()=>h.saved.jobs.some(job=>job.state==='queued'));
  const queued=h.saved.jobs.find(job=>job.state==='queued');assert.equal(queued.route.settings.cwd,process.cwd());
  await assert.rejects(h.gateway.action('save-clients',[]),/任务结束/);
  h.push(h.message('select','/new'));await tick();assert.equal(h.runs.length,1);
  h.runs[0].options.onSession('new-thread');
  const waiting=h.gateway.snapshot().jobs;assert.equal(waiting[0].chat.key,waiting[1].chat.key);assert.equal(waiting[0].chat.threadId,'new-thread');
  h.runs[0].resolve('done');await until(()=>h.runs.length===2);assert.equal(h.runs[1].options.session,'new-thread');assert.equal(h.runs[1].options.transport,'local');
});

test('task history identifies actual chats across instances and keeps older chats beyond the latest eight jobs',t=>{
  const state=fresh(),settings={backend:'codex',cwd:process.cwd(),binary:'',configHome:'',profile:'private-profile'};
  const route={clientId:'codex-default',clientName:'原客户端',settings,threadId:'same-thread',threadName:'实际对话',bindingId:'binding-one'};
  state.account={id:'bot'};state.bindings[bindingKey('bot','owner')]={id:'binding-one',threadId:'same-thread'};
  state.jobs=[{id:'older-chat',state:'completed',startedAt:1,route:{...route,threadId:'older-thread',threadName:'较早的对话'}},
    ...Array.from({length:9},(_,i)=>({id:'recent-'+i,state:'completed',startedAt:i+2,route,text:'private-task-content'})),
    {id:'other-client',state:'completed',startedAt:11,route:{...route,clientId:'other'}},
    {id:'other-profile',state:'completed',startedAt:12,route:{...route,settings:{...settings,profile:'other'}}},
    {id:'legacy',state:'completed',startedAt:13},
    {id:'uncreated',sender:'owner',state:'failed',startedAt:14,route:{...route,threadId:'',threadName:''}}];
  const h=harness(t,state),history=h.gateway.snapshot().jobs;
  assert.equal(history.length,14);assert.equal(history.at(-1).chat.name,'较早的对话');
  const byId=id=>history.find(job=>job.id===id).chat;
  assert.equal(byId('recent-0').name,'实际对话');assert.equal(byId('recent-0').key,byId('recent-8').key);
  assert.notEqual(byId('recent-0').key,byId('other-client').key);assert.notEqual(byId('recent-0').key,byId('other-profile').key);
  assert.equal(byId('uncreated').threadId,'');assert.notEqual(byId('uncreated').key,byId('recent-0').key);
  assert.match(byId('legacy').name,/未记录对话/);assert.equal(byId('recent-0').project,path.basename(process.cwd()));
  assert.ok(!JSON.stringify(history).includes('private-profile'));assert.ok(!JSON.stringify(history).includes('private-task-content'));
});
test('historical chat names come from each clients read-only local metadata and follow renames',t=>{
  const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
  const dir=fs.mkdtempSync('/tmp/whale-history-');t.after(()=>fs.rmSync(dir,{recursive:true}));
  const threadId='01a140a5-e74b-7193-9471-31cd59c28b2a',databases=[],files=[];
  const state=fresh();
  for(const client of ['one','two']){
    const home=path.join(dir,client);fs.mkdirSync(home);const file=path.join(home,'state_5.sqlite'),db=new DatabaseSync(file);databases.push(db);files.push(file);t.after(()=>db.close());
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,thread_source TEXT)');
    db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(threadId,'private raw prompt',client+'的侧栏名称','user');
    state.jobs.push({id:client,state:'completed',startedAt:1,route:{clientId:client,threadId,settings:{backend:'codex',cwd:dir,configHome:home}}});
  }
  const h=harness(t,state),before=files.map(file=>fs.readFileSync(file));
  assert.deepEqual(h.gateway.snapshot().jobs.map(job=>job.chat.name),['two的侧栏名称','one的侧栏名称']);
  assert.ok(!JSON.stringify(h.gateway.snapshot().jobs).includes('private raw prompt'));
  for(const [i,file]of files.entries())assert.deepEqual(fs.readFileSync(file),before[i]);
  databases[0].prepare('UPDATE threads SET name=? WHERE id=?').run('改名后的对话',threadId);
  assert.equal(h.gateway.snapshot().jobs.find(job=>job.id==='one').chat.name,'改名后的对话');
});
test('disabled pinned clients require an explicit selection; editing an instance cannot resume an old account thread',async t=>{
  const h=harness(t);await h.login();h.push(h.message('1','检查'));await until(()=>h.runs.length===1);h.runs[0].options.onSession('old-account');h.runs[0].resolve('done');await until(()=>!h.gateway.snapshot().active);
  const clients=h.gateway.snapshot().clients;clients[0].enabled=false;
  await h.gateway.action('save-clients',[...clients,{...fresh().clients[0],id:'other',name:'Other'}]);
  h.push(h.message('2','继续'));await until(()=>h.saved.seen.includes('2'));await tick();assert.equal(h.runs.length,1);
  clients[0].enabled=true;clients[0].profile='another-account';await h.gateway.action('save-clients',clients);
  assert.equal(h.saved.bindings[bindingKey('bot','owner')].threadId,'');
});
test('stop interrupts active work immediately despite a stalled catalog and discards waiting messages',async t=>{
  let finish;const h=harness(t,undefined,{listThreads:()=>new Promise(resolve=>{finish=resolve;})});
  await h.login();h.push(h.message('1','正在运行'));await until(()=>h.runs.length===1);
  h.push(h.message('list','/chats'),h.message('waiting','不能在停止后执行'));await until(()=>finish);
  h.push(h.message('stop','／STOP\u200b。'));await until(()=>h.runs[0].cancelled);
  finish({threads:[],nextCursor:null});await tick();assert.equal(h.runs.length,1);
});
test('manual client selection skips disabled entries and scopes paginated catalogs to that instance',async t=>{
  const calls=[],base=fresh().clients[0];
  const h=harness(t,fresh(),{listThreads:async(client,options)=>{calls.push({id:client.id,cursor:options.cursor});return {threads:[{id:'thread-'+client.id,cwd:process.cwd(),name:client.name,status:'idle'}],nextCursor:options.cursor?null:'page-two'};}});
  await h.login();await h.gateway.action('save-clients',[{...base,id:'disabled',enabled:false},{...base,id:'first',name:'First',profile:'first'},{...base,id:'second',name:'Second',profile:'second'}]);
  h.push(h.message('list','/clients'),h.message('client','/client 2'),h.message('projects','/projects'),h.message('project','/project 1'),h.message('chats','/chats'),h.message('next','/chats next'),h.message('task','检查'));
  await until(()=>h.runs.length===1);assert.equal(h.runs[0].options.settings.profile,'second');assert.deepEqual(calls.map(call=>call.id),['second','second','second']);assert.equal(calls[2].cursor,'page-two');
});
test('forget clears WeChat credentials and selections while preserving independent client configuration',async t=>{
  const h=harness(t);await h.login();const clients=[{...fresh().clients[0],name:'My Codex',profile:'existing'}];await h.gateway.action('save-clients',clients);
  await h.gateway.action('forget');assert.equal(h.saved.account,null);assert.deepEqual(h.saved.allowed,[]);assert.deepEqual(h.saved.bindings,{});assert.deepEqual(h.saved.jobs,[]);assert.deepEqual(h.saved.clients,clients);
});

test('projects returns a readable project list, including commands copied with invisible or fullwidth characters',async t=>{
  for(const command of ['/projects\u200b','／PROJECTS。','/projects']) {
    const h=harness(t,fresh(),{listThreads:async()=>({threads:[{id:'desktop',cwd:process.cwd(),name:'桌面对话'}],nextCursor:null})});
    await h.login();h.push(h.message('list',command));await until(()=>h.sent.length);
    assert.match(h.sent[0].text,/^最近项目/);assert.ok(h.sent[0].text.includes('1. '+path.basename(process.cwd())));
    assert.match(h.sent[0].text,/回复.*1/);assert.ok(!h.sent[0].text.includes('/allow'));assert.equal(h.runs.length,0);
  }
});
test('number replies select the latest list, then subsequent numbers are ordinary task text',async t=>{
  const thread={id:'desktop',cwd:process.cwd(),name:'桌面对话',status:'idle'};
  const h=harness(t,fresh(),{listThreads:async()=>({threads:[thread],nextCursor:null}),readThread:async()=>thread});
  await h.login();
  h.push(h.message('projects','/projects'),h.message('project','1'));
  await until(()=>h.saved.bindings[bindingKey('bot','owner')]?.cwd===process.cwd());assert.equal(h.runs.length,0);
  h.push(h.message('chats','/chats'),h.message('chat','1'),h.message('task','123'));
  await until(()=>h.runs.length===1);assert.equal(h.runs[0].options.session,'desktop');assert.equal(h.runs[0].options.text,'123');
});
test('chats renders five escaped table rows and number selection uses the displayed page',async t=>{
  const threads=Array.from({length:7},(_,i)=>({id:'thread-'+i,cwd:process.cwd(),name:i===0?'特殊 | **标题**\n[链接](https://example.test)':'会话'+i,status:'idle'}));
  const calls=[];
  const h=harness(t,fresh(),{listThreads:async(_client,options)=>{calls.push(options);const start=Number(options.cursor||0),end=start+options.limit;return {threads:threads.slice(start,end),nextCursor:end<threads.length?String(end):null};},readThread:async(_client,id)=>threads.find(thread=>thread.id===id)});
  await h.login();h.push(h.message('list','/chats'));await until(()=>h.sent.length);
  const first=h.sent[0].text;assert.match(first,/\| 编号 \| 对话 \| 项目 \/ 客户端 \|/);assert.match(first,/回复.*编号/);assert.match(first,/下一页/);
  assert.equal(calls[0].limit,5);assert.equal(first.split('\n').filter(line=>/^\| [1-9]\d* \|/.test(line)).length,5);
  assert.ok(!first.includes(process.cwd()));assert.ok(first.includes('\\|'));assert.ok(!first.includes('**标题**'));assert.ok(!first.includes('\n[链接]'));
  h.push(h.message('next','下一页'));await until(()=>h.sent.some(item=>item.text.includes('会话6')));
  h.push(h.message('select','2'),h.message('task','保留原文\n  问题  '));await until(()=>h.runs.length===1);
  assert.equal(h.runs[0].options.session,'thread-6');assert.equal(h.runs[0].options.text,'保留原文\n  问题  ');
});
test('multi-client chat tables retain buffered rows across pages without dropping or refetching them',async t=>{
  const base=fresh().clients[0],calls=[];
  const h=harness(t,fresh(),{listThreads:async(client,options)=>{calls.push({id:client.id,...options});const threads=Array.from({length:7},(_,i)=>({id:client.id+'-'+i,cwd:process.cwd(),name:client.id+'会话'+i})),start=Number(options.cursor||0),end=start+options.limit;return {threads:threads.slice(start,end),nextCursor:end<threads.length?String(end):null};}});
  await h.login();await h.gateway.action('save-clients',[{...base,id:'first',name:'First'},{...base,id:'second',name:'Second'}]);
  h.push(h.message('list','/chats'));await until(()=>h.sent.length);
  assert.equal(h.sent[0].text.split('\n').filter(line=>/^\| [1-9]\d* \|/.test(line)).length,5);assert.match(h.sent[0].text,/下一页/);
  h.push(h.message('next','下一页'));await until(()=>h.sent.length===2);
  assert.equal(calls.length,2,'buffered second page must retain remote cursors without querying again');
  h.push(h.message('last','下一页'));await until(()=>h.sent.length===3);
  const rows=h.sent.flatMap(item=>item.text.split('\n').filter(line=>/^\| [1-9]\d* \|/.test(line)));
  assert.equal(rows.length,14);for(const id of ['first','second'])for(let i=0;i<7;i++)assert.equal(rows.filter(row=>row.includes(id+'会话'+i)).length,1);
  assert.equal(calls.length,4);assert.ok(!h.sent[2].text.includes('下一页'));assert.equal(h.runs.length,0);
});
test('a failed next chat page preserves its cursor for an explicit retry',async t=>{
  let fail=true;
  const h=harness(t,fresh(),{listThreads:async(_client,options)=>{if(options.cursor&&fail){fail=false;throw Error('offline');}return {threads:options.cursor?[{id:'last',name:'末页对话',cwd:process.cwd()}]:Array.from({length:5},(_,i)=>({id:'first'+i,name:'首页对话'+i,cwd:process.cwd()})),nextCursor:options.cursor?null:'next'};}});
  await h.login();h.push(h.message('list','/chats'));await until(()=>h.sent.length===1);
  h.push(h.message('next','下一页'));await until(()=>h.sent.length===2);assert.match(h.sent[1].text,/查询失败/);
  h.push(h.message('retry','/chats next'));await until(()=>h.sent.length===3);assert.match(h.sent[2].text,/末页对话/);assert.equal(h.runs.length,0);
});
test('number selection and next-page replies stay within the senders latest menu',async t=>{
  const calls=[],base=fresh().clients[0];
  const h=harness(t,fresh(),{listThreads:async(client,options)=>{calls.push({id:client.id,cursor:options.cursor});return {threads:[{id:'desktop',cwd:process.cwd(),name:'桌面对话'}],nextCursor:options.cursor?null:'next-page'};}});
  await h.login();await h.gateway.action('save-clients',[base,{...base,id:'second',name:'第二 Codex',profile:'second'}]);
  h.push(h.message('projects','/projects'),h.message('next','下一页'),h.message('clients','/clients'),h.message('client','2'));
  await until(()=>h.saved.bindings[bindingKey('bot','owner')]?.clientId==='second');
  assert.equal(calls.length,4);assert.equal(calls[2].cursor,'next-page');assert.equal(h.runs.length,0);
  h.push(h.message('stranger','hi','stranger'));await until(()=>h.gateway.snapshot().pending.includes('stranger'));await h.gateway.action('allow-user','stranger');
  h.push(h.message('other-choice','1','stranger'));await until(()=>h.sent.some(item=>item.sender==='stranger')||h.saved.outbox.some(item=>item.sender==='stranger'));
  assert.equal(h.saved.bindings[bindingKey('bot','stranger')],undefined);assert.equal(h.runs.length,0);
});
test('unknown commands give a short next step; only help returns the command reference',async t=>{
  const h=harness(t);await h.login();h.push(h.message('unknown','/unknown'));
  await until(()=>h.sent.length);assert.match(h.sent[0].text,/没认出/);assert.match(h.sent[0].text,/\/projects/);assert.ok(!h.sent[0].text.includes('/allow'));
  h.push(h.message('help','/help'));await until(()=>h.saved.outbox.some(item=>item.parts.join('').includes('/allow'))||h.sent.some(item=>item.text.includes('/allow')));assert.equal(h.runs.length,0);
});
test('task failures retain safe stages and RPC codes for replies, snapshots and status without rerunning',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','修改项目代码'));await until(()=>h.runs.length===1);
  h.runs[0].reject(new AgentError('RPC_REJECTED','turn/start',-32602));await until(()=>!h.gateway.snapshot().active);
  const failure=h.gateway.snapshot().jobs[0].failure;assert.equal(failure.stage,'turn/start');assert.equal(failure.rpcCode,-32602);
  assert.match(failure.message,/启动任务失败/);assert.deepEqual(h.saved.jobs.at(-1).failure,failure);
  h.push(h.message('status','/status'));await until(()=>h.saved.outbox.some(item=>item.parts.join('').includes('最近任务：failed'))||h.sent.some(item=>item.text.includes('最近任务：failed')));
  const replies=[...h.sent.map(item=>item.text),...h.saved.outbox.flatMap(item=>item.parts)].join('\n');assert.match(replies,/RPC -32602/);assert.equal(h.runs.length,1);
});
test('unknown task errors cannot expose arbitrary exception text in diagnostics or messages',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','检查'));await until(()=>h.runs.length===1);
  h.runs[0].reject(Error('Bearer private-api-key https://private.example'));await until(()=>!h.gateway.snapshot().active);
  const report=JSON.stringify({snapshot:h.gateway.snapshot(),saved:h.saved,sent:h.sent});assert.ok(!report.includes('private-api-key'));assert.ok(!report.includes('private.example'));
  assert.equal(h.gateway.snapshot().jobs[0].failure.code,'UNKNOWN');
});


test('numbered chat pagination accepts sizes, retains them, resets and guards invalid navigation',async t=>{
  const calls=[],threads=Array.from({length:30},(_,i)=>({id:'t'+i,cwd:process.cwd(),name:'会话'+i}));
  const h=harness(t,undefined,{listThreads:async(_client,o)=>{calls.push(o);const start=Number(o.cursor||0),end=start+o.limit;return {threads:threads.slice(start,end),nextCursor:end<threads.length?String(end):null};},readThread:async(_client,id)=>threads.find(x=>x.id===id)});
  await h.login();
  async function send(text){const n=h.sent.length;h.push(h.message('page-'+Math.random(),text));await until(()=>h.sent.length>n);return h.sent.at(-1).text;}
  assert.match(await send('/chats'),/\| 0 \| 下一页 \| 当前每页 5 条 \|/);
  let page=await send('0 10');assert.match(page,/第 2 页.*每页 10 条/);assert.match(page,/\| 1 \| 会话5 \|/);assert.match(page,/\| 10 \| 会话14 \|/);
  page=await send('0');assert.match(page,/第 3 页.*每页 10 条/);assert.match(page,/会话24/);
  page=await send('下一页 3');assert.match(page,/\| 1 \| 会话25 \|/);assert.match(page,/每页 3 条/);
  page=await send('/chats next');assert.match(page,/会话29/);assert.ok(!page.includes('| 0 |'));
  const count=calls.length;assert.match(await send('0'),/没有下一页/);assert.equal(calls.length,count);
  for(const invalid of ['0 0','0 21','0 -1','0 1.5','0 abc','/chats 0','/chats next 21'])assert.match(await send(invalid),/1.*20/);
  assert.equal(calls.length,count);assert.equal(h.runs.length,0);
  page=await send('/chats 10');assert.match(page,/第 1 页.*每页 10 条/);assert.match(page,/会话0/);
  page=await send('/chats');assert.match(page,/第 1 页.*每页 5 条/);
  h.push(h.message('choose','1'),h.message('numeric-prompt','0 10'));await until(()=>h.runs.length===1);assert.equal(h.runs[0].options.text,'0 10');assert.equal(h.runs[0].options.session,'t0');
});

test('changing page sizes consumes multi-client buffers and original cursors exactly once',async t=>{
  const base=fresh().clients[0],calls=[],seen=[];
  const h=harness(t,fresh(),{listThreads:async(client,o)=>{calls.push([client.id,o.cursor,o.limit]);const all=Array.from({length:11},(_,i)=>({id:client.id+i,cwd:process.cwd(),name:client.id+'会话'+i})),start=Number(o.cursor||0),end=start+o.limit;return {threads:all.slice(start,end),nextCursor:end<all.length?String(end):null};}});
  await h.login();await h.gateway.action('save-clients',[{...base,id:'first',name:'甲客户端'},{...base,id:'second',name:'乙客户端'}]);
  for(const command of ['/chats','0 10','0 3','0','0']){
    const n=h.sent.length;h.push(h.message('size-'+n,command));await until(()=>h.sent.length>n);
    const rows=h.sent.at(-1).text.split('\n').filter(x=>/^\| [1-9]\d* \|/.test(x));seen.push(...rows.map(x=>x.split(' | ')[1]));
  }
  assert.equal(seen.length,22);assert.equal(new Set(seen).size,22);
  for(const id of ['first','second'])for(let i=0;i<11;i++)assert.ok(seen.includes(id+'会话'+i));
  assert.equal(new Set(calls.map(([id,cursor])=>id+':'+cursor)).size,calls.length);assert.equal(h.runs.length,0);
});

test('large chat pages split only at row boundaries with continuous numbering and a final navigation row',async t=>{
  const base=fresh().clients[0],h=harness(t,fresh(),{listThreads:async()=>({threads:Array.from({length:20},(_,i)=>({id:'long'+i,cwd:'/tmp/'+'*'.repeat(40),name:i+'*'.repeat(40)})),nextCursor:'more'})});
  await h.login();await h.gateway.action('save-clients',[{...base,name:'*'.repeat(60)}]);
  h.push(h.message('large','/chats 20'));await until(()=>h.sent.length>1&&h.gateway.snapshot().outbox===0,1000);
  const rows=[];for(const part of h.sent){assert.ok(Array.from(part.text).length<=1800);assert.match(part.text,/\| 编号 \| 对话 \| 项目 \/ 客户端 \|/);for(const line of part.text.split('\n').filter(x=>x.startsWith('|'))){assert.ok(line.endsWith(' |'));if(/^\| [1-9]\d* \|/.test(line))rows.push(Number(line.split(' | ')[0].slice(2)));}}
  assert.deepEqual(rows,Array.from({length:20},(_,i)=>i+1));assert.equal(h.sent.filter(x=>x.text.includes('| 0 |')).length,1);assert.match(h.sent.at(-1).text,/\| 0 \| 下一页/);assert.equal(h.runs.length,0);
});

test('failed numbered pagination keeps the current selection and retries its cursor and requested size',async t=>{
  let fail=true;const calls=[],first=Array.from({length:5},(_,i)=>({id:'old'+i,name:'旧会话'+i,cwd:process.cwd()}));
  const h=harness(t,fresh(),{listThreads:async(_client,o)=>{calls.push([o.cursor,o.limit]);if(o.cursor&&fail){fail=false;throw Error('offline');}return {threads:o.cursor?[{id:'last',name:'末页会话',cwd:process.cwd()}]:first,nextCursor:o.cursor?null:'cursor-5'};},readThread:async(_client,id)=>first.find(x=>x.id===id)});
  await h.login();h.push(h.message('first','/chats'));await until(()=>h.sent.length===1);
  h.push(h.message('fail','0 10'));await until(()=>h.sent.length===2);assert.match(h.sent[1].text,/查询失败/);
  h.push(h.message('retry','0'));await until(()=>h.sent.length===3);assert.match(h.sent[2].text,/第 2 页.*每页 10 条/);assert.match(h.sent[2].text,/末页会话/);assert.deepEqual(calls,[[null,5],['cursor-5',10],['cursor-5',10]]);assert.equal(h.runs.length,0);
});


test('a failed chat query can retry from the start and never replaces the last successful number selection',async t=>{
  let fail=true,failNext=true;const calls=[],threads=Array.from({length:5},(_,i)=>({id:'valid'+i,name:'会话'+i,cwd:process.cwd()}));
  const h=harness(t,fresh(),{listThreads:async(_client,o)=>{calls.push(o.cursor);if(fail){fail=false;throw Error('offline');}if(o.cursor&&failNext){failNext=false;throw Error('offline-next');}return {threads,nextCursor:'next'};},readThread:async(_client,id)=>threads.find(x=>x.id===id)});
  await h.login();h.push(h.message('fail-first','/chats'));await until(()=>h.sent.length===1);assert.match(h.sent[0].text,/查询失败/);
  h.push(h.message('retry-first','0'));await until(()=>h.sent.length===2);assert.match(h.sent[1].text,/第 1 页/);
  h.push(h.message('fail-next','0'));await until(()=>h.sent.length===3);assert.match(h.sent[2].text,/查询失败/);
  h.push(h.message('choose-previous','3'),h.message('task','test'));await until(()=>h.runs.length===1);assert.equal(h.runs[0].options.session,'valid2');assert.deepEqual(calls,[null,null,'next']);
});

test('empty filtered pages continue to the next cursor, with bounded requests for an empty source',async t=>{
  let mode='filtered';const calls=[];
  const h=harness(t,fresh(),{listThreads:async(_client,o)=>{calls.push(o.cursor);return mode==='filtered'?{threads:o.cursor?[{id:'visible',name:'可见对话',cwd:process.cwd()}]:[],nextCursor:o.cursor?null:'filtered'}:{threads:[],nextCursor:String(calls.length)};}});
  await h.login();h.push(h.message('filtered','/chats'));await until(()=>h.sent.length===1);assert.match(h.sent[0].text,/可见对话/);assert.deepEqual(calls,[null,'filtered']);
  mode='empty';h.push(h.message('bounded','/chats'));await until(()=>h.sent.length===2);assert.equal(calls.length,22);assert.match(h.sent[1].text,/回复 0 继续/);assert.equal(h.runs.length,0);
});

test('zero navigation never executes in another menu and chat menus remain isolated per contact',async t=>{
  const h=harness(t,undefined,{listThreads:async()=>({threads:[{id:'one',name:'桌面对话',cwd:process.cwd()}],nextCursor:null})});
  await h.login();h.push(h.message('clients','/clients'),h.message('zero','0 10'));await until(()=>h.sent.length===2);assert.match(h.sent[1].text,/对话表格/);assert.equal(h.runs.length,0);
  h.push(h.message('chats','/chats'),h.message('stranger','hi','stranger'));await until(()=>h.gateway.snapshot().pending.includes('stranger'));await h.gateway.action('allow-user','stranger');
  h.push(h.message('other-zero','0','stranger'));await until(()=>h.sent.some(x=>x.sender==='stranger')||h.saved.outbox.some(x=>x.sender==='stranger'));assert.equal(h.saved.bindings[bindingKey('bot','stranger')],undefined);assert.equal(h.runs.length,0);
});


test('explicit chats next reopens the chat menu so zero retries cannot become model prompts',async t=>{
  let fail=true;const threads=Array.from({length:5},(_,i)=>({id:'first'+i,name:'会话'+i,cwd:process.cwd()}));
  const h=harness(t,fresh(),{listThreads:async(_client,o)=>{if(o.cursor&&fail){fail=false;throw Error('offline');}return {threads:o.cursor?[{id:'last',name:'最终对话',cwd:process.cwd()}]:threads,nextCursor:o.cursor?null:'next'};},readThread:async(_client,id)=>threads.find(x=>x.id===id)});
  await h.login();h.push(h.message('list','/chats'),h.message('select','1'),h.message('fail','/chats next'));await until(()=>h.sent.length===3);assert.match(h.sent[2].text,/查询失败/);
  h.push(h.message('retry','0'));await until(()=>h.sent.length===4);assert.match(h.sent[3].text,/最终对话/);assert.equal(h.runs.length,0);
});

function recoveringState(overrides={}) {
  const state=fresh();state.enabled=true;state.account={id:'bot',token:'private-token',owner:'owner'};state.allowed=['owner'];state.contexts.owner='saved-context';
  state.jobs=[{id:'recover-job',sender:'owner',state:'running',startedAt:Date.now()-1000,exchange:{request:'只执行一次'},
    route:{clientId:state.clients[0].id,settings:{backend:'codex',cwd:process.cwd(),binary:'',configHome:'',profile:''},threadId:'original-thread',transport:'desktop'},
    checkpoint:{messageId:'original-message',turnId:'original-turn',submitted:true},...overrides}];return state;
}
test('restart restores a saved desktop watcher and delivers its result without resubmitting the request',async t=>{
  const initial=recoveringState(),h=harness(t,initial);h.gateway.start();await until(()=>h.runs.length===1);
  const run=h.runs[0];assert.equal(run.options.recovering,true);assert.equal(run.options.text,undefined);
  assert.deepEqual(run.options.checkpoint,initial.jobs[0].checkpoint);assert.equal(run.options.session,'original-thread');
  assert.equal(h.saved.jobs[0].startedAt,initial.jobs[0].startedAt);assert.equal(h.gateway.snapshot().jobs[0].state,'recovering');
  run.options.onCheckpoint(initial.jobs[0].checkpoint);assert.equal(h.gateway.snapshot().jobs[0].state,'running');
  run.resolve('原任务最终结果');await until(()=>h.sent.length===1);assert.equal(h.sent[0].text,'原任务最终结果');
  assert.equal(h.saved.jobs[0].delivery,'sent');assert.equal(h.saved.jobs[0].state,'completed');
  assert.ok(!JSON.stringify(h.gateway.snapshot()).includes('original-message'));
});
test('restart notices for untraceable and queued tasks survive delivery failures without replay or duplicate notices',async t=>{
  for(const kind of ['legacy','queued','local'])await t.test(kind,async t=>{
    const initial=recoveringState();if(kind==='legacy')delete initial.jobs[0].checkpoint;
    if(kind==='queued')initial.jobs[0].state='queued';if(kind==='local')initial.jobs[0].route.transport='local';
    const h=harness(t,initial);h.sendError=Error('offline');h.gateway.start();await until(()=>h.saved.outbox.length===1);
    const id=h.saved.outbox[0].id;assert.equal(h.runs.length,0);assert.equal(h.saved.jobs[0].state,'interrupted');assert.match(h.saved.outbox[0].parts.join(''),/重启|中断/);
    h.gateway.close();const reboot=harness(t,h.saved);reboot.gateway.start();await until(()=>reboot.sent.length===1);
    assert.equal(reboot.sent[0].id,id+'-0');assert.equal(reboot.runs.length,0);assert.equal(reboot.saved.jobs[0].delivery,'sent');
    reboot.gateway.close();const again=harness(t,reboot.saved);again.gateway.start();await tick();assert.equal(again.sent.length,0);assert.equal(again.runs.length,0);
  });
});
test('recovery failure explicitly reports interrupted or unknown execution and never retries execution',async t=>{
  for(const code of ['TURN_INTERRUPTED','RECOVERY_UNKNOWN'])await t.test(code,async t=>{
    const h=harness(t,recoveringState());h.gateway.start();await until(()=>h.runs.length===1);h.runs[0].reject(new AgentError(code,'desktop'));
    await until(()=>h.sent.length===1);assert.equal(h.saved.jobs[0].state,'interrupted');assert.match(h.sent[0].text,/中断/);assert.match(h.sent[0].text,/不会自动重新执行/);assert.equal(h.runs.length,1);
  });
});
test('shutdown detaches desktop watching before clearing interactions and ignores late completion',async t=>{
  const h=harness(t,recoveringState());h.gateway.start();await until(()=>h.runs.length===1);const run=h.runs[0];
  run.detach=()=>{run.detached=true;};h.gateway.close();assert.equal(run.detached,true);assert.equal(run.cancelled,undefined);
  run.resolve('关闭后迟到的结果');await tick();assert.equal(h.saved.jobs[0].state,'recovering');assert.equal(h.saved.outbox.length,0);assert.equal(h.sent.length,0);
});
test('restart recovers a stored completed reply whose pending outbox is missing without starting an agent',async t=>{
  const h=harness(t,recoveringState({state:'completed',delivery:'pending',exchange:{request:'原问题',response:'已保存的结果'}}));
  h.gateway.start();await until(()=>h.sent.length===1);assert.equal(h.sent[0].text,'已保存的结果');assert.equal(h.runs.length,0);assert.equal(h.saved.jobs[0].delivery,'sent');
});
test('revoked senders cannot receive restart notices or have their desktop work recovered',async t=>{
  for(const checkpoint of [undefined,{messageId:'saved',turnId:'turn',submitted:true}]) {
    const state=recoveringState({checkpoint});state.allowed=[];const h=harness(t,state);h.gateway.start();await tick();
    assert.equal(h.runs.length,0);assert.equal(h.sent.length,0);assert.equal(h.saved.outbox.length,0);
  }
});

test('restarted pending questions are discarded and only the revalidated live question can be answered',async t=>{
  const initial=recoveringState({state:'question'});initial.outbox=[{id:'stale',sender:'owner',parts:['失效的问题'],index:0,questionId:'stale-question'}];
  const h=harness(t,initial);h.gateway.start();await until(()=>h.runs.length===1);
  assert.equal(h.sent.length,0);assert.equal(h.saved.outbox.length,0);
  h.runs[0].options.onCheckpoint(initial.jobs[0].checkpoint);
  const answer=h.runs[0].options.onUserInput({questions:[{id:'current',question:'仍有效的问题',options:[]}]});
  await until(()=>h.sent.length===1);assert.match(h.sent[0].text,/仍有效的问题/);assert.ok(!h.sent[0].text.includes('失效'));
  h.push(h.message('answer','继续'));assert.deepEqual(await answer,{answers:{current:{answers:['继续']}}});assert.equal(h.runs.length,1);
  h.runs[0].resolve('完成');await until(()=>h.saved.jobs[0].state==='completed');
});
test('a full delivery queue retains restart notices and emits them after capacity becomes available',async t=>{
  const state=recoveringState({checkpoint:undefined});state.allowed.push('other');
  state.outbox=Array.from({length:100},(_,i)=>({id:'existing-'+i,sender:'other',parts:['已有消息'],index:0}));
  const h=harness(t,state);h.sendError=Error('offline');h.gateway.start();await until(()=>h.gateway.snapshot().status==='connected');
  assert.equal(h.saved.jobs[0].recoveryNotice,true);assert.equal(h.saved.outbox.length,100);assert.equal(h.runs.length,0);
  await h.gateway.action('remove-user','other');h.sendError=null;await h.gateway.action('retry');
  await until(()=>h.sent.length===1);assert.equal(h.sent[0].sender,'owner');assert.match(h.sent[0].text,/重启/);assert.equal(h.saved.jobs[0].delivery,'sent');
});
test('reconnecting discards old approvals and only accepts a newly validated approval token',async t=>{
  const h=harness(t);await h.login();h.push(h.message('task','检查'));await until(()=>h.runs.length===1);
  h.sendError=Error('offline');const first=h.runs[0].options.onApproval({kind:'command',detail:'pwd',cwd:process.cwd()});
  await until(()=>h.saved.outbox.some(item=>item.parts[0].includes('/allow ')));
  const stale=h.saved.outbox.find(item=>item.parts[0].includes('/allow ')).parts[0].match(/\/allow ([\w-]+)/)[1];
  h.runs[0].options.onRecovering();
  assert.equal(h.saved.jobs[0].state,'recovering');assert.equal(h.saved.outbox.some(item=>item.parts[0].includes('/allow '+stale)),false);
  assert.equal(await first,false);
  h.runs[0].options.onCheckpoint({messageId:'submitted',turnId:'own-turn',submitted:true});
  const second=h.runs[0].options.onApproval({kind:'command',detail:'pwd',cwd:process.cwd()});
  await until(()=>h.saved.outbox.some(item=>item.parts[0].includes('/allow ')));
  const current=h.saved.outbox.find(item=>item.parts[0].includes('/allow ')).parts[0].match(/\/allow ([\w-]+)/)[1];
  assert.notEqual(stale,current);h.push(h.message('stale','/allow '+stale));await until(()=>h.saved.seen.includes('stale'));
  assert.equal(h.saved.jobs[0].state,'approval');h.push(h.message('current','/allow '+current));assert.equal(await second,true);
  h.runs[0].resolve('完成');await until(()=>!h.gateway.snapshot().active);
});
