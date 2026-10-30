'use strict';
// 隔离用户配置与外部服务，使用真实 Electron 指针事件和主进程持久化。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-sidebar-ui-'),bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(path.join(dir,'archery.json'),JSON.stringify({enabled:false}));
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({sources:{codex:false,cursor:false}}));
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();const {Notification}=require('electron');Notification.isSupported=()=>false;
const channel=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),create=channel.createArcheryPending;
channel.createArcheryPending=options=>create({...options,readConfig:()=>{throw Object.assign(new Error('测试隔离'),{archeryConfig:true});}});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app,panel;const errors=[];
async function launch() {
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_TEST_WINDOWS:'hidden',WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing-token')}});
  await app.firstWindow();
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);panel.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows()){if(win.webContents.getURL().endsWith('/pet.html'))win.hide();else if(win.webContents.getURL().endsWith('/index.html')){win.setSize(1060,900);win.show();win.focus();}}});
  await panel.waitForFunction(()=>document.getElementById('sidebar-organize')?.disabled===false);
}
const state=()=>panel.evaluate(()=>window.whale.sidebar());
const order=()=>panel.locator('#sidebar-visible > .sidebar-row').evaluateAll(rows=>rows.map(row=>row.dataset.menu));
async function settled(){await panel.waitForFunction(()=>document.querySelector('.sidebar nav').getAttribute('aria-busy')==='false');}
async function hold(id) {
  const button=panel.locator('#nav-'+id);
  await button.evaluate(el=>Promise.all(el.closest('nav').getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))));
  await button.scrollIntoViewIfNeeded();const box=await button.boundingBox();
  await panel.mouse.move(box.x+box.width/2,box.y+box.height/2);await panel.mouse.down();
  await panel.waitForSelector('.sidebar-drag-ghost');return box;
}
(async()=>{
  await launch();const initial=await state();
  // 选中与未选中菜单共用图标画布和线宽，图标与文字垂直居中，文字起点一致。
  const iconMetrics=await panel.locator('.sidebar .nav-item').evaluateAll(buttons=>buttons.map(button=>{
    const icon=button.querySelector('.sidebar-icon'),label=button.querySelector('.sidebar-menu-label');
    const rect=icon.getBoundingClientRect(),text=label.getBoundingClientRect(),row=button.getBoundingClientRect(),style=getComputedStyle(icon);
    return {width:rect.width,height:rect.height,stroke:style.strokeWidth,textOffset:text.left-row.left,centerOffset:Math.abs(rect.top+rect.height/2-text.top-text.height/2)};
  }));
  assert.equal(iconMetrics.length,10);
  assert.equal(new Set(iconMetrics.map(icon=>`${icon.width}/${icon.height}/${icon.stroke}`)).size,1,'所有功能图标规格一致');
  assert.equal(new Set(iconMetrics.map(icon=>icon.textOffset)).size,1,'所有菜单文字起点一致');
  assert.ok(iconMetrics.every(icon=>icon.centerOffset<1),'图标与文字垂直居中');
  // 未打开页面时即显示已保存的暂停/未配置状态；暂停入口仍可点击恢复。
  for(const [id,status] of [['archery','已暂停'],['hooks','已暂停'],['mail','未配置'],['wechat','未连接'],['subscriptions','未订阅']]) {
    await panel.waitForFunction(({id,status})=>document.getElementById('nav-'+id).dataset.status===status,{id,status});
    assert.equal(await panel.locator('#nav-'+id).isEnabled(),true);
  }
  assert.notEqual(await panel.locator('#nav-archery').evaluate(el=>getComputedStyle(el).color),await panel.locator('#nav-home').evaluate(el=>getComputedStyle(el).color));
  await panel.locator('#nav-archery').click();
  const pausedIconColor=await panel.locator('#nav-archery .sidebar-icon').evaluate(el=>getComputedStyle(el).color);
  await panel.locator('#archery-status').click();
  await panel.waitForFunction(()=>document.getElementById('nav-archery').dataset.status==='');
  assert.notEqual(await panel.locator('#nav-archery .sidebar-icon').evaluate(el=>getComputedStyle(el).color),pausedIconColor,'开启后图标使用开启色');
  await panel.waitForFunction(()=>!document.getElementById('archery-status').disabled);
  await panel.locator('#archery-status').click();
  await panel.waitForFunction(()=>document.getElementById('nav-archery').dataset.status==='已暂停');
  assert.equal(await panel.locator('#nav-archery .sidebar-icon').evaluate(el=>getComputedStyle(el).color),pausedIconColor,'暂停后恢复停用色，选中页面不覆盖开关状态');
  await panel.locator('#nav-hooks').click();assert.equal(await panel.locator('#hooks-view').isVisible(),true);
  // 长按只进入整理，跨越多项后邻项让位；松手不能打开被拖项。
  await hold('home');const target=await panel.locator('#nav-wechat').boundingBox();
  await panel.mouse.move(target.x+50,target.y+target.height-3,{steps:12});
  await panel.waitForFunction(()=>document.querySelector('#sidebar-visible').children[4]?.dataset.menu==='home');
  await panel.screenshot({path:'/tmp/whale-sidebar-drag.png'});
  await panel.mouse.up();await settled();assert.equal((await state()).visible[4],'home');assert.equal(await panel.locator('#hooks-view').isVisible(),true);
  const arranged=await state();
  await hold('subscriptions');await panel.mouse.move(target.x+50,target.y+target.height,{steps:8});await panel.keyboard.press('Escape');await panel.mouse.up();
  assert.deepEqual(await order(),arranged.visible);assert.deepEqual(await state(),arranged);
  await panel.keyboard.press('Escape');assert.equal(await panel.locator('.sidebar-editing').count(),0);
  // 按下后立刻移动不会误进入长按整理。
  const box=await panel.locator('#nav-home').boundingBox();await panel.mouse.move(box.x+20,box.y+20);await panel.mouse.down();await panel.mouse.move(box.x+40,box.y+20);await panel.waitForTimeout(500);assert.equal(await panel.locator('.sidebar-drag-ghost').count(),0);await panel.mouse.up();
  await panel.locator('#nav-hooks').click();
  await panel.locator('#sidebar-organize').click();
  await panel.getByRole('button',{name:'收进更多：Hooks 配置',exact:true}).click();await settled();
  assert.equal(await panel.locator('#hooks-view').isVisible(),true);assert.match(await panel.locator('#sidebar-more-toggle').getAttribute('aria-label'),/当前/);
  await panel.getByRole('button',{name:'收进更多：Archery',exact:true}).click();await settled();
  await panel.locator('#sidebar-more-toggle').click();
  for(const width of [860,1060]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,900),width);
    const metrics=await panel.evaluate(()=>{
      const common=document.querySelector('#nav-home'),child=document.querySelector('#nav-archery'),heading=document.querySelector('#sidebar-more-toggle');
      const a=common.getBoundingClientRect(),b=child.getBoundingClientRect();
      return {fonts:[common,child,heading].map(el=>getComputedStyle(el).fontSize),weights:[common,child,heading].map(el=>getComputedStyle(el).fontWeight),indent:b.left-a.left,heights:[common,child,document.querySelector('#nav-hooks')].map(el=>el.getBoundingClientRect().height)};
    });
    assert.deepEqual(metrics.fonts,['13px','13px','13px'],'常用菜单、收纳菜单和更多入口使用原有统一字号');assert.deepEqual(metrics.weights,['500','500','500']);assert.ok(metrics.indent>=24,'收纳项保留原缩进');
    assert.equal(new Set(metrics.heights).size,1,'缩进后长菜单保持单行 '+JSON.stringify(metrics));
    for(const mode of ['editing','normal']) {
      if(mode==='normal')await panel.locator('#sidebar-organize').click();
      const clip=await panel.evaluate(()=>{const sidebar=document.querySelector('.sidebar').getBoundingClientRect(),label=document.querySelector('.nav-label').getBoundingClientRect(),nav=document.querySelector('.sidebar nav').getBoundingClientRect();return {x:sidebar.x,y:label.y-8,width:sidebar.width,height:nav.bottom-label.y+16};});
      await panel.screenshot({path:`/tmp/whale-sidebar-hierarchy-${width}-${mode}.png`,clip,animations:'disabled'});
      const badge=panel.locator('#nav-hooks .sidebar-status');
      assert.equal(await badge.textContent(),'已暂停','保留读屏状态说明');
      assert.equal(await badge.evaluate(el=>getComputedStyle(el,'::before').content),'none','菜单不显示状态符号');
      assert.notEqual(await panel.locator('#nav-archery').evaluate(el=>getComputedStyle(el).backgroundColor),await panel.locator('#nav-home').evaluate(el=>getComputedStyle(el).backgroundColor),'收纳区通过背景区分暂停状态');
      assert.equal(await panel.locator('#nav-hooks').getAttribute('title'),'已暂停 · 点击查看或设置 · 长按整理菜单');
      assert.equal(await panel.locator('#nav-hooks .sidebar-menu-label').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'收纳菜单名保持完整');
      assert.ok(await panel.locator('#sidebar-visible .sidebar-menu-label').evaluateAll(labels=>labels.every(el=>el.scrollWidth<=el.clientWidth)),'常用菜单长名称完整显示');
      if(mode==='normal')await panel.locator('#sidebar-organize').click();
    }
  }
  await hold('archery');const hiddenTarget=await panel.locator('#nav-hooks').boundingBox();
  await panel.mouse.move(hiddenTarget.x+50,hiddenTarget.y+3,{steps:8});
  await panel.waitForFunction(()=>document.querySelector('#sidebar-more-list').firstElementChild.dataset.menu==='archery');
  await panel.mouse.up();await settled();assert.deepEqual((await state()).more,['archery','hooks']);
  // 失焦取消未提交的拖动，已保存布局保持不变。
  const beforeBlur=await state();await hold('hooks');await panel.evaluate(()=>window.dispatchEvent(new Event('blur')));await panel.mouse.up();
  assert.deepEqual(await state(),beforeBlur);assert.equal(await panel.locator('.sidebar-drag-ghost').count(),0);

  await panel.locator('#nav-archery').click();assert.equal(await panel.locator('#archery-view').isVisible(),true);
  await panel.getByRole('button',{name:'移回常用：Hooks 配置',exact:true}).click();await settled();assert.equal((await state()).visible.at(-1),'hooks');
  // 保存失败回滚：只破坏测试目录的临时文件位置，绝不触碰真实配置。
  fs.mkdirSync(path.join(dir,'sidebar.json.tmp'));
  const beforeFailure=await state();await panel.getByRole('button',{name:'移回常用：Archery',exact:true}).click();await settled();
  assert.match(await panel.locator('#sidebar-feedback').textContent(),/保存失败/);assert.deepEqual(await state(),beforeFailure);assert.equal(await panel.locator('#sidebar-more-list #nav-archery').count(),1);
  fs.rmdirSync(path.join(dir,'sidebar.json.tmp'));
  // 键盘整理和小窗口布局。
  await panel.locator('#sidebar-organize').click();await panel.locator('#nav-hooks').focus();await panel.keyboard.press('Alt+ArrowUp');await settled();
  assert.equal((await state()).visible.at(-2),'hooks');await panel.keyboard.press('Escape');
  for(const width of [860,1060]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
    await panel.locator('.side-bottom').scrollIntoViewIfNeeded();
    const geometry=await panel.locator('.sidebar').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,bottom:el.querySelector('.side-bottom').getBoundingClientRect().bottom,height:innerHeight}));
    assert.ok(geometry.scrollWidth<=geometry.width,'侧栏无水平溢出');assert.ok(geometry.bottom<=geometry.height,'底部入口可滚动到窗口内');
    await panel.locator('.sidebar').evaluate(el=>el.scrollTop=0);await panel.screenshot({path:`/tmp/whale-sidebar-${width}.png`});
  }
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.sidebar();return false;}catch{return true;}}),true,'桌宠窗口不能读取或修改菜单布局');
  const final=await state();await app.close();app=null;panel=null;await launch();assert.deepEqual(await state(),final);assert.deepEqual(await order(),final.visible);
  // 全部收纳时，更多入口仍然可用。
  await panel.locator('#sidebar-organize').click();
  for(const id of final.visible){await panel.locator(`[data-menu="${id}"] > .sidebar-transfer`).click();await settled();}
  assert.equal((await state()).visible.length,0);await panel.locator('#sidebar-more-toggle').click();assert.equal(await panel.locator('#sidebar-more-list > .sidebar-row').count(),initial.visible.length);
  await panel.getByRole('button',{name:'移回常用：陪伴小屋',exact:true}).click();await settled();assert.deepEqual((await state()).visible,['home']);
  assert.deepEqual(errors,[]);console.log('Sidebar smoke OK: drag, cancel, collect/restore, keyboard, rollback, restart, layouts and IPC guard');
})().finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}).catch(error=>{console.error(error);process.exitCode=1;});
