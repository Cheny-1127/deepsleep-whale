const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createTitleReader,chatUrl}=require('../src/clients/chat-metadata.cjs');
const id='01a140a5-e74b-7193-9471-31cd59c28b2a';
test('only canonical thread UUIDs can create a local chat deep link',()=>{
  assert.equal(chatUrl(id),`codex://threads/${id}`);
  for(const value of ['https://example.com',`${id}?prompt=send`,'../config','new',null])assert.equal(chatUrl(value),null);
});
test('title lookup is read only, handles unknown chats and missing storage',t=>{
  const dir=fs.mkdtempSync('/tmp/whale-titles-');t.after(()=>fs.rmSync(dir,{recursive:true}));
  const file=path.join(dir,'state_5.sqlite');
  const db=new DatabaseSync(file);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?)').run(id,'修复登录问题');db.close();
  const before=fs.readFileSync(file);
  const reader=createTitleReader(dir);t.after(()=>reader.close());
  assert.equal(reader.title(id),'修复登录问题');
  assert.equal(reader.title('01a140a5-e74b-7193-9471-31cd59c28b2b'),null);
  assert.equal(reader.title('unknown'),null);
  assert.deepEqual(fs.readFileSync(file),before);
  const missing=createTitleReader(path.join(dir,'missing'));
  assert.equal(missing.title(id),null);
  assert.equal(fs.existsSync(path.join(dir,'missing')),false);
});
test('sidebar name wins over raw prompt and registered subagents are excluded',t=>{
 const dir=fs.mkdtempSync('/tmp/whale-names-');t.after(()=>fs.rmSync(dir,{recursive:true}));
 const db=new DatabaseSync(path.join(dir,'state_5.sqlite'));
 db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,thread_source TEXT)');
 db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(id,'raw prompt','侧栏名称','user');
 const child='01a140a5-e74b-7193-9471-31cd59c28b2b';
 db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(child,'child','临时代理','subagent');db.close();
 const reader=createTitleReader(dir);t.after(()=>reader.close());
 assert.equal(reader.title(id),'侧栏名称');assert.equal(reader.lookup(child).kind,'other');
 assert.equal(reader.lookup('01a140a5-e74b-7193-9471-31cd59c28b2c').kind,'missing');
});
test('reads local persisted unread IDs and safely handles missing or malformed desktop state',t=>{
 const dir=fs.mkdtempSync('/tmp/whale-read-');t.after(()=>fs.rmSync(dir,{recursive:true}));
 const reader=createTitleReader(dir);t.after(()=>reader.close());
 assert.equal(reader.readState(),null);
 const file=path.join(dir,'.codex-global-state.json');
 const write=value=>fs.writeFileSync(file,JSON.stringify({'electron-thread-read-state-v1':value}));
 write({version:1,unreadByIdentity:{identity:{'local:host':[id],'ssh:host':['remote']}}});
 const snapshot=reader.readState();assert.deepEqual([...snapshot.unreadIds],[id]);assert.ok(snapshot.updatedAt>0);
 assert.equal(reader.readState(),snapshot);
 write({version:2,unreadByIdentity:{}});assert.equal(reader.readState(),null);
 fs.writeFileSync(file,'{');assert.equal(reader.readState(),null);
});
test('Cursor uses only sidebar name, observes renames and preserves read-only storage',t=>{
 const {createCursorTitleReader}=require('../src/clients/chat-metadata.cjs');
 const {Activity}=require('../src/domain/activity.cjs');
 const dir=fs.mkdtempSync('/tmp/whale-cursor-titles-');t.after(()=>fs.rmSync(dir,{recursive:true}));
 const file=path.join(dir,'state.vscdb'),db=new DatabaseSync(file);t.after(()=>db.close());
 db.exec('CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,value TEXT)');
 db.prepare('INSERT INTO composerHeaders VALUES (?,?)').run(id,JSON.stringify({name:'你好测试',prompt:'private-content'}));
 const before=fs.readFileSync(file);
 const reader=createCursorTitleReader(file);t.after(()=>reader.close());
 assert.equal(reader.lookup('cursor:'+id).title,'你好测试');
 assert.deepEqual(fs.readFileSync(file),before);
 assert.equal(reader.lookup(id).kind,'unavailable');
 const activity=new Activity({resolveChat:reader.lookup});
 activity.accept({source:'cursor',hook_event_name:'Stop',session_id:'cursor:'+id,turn_id:'one'});
 assert.equal(activity.snapshot().notices[0].title,'Cursor · 你好测试');
 assert.equal(JSON.stringify(activity.exportState()).includes('private-content'),false);
 db.prepare('UPDATE composerHeaders SET value=? WHERE composerId=?').run(JSON.stringify({name:'新标题'}),id);
 activity.reconcile(null);
 assert.equal(activity.snapshot().notices[0].title,'Cursor · 新标题');
 const missing=createCursorTitleReader(path.join(dir,'missing'));t.after(()=>missing.close());
 assert.equal(missing.lookup('cursor:'+id).kind,'unavailable');assert.equal(fs.existsSync(path.join(dir,'missing')),false);
 const fallback=new Activity({resolveChat:missing.lookup});
 fallback.accept({source:'cursor',hook_event_name:'Stop',session_id:'cursor:'+id,turn_id:'one'});
 assert.equal(fallback.snapshot().notices[0].title,'Cursor · '+id.slice(-8));
});

function cursorFixture(t,{legacy=false}={}) {
 const {createCursorTitleReader}=require('../src/clients/chat-metadata.cjs');
 const {Activity}=require('../src/domain/activity.cjs');
 const dir=fs.mkdtempSync('/tmp/whale-cursor-subagents-');t.after(()=>fs.rmSync(dir,{recursive:true}));
 const file=path.join(dir,'state.vscdb'),db=new DatabaseSync(file);
 db.exec(`CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,${legacy?'':'isSubagent INTEGER,'}value TEXT)`);
 const reader=createCursorTitleReader(file);t.after(()=>{reader.close();db.close();});
 return {reader,activity:new Activity({resolveChat:reader.lookup}),
  write(chat,data,subagent=0) {
   db.prepare(`INSERT OR REPLACE INTO composerHeaders VALUES (${legacy?'?,?':'?,?,?'})`).run(...(legacy?[chat,JSON.stringify(data)]:[chat,subagent,JSON.stringify(data)]));
  }};
}
const children=['01a140a5-e74b-7193-9471-31cd59c28b2b','01a140a5-e74b-7193-9471-31cd59c28b2c'];
const cursorEvent=(name,chat,turn='one')=>({source:'cursor',hook_event_name:name,session_id:'cursor:'+chat,turn_id:turn});

test('Cursor subagents are identified by header flag even before a sidebar name is available',t=>{
 const f=cursorFixture(t);
 f.write(id,{name:'审查主聊天'});
 f.write(children[0],{},1);
 assert.equal(f.reader.lookup('cursor:'+id).kind,'chat','review wording alone must not exclude a main chat');
 assert.equal(f.reader.lookup('cursor:'+children[0]).kind,'other');
});

test('Cursor subagents remain identifiable from parent metadata with a legacy header schema',t=>{
 const f=cursorFixture(t,{legacy:true});
 f.write(id,{name:'主聊天'});
 f.write(children[0],{name:'审查子任务',subagentInfo:{parentComposerId:id}});
 assert.equal(f.reader.lookup('cursor:'+id).kind,'chat');
 assert.equal(f.reader.lookup('cursor:'+children[0]).kind,'other');
});

test('Cursor subagent hooks create neither active tasks nor completion notices while main chats work normally',t=>{
 const f=cursorFixture(t);
 f.write(id,{name:'主聊天'});f.write(children[0],{name:'审查子任务'},1);
 for(const name of ['UserPromptSubmit','PostToolUse','Stop'])assert.equal(f.activity.accept(cursorEvent(name,children[0])),null);
 assert.equal(f.activity.snapshot().count,0);assert.equal(f.activity.snapshot().working,0);assert.equal(f.activity.snapshot().unread,0);
 assert.ok(f.activity.accept(cursorEvent('UserPromptSubmit',id)));assert.equal(f.activity.snapshot().working,1);
 assert.ok(f.activity.accept(cursorEvent('Stop',id)));assert.equal(f.activity.snapshot().working,0);
 assert.equal(f.activity.snapshot().notices[0].title,'Cursor · 主聊天');
});

test('late Cursor subagent metadata removes orphan activity after its parent finishes without needing a stop hook',t=>{
 const f=cursorFixture(t);
 f.write(id,{name:'主聊天'});
 f.activity.accept(cursorEvent('UserPromptSubmit',id));
 for(const child of children)f.activity.accept(cursorEvent('PostToolUse',child));
 f.activity.accept(cursorEvent('Stop',id));
 f.activity.accept(cursorEvent('PostToolUse',children[0]));
 assert.equal(f.activity.snapshot().working,2);
 const before=f.activity.snapshot();
 for(const child of children)f.write(child,{name:'审查子任务',subagentInfo:{parentComposerId:id}},1);
 assert.equal(f.activity.reconcile(null),true,'metadata-only cleanup must trigger a new broadcast');
 const after=f.activity.snapshot();
 assert.equal(after.working,0);assert.equal(after.state,'completed');
 assert.deepEqual(after.sessions.map(item=>item.session_id),['cursor:'+id]);
 assert.deepEqual(after.notices,before.notices);assert.equal(after.count,before.count);
 assert.equal(f.activity.reconcile(null),false,'unchanged metadata must not repeatedly trigger cleanup');
});

test('Cursor subagent reconciliation preserves unknown regular chats and Codex activity and removes old child notices',t=>{
 const f=cursorFixture(t),unknown='01a140a5-e74b-7193-9471-31cd59c28b2d';
 f.activity.accept(cursorEvent('Stop',children[0]));
 const saved=JSON.parse(JSON.stringify(f.activity.exportState()));
 f.write(children[0],{name:'审查子任务'},1);
 assert.equal(f.activity.reconcile(null),true);assert.equal(f.activity.snapshot().unread,0);
 const {Activity}=require('../src/domain/activity.cjs');
 const restored=new Activity({saved,resolveChat:f.reader.lookup});assert.equal(restored.snapshot().unread,0);
 f.activity.accept(cursorEvent('UserPromptSubmit',unknown));
 f.activity.accept({hook_event_name:'UserPromptSubmit',session_id:id,turn_id:'one'});
 assert.equal(f.activity.reconcile(null),false);
 assert.equal(f.activity.snapshot().working,2,'unavailable metadata is not proof of a subagent');
});
