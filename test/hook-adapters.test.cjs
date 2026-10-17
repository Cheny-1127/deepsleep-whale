'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {adaptCursor,adapterInfo}=require('../src/hooks/adapters.cjs');
const {Activity,sanitizeEvent}=require('../src/domain/activity.cjs');
const {createConfig}=require('../scripts/hooks/cursor-config.cjs');
const input=(name,extra={})=>({hook_event_name:name,conversation_id:'same-chat',generation_id:'turn-1',...extra});
test('Cursor mapping strips content and isolates conversation IDs from Codex',()=>{
 const event=adaptCursor(input('postToolUse',{tool_name:'Shell',tool_use_id:'call-a',tool_input:{secret:'hidden'},tool_output:'hidden',user_email:'hidden',prompt:'hidden',transcript_path:'/private'}));
 assert.deepEqual(sanitizeEvent(event),{source:'cursor',raw_event:'postToolUse',hook_event_name:'PostToolUse',session_id:'cursor:same-chat',turn_id:'turn-1',tool_use_id:'call-a',tool_name:'Shell'});
 assert.equal(sanitizeEvent({...event,source:'other'}),null);
 assert.equal(sanitizeEvent({...event,source:'codex'}),null);
 assert.equal(sanitizeEvent({...event,session_id:'other'}),null);
 assert.equal(adaptCursor(input('not-supported')),null);
 assert.equal(adaptCursor(input('beforeSubmitPrompt',{generation_id:null})),null);
});
test('Cursor completed, cancelled and failed rounds cannot be confused',()=>{
 for(const status of ['aborted','error'])assert.equal(adaptCursor(input('stop',{status})).hook_event_name,'Interrupt');
 assert.equal(adaptCursor(input('stop',{status:'completed'})).hook_event_name,'Stop');
 assert.equal(adaptCursor(input('stop',{status:'unknown'})),null);
 assert.equal(adaptCursor(input('sessionEnd',{generation_id:undefined})).turn_id,'unknown');
 const activity=new Activity();
 activity.accept(adaptCursor(input('beforeSubmitPrompt')));
 activity.accept(adaptCursor(input('stop',{status:'error'})));
 assert.equal(activity.snapshot().unread,0);
 assert.equal(activity.snapshot().working,0);
});
test('pausing only removes that source activity and native Codex read state preserves Cursor reminders',()=>{
 const activity=new Activity({clock:()=>10000});
 const codex=(name,id)=>({hook_event_name:name,session_id:id,turn_id:'turn-1'});
 activity.accept(codex('Stop','same-chat'));
 activity.accept(adaptCursor(input('stop',{status:'completed'})));
 activity.accept(codex('UserPromptSubmit','active-codex'));
 activity.accept(adaptCursor(input('beforeSubmitPrompt',{conversation_id:'active-cursor'})));
 assert.equal(activity.snapshot().unread,2);assert.equal(activity.snapshot().working,2);
 activity.pauseSource('cursor');
 assert.equal(activity.snapshot().working,1);assert.equal(activity.snapshot().unread,2);
 activity.reconcile({updatedAt:20000,unreadIds:new Set()},20000);
 assert.equal(activity.snapshot().unread,1);assert.equal(activity.snapshot().notices[0].source,'cursor');
 const restored=new Activity({saved:activity.exportState(),resolveChat:()=>({kind:'missing'})});
 assert.equal(restored.snapshot().unread,1);assert.equal(restored.snapshot().working,0);
 assert.equal(restored.accept(adaptCursor(input('stop',{status:'completed'}))),null,'dedup survives restart');
});
test('configuration previews match registered adapter events and avoid tool permission hooks',()=>{
 const config=createConfig();assert.equal(config.version,1);
 const cursor=adapterInfo().find(source=>source.id==='cursor');
 assert.deepEqual(Object.keys(config.hooks),cursor.mappings.map(item=>item.event));
 assert.equal(config.hooks.preToolUse,undefined);
 assert.equal(config.hooks.beforeShellExecution,undefined);
 assert.match(config.hooks.stop[0].command,/cursor-hook\.cjs/);
});

test('raw Cursor event is allowlisted and must agree with its normalized event',()=>{
 const event=adaptCursor(input('postToolUseFailure'));
 assert.equal(sanitizeEvent(event).raw_event,'postToolUseFailure');
 assert.equal(sanitizeEvent({...event,raw_event:'stop'}),null);
 assert.equal(sanitizeEvent({...event,raw_event:'private-content'}),null);
 assert.equal(sanitizeEvent(adaptCursor(input('stop',{status:'error'}))).raw_event,'stop');
});

test('filtered lifecycle cleanup preserves other chats and newer turns without creating completion',()=>{
 const activity=new Activity();
 activity.accept(adaptCursor(input('beforeSubmitPrompt',{generation_id:'new'})));
 activity.accept({hook_event_name:'UserPromptSubmit',session_id:'codex-active',turn_id:'one'});
 activity.pauseSession('cursor:same-chat','old');
 assert.equal(activity.snapshot().working,2);
 activity.pauseSession('cursor:same-chat','new');
 assert.equal(activity.snapshot().working,1);
 assert.equal(activity.snapshot().unread,0);
 assert.equal(activity.snapshot().count,2,'cleanup does not record another event');
});
