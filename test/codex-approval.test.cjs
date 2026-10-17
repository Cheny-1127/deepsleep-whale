const test=require('node:test');
const assert=require('node:assert/strict');
const {Activity}=require('../src/domain/activity.cjs');
const session='01a1446b-7009-7db3-99bf-cf55383f6913',turn='turn-one';
const hook=(name,id=session,round=turn)=>({hook_event_name:name,session_id:id,turn_id:round,tool_name:'Bash',tool_use_id:'command-1'});
const runtime=(waiting,extra={})=>({sessionId:session,turnId:turn,waiting,active:true,requests:waiting?[{id:'request-1',itemId:'command-1'}]:[],...extra});
test('an answered approval leaves pending while its long command is still running',()=>{
 const a=new Activity();a.accept(hook('PreToolUse'));a.accept(hook('PermissionRequest'));
 assert.equal(a.snapshot().pending,1);
 a.syncCodexApproval(runtime(true));
 assert.equal(a.syncCodexApproval(runtime(false)),true);
 assert.equal(a.snapshot().pending,0);assert.equal(a.snapshot().working,1);
 assert.equal(a.snapshot().unread,0);assert.equal(a.snapshot().count,2,'runtime sync never counts as a Hook or completion');
 a.accept(hook('PostToolUse'));assert.equal(a.snapshot().pending,0);
});
test('one answered chat cannot clear another chat or remaining approval requests',()=>{
 const a=new Activity();a.accept(hook('PermissionRequest'));a.accept(hook('PermissionRequest','other'));
 a.syncCodexApproval(runtime(true));a.syncCodexApproval(runtime(true));
 assert.equal(a.snapshot().pending,2);
 a.syncCodexApproval(runtime(false));assert.equal(a.snapshot().pending,1);
 assert.equal(a.snapshot().sessions.find(s=>s.session_id==='other').state,'approval');
});
test('unobserved, unknown-turn, old-turn and disconnected runtime cannot guess an approval decision',()=>{
 const a=new Activity();a.accept(hook('PermissionRequest'));
 assert.equal(a.syncCodexApproval(runtime(false)),false);
 a.syncCodexApproval(runtime(true,{turnId:'old'}));a.syncCodexApproval(runtime(false));
 assert.equal(a.snapshot().pending,1);
 a.syncCodexApproval(runtime(true));a.resetCodexApprovalObservations();
 a.syncCodexApproval(runtime(false));assert.equal(a.snapshot().pending,1);
 a.syncCodexApproval(runtime(true));a.accept(hook('UserPromptSubmit',session,'turn-two'));a.accept(hook('PermissionRequest',session,'turn-two'));
 a.syncCodexApproval(runtime(false));assert.equal(a.snapshot().pending,1);
 assert.equal(a.syncCodexApproval(runtime(false,{turnId:'unknown'})),false);
});
test('runtime waiting may arrive before its Hook, but stale resolved state cannot clear a new request',()=>{
 const a=new Activity();a.accept(hook('PreToolUse'));a.syncCodexApproval(runtime(true));
 a.accept(hook('PermissionRequest'));a.syncCodexApproval(runtime(false));assert.equal(a.snapshot().pending,0);
 a.accept({...hook('PermissionRequest'),tool_use_id:'command-2'});
 a.syncCodexApproval(runtime(false));assert.equal(a.snapshot().pending,1);
});
test('idle after rejection clears pending without manufacturing a completion; offline and Cursor stay untouched',()=>{
 const a=new Activity();a.accept(hook('PermissionRequest'));a.syncCodexApproval(runtime(true));
 a.syncCodexApproval(runtime(false,{active:false}));assert.equal(a.snapshot().pending,0);
 assert.equal(a.snapshot().working,0);assert.equal(a.snapshot().unread,0);
 a.accept(hook('Stop'));assert.equal(a.snapshot().unread,1,'only actual Stop creates completion');
 const cursor='cursor:'+session;
 a.accept({...hook('PermissionRequest',cursor),source:'cursor'});
 a.syncCodexApproval(runtime(true,{sessionId:cursor}));a.syncCodexApproval(runtime(false,{sessionId:cursor}));
 assert.equal(a.snapshot().pending,1);
});
test('an old request resolving must not clear a newer permission Hook in the same round',()=>{
 const a=new Activity();a.accept(hook('PreToolUse'));a.accept(hook('PermissionRequest'));
 a.syncCodexApproval({...runtime(true),requests:[{id:'request-1',itemId:'command-1'}]});
 a.accept({...hook('PreToolUse'),tool_use_id:'command-2'});
 a.accept({...hook('PermissionRequest'),tool_use_id:'command-2'});
 a.syncCodexApproval({...runtime(false),active:false,requests:[]});
 assert.equal(a.snapshot().pending,1,'new request must remain pending before its own runtime request is observed');
 a.syncCodexApproval({...runtime(true),requests:[{id:'request-2',itemId:'command-2'}]});
 a.syncCodexApproval({...runtime(false),requests:[]});assert.equal(a.snapshot().pending,0);
});
test('permissions without a call ID bind a new runtime request without confusing an older same-name call',()=>{
 const a=new Activity();a.accept(hook('PreToolUse'));
 a.accept({...hook('PermissionRequest'),tool_use_id:undefined});a.syncCodexApproval(runtime(true));
 a.accept({...hook('PreToolUse'),tool_use_id:'command-2'});
 a.accept({...hook('PermissionRequest'),tool_use_id:undefined});
 a.syncCodexApproval(runtime(false));assert.equal(a.snapshot().pending,1);
 a.syncCodexApproval(runtime(true,{requests:[{id:'request-2',itemId:'command-2'}]}));
 a.syncCodexApproval(runtime(false));assert.equal(a.snapshot().pending,0);
 assert.equal(a.snapshot().working,1);
});
