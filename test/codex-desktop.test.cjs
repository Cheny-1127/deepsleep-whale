'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {desktopFixture}=require('./fixtures/codex-desktop.cjs');
const {startDesktopAgent}=require('../src/agents/codex-desktop.cjs');
const {startWechatAgent}=require('../src/agents/wechat-agent.cjs');
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('desktop condition timed out');}
async function setup(t,options={}) {
  const home=fs.mkdtempSync('/tmp/whale-desktop-');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const desktop=await desktopFixture({home,...options});t.after(()=>desktop.close());
  const settings={backend:'codex',cwd:fs.realpathSync(home),configHome:home,profile:'must-not-override-desktop'};
  return {desktop,run:extra=>startDesktopAgent({settings,session:'desktop-fixture',text:'test',...extra})};
}
test('forwards exact text to the desktop owner, inherits settings and returns only this turn final answer',async t=>{
  const {desktop}=await setup(t,{autoComplete:true});
  const text='test\n保留原文 /help  😀  ',sessions=[];
  const result=await startWechatAgent({settings:{backend:'codex',cwd:fs.realpathSync(path.dirname(path.dirname(desktop.socketPath))),configHome:path.dirname(path.dirname(desktop.socketPath))},session:'desktop-fixture',transport:'desktop',text,onSession:id=>sessions.push(id),spawnImpl:()=>assert.fail('must never spawn CLI for desktop forwarding')}).promise;
  assert.deepEqual(result,{text:'桌面回复😀',session:'desktop-fixture'});assert.deepEqual(sessions,['desktop-fixture']);
  const requests=desktop.wire.filter(m=>m.type==='request');
  assert.deepEqual(requests.map(m=>m.method),['initialize','thread-owner-discovery','thread-follower-start-turn']);
  const start=requests.at(-1);assert.equal(start.version,2);assert.equal(start.targetClientId,'desktop-owner');
  assert.equal(start.params.conversationId,'desktop-fixture');assert.deepEqual(start.params.turnStart.context,{inheritThreadSettings:true});
  assert.deepEqual(start.params.turnStart.request,{threadId:'desktop-fixture',input:[{type:'text',text,text_elements:[]}],clientUserMessageId:start.params.turnStart.request.clientUserMessageId});
  assert.ok(start.params.turnStart.request.clientUserMessageId);
});
test('waits for the desktop current turn to finish and never reports its old answer as the new reply',async t=>{
  const {desktop,run}=await setup(t,{busy:true});let settled=false;
  const task=run();task.promise.finally(()=>{settled=true;}).catch(()=>{});
  await until(()=>desktop.wire.some(m=>m.params?.following));
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);assert.equal(settled,false);
  desktop.idle();await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  assert.equal(settled,false);desktop.complete('本次 test 的回复');assert.equal((await task.promise).text,'本次 test 的回复');
});
test('accepts canonical patches, ignores other chats and completes only the correlated turn',async t=>{
  const {desktop,run}=await setup(t);const task=run();
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.send({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'other-owner',params:{hostId:'local',conversationId:'another-chat',change:{type:'snapshot',revision:99,conversationState:{id:'another-chat'}}}});
  desktop.patch([{op:'replace',path:['turnHistory','history','entitiesByKey','current','items'],value:[{type:'agentMessage',id:'result',phase:'final_answer',text:'精确回复'}]},{op:'replace',path:['turnHistory','history','entitiesByKey','current','status'],value:'completed'}]);
  assert.equal((await task.promise).text,'精确回复');
});
test('cancel while waiting leaves the desktop running turn alone; cancel after forwarding interrupts only its own turn',async t=>{
  const first=await setup(t,{busy:true}),waiting=first.run();
  await until(()=>first.desktop.wire.some(m=>m.params?.following));waiting.cancel();await assert.rejects(waiting.promise,e=>e.code==='CANCELLED');
  assert.equal(first.desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'),false);
  const second=await setup(t),task=second.run();await until(()=>second.desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  task.cancel();await assert.rejects(task.promise,e=>e.code==='CANCELLED');
  const stop=second.desktop.wire.find(m=>m.method==='thread-follower-interrupt-turn');
  assert.equal(stop.version,4);assert.equal(stop.params.expectedTurnId,'forwarded-turn');assert.equal(stop.targetClientId,'desktop-owner');
});
test('desktop disconnect after submission does not reconnect or replay and reports uncertain delivery',async t=>{
  const {desktop,run}=await setup(t),task=run();await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  for(const socket of desktop.connections)socket.destroy();
  await assert.rejects(task.promise,e=>e.code==='DELIVERY_UNKNOWN');
  assert.equal(desktop.wire.filter(m=>m.method==='thread-follower-start-turn').length,1);
});
test('unexpected protocol, changed owner, patch gaps and unsafe paths fail without forwarding or returning history',async t=>{
  for(const failure of ['version','owner','gap','prototype']) {
    const {desktop,run}=await setup(t,{busy:true}),task=run();await until(()=>desktop.wire.some(m=>m.params?.following));
    if(failure==='version')desktop.snapshot({version:99});
    if(failure==='owner')desktop.snapshot({sourceClientId:'unrelated-owner'});
    if(failure==='gap')desktop.broadcast({type:'patches',baseRevision:500,revision:501,patches:[]});
    if(failure==='prototype')desktop.patch([{op:'add',path:['__proto__','polluted'],value:true}]);
    await assert.rejects(task.promise,e=>e.code==='DESKTOP_PROTOCOL');
    assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);assert.equal({}.polluted,undefined);
  }
});
test('no desktop endpoint or foreign project fails clearly without creating an endpoint or starting CLI',async t=>{
  const home=fs.mkdtempSync('/tmp/whale-desktop-missing-');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  await assert.rejects(startDesktopAgent({settings:{cwd:home,configHome:home},session:'selected',text:'test'}).promise,e=>e.code==='DESKTOP_UNAVAILABLE');assert.equal(fs.existsSync(path.join(home,'ipc')),false);
  const {run}=await setup(t,{cwd:'/'});await assert.rejects(run().promise,e=>e.code==='PROJECT');
});
test('only approvals in the forwarded turn are reviewed once and explicit decisions return to the pinned desktop owner',async t=>{
  const {desktop,run}=await setup(t),reviews=[];
  const task=run({onApproval:async request=>{reviews.push(request);return true;}});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.requests=[{id:'old-request',method:'item/commandExecution/requestApproval',params:{threadId:'desktop-fixture',turnId:'previous-turn',itemId:'old-tool',command:'never approve this'}}];
  desktop.snapshot();assert.equal(reviews.length,0);
  desktop.state.requests.push({id:7,method:'item/commandExecution/requestApproval',params:{threadId:'desktop-fixture',turnId:'forwarded-turn',itemId:'own-tool',command:'pwd',cwd:desktop.state.cwd}});
  desktop.snapshot();desktop.snapshot();
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-command-approval-decision'));
  assert.deepEqual(reviews,[{kind:'command',detail:'pwd',cwd:desktop.state.cwd}]);
  const decision=desktop.wire.find(m=>m.method==='thread-follower-command-approval-decision');
  assert.equal(decision.targetClientId,'desktop-owner');assert.equal(decision.version,1);assert.deepEqual(decision.params,{conversationId:'desktop-fixture',requestId:7,decision:'accept'});
  desktop.complete();await task.promise;
});
test('a desktop-resolved request cannot be approved again by a late WeChat response',async t=>{
  const {desktop,run}=await setup(t);let decide;
  const task=run({onApproval:()=>new Promise(resolve=>{decide=resolve;})});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.requests=[{id:'own-request',method:'item/commandExecution/requestApproval',params:{threadId:'desktop-fixture',turnId:'forwarded-turn',itemId:'own-tool',command:'pwd'}}];
  desktop.snapshot();await until(()=>decide);
  desktop.state.requests=[];desktop.snapshot();decide(true);desktop.complete();await task.promise;
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-command-approval-decision'),false);
});
test('waiting timeout does not interrupt somebody elses desktop turn, and rejected delivery never leaks raw errors',async t=>{
  const first=await setup(t,{busy:true});await assert.rejects(first.run({timeoutMs:30}).promise,e=>e.code==='TIMEOUT');
  assert.equal(first.desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'||m.method==='thread-follower-start-turn'),false);
  const second=await setup(t);await assert.rejects(second.run({text:'desktop-rejected'}).promise,e=>e.code==='DELIVERY_UNKNOWN'&&!e.message.includes('private-api-key')&&!e.message.includes('private.example'));
});
