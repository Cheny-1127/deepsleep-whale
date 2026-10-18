'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname, '../..');
const dir=fs.mkdtempSync('/tmp/whale-sources-');
const codexHome=path.join(dir,'codex');fs.mkdirSync(codexHome);
const ids=['01a140a5-e74b-7193-9471-31cd59c28b2a','01a140a5-e74b-7193-9471-31cd59c28b2b','01a140a5-e74b-7193-9471-31cd59c28b2c'];
const db=new DatabaseSync(path.join(codexHome,'state_5.sqlite'));
db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,thread_source TEXT)');
for(const [i,id] of ids.entries())db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(id,'Codex '+i,'Codex '+i,'user');db.close();
const cursorHome=path.join(dir,'cursor');fs.mkdirSync(cursorHome);

const cursorState=path.join(cursorHome,'state.vscdb');
const cursorDb=new DatabaseSync(cursorState);cursorDb.exec('CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,value TEXT); CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)');
for(const [index,id] of ids.entries())cursorDb.prepare('INSERT INTO composerHeaders VALUES (?,?)').run(id,JSON.stringify({name:`Cursor 测试聊天 ${index}`}));cursorDb.close();
const hookFixture=path.join(dir,'hooks-result.json');
const fixtureHooks=Object.entries(require('../hooks/codex-config.cjs').createConfig(process.execPath).hooks).map(([event,groups])=>({eventName:event[0].toLowerCase()+event.slice(1),handlerType:'command',command:groups[0].hooks[0].command,enabled:true,trustStatus:'trusted'}));
fs.writeFileSync(hookFixture,JSON.stringify({data:[{hooks:fixtureHooks,errors:[],warnings:[]}]}));
const codexBinary=path.join(dir,'codex-fixture');
fs.writeFileSync(codexBinary,'#!'+process.execPath+'\n'+`const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id)process.stdout.write(JSON.stringify({id:message.id,result:message.id===1?{}:message.id===3?{config:{}}:message.id===4?{requirements:null}:JSON.parse(fs.readFileSync(${JSON.stringify(hookFixture)},'utf8'))})+'\\n');});`,{mode:0o700});
let app,panel,pet;
const errors=[];
async function launch() {
 app=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,CODEX_HOME:codexHome,WHALE_CURSOR_HOME:cursorHome,WHALE_CURSOR_STATE_DB:cursorState,WHALE_CODEX_BIN:codexBinary,WHALE_DATA_DIR:dir}});
 app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
 await app.firstWindow();
 for(let i=0;i<100;i++) {
  panel=app.windows().find(page=>page.url().endsWith('/index.html'));pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
  if(panel&&pet)break;await new Promise(resolve=>setTimeout(resolve,100));
 }
 await panel.waitForFunction(()=>document.querySelector('#connection-status').textContent!=='等待连接');
 await wait(async()=>{const data=await window.whale.snapshot();return ['codex','cursor'].every(source=>data.hookAvailability[source].state==='checked');});
 await app.evaluate(({shell,Notification,clipboard},cursorState)=>{global.opened=[];global.testNotices=[];global.copiedConfigs=[];clipboard.writeText=text=>global.copiedConfigs.push(text);shell.openExternal=async url=>{global.opened.push(url);if(url.startsWith('cursor:')){const db=new (process.getBuiltinModule('node:sqlite').DatabaseSync)(cursorState);try{db.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?,?)').run('cursor/glass.selectedAgent',new URL(url).searchParams.get('id'));}finally{db.close();}}};Notification.prototype.show=function(){global.testNotices.push({title:this.title,body:this.body});};},cursorState);
}
async function send(source,name,index=0,turn='turn-1',extra={}) {
 const received=(await panel.evaluate(()=>window.whale.snapshot())).sourceStatus[source].lastReceivedAt;
 const input=source==='cursor'?{hook_event_name:name,conversation_id:ids[index],generation_id:turn,...extra}:{hook_event_name:name,session_id:ids[index],turn_id:turn,...extra};
 const result=spawnSync(process.execPath,[path.join(root,`scripts/${source}-hook.cjs`)],{env:{...process.env,WHALE_DATA_DIR:dir},input:JSON.stringify(input),encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(result.stdout,source==='cursor'&&name==='beforeSubmitPrompt'?'{"continue":true}\n':'{}\n');
 const deadline=Date.now()+10000;
 while((await panel.evaluate(()=>window.whale.snapshot())).sourceStatus[source].lastReceivedAt===received) {
  if(Date.now()>deadline)throw new Error('Hook 接收等待超时：'+source+' / '+name);
  await new Promise(resolve=>setTimeout(resolve,50));
 }
}
async function wait(predicate) {
 const deadline=Date.now()+15000;
 while(!await panel.evaluate(predicate)) {
  if(Date.now()>deadline)throw new Error('页面状态等待超时：'+JSON.stringify(await panel.evaluate(async()=>({state:await window.whale.snapshot(),speech:document.querySelector('#speech').textContent})))+' / '+JSON.stringify(await app.evaluate(()=>global.opened)));
  await new Promise(resolve=>setTimeout(resolve,100));
 }
}
const snapshot=async()=>{await panel.waitForFunction(()=>!document.querySelector('[data-saving="true"]'));return panel.evaluate(()=>window.whale.snapshot());};
async function refreshCodex() {
 await panel.locator('#refresh-hooks-codex').click();
 await snapshot();
}

(async()=>{
 await launch();
 await panel.locator('#nav-hooks').click();
 assert.equal(await panel.locator('#source-enabled-cursor').isChecked(),false,'no configuration starts with Cursor off');
 assert.equal(fs.existsSync(path.join(cursorHome,'hooks.json')),false,'startup does not create configuration');
 await app.close();app=null;
 fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({sources:{codex:true,cursor:true}}));
 await launch();await panel.locator('#nav-hooks').click();
 assert.equal(await panel.locator('#source-enabled-cursor').isChecked(),false,'old enabled preference cannot override missing configuration');
 assert.equal(fs.existsSync(path.join(cursorHome,'hooks.json')),false);
 await panel.locator('#source-enabled-cursor').check();await snapshot();
 assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(cursorHome,'hooks.json'),'utf8')).hooks).length,5);

 assert.equal(await panel.locator('#home-view').isVisible(),false);
 assert.equal(await panel.locator('#hooks-view').isVisible(),true);
 assert.equal(await panel.locator('.hook-source').count(),2);
 const previews=(await snapshot()).hookAdapters;
 for(const adapter of previews) {const config=JSON.parse(adapter.config);const command=adapter.id==='cursor'?config.hooks.stop[0].command:config.hooks.Stop[0].hooks[0].command;assert.equal(command.includes('/Electron'),false,'configuration uses Node, not Electron');}
 for(const source of ['codex','cursor'])assert.equal(await panel.locator(`#source-enabled-${source}`).isChecked(),true);
 assert.equal(await panel.locator('#hook-event-table').isVisible(),true);
 assert.equal(await panel.locator('#hook-event-table tbody tr').count(),7);
 assert.equal(await panel.locator('.event-switch input').count(),12);
 await panel.screenshot({path:path.join(root,'out/hooks-settings.png')});
 await panel.locator('.hook-config-preview summary').last().click();
 await panel.locator('.hook-config-preview button').last().click();
 assert.equal(JSON.parse((await app.evaluate(()=>global.copiedConfigs))[0]).version,1);
 await send('codex','UserPromptSubmit');await send('cursor','beforeSubmitPrompt');
 await wait(async()=>(await window.whale.snapshot()).activity.working===2);
 const mixed=await snapshot();assert.equal(new Set(mixed.activity.sessions.map(item=>item.session_id)).size,2,'same original ID cannot collide across sources');
 // Cursor 留存的选中记录早于任务完成，不能用它证明用户看过新结果。
 const selectedDb=new DatabaseSync(cursorState);selectedDb.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?,?)').run('cursor/glass.selectedAgent',ids[0]);selectedDb.close();
 await send('cursor','stop',0,'turn-1',{status:'completed'});
 await send('cursor','beforeSubmitPrompt',1);
 await wait(async()=>{const data=await window.whale.snapshot();return data.activity.working===2&&data.activity.unread===1;});
 await app.evaluate(async()=>{await new Promise(resolve=>setTimeout(resolve,2200));});
 assert.equal((await snapshot()).activity.unread,1,'a remembered Cursor selection must not consume an unviewed completion during background polling');
 assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'reminders.json'),'utf8')).notices.some(item=>item.session_id==='cursor:'+ids[0]),'the unread completion must remain on disk');
 await panel.locator('#source-enabled-cursor').uncheck();
 let state=await snapshot();assert.equal(state.activity.working,1);assert.equal(state.activity.unread,1);
 const before={activity:state.activity,nurture:state.nurture,notices:await app.evaluate(()=>global.testNotices.length)};
 await send('cursor','beforeSubmitPrompt',2);await send('cursor','stop',2,'turn-1',{status:'completed'});
 state=await snapshot();assert.deepEqual(state.activity,before.activity);assert.deepEqual(state.nurture,before.nurture);
 assert.equal(await app.evaluate(()=>global.testNotices.length),before.notices);
 assert.equal(state.sourceStatus.cursor.ignored,2);assert.equal(state.settings.sources.codex,true);
 await panel.locator('#source-enabled-codex').uncheck();
 assert.equal((await snapshot()).activity.working,0);
 const count=(await snapshot()).activity.count;
 await send('codex','Stop');assert.equal((await snapshot()).activity.count,count);
 const revisionBeforeEnable=(await snapshot()).revision;
 await panel.locator('#source-enabled-cursor').check();
 assert.equal((await snapshot()).revision,revisionBeforeEnable,'enabling never replays completed animation');
 assert.equal((await snapshot()).activity.working,0,'enable does not restore stale activity');
 await send('cursor','beforeSubmitPrompt',1,'turn-2');
 await send('cursor','postToolUse',1,'turn-2',{tool_use_id:'call-a',tool_name:'Shell',tool_input:{secret:'never-forward'},tool_output:'never-forward'});
 await send('cursor','stop',1,'turn-2',{status:'completed'});
 state=await snapshot();assert.equal(state.activity.unread,2);
 assert.equal(state.activity.notices[0].title,'Cursor · Cursor 测试聊天 1');
 const renamedDb=new DatabaseSync(cursorState);renamedDb.prepare('UPDATE composerHeaders SET value=? WHERE composerId=?').run(JSON.stringify({name:'重命名后的 Cursor 聊天'}),ids[1]);renamedDb.close();
 await wait(async()=>(await window.whale.snapshot()).activity.notices[0].title==='Cursor · 重命名后的 Cursor 聊天');
 assert.equal(state.nurture.totalWorkSessions,before.nurture.totalWorkSessions+1);

 // 授权变化只影响对应事件，不覆盖接收偏好；其他插件同名事件无效。
 await panel.locator('#source-enabled-codex').check();await snapshot();
 fixtureHooks.find(hook=>hook.eventName==='preToolUse').trustStatus='untrusted';
 fixtureHooks.find(hook=>hook.eventName==='permissionRequest').enabled=false;
 fixtureHooks.find(hook=>hook.eventName==='postToolUse').command='other-plugin';
 fs.writeFileSync(hookFixture,JSON.stringify({data:[{hooks:fixtureHooks,errors:[]}]}));
 await refreshCodex();
 await wait(async()=>(await window.whale.snapshot()).hookAvailability.codex.state==='checked'&&document.querySelector('#event-enabled-codex-PreToolUse').disabled);
 assert.equal(await panel.locator('#event-enabled-codex-PermissionRequest').isDisabled(),true);
 assert.equal(await panel.locator('#event-enabled-codex-PostToolUse').isDisabled(),true);
 assert.equal(await panel.locator('#event-enabled-codex-Stop').isDisabled(),false);
 assert.equal((await snapshot()).settings.events?.codex?.PreToolUse!==false,true,'availability does not erase preferences');
 const beforeBlocked=await snapshot();
 await send('codex','PreToolUse',2,'blocked',{tool_use_id:'blocked'});
 assert.deepEqual((await snapshot()).activity,beforeBlocked.activity);
 await panel.locator('#source-enabled-codex').uncheck();
 // 检测失败明确显示未知并置灰，恢复后能再次检测。
 fs.writeFileSync(hookFixture,JSON.stringify({data:[{hooks:[],errors:['fixture failure']}]}));
 await refreshCodex();
 await wait(async()=>(await window.whale.snapshot()).hookAvailability.codex.state==='unknown');
 assert.equal(await panel.locator('#event-enabled-codex-Stop').isChecked(),false);
 fs.writeFileSync(hookFixture,JSON.stringify({data:[{hooks:fixtureHooks,errors:[]}]}));
 await refreshCodex();
 await wait(async()=>(await window.whale.snapshot()).hookAvailability.codex.state==='checked');
 // 总开关不改已有 Cursor 文件；首次开启缺失文件则生成全部五项。
 const cursorFile=path.join(cursorHome,'hooks.json');
 await panel.locator('#source-enabled-cursor').uncheck();await snapshot();
 fs.unlinkSync(cursorFile);
 await panel.locator('#source-enabled-cursor').check();await snapshot();
 assert.equal(Object.keys(JSON.parse(fs.readFileSync(cursorFile,'utf8')).hooks).length,5);
 const existingConfig=JSON.parse(fs.readFileSync(cursorFile,'utf8'));
 existingConfig.custom='keep';existingConfig.hooks.stop.push({command:'other-plugin'});
 fs.writeFileSync(cursorFile,JSON.stringify(existingConfig));
 const existingText=fs.readFileSync(cursorFile,'utf8');
 await panel.locator('#source-enabled-cursor').uncheck();await snapshot();
 assert.equal(fs.readFileSync(cursorFile,'utf8'),existingText);
 await panel.locator('#source-enabled-cursor').check();await snapshot();
 assert.equal(fs.readFileSync(cursorFile,'utf8'),existingText,'existing file remains untouched on master enable');
 // 逐项开关仅改变接收偏好，配置保持全部接入。
 await panel.locator('#event-enabled-cursor-stop').uncheck();await snapshot();
 assert.equal(fs.readFileSync(cursorFile,'utf8'),existingText);
 assert.equal(await panel.locator('#event-enabled-cursor-stop').isDisabled(),false);
 await panel.locator('#event-enabled-cursor-stop').check();await snapshot();
 assert.equal(fs.readFileSync(cursorFile,'utf8'),existingText);
 await panel.locator('#event-enabled-cursor-stop').uncheck();await snapshot();
 await send('cursor','beforeSubmitPrompt',2,'filtered');
 assert.equal((await snapshot()).activity.working,1);
 const filteredBefore=await snapshot();const noticesBefore=await app.evaluate(()=>global.testNotices.length);
 await send('cursor','stop',2,'filtered',{status:'completed'});
 state=await snapshot();assert.equal(state.activity.working,0);assert.equal(state.activity.unread,2);
 assert.equal(state.nurture.totalWorkSessions,filteredBefore.nurture.totalWorkSessions);
 assert.equal(await app.evaluate(()=>global.testNotices.length),noticesBefore);
 await panel.locator('#event-enabled-cursor-postToolUseFailure').uncheck();await snapshot();
 assert.equal(fs.readFileSync(cursorFile,'utf8'),existingText);
 assert.equal(await panel.locator('#event-enabled-cursor-postToolUse').isChecked(),true);
 assert.equal(await panel.locator('#event-enabled-codex-Stop').isChecked(),true);
 // 启动按实际配置修正缺失事件；接收偏好独立保存。
 const partial=JSON.parse(fs.readFileSync(cursorFile,'utf8'));
 delete partial.hooks.postToolUse;
 fs.writeFileSync(cursorFile,JSON.stringify(partial));
 await app.close();app=null;await launch();await panel.locator('#nav-hooks').click();
 assert.equal(await panel.locator('#event-enabled-cursor-postToolUse').isChecked(),false);
 assert.equal(await panel.locator('#event-enabled-cursor-postToolUse').isDisabled(),true);
 assert.equal(await panel.locator('#event-enabled-cursor-stop').isChecked(),false,'restart preserves local receiving preference with configured stop');
 // 主动重开总开关补齐配置，同时保留关闭的接收项。
 await panel.locator('#source-enabled-cursor').uncheck();await snapshot();
 await panel.locator('#source-enabled-cursor').check();await snapshot();
 assert.equal(await panel.locator('#event-enabled-cursor-postToolUse').isChecked(),true);
 assert.equal(await panel.locator('#event-enabled-cursor-stop').isChecked(),false);
 assert.equal(Object.keys(JSON.parse(fs.readFileSync(cursorFile,'utf8')).hooks).length,5);
 // 已有异常 JSON 不覆盖，开启失败回退总开关。
 const validConfig=fs.readFileSync(cursorFile,'utf8');
 await panel.locator('#source-enabled-cursor').uncheck();await snapshot();
 fs.writeFileSync(cursorFile,'broken-json');
 await panel.locator('#source-enabled-cursor').click();
 await panel.waitForFunction(()=>document.querySelector('#hooks-feedback').textContent==='设置未保存，请重试。');
 assert.equal(await panel.locator('#source-enabled-cursor').isChecked(),false);
 assert.equal(fs.readFileSync(cursorFile,'utf8'),'broken-json');
 fs.writeFileSync(cursorFile,validConfig);
 await panel.locator('#source-enabled-cursor').check();await snapshot();
 // 保存失败必须回退开关，且不清除状态。

 fs.mkdirSync(path.join(dir,'settings.json.tmp'));
 await panel.locator('#source-enabled-cursor').click();
 await panel.waitForFunction(()=>document.querySelector('#hooks-feedback').textContent==='设置未保存，请重试。');
 assert.equal(await panel.locator('#source-enabled-cursor').isChecked(),true);
 assert.equal((await snapshot()).settings.sources.cursor,true);
 fs.rmdirSync(path.join(dir,'settings.json.tmp'));
 await app.close();app=null;await launch();
 await panel.locator('#nav-hooks').click();
 assert.equal(await panel.locator('#source-enabled-codex').isChecked(),false);
 assert.equal(await panel.locator('#source-enabled-cursor').isChecked(),true);
 assert.equal(await panel.locator('#event-enabled-cursor-stop').isChecked(),false);
 assert.equal(await panel.locator('#event-enabled-cursor-postToolUseFailure').isChecked(),false);
 assert.equal(await panel.locator('#event-enabled-codex-Stop').isDisabled(),true);
 state=await snapshot();assert.equal(state.activity.unread,2);assert.equal(state.activity.working,0);
 assert.equal(state.activity.notices.every(item=>item.source==='cursor'),true);
 assert.equal(JSON.stringify(state.activity).includes('never-forward'),false);
 await panel.evaluate(()=>window.whale.action('reminders'));
 await panel.waitForFunction(()=>!document.querySelector('#home-view').hidden&&document.activeElement.id==='reminders');
 assert.equal(await panel.locator('#unread-list .chat-row').count(),2);
 // 跳转拦截在隔离进程中模拟客户端选中结果，绝不打开用户真实 Cursor。
 assert.equal(await panel.locator('#unread-list .chat-row button').first().isDisabled(),false);
 const first=(await snapshot()).activity.notices[0];
 await panel.locator('#unread-list .chat-row button').first().click();
 await wait(async()=>(await window.whale.snapshot()).activity.unread===1);
 assert.deepEqual(await app.evaluate(()=>global.opened),[`cursor://anysphere.cursor-deeplink/agent?id=${first.session_id.slice(7)}`]);
 await panel.locator('#unread-list .chat-row button').nth(1).click();
 assert.equal((await snapshot()).activity.unread,0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',checks:['cursor-auto-create-and-preserve-existing','cursor-local-receiving-keeps-config','startup-matches-config-and-preferences','malformed-cursor-preserved','navigation-and-event-tables','source-namespace-isolation','remembered-selection-keeps-unread','paused-events-no-effects','pause-clears-only-source-activity','keeps-completed-reminders','enable-no-backfill','restore-source-settings','settings-write-failure-reverts-toggle','cursor-notices-survive-restart','cursor-agent-jump-confirmed','reminders-return-home','manual-read-cursor'],dataDir:dir}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
