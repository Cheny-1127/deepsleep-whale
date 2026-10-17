'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {detectClients,readClientPresence}=require('../src/clients/presence.cjs');
const {Activity}=require('../src/domain/activity.cjs');
const event=(name,id,source='codex')=>({hook_event_name:name,session_id:source==='cursor'?`cursor:${id}`:id,source,turn_id:'turn-1'});

test('presence matches only desktop main executables, including the ChatGPT Codex host',()=>{
  const helpers='/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper\n/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex\n/usr/local/bin/codex\n';
  assert.deepEqual(detectClients(helpers),{codex:false,cursor:false});
  assert.deepEqual(detectClients(helpers+'/Applications/Cursor.app/Contents/MacOS/Cursor\n/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),{codex:true,cursor:true});
  assert.deepEqual(detectClients('/Users/test/My Apps/Codex.app/Contents/MacOS/Codex'),{codex:true,cursor:false});
});
test('process query failure remains unknown instead of reporting both clients closed',async()=>{
  assert.equal(await readClientPresence({listProcesses:()=>Promise.reject(new Error('permission denied'))}),null);
  assert.deepEqual(await readClientPresence({listProcesses:()=>''}),{codex:false,cursor:false});
});
test('closing hides only that source while preserving completion IDs, order and dedup across restart',()=>{
  let now=1;const activity=new Activity({clock:()=>now++});
  activity.accept(event('Stop','codex-a'));
  activity.accept(event('Stop','cursor-a','cursor'));
  activity.accept(event('Stop','codex-b'));
  activity.accept(event('UserPromptSubmit','cursor-live','cursor'));
  activity.accept(event('PermissionRequest','codex-live'));
  const saved=structuredClone(activity.exportState());
  activity.setSourceRunning('cursor',false);
  assert.equal(activity.snapshot().unread,2);assert.equal(activity.snapshot().working,0);assert.equal(activity.snapshot().pending,1);
  assert.deepEqual(activity.exportState(),saved);
  assert.equal(activity.accept(event('PermissionRequest','cursor-live','cursor')),null);
  activity.setSourceRunning('cursor',true);
  assert.equal(activity.snapshot().unread,3);assert.equal(activity.snapshot().working,0);
  assert.deepEqual(activity.snapshot().notices.map(item=>item.id),saved.notices.map(item=>item.id));
  assert.equal(activity.accept(event('Stop','cursor-a','cursor')),null);
  const restarted=new Activity({saved:activity.exportState(),sourceRunning:{codex:true,cursor:false}});
  assert.equal(restarted.snapshot().unread,2);
  assert.equal(restarted.exportState().notices.length,3);
  restarted.setSourceRunning('cursor',true);
  assert.equal(restarted.snapshot().unread,3);assert.equal(restarted.snapshot().pending,0);assert.equal(restarted.snapshot().working,0);
});
test('offline native read state and metadata cannot consume hidden reminders; late Stop stays hidden',()=>{
  const activity=new Activity({clock:()=>100});
  activity.accept(event('Stop','codex-a'));
  activity.setSourceRunning('codex',false);
  activity.resolveChat=()=>({kind:'missing'});
  activity.reconcile({updatedAt:10000,unreadIds:new Set()},10000);
  assert.equal(activity.exportState().notices.length,1);assert.equal(activity.snapshot().unread,0);
  activity.resolveChat=()=>({kind:'chat'});
  assert.ok(activity.accept(event('Stop','codex-late')));
  assert.equal(activity.snapshot().unread,0);assert.equal(activity.snapshot().sessions.length,0);
  activity.setSourceRunning('codex',true);
  assert.equal(activity.snapshot().unread,2);assert.equal(activity.snapshot().working,0);assert.equal(activity.snapshot().state,'idle');
});
