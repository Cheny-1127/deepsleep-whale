'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createWechatManager}=require('../src/channels/wechat-manager.cjs');
const {fresh,bindingKey}=require('../src/channels/wechat-store.cjs');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let i=0;i<300;i++){if(check())return;await tick();}assert.fail('multi-account condition timed out');}
function harness(t,initial,options={}){
  let saved=structuredClone(initial||fresh()),nextBot='bot-b',nextOwner='owner',failStore=false;
  const queues=new Map(),waiting=new Map(),sent=[],runs=[],qrTokens=[];
  const api={validate:value=>value,qr:async(_signal,tokens)=>{qrTokens.push(tokens);return {qrcode:'code',qrcode_img_content:'qr'};},qrStatus:async()=>({status:'confirmed',ilink_bot_id:nextBot,bot_token:'secret-'+nextBot,ilink_user_id:nextOwner,baseurl:'https://ilinkai.weixin.qq.com'}),
    updates:async(account,cursor,signal)=>{const queue=queues.get(account.id)||[];if(queue.length)return {msgs:queue.splice(0),get_updates_buf:'cursor-'+account.id};return new Promise(resolve=>{const done=()=>{waiting.delete(account.id);resolve({});};waiting.set(account.id,done);signal.addEventListener('abort',done,{once:true});});},
    uploadAvatar:async()=>({media:{encrypt_query_param:'preview'}}),
    sendImage:async(account,sender,image,context)=>sent.push({account:account.id,sender,image,context}),
    send:async(account,sender,text,context)=>sent.push({account:account.id,sender,text,context})};
  const manager=createWechatManager({...options,store:{available:()=>true,load:()=>structuredClone(saved),save:value=>{if(failStore)throw Error('disk');saved=structuredClone(value);},remove:()=>assert.fail('must not delete shared encrypted storage')},api,makeQr:async()=> 'data:image/png;base64,test',pollDelay:1,loginDelay:1,
    runAgent:options=>{const run={options};run.promise=new Promise((resolve,reject)=>{run.resolve=text=>resolve({text});run.cancel=()=>reject(Error('cancelled'));});runs.push(run);return run;}});
  t.after(()=>manager.close());
  const action=(id,name,value)=>manager.action(name,{connectionId:id,value});
  return {manager,action,api,sent,runs,qrTokens,get saved(){return saved;},set failStore(value){failStore=value;},set nextBot(value){nextBot=value;},set nextOwner(value){nextOwner=value;},
    pulse(bot){waiting.get(bot)?.();},
    push(bot,id,text,sender='owner',images=[]){if(!queues.has(bot))queues.set(bot,[]);queues.get(bot).push({message_id:id,message_type:1,from_user_id:sender,to_user_id:bot,context_token:'context-'+bot,item_list:[{type:1,text_item:{text}},...images.map(image_item=>({type:2,image_item}))]});waiting.get(bot)?.();}};
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

test('settings only exposes user information and saves nickname and remark for the originating WeChat',async t=>{
  const h=harness(t,pair());h.manager.start();
  const other=structuredClone(h.saved.connections[1]),identity=structuredClone(h.saved.connections[0].state.account);
  async function send(id,text){const count=h.sent.length;h.push('bot-a',id,text);await until(()=>h.sent.length>count);return h.sent.at(-1).text;}
  assert.match(await send('settings','/settings'),/1\. 用户信息/);
  assert.equal(await send('info','1'),'用户信息\n\n| 编号 | 项目 | 当前值 |\n| --- | --- | --- |\n| 1 | 昵称 | 未设置 |\n| 2 | 备注名 | 未设置 |\n| 3 | 头像 | 未设置 |\n\n回复 1/2/3 修改对应项目，回复 0 退出设置。');
  assert.match(await send('nickname','1'),/请输入昵称/);
  assert.match(await send('new-name','小鲸'),/昵称已保存/);
  assert.match(await send('remark','2'),/请输入备注名/);
  assert.match(await send('new-remark','我的工作微信'),/备注名已保存/);
  assert.equal(h.saved.connections[0].profile.nickname,'小鲸');assert.equal(h.saved.connections[0].name,'我的工作微信');
  assert.deepEqual(h.saved.connections[0].state.account,identity);assert.deepEqual(h.saved.connections[1],other);assert.equal(h.runs.length,0);
  await h.manager.action('select-connection','a');assert.equal(h.manager.snapshot().profile.nickname,'小鲸');assert.equal(h.manager.snapshot().connectionName,'我的工作微信');
  h.manager.close();const reboot=harness(t,h.saved);assert.equal(reboot.manager.snapshot().profile.nickname,'小鲸');
});

const avatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXkAAAAASUVORK5CYII=';
test('option 4 lets only its owner replace the avatar directly with the next image',async t=>{
  const initial=pair();initial.connections[0].profile={nickname:'小鲸',avatar};initial.connections[0].state.allowed.push('friend');
  const h=harness(t,initial,{normalizeAvatar:()=>avatar});h.manager.start();const previews=[];let downloads=0;
  h.api.image=async()=>{downloads++;return Buffer.from('replacement');};
  h.api.uploadAvatar=async(account,sender,data)=>{previews.push({account:account.id,sender,data});return {media:{encrypt_query_param:'preview'}};};
  h.api.sendImage=async(account,sender,image,context,id)=>h.sent.push({account:account.id,sender,image,context,id});
  await settingsReply(h,'open','/settings');assert.match(await settingsReply(h,'info','1'),/4\. 查看头像/);assert.equal(previews.length,0);
  h.push('bot-a','view','4');await until(()=>h.sent.some(item=>item.text?.includes('回复 3 修改头像'))&&h.sent.some(item=>item.image));
  assert.deepEqual(previews,[{account:'bot-a',sender:'owner',data:avatar}]);
  const imageIndex=h.sent.findIndex(item=>item.image),promptIndex=h.sent.findIndex(item=>item.text?.includes('回复 3 修改头像'));
  assert.ok(imageIndex<promptIndex);assert.equal(h.saved.connections[0].profile.avatar,avatar);assert.equal(h.saved.connections[1].profile,undefined);
  assert.match(await settingsReply(h,'friend','/settings',{sender:'friend'}),/仅扫码账号本人/);assert.equal(previews.length,1);
  assert.match(await settingsReply(h,'image-after-view','',{images:[{media:{}}]}),/头像已保存/);assert.equal(h.saved.connections[0].profile.avatar,avatar);assert.equal(downloads,1);
  assert.match(await settingsReply(h,'image-without-view','',{images:[{media:{}}]}),/修改昵称/);assert.equal(downloads,1);
  assert.match(await settingsReply(h,'edit','3'),/请发送一张头像/);assert.equal(previews.length,1);
  const cleared=await settingsReply(h,'clear','清空');assert.match(cleared,/头像已清空/);assert.ok(!cleared.includes('4. 查看头像'));
  assert.match(await settingsReply(h,'missing','4'),/尚未设置头像/);assert.equal(previews.length,1);assert.equal(h.runs.length,0);
});
test('avatar preview failure preserves the profile and still allows clearing the avatar',async t=>{
  const initial=pair();initial.connections[0].profile={nickname:'小鲸',avatar};const h=harness(t,initial);h.manager.start();
  h.api.uploadAvatar=async()=>{throw Error('private upload failure');};
  await settingsReply(h,'s','/settings');await settingsReply(h,'p','1');
  assert.match(await settingsReply(h,'a','4'),/预览暂时不可用/);
  await until(()=>h.sent.some(item=>item.text?.includes('回复 3 修改头像')));
  assert.equal(h.sent.some(item=>item.image),false);assert.equal(h.saved.connections[0].profile.avatar,avatar);
  assert.match(await settingsReply(h,'clear','清空'),/头像已清空/);assert.equal(h.saved.connections[0].profile.avatar,'');assert.equal(h.runs.length,0);
});
test('cancelling during preview upload aborts it and discards the late image and instructions',async t=>{
  const initial=pair();initial.connections[0].profile={nickname:'小鲸',avatar};const h=harness(t,initial);h.manager.start();let started=false,aborted=false;
  h.api.uploadAvatar=async(_account,_sender,_avatar,signal)=>new Promise((_resolve,reject)=>{started=true;signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});});
  await settingsReply(h,'s','/settings');await settingsReply(h,'p','1');h.push('bot-a','a','4');await until(()=>started);
  assert.match(await settingsReply(h,'cancel','0'),/已退出设置/);await until(()=>h.manager.snapshot().outbox===0);
  assert.equal(aborted,true);assert.equal(h.sent.some(item=>item.image||item.text?.includes('回复 3 修改头像')),false);assert.equal(h.saved.connections[0].profile.avatar,avatar);
});
test('clearing an avatar while viewing it discards the old preview even after returning to the profile menu',async t=>{
  const initial=pair();initial.connections[0].profile={nickname:'小鲸',avatar};const h=harness(t,initial);h.manager.start();let release;
  h.api.uploadAvatar=()=>new Promise(resolve=>{release=resolve;});
  await settingsReply(h,'s','/settings');await settingsReply(h,'p','1');h.push('bot-a','view','4');await until(()=>release);
  h.push('bot-a','clear','清空');await until(()=>h.saved.connections[0].profile.avatar==='');
  release({media:{encrypt_query_param:'old-avatar'}});await until(()=>h.manager.snapshot().outbox===0);
  assert.equal(h.sent.some(item=>item.image),false);assert.match(h.sent.at(-1).text,/头像已清空/);assert.ok(!h.sent.at(-1).text.includes('4. 查看头像'));
});
test('restarting never replays an avatar preview from an earlier settings session',async t=>{
  const initial=connected();initial.outbox=[{id:'old-preview',sender:'owner',parts:[{kind:'avatar-preview',avatar,session:'old',expiresAt:Date.now()+300000},{kind:'avatar-instructions',text:'旧头像提示',session:'old',expiresAt:Date.now()+300000}],index:0}];
  const h=harness(t,initial);h.api.uploadAvatar=()=>assert.fail('old previews must not upload');h.manager.start();h.pulse('bot-a');
  await until(()=>h.manager.snapshot().outbox===0);assert.deepEqual(h.sent,[]);
});
async function settingsReply(h,id,text,{sender='owner',images=[]}={}){const replies=()=>h.sent.filter(item=>item.sender===sender&&typeof item.text==='string');const count=replies().length;h.push('bot-a',id,text,sender,images);await until(()=>replies().length>count);return replies().at(-1).text;}
test('avatar updates require the explicit owner edit step; errors retain the old image and clearing persists',async t=>{
  const initial=pair();initial.connections[0].state.allowed.push('friend');
  const h=harness(t,initial,{normalizeAvatar:()=>avatar});h.manager.start();let downloads=0,fail=false;
  h.api.image=async()=>{downloads++;if(fail)throw Error('private download error');return Buffer.from('downloaded image');};
  assert.match(await settingsReply(h,'friend','/settings',{sender:'friend'}),/仅扫码账号本人/);
  await settingsReply(h,'outside','',{images:[{media:{}}]});assert.equal(downloads,0);
  await settingsReply(h,'open','/settings');await settingsReply(h,'profile','1');await settingsReply(h,'photo','3');
  assert.match(await settingsReply(h,'photo-text','hello'),/单独发送一张/);assert.equal(downloads,0);
  assert.match(await settingsReply(h,'photo-data','',{images:[{media:{encrypt_query_param:'fixture'}}]}),/头像已保存/);
  assert.equal(h.saved.connections[0].profile.avatar,avatar);assert.equal(h.saved.connections[1].profile,undefined);
  const reboot=harness(t,h.saved);assert.equal(reboot.manager.snapshot().profile.avatar,avatar);
  await settingsReply(h,'retry-photo','3');fail=true;
  assert.match(await settingsReply(h,'failed-photo','',{images:[{media:{}}]}),/读取失败.*原头像已保留/);
  assert.equal(h.saved.connections[0].profile.avatar,avatar);
  assert.match(await settingsReply(h,'clear','清空'),/头像已清空/);assert.equal(h.saved.connections[0].profile.avatar,'');assert.equal(h.runs.length,0);
});
test('settings cancellation, expiry and known commands do not trap normal tasks or write invalid names',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const h=harness(t,connected());h.manager.start();
  await settingsReply(h,'s','/settings');assert.match(await settingsReply(h,'not-open','2'),/只开放用户信息/);
  await settingsReply(h,'p','1');await settingsReply(h,'n','1');
  assert.match(await settingsReply(h,'long','字'.repeat(41)),/40 字以内/);assert.equal(h.saved.connections[0].profile,undefined);
  now+=300001;assert.match(await settingsReply(h,'expired','不保存'),/已超时/);assert.equal(h.saved.connections[0].profile,undefined);
  await settingsReply(h,'again','/settings');assert.match(await settingsReply(h,'cancel','0'),/已退出/);
  h.push('bot-a','normal','正常任务');await until(()=>h.runs.length===1);
  assert.match(await settingsReply(h,'busy','/settings'),/先结束或停止当前任务/);
  let answered=false;const answer=h.runs[0].options.onUserInput({questions:[{id:'q',question:'确认？',options:[]}]}).then(value=>{answered=true;return value;});
  await until(()=>h.sent.some(item=>item.text.includes('【问题】\n确认？')));
  assert.match(await settingsReply(h,'question-settings','/settings'),/先结束或停止/);assert.equal(answered,false);
  h.push('bot-a','answer','继续');await answer;assert.equal(h.runs.length,1);h.runs[0].resolve('完成');await until(()=>h.saved.connections[0].state.jobs[0].state==='completed');
  await settingsReply(h,'new-open','/settings');await settingsReply(h,'status','/status');
  h.push('bot-a','after-status','下一条任务');await until(()=>h.runs.length===2);
});
test('pausing during avatar download discards late results and store failure preserves the old profile',async t=>{
  const h=harness(t,connected(),{normalizeAvatar:()=>avatar});h.manager.start();let release,started=false;
  h.api.image=()=>new Promise(resolve=>{started=true;release=resolve;});
  await settingsReply(h,'s','/settings');await settingsReply(h,'p','1');await settingsReply(h,'a','3');
  h.push('bot-a','photo','', 'owner',[{media:{}}]);await until(()=>started);
  await h.action('wechat-legacy','enable',false);release(Buffer.from('late'));await tick();assert.equal(h.saved.connections[0].profile,undefined);
  const other=harness(t,connected());other.manager.start();await settingsReply(other,'s','/settings');await settingsReply(other,'p','1');await settingsReply(other,'n','1');
  other.failStore=true;other.push('bot-a','name','不能保存');await until(()=>other.manager.snapshot().error.includes('无法安全保存'));
  assert.equal(other.saved.connections[0].profile,undefined);assert.equal(other.manager.snapshot().profile.nickname,'');
});
test('a status command exits an in-flight avatar edit and late downloads cannot overwrite the profile',async t=>{
  const h=harness(t,connected(),{normalizeAvatar:()=>avatar});h.manager.start();let release,started=false;
  h.api.image=()=>new Promise(resolve=>{started=true;release=resolve;});
  await settingsReply(h,'s','/settings');await settingsReply(h,'p','1');await settingsReply(h,'a','3');
  h.push('bot-a','photo','','owner',[{media:{}}]);await until(()=>started);
  await settingsReply(h,'status','/status');release(Buffer.from('late'));await tick();assert.equal(h.saved.connections[0].profile,undefined);
  h.push('bot-a','normal','正常任务');await until(()=>h.runs.length===1);
});
test('zero cancels a downloading avatar immediately and late data cannot save after cancellation',async t=>{
  const h=harness(t,connected(),{normalizeAvatar:()=>avatar});h.manager.start();let release,started=false;
  h.api.image=()=>new Promise(resolve=>{started=true;release=resolve;});
  await settingsReply(h,'s','/settings');await settingsReply(h,'p','1');await settingsReply(h,'a','3');
  h.push('bot-a','photo','','owner',[{media:{}}]);await until(()=>started);
  assert.match(await settingsReply(h,'cancel','0'),/已退出设置/);
  release(Buffer.from('late'));await tick();assert.equal(h.saved.connections[0].profile,undefined);
  h.push('bot-a','normal','正常任务');await until(()=>h.runs.length===1);
});

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
  await assert.rejects(invalid.manager.action('add-connection'),/备注名格式/);assert.deepEqual(invalid.saved,malformed);
});
