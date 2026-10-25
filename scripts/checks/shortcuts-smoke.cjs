'use strict';
// 使用现有 Playwright 安装验证真实浏览器计时器、点击事件和窗口打开行为。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const dir=fs.mkdtempSync('/tmp/whale-shortcuts-ui-');
const bootstrap=path.join(dir,'bootstrap.cjs');
// 隔离测试数据及 Archery 配置，不读取真实账号或连接生产服务。
fs.writeFileSync(bootstrap,`const {Notification}=require('electron');Notification.isSupported=()=>false;
const channel=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),create=channel.createArcheryPending;
channel.createArcheryPending=options=>create({...options,readConfig:()=>{throw Object.assign(new Error('测试隔离'),{archeryConfig:true});}});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing-token')}});
  const errors=[];
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  await app.firstWindow();
  let panel,pet;
  for(let i=0;i<100;i++) {
    panel=app.windows().find(page=>page.url().endsWith('/index.html'));
    pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
    if(panel&&pet)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(panel);assert.ok(pet);
  await app.evaluate(({BrowserWindow})=>{
    for(const win of BrowserWindow.getAllWindows()){
      if(win.webContents.getURL().endsWith('/pet.html'))win.hide();
      if(win.webContents.getURL().endsWith('/index.html')){win.show();win.focus();}
    }
  });
  await panel.locator('#nav-shortcuts').click();
  const picker=panel.locator('#shortcuts-picker'),trigger=panel.locator('#shortcuts-triple');
  await trigger.click();
  assert.equal(await picker.getAttribute('open'),'');
  assert.equal(await panel.getByRole('listbox',{name:'执行动作',exact:true}).getByRole('option').count(),6);
  assert.equal(await panel.getByRole('option',{selected:true}).textContent(),'打开小屋✓');
  await panel.waitForFunction(()=>document.activeElement?.getAttribute('aria-selected')==='true');
  await panel.keyboard.press('ArrowDown');await panel.keyboard.press('Enter');
  await panel.waitForFunction(()=>document.getElementById('shortcuts-selected').textContent==='摸摸头'&&document.getElementById('shortcuts-triple').getAttribute('aria-disabled')==='false');
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).shortcuts.tripleClick,'pat');
  await trigger.click();await panel.getByRole('option',{name:'打开小屋',exact:true}).click();
  await panel.waitForFunction(()=>document.getElementById('shortcuts-selected').textContent==='打开小屋'&&document.getElementById('shortcuts-triple').getAttribute('aria-disabled')==='false');
  for(const width of [860,1060]){
    await app.evaluate(({BrowserWindow},value)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(value,770),width);
    await trigger.click();
    const menu=await panel.locator('#shortcuts-picker .ui-select-menu').boundingBox(),field=await trigger.boundingBox();
    assert.equal(Math.round(menu.width),Math.round(field.width),'菜单与控件等宽');
    assert.ok(menu.x>=0&&menu.x+menu.width<=width&&menu.y+menu.height<=770,'展开菜单位于窗口内');
    await panel.screenshot({path:`/tmp/whale-shortcuts-menu-${width}.png`});
    await panel.keyboard.press('Escape');assert.equal(await picker.getAttribute('open'),null);
    assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  }
  await trigger.click();await panel.locator('#shortcuts-heading').click();
  assert.equal(await picker.getAttribute('open'),null,'点击菜单外部收起');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).show());
  await pet.waitForFunction(()=>document.querySelector('#rice-image').naturalWidth>0);
  assert.equal((await pet.evaluate(()=>window.whale.snapshot())).shortcuts.tripleClick,'panel');
  const panelVisible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).isVisible());
  async function hidePanel() {
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).hide());
    await pet.bringToFront();
  }
  async function clickCharacter(clickCount=1) {
    const box=await pet.locator('#pet-art').boundingBox();
    await pet.mouse.click(box.x+box.width/2,box.y+box.height/2,{clickCount,delay:70});
  }
  await hidePanel();
  await clickCharacter(3);
  for(let i=0;i<20&&!await panelVisible();i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(await panelVisible(),true,'三连击应打开小屋');
  assert.deepEqual(errors,[],'真实点击不应出现浏览器错误');
  await hidePanel();
  await clickCharacter();
  await pet.waitForTimeout(450);
  assert.equal(await panelVisible(),false,'单击不应打开小屋');
  // 禁用后再次三连击，确认实际窗口使用更新后的配置。
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).show());
  await panel.locator('#nav-shortcuts').click();await trigger.click();
  await panel.getByRole('option',{name:'不启用（保留默认互动）',exact:true}).click();
  await panel.waitForFunction(()=>document.getElementById('shortcuts-status').textContent==='未启用');
  await pet.waitForFunction(async()=>(await window.whale.snapshot()).shortcuts.tripleClick==='none');
  await hidePanel();await clickCharacter(3);await pet.waitForTimeout(450);
  assert.equal(await panelVisible(),false,'禁用后不应打开小屋');
  assert.deepEqual(errors,[]);
  console.log('Shortcuts UI smoke OK: styled dropdown at 860/1060px, selection, keyboard, Escape/outside close, auto-save, real triple click and disabled binding');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(app)await app.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
