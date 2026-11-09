'use strict';
// 使用隔离的客户端状态验证提醒界面；通知和跳转均在测试进程中拦截。
const { _electron:electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { createCodexConfig } = require('../../src/hooks/config.cjs');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync('/tmp/whale-reminders-');
const codexHome = path.join(dir, 'codex');
fs.mkdirSync(codexHome);
fs.mkdirSync(path.join(root, 'out'), { recursive:true });
const ids = Array.from({ length:7 }, (_, i) => `11111111-1111-4111-8111-11111111111${i}`);
const titles = ['修复登录问题', '检查测试 <img src=x onerror=alert(1)>', '整理文档', '更新配置', '检查权限 A', '检查权限 B', '执行验证'];
const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,thread_source TEXT)');
for (const [i, id] of ids.entries()) db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(id, '原始输入', titles[i], 'user');
db.close();
const hooks = Object.entries(createCodexConfig().hooks).map(([event, groups]) => ({ eventName:event[0].toLowerCase() + event.slice(1), handlerType:'command', command:groups[0].hooks[0].command, enabled:true, trustStatus:'trusted' }));
const codexBin = path.join(dir, 'codex-fixture');
fs.writeFileSync(codexBin, '#!' + process.execPath + '\n' + `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.id===1?{}:m.id===3?{config:{}}:m.id===4?{requirements:null}:{data:[{hooks:${JSON.stringify(hooks)},errors:[]}]}})+'\\n');});`, { mode:0o700 });
// 只替换测试进程的客户端检测，不要求用户打开或退出真实客户端。
const bootstrap = path.join(dir, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();const cp=require('node:child_process'),original=cp.execFile;cp.execFile=function(file,args,options,callback){if(file==='/bin/ps'&&args.join(' ')==='-axo comm='){setImmediate(()=>callback(null,'/Applications/Codex.app/Contents/MacOS/Codex'));return;}return original.apply(this,arguments);};global.reminderNow=process.env.WHALE_REMINDER_TEST_NOW?Number(process.env.WHALE_REMINDER_TEST_NOW):undefined;const planning=require(${JSON.stringify(path.join(root,'src/app/planner.cjs'))}),createPlanning=planning.createPlanner;planning.createPlanner=options=>(global.reminderPlanner=createPlanning({...options,now:()=>global.reminderNow??Date.now()}));require(${JSON.stringify(path.join(root, 'src/main.cjs'))});`);
let app, panel, pet, plannerTestNow;
const errors = [], failedAssets = [];
const snapshot = () => panel.evaluate(() => window.whale.snapshot());
async function wait(predicate) {
  const deadline = Date.now() + 10000;
  while (!await pet.evaluate(predicate)) {
    if (Date.now() > deadline) throw new Error('提醒状态等待超时：' + JSON.stringify((await snapshot()).activity));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function launch() {
  app = await electron.launch({ executablePath:require('electron'), args:[bootstrap], env:{ ...process.env, WHALE_TEST_WINDOWS:'hidden', WHALE_REMINDER_TEST_NOW:plannerTestNow===undefined?'':String(plannerTestNow), CODEX_HOME:codexHome, WHALE_CODEX_BIN:codexBin, WHALE_DATA_DIR:dir } });
  app.on('window', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failedAssets.push(request.url()));
  });
  await app.firstWindow();
  for (let i = 0; i < 100; i++) {
    panel = app.windows().find(page => page.url().endsWith('/index.html'));
    pet = app.windows().find(page => page.url().endsWith('/pet.html'));
    if (panel && pet) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(panel && pet);
  await wait(async () => { const data = await window.whale.snapshot(); return data.bridge && data.hookAvailability.codex.state === 'checked'; });
  await app.evaluate(({ shell, Notification }) => {
    global.openedChats = []; global.testNotices = [];
    shell.openExternal = async url => { if (global.openChatFailure) throw new Error('模拟跳转失败'); global.openedChats.push(url); };
    Notification.prototype.show = function() { global.testNotices.push(this.body); };
  });
}
async function send(name, index, turn = 'turn-1') {
  const before = (await snapshot()).activity.count;
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(dir, 'events.sock'), () => socket.write(JSON.stringify({ hook_event_name:name, session_id:ids[index], turn_id:turn }) + '\n'));
    socket.on('error', reject); socket.on('data', () => {}); socket.on('close', resolve);
  });
  const deadline = Date.now() + 10000;
  while ((await snapshot()).activity.count === before) {
    if (Date.now() > deadline) throw new Error('Hook 等待超时：' + name);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
(async () => { try {
  await launch();
  await panel.locator('#nav-shortcuts').click();
  for(const width of [860,1060]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
    assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'快捷操作页不横向溢出');
    for(const id of ['shortcuts-help','shortcuts-reminder-help']) {
    const help=panel.locator('button[aria-describedby="'+id+'"]'),tip=panel.locator('#'+id);
    assert.equal(await tip.isVisible(),false,'说明默认收起');
    await help.hover();assert.equal(await tip.isVisible(),true,'悬停问号显示说明');
    const bounds=await tip.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width,'说明不超出窗口');
    await panel.screenshot({path:`/tmp/whale-${id}-${width}.png`});
    await panel.locator('#shortcuts-heading').hover();assert.equal(await tip.isVisible(),false,'移出后隐藏');
    await help.focus();assert.equal(await tip.isVisible(),true,'键盘聚焦显示说明');
    await panel.keyboard.press('Tab');assert.equal(await tip.isVisible(),false,'失焦后隐藏');
    const icon=await help.boundingBox();assert.ok(Math.abs(bounds.x-icon.x)<2&&Math.abs(bounds.y-icon.y-icon.height-4)<2,'Tooltip aligns with help icon');
    const heading=await help.locator('xpath=ancestor::div[contains(@class,"shortcuts-title")]/h2').boundingBox();
    assert.ok(Math.abs(icon.x-heading.x-heading.width-4)<2&&icon.y<heading.y,'Help icon sits immediately above the title right edge');
    }
    await panel.screenshot({path:`/tmp/whale-shortcuts-settings-${width}.png`});
    await panel.locator('#shortcuts-triple').click();
    const menu=await panel.locator('#shortcuts-picker .ui-select-menu').boundingBox();
    assert.ok(menu.x>=0&&menu.x+menu.width<=width&&menu.y+menu.height<=770,'快捷菜单不裁切');
    await panel.keyboard.press('Escape');
  }
  if(process.env.WHALE_SHORTCUTS_LAYOUT_ONLY==='1'){assert.deepEqual(errors,[]);console.log('PASS: 快捷操作问号提示悬停、移出、聚焦、失焦及 860/1060 布局');return;}
  // 覆盖用户截图中的定时提醒与聊天同屏，整个过程只保留一个任务气泡。
  const plannerAction=async(name,value)=>{
    const result=await panel.evaluate(({name,value})=>window.whale.planner(name,value),{name,value});
    assert.equal(result.error,undefined);return result.value;
  };
  const plannerStart=+new Date('2026-11-08T12:00:00+08:00');
  async function advancePlanner(minutes) {
    const now=plannerStart+minutes*60000;plannerTestNow=now;
    await pet.evaluate(now=>{window.reminderRealNow??=Date.now;Date.now=()=>now;},now);
    await app.evaluate((_,now)=>{global.reminderNow=now;global.reminderPlanner.tick();},now);
  }
  await advancePlanner(0);
  const ordinary=(await plannerAction('save-task',{title:'普通日程待办',status:'processing',deadline:'none',notes:'不发送给桌宠的备注'})).tasks.at(-1);
  assert.equal((await snapshot()).execution.count,0,'普通日程待办不混入定时提醒');
  const reminders=[];
  for(const [i,title] of ['喝水','闭眼休息','拉伸','远眺'].entries())reminders.push((await plannerAction('save-reminder',{
    title,category:i===3?'personal':'work',mode:'interval',intervalMinutes:2,processMinutes:i===1?3:0,fixedTimes:[],
    customWorkTime:{days:[0,1,2,3,4,5,6],periods:[{start:'00:00',end:'24:00'}]}
  })).reminders.at(-1));
  await send('UserPromptSubmit',0,'reminder-mixed');await advancePlanner(2);
  await wait(()=>document.getElementById('planner-reminder-alert').textContent==='提醒：4'&&document.getElementById('busy-alert').classList.contains('selected-category'));
  assert.equal(await pet.locator('.completion-reminder-row').count(),0,'同时存在聊天时默认优先展示聊天');
  assert.equal(await pet.locator('#completion-rows .completion-row').textContent(),titles[0]);
  assert.equal(await pet.locator('#planner-bubble').count(),0,'移除独立日程气泡节点');
  assert.equal((await snapshot()).activity.pending,0,'日程提醒不伪造聊天权限状态');
  assert.equal((await snapshot()).execution.count,1);
  assert.equal((await snapshot()).execution.pendingCount,0,'日程提醒不计入待处理');
  assert.equal(await pet.locator('#pending-alert').isHidden(),true);
  await pet.locator('#planner-reminder-alert').click();
  await wait(()=>!document.getElementById('completion-bubble').hidden&&document.querySelectorAll('.completion-reminder-row').length===4);
  assert.equal(await pet.locator('.completion-shell').count(),1,'聊天与提醒共用一个任务气泡');
  assert.equal(await pet.locator('.planner-pet-bubble').count(),0);
  assert.equal(await pet.locator('.completion-reminder-action').count(),0,'提醒气泡不提供完成或开始处理按钮');
  assert.equal(await pet.locator('.completion-reminder-title .completion-reminder-time').textContent(),'3 分钟','时长用沙漏标出，不写处理');
  await pet.locator('#planner-reminder-alert').click();
  await wait(()=>document.getElementById('completion-bubble').hidden);
  await pet.locator('#planner-reminder-alert').click();
  await wait(()=>!document.getElementById('completion-bubble').hidden);
  await pet.screenshot({path:path.join(root,'out/reminders-category.png'),omitBackground:true});
  const rest=()=>pet.locator(`.completion-reminder-row[data-reminder-id="${reminders[1].id}"]`);
  await rest().locator('.completion-reminder-title').evaluate(button=>{button.click();button.click();});
  await wait(()=>document.getElementById('planner-reminder-alert').textContent==='提醒：4'&&document.querySelector('.completion-reminder-time')?.textContent==='3:00');
  assert.equal((await snapshot()).reminderView,'reminders','开始处理后保持提醒分类');
  assert.equal((await snapshot()).execution.pendingCount,0);
  assert.equal((await snapshot()).execution.count,1,'开始处理后也不计入执行中');
  assert.equal((await snapshot()).activity.working,1,'执行中的聊天数量保持独立');
  assert.equal((await plannerAction('snapshot')).reminders[1].run.state,'processing');
  await advancePlanner(3);
  await wait(()=>document.querySelector('.completion-reminder-time')?.textContent==='2:00');
  assert.equal(await pet.locator('#completion-rows .completion-row').count(),4,'处理中的提醒和其余提醒留在同一分类');
  await pet.screenshot({path:path.join(root,'out/reminders-category-processing.png'),omitBackground:true});
  await pet.locator('#busy-alert').click();
  await wait(()=>document.querySelectorAll('#completion-rows .completion-row').length===1);
  assert.equal(await pet.locator('.completion-reminder-row').count(),0,'执行中只显示聊天');
  await pet.locator('#planner-reminder-alert').click();
  await wait(()=>document.querySelectorAll('.completion-reminder-row').length===4);
  const drink=()=>pet.locator(`.completion-reminder-row[data-reminder-id="${reminders[0].id}"]`);
  await drink().locator('.completion-reminder-title').click();
  await wait(async()=>(await window.whale.snapshot()).execution.reminderCount===3);
  await send('PermissionRequest',1,'reminder-permission');
  await wait(()=>document.getElementById('pending-alert').textContent==='待处理：1');
  await pet.locator('#pending-alert').click();
  await wait(()=>document.querySelectorAll('.pending-row').length===1);
  assert.equal(await pet.locator('.pending-row').count(),1,'真正的权限请求仍单独保留权限样式');
  assert.equal(await pet.locator('.completion-reminder-row').count(),0,'待处理不包含定时提醒');
  await send('UserPromptSubmit',2,'reminder-completed');await send('Stop',2,'reminder-completed');
  await wait(()=>document.getElementById('unread-label').textContent==='已完成：1'&&document.getElementById('completion-alert').classList.contains('selected-category'));
  assert.equal(await pet.locator('.completion-row').textContent(),titles[2],'新完成的聊天把面板切到已完成');
  await pet.locator('#planner-reminder-alert').click();
  await wait(()=>document.querySelectorAll('.completion-reminder-row').length===3);
  const layout=await pet.evaluate(()=>{
    const shell=document.getElementById('completion-shell').getBoundingClientRect();
    const tabs=[...document.querySelectorAll('.completion-counts button')].filter(button=>!button.hidden),buttons=tabs.map(button=>button.getBoundingClientRect());
    return {order:tabs.map(button=>button.id),count:buttons.length,inside:buttons.every(button=>button.x>=shell.x&&button.right<=shell.right&&button.y>=shell.y&&button.bottom<=shell.bottom),bottom:shell.bottom,rowsBottom:document.getElementById('completion-rows').getBoundingClientRect().bottom,height:innerHeight};
  });
  assert.deepEqual(layout.order,['pending-alert','completion-alert','planner-reminder-alert','busy-alert'],'提醒排在执行中之前');
  assert.equal(layout.count,4,'四个分类可同时展示');assert.equal(layout.inside,true,'分类标题不溢出气泡');
  assert.ok(layout.rowsBottom<=layout.bottom&&layout.bottom<=layout.height,'换行后列表不被裁切');
  await pet.screenshot({path:path.join(root,'out/reminders-four-categories.png'),omitBackground:true});
  await panel.evaluate(id=>window.whale.action('read-notice',id),(await snapshot()).activity.notices[0].id);
  await send('Interrupt',0,'reminder-mixed');await send('Interrupt',1,'reminder-permission');
  await panel.evaluate(()=>window.whale.modules({id:'planner',enabled:false}));
  await wait(()=>document.getElementById('completion-shell').hidden);
  await panel.evaluate(()=>window.whale.modules({id:'planner',enabled:true}));
  await wait(()=>document.getElementById('planner-reminder-alert').textContent==='提醒：3');
  const restToken=(await plannerAction('snapshot')).reminders[1].run.token;
  await app.close();app=null;await launch();await advancePlanner(3);
  await wait(()=>document.getElementById('planner-reminder-alert').textContent==='提醒：3');
  assert.equal((await snapshot()).execution.count,0,'重启后处理中的提醒仍不计入聊天');
  assert.equal((await snapshot()).execution.reminderItems.filter(item=>item.state==='processing').length,1,'重启从原提醒记录恢复处理状态');
  assert.equal(await pet.locator('#planner-bubble').count(),0,'重启后也只有统一任务气泡');
  assert.deepEqual(await app.evaluate(()=>global.testNotices),[],'重启不重发提醒通知');
  await wait(()=>document.querySelector('.completion-reminder-time')?.textContent==='2:00');
  await advancePlanner(5);
  await wait(async()=>!(await window.whale.snapshot()).execution.reminderItems.some(item=>item.state==='processing'));
  assert.equal((await plannerAction('snapshot')).reminders[1].run.dueAt,plannerStart+7*60000,'处理结束后才计算下一轮');
  const stale=await pet.evaluate(value=>window.whale.planner('start',value),{id:reminders[1].id,token:restToken});assert.match(stale.error,/这轮提醒已结束/);
  for(const item of reminders)await plannerAction('remove-reminder',{id:item.id});
  await plannerAction('remove-task',{id:ordinary.id});
  await pet.evaluate(()=>{Date.now=window.reminderRealNow;delete window.reminderRealNow;});
  plannerTestNow=undefined;await app.evaluate(()=>{global.reminderNow=undefined;global.reminderPlanner.tick();});
  await wait(()=>document.getElementById('completion-shell').hidden);
  assert.deepEqual(await app.evaluate(()=>testWindowPolicy.events),[],'检查全程使用隐藏独立测试窗口');
  await panel.locator('#nav-shortcuts').click();
  // 覆盖一、三、四条边界及四→三→四切换，防止手动展开状态残留。
  await send('UserPromptSubmit', 0, 'busy-preview');
  await wait(() => !document.querySelector('#completion-shell').hidden && !document.querySelector('#completion-bubble').hidden);
  assert.equal(await pet.locator('.completion-row').textContent(), titles[0], '只有一个执行中也直接展示');
  assert.equal((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).getBounds())).height, 380);
  for (const i of [1, 2]) await send('UserPromptSubmit', i, 'busy-preview');
  await wait(() => !document.querySelector('#completion-bubble').hidden && document.querySelectorAll('.completion-row').length === 3);
  const threshold=panel.locator('#shortcuts-threshold');
  await threshold.fill('2');await threshold.press('Tab');
  await wait(()=>document.querySelector('#completion-bubble').hidden);
  assert.equal((await snapshot()).shortcuts.reminderCollapseThreshold,2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'shortcuts.json'),'utf8')).reminderCollapseThreshold,2);
  await pet.locator('#busy-alert').click();
  await wait(()=>!document.querySelector('#completion-bubble').hidden);
  await pet.locator('#busy-alert').click();
  await wait(()=>document.querySelector('#completion-bubble').hidden);
  await threshold.fill('3');await threshold.press('Tab');
  await wait(()=>!document.querySelector('#completion-bubble').hidden);
  await pet.locator('#busy-alert').click();
  assert.equal(await pet.locator('#completion-bubble').isVisible(), true, '阈值内点击分类不折叠');
  await pet.locator('#busy-alert').focus(); await pet.keyboard.press('ArrowDown');
  assert.equal(await pet.locator('.completion-row').first().evaluate(el => el === document.activeElement), true);
  await pet.screenshot({ path:path.join(root, 'out/busy-three.png'), omitBackground:true });
  await send('UserPromptSubmit', 3, 'busy-preview');
  await wait(() => document.querySelector('#completion-bubble').hidden);
  assert.equal((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).getBounds())).height, 320);
  await pet.locator('#busy-alert').click();
  await wait(() => !document.querySelector('#completion-bubble').hidden && document.querySelectorAll('.completion-row').length === 4);
  await send('Interrupt', 3, 'busy-preview');
  await wait(() => !document.querySelector('#completion-bubble').hidden && document.querySelectorAll('.completion-row').length === 3);
  await send('UserPromptSubmit', 3, 'busy-preview-2');
  await wait(() => document.querySelector('#completion-bubble').hidden);
  await send('Interrupt', 3, 'busy-preview-2');
  for (const i of [1, 2]) await send('Interrupt', i, 'busy-preview');
  await send('Stop', 0, 'busy-preview');
  await wait(() => document.querySelector('#unread-label').textContent === '已完成：1');
  assert.equal(await pet.locator('.completion-row').textContent(), titles[0]);
  assert.equal(await pet.locator('#completion-shell').evaluate(el => el.classList.contains('single-category')), true);
  for (const i of [1, 2]) { await send('UserPromptSubmit', i); await send('Stop', i); }
  await wait(() => !document.querySelector('#completion-bubble').hidden && document.querySelectorAll('.completion-row').length === 3);
  assert.equal(await pet.locator('#completion-rows img').count(), 0, '聊天标题只能作为文本');
  await send('Stop', 3);
  await wait(() => document.querySelector('#unread-label').textContent === '已完成：4' && document.querySelector('#completion-bubble').hidden);
  await pet.locator('#completion-alert').click();
  await wait(() => !document.querySelector('#completion-bubble').hidden);
  assert.equal(app.windows().length, 2, '展开提醒不额外创建窗口');
  const first = pet.locator('.completion-row').first(), second = pet.locator('.completion-row').nth(1);
  await first.hover(); await pet.waitForTimeout(180);
  const firstColor = await first.evaluate(el => getComputedStyle(el).backgroundColor);
  await second.hover(); await pet.waitForTimeout(180);
  assert.notEqual(await second.evaluate(el => getComputedStyle(el).backgroundColor), firstColor, '相邻行的悬停颜色不同');
  await pet.locator('#completion-alert').focus(); await pet.keyboard.press('ArrowDown');
  assert.equal(await first.evaluate(el => el === document.activeElement), true);
  await pet.screenshot({ path:path.join(root, 'out/completion-bubble-hover.png'), omitBackground:true });
  await pet.locator('.completion-row').last().click();
  await wait(() => document.querySelector('#unread-label').textContent === '已完成：3');
  assert.deepEqual(await app.evaluate(() => global.openedChats), [`codex://threads/${ids[0]}`]);
  assert.equal(await pet.locator('#completion-bubble').isVisible(), true, '回到三条后自动展示');
  await threshold.fill('2');await threshold.press('Tab');
  await wait(()=>document.querySelector('#completion-bubble').hidden);
  assert.equal(await pet.locator('#unread-label').textContent(),'已完成：3');
  await pet.locator('#completion-alert').click();
  await wait(()=>!document.querySelector('#completion-bubble').hidden);
  await pet.locator('#completion-alert').click();
  await wait(()=>document.querySelector('#completion-bubble').hidden);
  await threshold.fill('3');await threshold.press('Tab');
  await wait(()=>!document.querySelector('#completion-bubble').hidden);

  await send('PermissionRequest', 4); await send('PermissionRequest', 5); await send('PermissionRequest', 4);
  await send('UserPromptSubmit', 6);
  await pet.locator('#pending-alert').click();
  await wait(() => document.querySelectorAll('.pending-row').length === 2);
  assert.deepEqual(await pet.locator('.completion-row').allTextContents(), [titles[4], titles[5]], '重复权限事件不改变首次到达顺序');
  assert.equal(await pet.locator('#pending-alert').textContent(), '待处理：2');
  await threshold.fill('1');await threshold.press('Tab');
  await wait(()=>document.querySelector('#completion-bubble').hidden);
  assert.equal((await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')).getBounds())).height,320);
  await pet.locator('#pending-alert').click();
  await wait(()=>!document.querySelector('#completion-bubble').hidden);
  assert.equal(await pet.locator('#pending-alert').getAttribute('aria-expanded'),'true');
  assert.deepEqual(await pet.locator('.completion-row').allTextContents(),[titles[4],titles[5]],'合并展开后保持收到顺序');
  await pet.locator('#pending-alert').click();
  await wait(()=>document.querySelector('#completion-bubble').hidden);
  await threshold.fill('2');await threshold.press('Tab');
  await wait(()=>!document.querySelector('#completion-bubble').hidden);
  await threshold.fill('3');await threshold.press('Tab');
  await panel.waitForFunction(async()=>(await window.whale.snapshot()).shortcuts.reminderCollapseThreshold===3);
  assert.equal(await pet.locator('#busy-alert').textContent(), '执行中：1');
  assert.equal(await pet.locator('#speech').isHidden(), true, '权限状态不额外显示冗余提示气泡');
  await pet.locator('#busy-alert').click();
  await wait(() => document.body.classList.contains('busy-expanded') && document.querySelectorAll('.completion-row').length === 1);
  assert.equal(await first.textContent(), titles[6]);
  await first.click();
  assert.equal((await snapshot()).activity.unread, 3, '打开执行中任务不消费完成提醒');
  await pet.locator('#completion-alert').click();
  await wait(() => document.querySelectorAll('.completion-row').length === 3);
  await app.evaluate(() => { global.openChatFailure = true; });
  await first.click();
  await wait(() => !document.querySelector('#completion-error').hidden);
  assert.equal((await snapshot()).activity.unread, 3, '跳转失败保留记录');
  await app.evaluate(() => { global.openChatFailure = false; });
  await first.click();
  await wait(() => document.querySelector('#unread-label').textContent === '已完成：2');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8'));
  await app.close(); app = null;
  await launch();
  await wait(() => document.querySelector('#unread-label').textContent === '已完成：2');
  assert.equal((await snapshot()).activity.working, 0);
  assert.equal((await snapshot()).activity.pending, 0);
  assert.deepEqual((await snapshot()).activity.notices.map(item => item.id), saved.notices.map(item => item.id));
  assert.deepEqual(await app.evaluate(() => global.testNotices), [], '恢复完成记录不重发通知');
  await pet.locator('.completion-row').first().click();
  await wait(() => document.querySelector('#unread-label').textContent === '已完成：1');
  await pet.locator('#completion-alert').click();
  await wait(() => document.querySelector('#completion-shell').hidden);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8')).notices.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(failedAssets, []);
  console.log('PASS: 同一任务气泡内独立提醒分类，开始处理保留分类、倒计时、独立计数、四分类布局、折叠、重启及旧轮次拒绝；聊天提醒回归');
} finally { if (app) await app.close(); } })().catch(error => { console.error(error); process.exitCode = 1; });
