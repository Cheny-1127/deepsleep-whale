const test = require('node:test');
const assert = require('node:assert/strict');
const { Activity, sanitizeEvent } = require('../src/domain/activity.cjs');
const event = (name, session = 'chat-1', turn = 'turn-1') => ({ hook_event_name: name, session_id: session, turn_id: turn });
test('an ended reply cannot hide another chat waiting for approval', () => {
  const activity = new Activity();
  activity.accept(event('PermissionRequest'));
  activity.accept(event('UserPromptSubmit', 'chat-2'));
  activity.accept(event('Stop', 'chat-2'));
  assert.equal(activity.snapshot().state, 'approval');
  assert.equal(activity.snapshot().pending, 1);
  activity.accept(event('PreToolUse'));
  assert.equal(activity.snapshot().state, 'working');
});
test('duplicate Stop is ignored but next turn is counted', () => {
  const activity = new Activity();
  assert.ok(activity.accept(event('Stop')));
  assert.equal(activity.accept(event('Stop')), null);
  assert.ok(activity.accept(event('Stop', 'chat-1', 'turn-2')));
  assert.equal(activity.snapshot().count, 2);
});
test('old hosts without turn IDs can complete later replies', () => {
  const activity = new Activity();
  const input = event('Stop'); delete input.turn_id;
  assert.ok(activity.accept(input));
  assert.equal(activity.accept(input), null);
  activity.accept(event('UserPromptSubmit'));
  assert.ok(activity.accept(input));
});
test('interruption does not create a completed reply', () => {
  const activity = new Activity();
  activity.accept(event('UserPromptSubmit'));
  assert.equal(activity.accept(event('Interrupt')).state, 'idle');
});
test('prompts, transcripts and tool contents are discarded', () => {
  assert.deepEqual(sanitizeEvent({ ...event('PreToolUse'), prompt: 'secret', transcript_path: '/private', tool_input: { token: 'secret' } }), event('PreToolUse'));
  assert.equal(sanitizeEvent({ ...event('Stop'), session_id: '../bad' }), null);
  assert.equal(sanitizeEvent(event('NotARealEvent')), null);
});
test('one finished chat stays unread while two other chats keep working', () => {
  const activity = new Activity({ resolveTitle:id=>({a:'修复登录',b:'检查测试',c:'整理文档'})[id] });
  for(const id of ['a','b','c']) activity.accept(event('UserPromptSubmit',id));
  activity.accept(event('Stop','a'));
  const state=activity.snapshot();
  assert.equal(state.working,2);
  assert.equal(state.unread,1);
  assert.equal(state.notices[0].title,'修复登录');
  assert.equal(state.sessions.length,3);
  activity.accept(event('PreToolUse','b'));
  assert.equal(activity.snapshot().unread,1);
  activity.accept(event('Stop','a'));
  assert.equal(activity.snapshot().unread,1);
});
test('reading one completion cannot clear another or change active chat state', () => {
  const activity = new Activity();
  activity.accept(event('Stop','a'));
  activity.accept(event('Stop','b'));
  activity.accept(event('PermissionRequest','c'));
  const [notice]=activity.snapshot().notices;
  activity.markRead(notice.id);
  assert.equal(activity.snapshot().unread,1);
  assert.equal(activity.snapshot().pending,1);
  assert.equal(activity.snapshot().state,'approval');
});
test('restart keeps unread reminders and dedup but never restores stale working states', () => {
  const activity = new Activity();
  activity.accept(event('Stop','a'));
  activity.accept(event('UserPromptSubmit','b'));
  const restored=new Activity({ saved:JSON.parse(JSON.stringify(activity.exportState())) });
  assert.equal(restored.snapshot().unread,1);
  assert.equal(restored.snapshot().working,0);
  assert.equal(restored.accept(event('Stop','a')),null);
  restored.markRead(restored.snapshot().notices[0].id);
  assert.equal(new Activity({saved:restored.exportState()}).snapshot().unread,0);
});
test('entering one Cursor chat clears only that completion',()=>{
  const a=new Activity();
  const cursorStop=id=>({source:'cursor',raw_event:'stop',hook_event_name:'Stop',session_id:`cursor:${id}`,turn_id:'turn-1'});
  a.accept(cursorStop('aaa'));a.accept(cursorStop('bbb'));a.accept(event('Stop','codex-chat'));
  assert.equal(a.acknowledgeCursor(null),false);
  assert.equal(a.acknowledgeCursor('codex-chat'),false);
  assert.equal(a.acknowledgeCursor('cursor:missing'),false);
  assert.equal(a.snapshot().unread,3);
  assert.equal(a.acknowledgeCursor('cursor:aaa'),true);
  assert.deepEqual(a.snapshot().notices.map(item=>item.session_id).sort(),['codex-chat','cursor:bbb']);
  assert.equal(a.acknowledgeCursor('cursor:aaa'),false);
});
test('multiple replies in one chat count once and continuing that chat clears its old reminder',()=>{
 const a=new Activity();
 a.accept(event('Stop','a','one'));a.accept(event('Stop','a','two'));
 assert.equal(a.snapshot().unread,1);
 assert.equal(a.snapshot().notices[0].turn_id,'two');
 a.accept(event('UserPromptSubmit','a','three'));
 assert.equal(a.snapshot().unread,0);
});
test('temporary sessions are excluded and native read state removes only read chats',()=>{
 let now=10000;
 const a=new Activity({clock:()=>now,resolveChat:id=>id==='temp'?{kind:'missing'}:{kind:'chat',title:id}});
 assert.equal(a.accept(event('Stop','temp')),null);
 a.accept(event('Stop','a'));a.accept(event('Stop','b'));
 now+=4000;
 assert.equal(a.reconcile({updatedAt:9999,unreadIds:new Set()},now),false,'stale app state cannot clear reminders');
 assert.equal(a.reconcile(null,now),false,'unavailable app state cannot clear reminders');
 assert.equal(a.reconcile({updatedAt:13000,unreadIds:new Set(['b'])},now),true);
 assert.equal(a.snapshot().unread,1);assert.equal(a.snapshot().notices[0].session_id,'b');
 assert.equal(a.reconcile({updatedAt:13000,unreadIds:new Set()},now),true);
 assert.equal(a.snapshot().unread,0);
});
test('restored old duplicate notices consolidate by chat and temporary sessions disappear',()=>{
 const old=new Activity();old.accept(event('Stop','a','one'));
 const saved=old.exportState();
 saved.notices.push({...saved.notices[0],id:'older',time:1});
 saved.notices.push({...saved.notices[0],id:'temp',session_id:'temp'});
 const restored=new Activity({saved,resolveChat:id=>id==='temp'?{kind:'missing'}:{kind:'chat',title:'侧栏名字'}});
 assert.equal(restored.snapshot().unread,1);assert.equal(restored.snapshot().notices[0].title,'侧栏名字');
});
const tool=(name,call='call-a',toolName='Bash',turn='turn-1',session='chat-1')=>({...event(name,session,turn),tool_use_id:call,tool_name:toolName});
test('tool output clears its permission state without creating a completion reminder',()=>{
 const a=new Activity();a.accept(tool('PreToolUse'));a.accept(tool('PermissionRequest'));
 assert.equal(a.snapshot().pending,1);
 assert.ok(a.accept({...tool('PostToolUse'),tool_response:{exit_code:1,secret:'discard'}}));
 assert.equal(a.snapshot().pending,0);assert.equal(a.snapshot().state,'thinking');assert.equal(a.snapshot().unread,0);
});
test('other parallel tools and other chats cannot clear a pending permission check',()=>{
 const a=new Activity();a.accept(tool('PreToolUse','a'));a.accept(tool('PermissionRequest','a'));
 a.accept(tool('PreToolUse','b','mcp__files__read'));
 a.accept(tool('PostToolUse','b','mcp__files__read'));
 assert.equal(a.snapshot().pending,1);
 a.accept(tool('PostToolUse','c','Bash','turn-1','chat-2'));assert.equal(a.snapshot().pending,1);
 a.accept(tool('PostToolUse','a'));assert.equal(a.snapshot().pending,0);
});
test('a tool return preserves other running calls and named permissions without call IDs are matched safely',()=>{
 const a=new Activity();a.accept(tool('PreToolUse','a'));a.accept(tool('PreToolUse','b','mcp__db__query'));
 a.accept({...event('PermissionRequest'),tool_name:'Bash'});
 a.accept(tool('PostToolUse','b','mcp__db__query'));assert.equal(a.snapshot().pending,1);
 a.accept(tool('PostToolUse','a'));assert.equal(a.snapshot().state,'thinking');
 const b=new Activity();b.accept(tool('PreToolUse','a'));b.accept(tool('PreToolUse','b'));
 b.accept({...event('PermissionRequest'),tool_name:'Bash'});
 b.accept(tool('PostToolUse','a'));assert.equal(b.snapshot().pending,1,'ambiguous same-name calls cannot clear a different check');
 b.accept(tool('PostToolUse','b'));assert.equal(b.snapshot().pending,0);
 const c=new Activity();c.accept(tool('PreToolUse','a'));c.accept(tool('PreToolUse','b'));
 c.accept(tool('PostToolUse','a'));assert.equal(c.snapshot().state,'working');
});
test('late returns or permissions cannot revive ended turns or overwrite a newer round',()=>{
 const a=new Activity();a.accept(tool('PreToolUse'));a.accept(event('Stop'));
 assert.equal(a.accept(tool('PostToolUse')),null);assert.equal(a.accept(tool('PermissionRequest')),null);
 a.accept(event('UserPromptSubmit','chat-1','turn-2'));
 assert.equal(a.accept(tool('PostToolUse')),null);assert.equal(a.accept(tool('PermissionRequest')),null);
 assert.equal(a.snapshot().state,'thinking');
});
test('tool identifiers cross the bridge but tool input, responses and invalid identifiers do not',()=>{
 const input={...tool('PostToolUse'),tool_input:{password:'secret'},tool_response:{secret:'secret'}};
 assert.deepEqual(sanitizeEvent(input),tool('PostToolUse'));
 assert.equal(sanitizeEvent({...input,tool_use_id:'bad/id'}).tool_use_id,undefined);
});
test('late tool signals from an interrupted round cannot reopen its permission state',()=>{
 const a=new Activity();a.accept(tool('PreToolUse'));a.accept(event('Interrupt'));
 a.accept(event('UserPromptSubmit','chat-1','turn-2'));a.accept(event('Stop','chat-1','turn-2'));
 assert.equal(a.accept(tool('PermissionRequest')),null);assert.equal(a.accept(tool('PostToolUse')),null);
 assert.equal(a.snapshot().state,'completed');
});

test('pending tasks retain arrival order through repeated permission events and requeue after resolution',()=>{
 let now=100;const activity=new Activity({clock:()=>now});
 activity.accept(event('PermissionRequest','first'));
 now=200;activity.accept(event('PermissionRequest','second'));
 now=300;activity.accept(event('PermissionRequest','first'));
 let queue=activity.snapshot().sessions.filter(item=>item.state==='approval').sort((a,b)=>a.approvalSince-b.approvalSince);
 assert.deepEqual(queue.map(item=>item.session_id),['first','second']);
 assert.equal(queue[0].approvalSince,100);
 now=400;activity.accept(event('PreToolUse','first'));
 now=500;activity.accept(event('PermissionRequest','first'));
 queue=activity.snapshot().sessions.filter(item=>item.state==='approval').sort((a,b)=>a.approvalSince-b.approvalSince);
 assert.deepEqual(queue.map(item=>item.session_id),['second','first']);
});
