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
fs.writeFileSync(bootstrap, `const cp=require('node:child_process'),original=cp.execFile;cp.execFile=function(file,args,options,callback){if(file==='/bin/ps'&&args.join(' ')==='-axo comm='){setImmediate(()=>callback(null,'/Applications/Codex.app/Contents/MacOS/Codex'));return;}return original.apply(this,arguments);};require(${JSON.stringify(path.join(root, 'src/main.cjs'))});`);
let app, panel, pet;
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
  app = await electron.launch({ executablePath:require('electron'), args:[bootstrap], env:{ ...process.env, CODEX_HOME:codexHome, WHALE_CODEX_BIN:codexBin, WHALE_DATA_DIR:dir } });
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
  // 覆盖一、三、四条边界及四→三→四切换，防止手动展开状态残留。
  await send('UserPromptSubmit', 0, 'busy-preview');
  await wait(() => !document.querySelector('#completion-shell').hidden && !document.querySelector('#completion-bubble').hidden);
  assert.equal(await pet.locator('.completion-row').textContent(), titles[0], '只有一个执行中也直接展示');
  assert.equal((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).getBounds())).height, 380);
  for (const i of [1, 2]) await send('UserPromptSubmit', i, 'busy-preview');
  await wait(() => !document.querySelector('#completion-bubble').hidden && document.querySelectorAll('.completion-row').length === 3);
  await pet.locator('#busy-alert').click();
  assert.equal(await pet.locator('#completion-bubble').isVisible(), true, '三条以内点击分类不折叠');
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

  await send('PermissionRequest', 4); await send('PermissionRequest', 5); await send('PermissionRequest', 4);
  await send('UserPromptSubmit', 6);
  await pet.locator('#pending-alert').click();
  await wait(() => document.querySelectorAll('.pending-row').length === 2);
  assert.deepEqual(await pet.locator('.completion-row').allTextContents(), [titles[4], titles[5]], '重复权限事件不改变首次到达顺序');
  assert.equal(await pet.locator('#pending-alert').textContent(), '待处理：2');
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
  console.log('PASS: 提醒分类、1～3 条直显、超过三条折叠、交替悬停、按序待处理、跳转消费、失败保留及重启恢复');
} finally { if (app) await app.close(); } })().catch(error => { console.error(error); process.exitCode = 1; });
