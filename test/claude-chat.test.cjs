'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createClaudeChatOpener,createClaudeSessions}=require('../src/clients/claude-chat.cjs');
const {Activity}=require('../src/domain/activity.cjs');
const findDesktopSession=(id,dir)=>createClaudeSessions({dir}).find(id);
const cli='11111111-2222-3333-4444-555555555555',local='local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',other='local_ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-claude-chat-')),folder=path.join(dir,'account','org');fs.mkdirSync(folder,{recursive:true});
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,write:(name,value)=>fs.writeFileSync(path.join(folder,name+'.json'),typeof value==='string'?value:JSON.stringify(value))};
}
test('a hook session maps to its desktop record only on an exact, well-formed match',t=>{
  const f=fixture(t);assert.equal(findDesktopSession(cli,path.join(f.dir,'missing')),null);
  f.write(other,{sessionId:other,cliSessionId:'other',title:`mentions ${cli}`});assert.equal(findDesktopSession(cli,f.dir),null,'内容里提到 ID 不算匹配');
  f.write('local_broken',`{"cliSessionId":"${cli}"`);f.write('local_mismatch',{sessionId:other,cliSessionId:cli});
  f.write('notes',{sessionId:'notes',cliSessionId:cli});assert.equal(findDesktopSession(cli,f.dir),null);
  f.write(local,{sessionId:local,cliSessionId:cli,lastActivityAt:1});
  assert.equal(findDesktopSession(cli,f.dir).sessionId,local);
  f.write(other,{sessionId:other,cliSessionId:cli,lastActivityAt:5});assert.equal(findDesktopSession(cli,f.dir).sessionId,other,'多条匹配取最近活动的一条');
});
test('an earlier CLI id of the same desktop session still maps, without taking another session current id',t=>{
  const f=fixture(t),next='99999999-2222-3333-4444-555555555555';
  f.write(local,{sessionId:local,cliSessionId:next,priorCliSessionIds:[cli,42,'bad'],lastActivityAt:9});
  assert.equal(findDesktopSession(cli,f.dir).sessionId,local);assert.equal(findDesktopSession(next,f.dir).sessionId,local);assert.equal(findDesktopSession('bad',f.dir),null);
  f.write(other,{sessionId:other,cliSessionId:cli,lastActivityAt:1});assert.equal(findDesktopSession(cli,f.dir).sessionId,other);
});
test('opening navigates without importing, and refuses archived, malformed or concurrent requests',async()=>{
  const opened=[];let record={sessionId:local,archived:false},release;
  const chats=createClaudeChatOpener({find:()=>record,openExternal:async url=>{opened.push(url);if(release!==undefined)await new Promise(resolve=>{release=resolve;});}});
  assert.equal(await chats.open('claude:'+cli),true);assert.deepEqual(opened,[`claude://code/continue?session=${local}`]);
  for(const id of [cli,'claude:../x','cursor:'+cli,null])await assert.rejects(chats.open(id),/无法定位/);
  record=null;assert.equal(await chats.open('claude:'+cli),false,'命令行会话没有桌面页面');
  record={sessionId:local,archived:true};await assert.rejects(chats.open('claude:'+cli),/归档/);assert.equal(opened.length,1);
  record={sessionId:local,archived:false};release=null;const pending=chats.open('claude:'+cli);
  await assert.rejects(chats.open('claude:'+cli),/正在打开/);release();await pending;
  const failing=createClaudeChatOpener({find:()=>record,openExternal:async()=>{throw Error('blocked');}});
  for(let i=0;i<2;i++)await assert.rejects(failing.open('claude:'+cli),/blocked/,'失败后释放锁');
});

test('titles follow renames, are rescanned sparingly and only reparse changed records',t=>{
  const f=fixture(t);let now=0;const sessions=createClaudeSessions({dir:f.dir,clock:()=>now}),title=()=>sessions.lookup('claude:'+cli).title;
  assert.deepEqual(sessions.lookup('claude:'+cli),{kind:'unavailable'});
  f.write(local,{sessionId:local,cliSessionId:cli,title:'  添加备注功能 '});assert.equal(title(),undefined,'间隔内不重复扫描');
  now=3000;assert.equal(title(),'添加备注功能');
  f.write(local,{sessionId:local,cliSessionId:cli,title:'改名之后的会话'});now=6000;assert.equal(title(),'改名之后的会话');
  f.write(local,'{"half');now=9000;assert.equal(title(),'改名之后的会话','写入中沿用上次结果');
  f.write(local,{sessionId:local,cliSessionId:cli,title:''});assert.equal(sessions.find(cli,true).title,'');assert.deepEqual(sessions.lookup('claude:'+cli),{kind:'unavailable'});
  const read=fs.readFileSync;let reads=0;t.mock.method(fs,'readFileSync',(...args)=>{reads++;return read(...args);});
  sessions.find(cli,true);assert.equal(reads,0,'未修改的记录不重新解析');
  fs.rmSync(path.join(f.dir,'account','org',local+'.json'));assert.equal(sessions.find(cli,true),null);
});
test('reminders show the desktop title, update on rename and keep it when the record disappears',()=>{
  let chat={kind:'unavailable'};const activity=new Activity({resolveChat:()=>chat}),event=(name,turn)=>({source:'claude',raw_event:name,hook_event_name:name,session_id:'claude:'+cli,turn_id:turn});
  activity.accept(event('UserPromptSubmit','a'));assert.equal(activity.snapshot().sessions[0].title,'Claude · 55555555');
  chat={kind:'chat',title:'第一个标题'};activity.accept(event('Stop','a'));assert.equal(activity.snapshot().notices[0].title,'Claude · 第一个标题');
  chat={kind:'chat',title:'新标题'};assert.equal(activity.reconcile(null),true);assert.equal(activity.snapshot().notices[0].title,'Claude · 新标题');
  activity.accept(event('UserPromptSubmit','b'));chat={kind:'chat',title:'进行中改名'};activity.reconcile(null);assert.equal(activity.snapshot().sessions[0].title,'Claude · 进行中改名');
  activity.accept(event('Stop','b'));chat={kind:'chat',title:'新标题'};activity.reconcile(null);
  chat={kind:'unavailable'};activity.reconcile(null);assert.equal(activity.snapshot().notices[0].title,'Claude · 新标题');
  const restored=new Activity({saved:activity.exportState(),resolveChat:()=>({kind:'unavailable'})});assert.equal(restored.snapshot().notices[0].title,'Claude · 新标题');
});

test('entering the desktop session after completion clears only that Claude reminder',t=>{
  const f=fixture(t),next='99999999-2222-3333-4444-555555555555';let now=10000;
  const sessions=createClaudeSessions({dir:f.dir,clock:()=>now,interval:0});
  const activity=new Activity({clock:()=>now,resolveChat:id=>sessions.lookup(id),resolveRead:item=>item.source==='claude'?sessions.readReceipt(item):null});
  const stop=id=>activity.accept({source:'claude',raw_event:'Stop',hook_event_name:'Stop',session_id:'claude:'+id,turn_id:'t'});
  const focus=(at,extra={})=>f.write(local,{sessionId:local,cliSessionId:cli,title:'会话',lastFocusedAt:at,...extra});
  const left=(read=null)=>{activity.reconcile(read,now);return activity.snapshot().unread;};
  focus(9000);stop(cli);stop(next);now=20000;
  assert.equal(left(),2,'完成前看过不算');
  assert.equal(left({updatedAt:99999,unreadIds:new Set()}),2,'Codex 未读列表不影响 Claude');
  focus(undefined);assert.equal(left(),2,'没有查看记录');
  focus(15000);activity.setSourceRunning('claude',false);activity.reconcile(null,now);assert.equal(activity.exportState().notices.length,2,'Claude 退出时不消费提醒');
  activity.setSourceRunning('claude',true);assert.equal(left(),1);assert.equal(activity.snapshot().notices[0].session_id,'claude:'+next,'没有桌面记录的命令行会话保留');
  now=30000;stop(cli+'');assert.equal(activity.snapshot().unread,1,'同一轮不重复提醒');
  activity.accept({source:'claude',raw_event:'Stop',hook_event_name:'Stop',session_id:'claude:'+cli,turn_id:'t2'});focus(30500);now=31000;
  assert.equal(left(),2,'完成后 3 秒内保留');now=33500;assert.equal(left(),1);
  f.write(local,{sessionId:local,cliSessionId:'aaaaaaaa-2222-3333-4444-555555555555',priorCliSessionIds:[next],lastFocusedAt:33600});now=34000;
  assert.equal(left(),0,'会话换过 ID 也能对应');
  assert.equal(sessions.readReceipt({session_id:cli,time:1}),null);assert.equal(sessions.readReceipt({session_id:'claude:'+cli}),null);
});
