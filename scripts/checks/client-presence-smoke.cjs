'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname, '../..');
const cursorSubagentsOnly=process.env.WHALE_CURSOR_SUBAGENTS_ONLY==='1';
const dir=fs.mkdtempSync('/tmp/whale-presence-');
const home=path.join(dir,'codex');fs.mkdirSync(home);
const cursorHome=path.join(dir,'cursor');fs.mkdirSync(cursorHome);
const processFile=path.join(dir,'processes.txt');
const cursorMain='/Applications/Cursor.app/Contents/MacOS/Cursor';
const codexMain='/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const helpers='/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper';
function clients(codex,cursor) {fs.writeFileSync(processFile+'.tmp',[helpers,codex&&codexMain,cursor&&cursorMain].filter(Boolean).join('\n'));fs.renameSync(processFile+'.tmp',processFile);}
clients(true,true);
const ids=Array.from({length:5},(_,i)=>`11111111-1111-4111-8111-11111111111${i}`);
const db=new DatabaseSync(path.join(home,'state_5.sqlite'));
db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,thread_source TEXT)');
for(const [i,id]of ids.entries())db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(id,'test','测试任务 '+i,'user');db.close();
const cursorState=path.join(cursorHome,'state.vscdb');const cursorDb=new DatabaseSync(cursorState);
cursorDb.exec('CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,value TEXT)');
for(const id of ids)cursorDb.prepare('INSERT INTO composerHeaders VALUES (?,?)').run(id,JSON.stringify({name:'Cursor 测试任务'}));cursorDb.close();
const notices=[
 {hook_event_name:'Stop',session_id:ids[0],id:'codex-a',time:100,title:'Codex A',turn_id:'old'},
 {hook_event_name:'Stop',source:'cursor',session_id:'cursor:'+ids[1],id:'cursor-a',time:200,title:'Cursor A',turn_id:'old'},
 {hook_event_name:'Stop',session_id:ids[2],id:'codex-b',time:300,title:'Codex B',turn_id:'old'}
];
fs.writeFileSync(path.join(dir,'reminders.json'),JSON.stringify({version:1,notices,seen:[]}));
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({sources:{codex:true,cursor:true},notifications:true}));
if(cursorSubagentsOnly)fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(require('../../src/app/module-settings.cjs').MODULE_IDS.map(id=>[id,id==='hooks']))));
fs.writeFileSync(path.join(cursorHome,'hooks.json'),JSON.stringify(require('../hooks/cursor-config.cjs').createConfig(process.execPath)));
const hookFixture=Object.entries(require('../hooks/codex-config.cjs').createConfig(process.execPath).hooks).map(([event,groups])=>({eventName:event[0].toLowerCase()+event.slice(1),handlerType:'command',command:groups[0].hooks[0].command,enabled:true,trustStatus:'trusted'}));
const codexBin=path.join(dir,'codex-fixture');
fs.writeFileSync(codexBin,'#!'+process.execPath+'\n'+`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.id===1?{}:m.id===3?{config:{}}:m.id===4?{requirements:null}:{data:[{hooks:${JSON.stringify(hookFixture)},errors:[]}]}})+'\\n');});`,{mode:0o700});
// 仅在这个隔离进程中替换 /bin/ps 的可执行路径清单，不关闭用户的真实客户端。
const bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();const fs=require('node:fs'),cp=require('node:child_process'),original=cp.execFile;cp.execFile=function(file,args,options,callback){if(file==='/bin/ps'&&args.join(' ')==='-axo comm='){setImmediate(()=>{const value=fs.readFileSync(${JSON.stringify(processFile)},'utf8');callback(value==='ERROR'?new Error('simulated query failure'):null,value);});return;}return original.apply(this,arguments);};require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app,panel,pet;const errors=[];
async function launch() {
 app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,CODEX_HOME:home,WHALE_CURSOR_HOME:cursorHome,WHALE_CURSOR_STATE_DB:cursorState,WHALE_CODEX_BIN:codexBin,WHALE_DATA_DIR:dir}});
 app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
 await app.firstWindow();
 for(let i=0;i<100;i++){panel=app.windows().find(p=>p.url().endsWith('/index.html'));pet=app.windows().find(p=>p.url().endsWith('/pet.html'));if(panel&&pet)break;await new Promise(r=>setTimeout(r,100));}
 await wait(async()=>{const s=await window.whale.snapshot();return s.bridge&&s.hookAvailability.codex.state==='checked';});
 await app.evaluate(({shell,Notification,BrowserWindow})=>{global.presenceTrace=[];const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));const send=win.webContents.send.bind(win.webContents);win.webContents.send=(channel,...args)=>{if(channel==='snapshot'){const s=args[0];const value=JSON.stringify({running:s.clientRunning,unread:s.activity.unread,pending:s.activity.pending,working:s.activity.working});if(global.presenceTrace.at(-1)!==value)global.presenceTrace.push(value);}return send(channel,...args);};global.opened=[];global.notified=[];shell.openExternal=async url=>global.opened.push(url);Notification.prototype.show=function(){global.notified.push(this.body);};});
}
const snapshot=()=>panel.evaluate(()=>window.whale.snapshot());
async function wait(predicate) {
 const deadline=Date.now()+15000;
 do {if(await panel.evaluate(predicate))return;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
 throw new Error('状态等待超时：'+JSON.stringify((await snapshot()).activity));
}
async function send(event) {
 await new Promise((resolve,reject)=>{const client=net.createConnection(path.join(dir,'events.sock'),()=>client.write(JSON.stringify(event)+'\n'));client.on('error',reject);client.on('data',()=>{});client.on('close',resolve);});
}
(async()=>{try{
 await launch();
 if(cursorSubagentsOnly) {
  const input=(name,index)=>({source:'cursor',hook_event_name:name,session_id:'cursor:'+ids[index],turn_id:'review'});
  await send(input('UserPromptSubmit',1));
  for(const index of [3,4])await send(input('PostToolUse',index));
  await send(input('Stop',1));
  await wait(async()=>{const s=await window.whale.snapshot();return s.activity.working===2&&s.activity.unread===3;});
  await pet.waitForFunction(()=>document.getElementById('busy-alert').textContent.includes('2'));
  const before=await snapshot(),notified=await app.evaluate(()=>global.notified);
  // 模拟工具 Hook 先到，Cursor 稍后才写入审查子代理的父聊天标识。
  const db=new DatabaseSync(cursorState);
  try {
   for(const index of [3,4])db.prepare('UPDATE composerHeaders SET value=? WHERE composerId=?').run(JSON.stringify({name:'审查子任务',subagentInfo:{parentComposerId:ids[1]}}),ids[index]);
  } finally {db.close();}
  await wait(async()=>{const s=await window.whale.snapshot();return s.activity.working===0&&s.state==='idle';});
  await pet.waitForFunction(()=>document.getElementById('busy-alert').hidden);
  const cleaned=await snapshot();
  assert.ok(cleaned.activity.sessions.every(item=>![3,4].some(index=>item.session_id==='cursor:'+ids[index])));
  assert.deepEqual(cleaned.activity.notices,before.activity.notices);
  assert.equal(cleaned.activity.count,before.activity.count);
  assert.equal(cleaned.nurture.totalWorkSessions,before.nurture.totalWorkSessions);
  assert.deepEqual(await app.evaluate(()=>global.notified),notified);
  // 已确认子代理的迟到工具或完成事件也不能重新计数、提醒或累计成长。
  await send(input('PostToolUse',3));await send(input('Stop',4));
  await send({...input('UserPromptSubmit',1),turn_id:'normal'});
  await wait(async()=>(await window.whale.snapshot()).activity.working===1);
  const regular=await snapshot();
  assert.equal(regular.activity.count,cleaned.activity.count+1);
  assert.equal(regular.activity.sessions.filter(item=>['working','thinking'].includes(item.state))[0].session_id,'cursor:'+ids[1]);
  assert.equal(regular.nurture.totalWorkSessions,cleaned.nurture.totalWorkSessions);
  assert.deepEqual(await app.evaluate(()=>global.notified),notified);
  assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[]);
  console.log('PASS: Cursor review subagents removed without stop hooks, busy bubble and animation cleared, late hooks ignored, ordinary chat retained, no completion/notification/growth replay');
  return;
 }
 assert.equal((await snapshot()).activity.unread,3);
 const saved=fs.readFileSync(path.join(dir,'reminders.json'),'utf8');
 await send({hook_event_name:'PermissionRequest',session_id:ids[3],turn_id:'live'});
 await send({hook_event_name:'UserPromptSubmit',source:'cursor',raw_event:'beforeSubmitPrompt',session_id:'cursor:'+ids[4],turn_id:'live'});
 await wait(async()=>{const s=await window.whale.snapshot();return s.activity.pending===1&&s.activity.working===1;});
 const before=await snapshot();
 const beforeNotifications=await app.evaluate(()=>global.notified);
 // 点击与轮询之间恰好退出：点击必须主动重新检查，不能发出打开客户端的系统链接。
 clients(true,false);
 const failure=await panel.evaluate(async id=>(await window.whale.openChat({sessionId:id,noticeId:'cursor-a'})).error,'cursor:'+ids[1]);
 assert.match(failure,/Cursor 已退出/);
 await wait(async()=>{const s=await window.whale.snapshot();return s.activity.unread===2&&s.activity.working===0;});
 assert.equal((await snapshot()).activity.pending,1);
 assert.deepEqual(await app.evaluate(()=>global.opened),[]);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'reminders.json'),'utf8')).notices.length,3);
 clients(true,true);
 await wait(async()=>{const s=await window.whale.snapshot();return s.clientRunning.cursor&&s.activity.unread===3;});
 const restored=await snapshot();
 assert.equal(restored.activity.working,0);assert.equal(restored.activity.pending,1);
 assert.deepEqual(restored.activity.notices.map(n=>n.id),before.activity.notices.map(n=>n.id),JSON.stringify(await app.evaluate(()=>global.presenceTrace)));
 assert.equal(restored.nurture.totalWorkSessions,before.nurture.totalWorkSessions);
 assert.deepEqual(await app.evaluate(()=>global.notified),beforeNotifications);
 assert.equal(fs.readFileSync(path.join(dir,'reminders.json'),'utf8'),saved);
 // 检测失败保留上次状态；跳转则明确失败，不猜测客户端仍在运行。
 fs.writeFileSync(processFile,'ERROR');
 const unknown=await panel.evaluate(async id=>(await window.whale.openChat({sessionId:id})).error,ids[0]);
 assert.match(unknown,/无法确认/);assert.equal((await snapshot()).activity.unread,3);
 clients(false,true);
 await wait(async()=>{const s=await window.whale.snapshot();return !s.clientRunning.codex&&s.activity.unread===1&&s.activity.pending===0;});
 clients(false,false);
 await wait(async()=>{const s=await window.whale.snapshot();return s.activity.unread===0&&!s.clientRunning.cursor;});
 assert.equal(await pet.locator('#completion-shell').isHidden(),true);
 await app.close();app=null;await launch();
 assert.equal((await snapshot()).activity.unread,0);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'reminders.json'),'utf8')).notices.length,3);
 clients(true,true);
 await wait(async()=>{const s=await window.whale.snapshot();return s.activity.unread===3;});
 assert.equal((await snapshot()).activity.pending,0);assert.equal((await snapshot()).activity.working,0);
 assert.deepEqual(await app.evaluate(()=>global.notified),[]);
 assert.deepEqual(errors,[]);
 assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[]);
 console.log('PASS: per-source hide/restore, preserved disk records/order, no notification or growth replay, no stale live states, closed-client jump blocked, failed query retains state, restart recovery');
}finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
