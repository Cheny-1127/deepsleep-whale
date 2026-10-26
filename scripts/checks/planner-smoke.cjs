'use strict';
// 独立数据目录和可控的日程时钟；拦截系统通知，不访问真实账号或生产服务。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-planner-ui-'),out=path.join(root,'out');
fs.mkdirSync(out,{recursive:true});
const bootstrap=path.join(dir,'bootstrap.cjs');
// 必须先安装窗口策略，再加载应用模块；创建后才 hide 无法阻止启动闪窗。
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {Notification}=require('electron');global.plannerNow=+new Date('2026-10-26T10:00:00');global.plannerNotices=[];global.plannerClosed=[];global.plannerChimes=0;
Notification.isSupported=()=>true;Notification.prototype.show=function(){global.plannerNotices.push(this.body);};Notification.prototype.close=function(){global.plannerClosed.push(this.body);};
const presence=require(${JSON.stringify(path.join(root,'src/clients/presence.cjs'))});presence.readClientPresence=async()=>({codex:false,cursor:false});
const archery=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),createArchery=archery.createArcheryPending;archery.createArcheryPending=options=>createArchery({...options,readConfig:()=>{throw Object.assign(Error('测试隔离'),{archeryConfig:true});}});
const planner=require(${JSON.stringify(path.join(root,'src/app/planner.cjs'))}),createPlanner=planner.createPlanner;planner.createPlanner=options=>(global.plannerTest=createPlanner({...options,now:()=>global.plannerNow}));
const windows=require(${JSON.stringify(path.join(root,'src/app/windows.cjs'))}),createWindows=windows.createWindows;windows.createWindows=options=>({...createWindows(options),chime(){global.plannerChimes++;}});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app,panel,pet;
const errors=[];
async function assertWindowPolicy() {
  // 同时检查当前状态和历史事件，曾短暂显示或抢焦点再恢复，也不能算通过。
  const state=await app.evaluate(({BrowserWindow})=>({...global.testWindowPolicy,
    windows:BrowserWindow.getAllWindows().map(win=>({url:win.webContents.getURL(),visible:win.isVisible(),focused:win.isFocused(),top:win.isAlwaysOnTop()}))}));
  assert.ok(state.windows.every(win=>!win.focused&&!win.top),'测试窗口不能抢焦点或置顶');
  assert.equal(state.events.some(event=>event.type==='focus'),false,'测试全程不能获得焦点');
  if(state.mode==='hidden') {
    assert.ok(state.windows.every(win=>!win.visible),'默认隐藏全部测试窗口：'+JSON.stringify(state));
    assert.equal(state.events.some(event=>event.type==='show'),false,'隐藏测试全程不能展示窗口');
  }
}
async function launch() {
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,CODEX_HOME:dir,WHALE_DATA_DIR:dir,WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing-token')}});
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  await app.firstWindow();
  for(let i=0;i<100;i++) {
    panel=app.windows().find(page=>page.url().endsWith('/index.html'));pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
    if(panel&&pet)break;await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(panel&&pet);
  await panel.waitForFunction(async()=>Boolean((await window.whale.snapshot()).planner));
  for(const page of [panel,pet])await page.evaluate(time=>{Date.now=()=>time;},+new Date('2026-10-26T10:00:00'));
  await assertWindowPolicy();
  await panel.locator('#nav-planner').click();
  await panel.waitForSelector('#planner-add-item');
  await panel.waitForFunction(()=>document.getElementById('planner-work-summary').textContent.includes('10:00'));
}
const snapshot=()=>panel.evaluate(async()=>{const result=await window.whale.planner('snapshot');if(result.error)throw Error(result.error);return result.value;});
async function choose(id,label) {
  await panel.locator('#planner-'+id+'-trigger').click();
  await panel.locator('#planner-'+id+'-options').getByRole('option',{name:label,exact:true}).click();
}
async function advance(time) {
  const value=+new Date(time);
  for(const page of [panel,pet])await page.evaluate(time=>{Date.now=()=>time;},value);
  await app.evaluate((_,time)=>{global.plannerNow=time;global.plannerTest.tick();},value);
  await panel.waitForFunction(async()=>{const state=await window.whale.snapshot();return Boolean(state.planner);});
}
async function newItem(kind='task') {
  await panel.locator('#planner-add-item').click();
  assert.equal(await panel.locator('[name="planner-kind"][value="task"]').isChecked(),true);
  if(kind==='reminder')await panel.locator('[name="planner-kind"][value="reminder"]').check();
}
async function chooseCategory(value) {await panel.locator(`[name="planner-category"][value="${value}"]`).check();}
async function addTask(title,deadline) {
  await newItem('task');await panel.locator('#planner-item-title').fill(title);await choose('deadline',deadline);
  await panel.locator('#planner-task-notes').fill('本地工作备注 <img src=x onerror=alert(1)>');
  await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
}
(async()=>{try {
  await launch();
  // 新入口可以切页，已有侧栏配置升级后仍保留全部菜单。
  assert.equal(await panel.locator('#home-view').isVisible(),false);
  assert.equal((await panel.evaluate(()=>window.whale.sidebar())).visible.includes('planner'),true);
  assert.equal(await panel.locator('[data-category="all"]').getAttribute('aria-pressed'),'true');
  // 同一入口选择类型和分类；切换类型保留草稿，取消不落盘。
  await newItem();await panel.locator('#planner-item-title').fill('同一份草稿');await chooseCategory('personal');
  await choose('deadline','指定日期');await panel.locator('#planner-task-date').fill('');
  await panel.locator('#planner-task-notes').fill('切换后仍保留备注');
  await panel.locator('[name="planner-kind"][value="reminder"]').check();
  assert.equal(await panel.locator('#planner-item-title').inputValue(),'同一份草稿');
  assert.equal(await panel.locator('[name="planner-category"][value="personal"]').isChecked(),true);
  assert.equal(await panel.locator('#planner-task-fields').isVisible(),false);
  assert.equal(await panel.locator('#planner-task-date').isDisabled(),true);
  await panel.locator('#planner-interval').fill('25');
  await panel.locator('[name="planner-kind"][value="task"]').check();
  assert.equal(await panel.locator('#planner-task-notes').inputValue(),'切换后仍保留备注');
  assert.equal(await panel.locator('#planner-reminder-fields').isVisible(),false);
  await panel.locator('[name="planner-kind"][value="reminder"]').check();assert.equal(await panel.locator('#planner-interval').inputValue(),'25');
  await panel.locator('#planner-cancel-item').click();assert.equal((await snapshot()).reminders.length,0);assert.equal((await snapshot()).tasks.length,0);
  // 新建待办和提醒在两种窗口宽度下均可操作。
  for(const width of [860,1060]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
    await newItem();await panel.locator('#planner-item-title').fill('整理本周工作');
    const dialog=panel.locator('#planner-item-dialog');assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));
    await panel.screenshot({path:path.join(out,`planner-create-task-${width}.png`)});
    await panel.locator('[name="planner-kind"][value="reminder"]').check();await panel.locator('#planner-item-title').fill('闭眼休息');
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));
    assert.ok(await dialog.locator('[type="submit"]').evaluate(el=>{const button=el.getBoundingClientRect(),dialog=el.closest('dialog').getBoundingClientRect();return button.top>=dialog.top&&button.bottom<=dialog.bottom;}),'长表单保存按钮保持可见');
    await panel.screenshot({path:path.join(out,`planner-create-reminder-${width}.png`)});
    await panel.keyboard.press('Escape');
  }

  await panel.getByRole('button',{name:'添加喝水提醒',exact:true}).click();
  await panel.locator('#planner-interval').fill('2');await panel.locator('#planner-item-form [type="submit"]').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.planner-reminder').length===1&&!document.getElementById('planner-item-dialog').open);
  await newItem('reminder');await panel.locator('#planner-item-title').fill('闭眼休息');
  await panel.locator('#planner-interval').fill('2');await panel.locator('#planner-process').fill('3');await panel.locator('#planner-item-form [type="submit"]').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.planner-reminder').length===2&&!document.getElementById('planner-item-dialog').open);
  await advance('2026-10-26T10:02:00');
  await pet.waitForFunction(()=>!document.getElementById('planner-bubble').hidden&&document.querySelectorAll('.planner-pet-row').length===2);
  assert.equal((await app.evaluate(()=>global.plannerNotices)).length,2);
  // 桌宠无法读取工作正文或修改时间设置；广播只带当前提醒摘要。
  assert.match((await pet.evaluate(()=>window.whale.planner('snapshot'))).error,/仅允许/);
  assert.equal((await pet.evaluate(()=>window.whale.snapshot())).planner.tasks,undefined);
  // 10:06 才开始闭眼休息，10:09 结束；喝水点击完成后才重新计时。
  await advance('2026-10-26T10:06:00');
  const rest=panel.locator('.planner-reminder').filter({has:panel.getByRole('heading',{name:'闭眼休息',exact:true})});
  await rest.getByRole('button',{name:'开始处理',exact:true}).click();
  await pet.waitForFunction(()=>document.querySelector('.planner-clock')?.textContent.includes('3:00'));
  const drink=panel.locator('.planner-reminder').filter({has:panel.getByRole('heading',{name:'喝水',exact:true})});
  await drink.getByRole('button',{name:'完成',exact:true}).click();
  await pet.waitForFunction(()=>document.querySelectorAll('.planner-pet-row').length===1);
  assert.equal((await snapshot()).reminders.find(item=>item.title==='喝水').run.dueAt,+new Date('2026-10-26T10:08:00'));
  await advance('2026-10-26T10:09:00');
  await panel.waitForFunction(()=>![...document.querySelectorAll('#planner-reminder-list .planner-clock')].length);
  assert.equal((await snapshot()).reminders.find(item=>item.title==='闭眼休息').run.dueAt,+new Date('2026-10-26T10:11:00'));
  assert.ok((await app.evaluate(()=>global.plannerNotices)).some(text=>text.includes('3 分钟处理已结束')));
  // 固定时间使用公共下拉；键盘可切换，失效时段不能保存。
  await newItem('reminder');await panel.locator('#planner-item-title').fill('固定提醒');
  await panel.locator('#planner-mode-trigger').click();
  await panel.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option'&&document.activeElement.closest('#planner-mode-options'));
  await panel.keyboard.press('ArrowDown');await panel.keyboard.press('Enter');
  assert.equal(await panel.locator('#planner-mode-selected').textContent(),'固定时间');
  await panel.locator('#planner-fixed').fill('19:30');await panel.locator('#planner-item-form [type="submit"]').click();
  await panel.waitForSelector('#planner-item-error:not([hidden])');assert.equal((await snapshot()).reminders.length,2);
  await panel.locator('#planner-fixed').fill('11:00, 15:00');await panel.locator('#planner-item-form [type="submit"]').click();
  await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  // 工作期限、未排期、完成及纯文本展示。
  assert.equal(await panel.locator('#planner-reminders').isVisible(),true);
  assert.equal(await panel.locator('#planner-tasks').isVisible(),true);
  // 默认配置是整个模块的入口，在工作待办页也能打开；取消和 Esc 不保存草稿。
  const settingsButton=panel.getByRole('button',{name:'默认配置',exact:true});
  await settingsButton.click();
  const settingsDialog=panel.getByRole('dialog',{name:'默认配置',exact:true});
  await panel.getByRole('textbox',{name:'默认时段结束时间',exact:true}).fill('18:00');
  await settingsDialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal((await snapshot()).workTime.periods[0].end,'19:00');
  await settingsButton.click();assert.equal(await panel.getByRole('textbox',{name:'默认时段结束时间',exact:true}).inputValue(),'19:00');
  await panel.keyboard.press('Escape');assert.equal(await settingsDialog.isVisible(),false);
  for(const [title,deadline] of [['今天处理','今天完成'],['明天处理','明天完成'],['周内处理','一周内完成'],['以后安排','暂不安排']])await addTask(title,deadline);
  assert.deepEqual((await snapshot()).tasks.map(item=>item.dueDate),['2026-10-26','2026-10-27','2026-11-02',null]);
  assert.equal(await panel.locator('#planner-task-list img').count(),0);
  await panel.getByRole('button',{name:'未排期',exact:true}).click();assert.equal(await panel.locator('.planner-task').count(),1);
  await panel.getByRole('button',{name:'今天',exact:true}).click();assert.equal(await panel.locator('.planner-task').count(),1);
  await panel.getByRole('checkbox',{name:'完成待办：今天处理',exact:true}).click();await panel.waitForFunction(()=>!document.querySelector('.planner-task'));
  await panel.getByRole('button',{name:'已完成',exact:true}).click();assert.equal(await panel.locator('.planner-task').count(),1);
  await panel.getByRole('checkbox',{name:'恢复待办：今天处理',exact:true}).click();await panel.waitForFunction(()=>!document.querySelector('.planner-task'));
  // 验证编辑后期限不滚动，以及失败时保留输入和已保存数据。
  await panel.getByRole('button',{name:'全部',exact:true}).click();
  await panel.locator('.planner-task').first().getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await panel.locator('#planner-deadline-selected').textContent(),'指定日期');
  fs.mkdirSync(path.join(dir,'planner.json.tmp'));await panel.locator('#planner-item-title').fill('保存失败保留输入');
  await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForSelector('#planner-item-error:not([hidden])');
  assert.equal(await panel.locator('#planner-item-title').inputValue(),'保存失败保留输入');assert.equal((await snapshot()).tasks[0].title,'今天处理');
  fs.rmdirSync(path.join(dir,'planner.json.tmp'));await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  for(const width of [860,1060]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
    assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await panel.screenshot({path:path.join(out,`planner-tasks-${width}.png`),fullPage:true});
  }
  await panel.locator('[data-category="work"]').click();
  await settingsButton.click();
  // 编辑未提交的默认时段不能被后台计时快照覆盖。
  const end=panel.getByRole('textbox',{name:'默认时段结束时间',exact:true});await end.fill('18:00');
  await advance('2026-10-26T10:11:00');await panel.waitForTimeout(250);assert.equal(await end.inputValue(),'18:00');
  await end.fill('09:00');await panel.locator('#planner-settings-form [type="submit"]').click();
  await panel.waitForSelector('#planner-settings-error:not([hidden])');assert.equal(await settingsDialog.isVisible(),true);
  assert.equal((await snapshot()).workTime.periods[0].end,'19:00');await end.fill('19:00');
  await panel.locator('#planner-sound').check();
  await settingsDialog.getByRole('button',{name:'每天',exact:true}).click();
  assert.equal(await settingsDialog.locator('.planner-days input:checked').count(),7);
  await settingsDialog.getByRole('checkbox',{name:'周日',exact:true}).uncheck();
  assert.equal(await settingsDialog.getByRole('button',{name:'每天',exact:true}).getAttribute('aria-pressed'),'false');
  await settingsDialog.getByRole('button',{name:'每天',exact:true}).click();
  await settingsDialog.getByRole('checkbox',{name:'全天允许',exact:true}).check();
  assert.equal(await settingsDialog.locator('.planner-time-fields').isVisible(),false);
  await settingsDialog.getByRole('checkbox',{name:'全天允许',exact:true}).uncheck();assert.equal(await end.inputValue(),'19:00');
  await settingsDialog.getByRole('checkbox',{name:'全天允许',exact:true}).check();
  await panel.locator('#planner-settings-form [type="submit"]').click();
  await panel.waitForFunction(()=>!document.getElementById('planner-settings-dialog').open&&document.getElementById('planner-settings-feedback').textContent.includes('已保存'));
  assert.equal((await snapshot()).sound,true);
  assert.equal((await snapshot()).workTime.days.length,7);
  await panel.waitForFunction(()=>document.getElementById('planner-work-summary').textContent==='默认：每天 · 全天');
  assert.equal(await panel.locator('#planner-reminder-list').textContent().then(text=>text.includes('00:00–24:00')),false);
  await panel.screenshot({path:path.join(out,'planner-reminders.png'),fullPage:true});
  for(const width of [860,1060]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
    await settingsButton.click();
    assert.equal(await settingsDialog.getByRole('checkbox',{name:'全天允许',exact:true}).isChecked(),true);
    assert.equal(await settingsDialog.getByRole('button',{name:'每天',exact:true}).getAttribute('aria-pressed'),'true');
    assert.ok(await settingsDialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'默认配置弹窗内容不横向溢出');
    await panel.screenshot({path:path.join(out,`planner-default-settings-${width}.png`)});
    await panel.keyboard.press('Escape');
  }
  // 恢复工作时段，后续继续验证下班停止提醒。
  await settingsButton.click();await settingsDialog.getByRole('checkbox',{name:'全天允许',exact:true}).uncheck();
  for(const day of ['周六','周日'])await settingsDialog.getByRole('checkbox',{name:day,exact:true}).uncheck();
  await panel.locator('#planner-settings-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-settings-dialog').open);
  await newItem('reminder');await panel.locator('#planner-use-default').uncheck();
  await panel.locator('#planner-mode-trigger').click();
  await panel.screenshot({path:path.join(out,'planner-editor.png')});
  await panel.keyboard.press('Escape');await panel.locator('#planner-cancel-item').click();
  await advance('2026-10-26T10:13:00');await pet.waitForFunction(()=>!document.getElementById('planner-bubble').hidden);
  await pet.screenshot({path:path.join(out,'planner-pet.png'),omitBackground:true});
  assert.equal(await pet.locator('#planner-bubble').evaluate(el=>Math.round(el.getBoundingClientRect().width)),236);
  await advance('2026-10-26T15:00:00');assert.ok(await app.evaluate(()=>global.plannerChimes)>0);
  // 系统通知、声音及气泡在工作时间外均停止，旧通知主动关闭。
  const noticesBefore=(await app.evaluate(()=>global.plannerNotices)).length,chimesBefore=await app.evaluate(()=>global.plannerChimes);
  await advance('2026-10-26T19:00:00');await pet.waitForFunction(()=>document.getElementById('planner-bubble').hidden);
  assert.equal((await app.evaluate(()=>global.plannerNotices)).length,noticesBefore);assert.equal(await app.evaluate(()=>global.plannerChimes),chimesBefore);
  await panel.waitForFunction(()=>document.getElementById('planner-reminder-list').textContent.includes('10/27'));
  assert.equal((await app.evaluate(()=>global.plannerClosed)).length,noticesBefore,'下班主动关闭全部到期和处理结束通知');
  // 单条提醒也能每天、全天；23:58 开始处理 3 分钟，零点后仍继续。
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).hide());
  await newItem('reminder');await panel.locator('#planner-item-title').fill('全天休息');
  await panel.locator('#planner-interval').fill('2');await panel.locator('#planner-process').fill('3');await panel.locator('#planner-use-default').uncheck();
  const custom=panel.locator('#planner-custom-work');await custom.getByRole('button',{name:'每天',exact:true}).click();await custom.getByRole('checkbox',{name:'全天允许',exact:true}).check();
  assert.equal(await custom.locator('.planner-time-fields').isVisible(),false);
  await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  const allDayItem=(await snapshot()).reminders.find(item=>item.title==='全天休息');assert.equal(allDayItem.customWorkTime.days.length,7);
  await advance('2026-10-26T23:58:00');
  const allDayCard=panel.locator('.planner-reminder').filter({has:panel.getByRole('heading',{name:'全天休息',exact:true})});
  await allDayCard.getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await custom.getByRole('checkbox',{name:'全天允许',exact:true}).isChecked(),true);
  await panel.screenshot({path:path.join(out,'planner-all-day-editor.png')});await panel.locator('#planner-cancel-item').click();
  await allDayCard.getByRole('button',{name:'开始处理',exact:true}).click();
  await advance('2026-10-27T00:00:00');assert.equal((await snapshot()).active[0].state,'processing');
  await advance('2026-10-27T00:01:00');assert.equal((await snapshot()).reminders.find(item=>item.id===allDayItem.id).run.dueAt,+new Date('2026-10-27T00:03:00'));
  // 同一个应用内确认组件用于日程删除，隐藏测试直接操作中文按钮。
  await allDayCard.getByRole('button',{name:'删除',exact:true}).click();
  const removeDialog=panel.getByRole('alertdialog',{name:'删除提醒？'});assert.match(await removeDialog.textContent(),/全天休息/);
  await removeDialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal((await snapshot()).reminders.some(item=>item.id===allDayItem.id),true,'取消删除保留提醒');
  await allDayCard.getByRole('button',{name:'删除',exact:true}).click();
  await removeDialog.getByRole('button',{name:'删除提醒',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('.planner-reminder').length===3);
  await assertWindowPolicy();
  // 分类是筛选条件；在新建事项中选择类型和个人，保存后跳到对应分类。
  await panel.locator('[data-category="personal"]').click();
  assert.equal(await panel.locator('.planner-reminder').count(),0);assert.equal(await panel.locator('.planner-task').count(),0);
  await panel.locator('[data-category="work"]').click();
  await newItem('reminder');await chooseCategory('personal');
  await panel.locator('#planner-item-title').fill('个人伸展');await panel.locator('#planner-interval').fill('2');
  await panel.locator('#planner-use-default').uncheck();await custom.getByRole('button',{name:'每天',exact:true}).click();await custom.getByRole('checkbox',{name:'全天允许',exact:true}).check();
  // 无关的待办日期即使无效，也不应阻止保存提醒。
  await panel.locator('[name="planner-kind"][value="task"]').check();await choose('deadline','指定日期');await panel.locator('#planner-task-date').fill('');
  await panel.locator('[name="planner-kind"][value="reminder"]').check();
  await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  assert.equal(await panel.locator('[data-category="personal"]').getAttribute('aria-pressed'),'true');
  assert.equal(await panel.locator('.planner-reminder .planner-category-badge').textContent(),'个人');
  await addTask('买牛奶','明天完成');assert.equal((await snapshot()).tasks.at(-1).category,'personal');
  await panel.locator('[data-category="all"]').click();assert.equal(await panel.locator('.planner-reminder').count(),4);assert.equal(await panel.locator('.planner-task').count(),5);
  assert.equal(await panel.locator('#planner-task-count').textContent(),'5');
  await panel.locator('[data-category="work"]').click();assert.equal(await panel.locator('.planner-reminder').count(),3);assert.equal(await panel.locator('.planner-task').count(),4);
  await advance('2026-10-27T00:03:00');await pet.waitForFunction(()=>document.getElementById('planner-bubble').textContent.includes('个人伸展'));
  const personalRun=(await snapshot()).reminders.find(item=>item.title==='个人伸展').run;
  await panel.locator('[data-category="personal"]').click();
  await panel.locator('.planner-reminder').getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await panel.locator('#planner-item-types').isVisible(),false);await chooseCategory('work');
  await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  assert.equal(await panel.locator('[data-category="work"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual((await snapshot()).reminders.find(item=>item.title==='个人伸展').run,personalRun);
  const movedReminder=panel.locator('.planner-reminder').filter({has:panel.getByRole('heading',{name:'个人伸展',exact:true})});
  await movedReminder.getByRole('button',{name:'编辑',exact:true}).click();await chooseCategory('personal');await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  await panel.locator('.planner-task').getByRole('button',{name:'编辑',exact:true}).click();await chooseCategory('work');
  await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  const movedTask=panel.locator('.planner-task').filter({has:panel.getByRole('heading',{name:'买牛奶',exact:true})});
  await movedTask.getByRole('button',{name:'编辑',exact:true}).click();await chooseCategory('personal');await panel.locator('#planner-item-form [type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('planner-item-dialog').open);
  assert.equal(await panel.locator('.planner-task .planner-category-badge').textContent(),'个人');
  // 筛选可用键盘操作；全部事项同时展示工作和个人，两模块始终存在。
  await panel.locator('[data-category="all"]').focus();await panel.keyboard.press('Enter');
  assert.equal(await panel.locator('[data-category="all"]').getAttribute('aria-pressed'),'true');
  assert.equal(await panel.locator('.planner-reminder').first().getByRole('heading').textContent(),'个人伸展');
  for(const width of [860,1060]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
    assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await panel.locator('#planner-reminders').isVisible(),true);assert.equal(await panel.locator('#planner-tasks').isVisible(),true);
    await panel.locator('#planner-heading').scrollIntoViewIfNeeded();await panel.screenshot({path:path.join(out,`planner-overview-${width}.png`),fullPage:true});
  }
  const saved=await snapshot();await assertWindowPolicy();await app.close();app=null;await launch();
  assert.equal((await snapshot()).reminders.length,4);assert.equal((await snapshot()).tasks.length,5);
  assert.equal(await panel.locator('[data-category="all"]').getAttribute('aria-pressed'),'true');
  await panel.locator('[data-category="personal"]').click();assert.equal(await panel.locator('.planner-reminder').count(),1);assert.equal(await panel.locator('.planner-task').count(),1);
  assert.deepEqual((await snapshot()).tasks,saved.tasks);
  await assertWindowPolicy();assert.deepEqual(errors,[]);console.log('Planner Electron smoke OK: scheduling, IPC, notifications, tasks, persistence, failure recovery, layout and window policy');
}finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
