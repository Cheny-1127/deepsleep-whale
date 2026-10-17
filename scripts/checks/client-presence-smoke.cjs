'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname, '../..');
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
fs.writeFileSync(path.join(cursorHome,'hooks.json'),JSON.stringify(require('../hooks/cursor-config.cjs').createConfig(process.execPath)));
const hookFixture=Object.entries(require('../hooks/codex-config.cjs').createConfig(process.execPath).hooks).map(([event,groups])=>({eventName:event[0].toLowerCase()+event.slice(1),handlerType:'command',command:groups[0].hooks[0].command,enabled:true,trustStatus:'trusted'}));
const codexBin=path.join(dir,'codex-fixture');
fs.writeFileSync(codexBin,'#!'+process.execPath+'\n'+`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.id===1?{}:m.id===3?{config:{}}:m.id===4?{requirements:null}:{data:[{hooks:${JSON.stringify(hookFixture)},errors:[]}]}})+'\\n');});`,{mode:0o700});
// 仅在这个隔离进程中替换 /bin/ps 的可执行路径清单，不关闭用户的真实客户端。
const bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`const fs=require('node:fs'),cp=require('node:child_process'),original=cp.execFile;cp.execFile=function(file,args,options,callback){if(file==='/bin/ps'&&args.join(' ')==='-axo comm='){setImmediate(()=>{const value=fs.readFileSync(${JSON.stringify(processFile)},'utf8');callback(value==='ERROR'?new Error('simulated query failure'):null,value);});return;}return original.apply(this,arguments);};require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
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
 assert.equal((await snapshot()).activity.unread,3);
 const saved=fs.readFileSync(path.join(dir,'reminders.json'),'utf8');
 await send({hook_event_name:'PermissionRequest',session_id:ids[3],turn_id:'live'});
 await send({hook_event_name:'UserPromptSubmit',source:'cursor',raw_event:'beforeSubmitPrompt',session_id:'cursor:'+ids[4],turn_id:'live'});
 await wait(async()=>{const s=await window.whale.snapshot();return s.activity.pending===1&&s.activity.working===1;});
 const before=await snapshot();
 const beforeNotifications=await app.evaluate(()=>global.notified);
 // 点击与轮询之间恰好退出：点击必须主动重新检查，不能发出打开客户端的系统链接。
 clients(true,false);
 const failure=await panel.evaluate(async id=>{try{await window.whale.action('open-chat',{sessionId:id,noticeId:'cursor-a'});return null;}catch(error){return error.message;}},'cursor:'+ids[1]);
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
 const unknown=await panel.evaluate(async id=>{try{await window.whale.action('open-chat',{sessionId:id});return null;}catch(error){return error.message;}},ids[0]);
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
 console.log('PASS: per-source hide/restore, preserved disk records/order, no notification or growth replay, no stale live states, closed-client jump blocked, failed query retains state, restart recovery');
}finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
