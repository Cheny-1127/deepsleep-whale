'use strict';
// 真实设置页、IPC 和连击计时器；使用临时数据，关闭外部服务和客户端接入。
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');
const root=path.resolve(__dirname,'../..'),preview=process.argv.includes('--preview');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-shortcuts-ui-')),bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({showPanelOnStartup:true,sources:{codex:false,cursor:false},notifications:false,sound:false}));
fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,id==='shortcuts']))));
if(preview)fs.writeFileSync(path.join(dir,'shortcuts.json'),JSON.stringify({doubleClick:'panel',tripleClick:'store-pet',reminderCollapseThreshold:3}));
fs.writeFileSync(bootstrap,`
const electron=require('electron'),NativeWindow=electron.BrowserWindow;
const record=message=>require('node:fs').appendFileSync(${JSON.stringify(path.join(dir,'bootstrap.log'))},String(message)+'\\n');
process.on('uncaughtException',error=>{record(error.stack);electron.app.exit(1);});
process.on('unhandledRejection',error=>{record(error.stack||error);electron.app.exit(1);});
electron.app.whenReady().then(()=>record('ready'));
electron.app.on('browser-window-created',()=>record('window created'));
require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
electron.Notification.isSupported=()=>false;
electron.net.fetch=globalThis.fetch=async()=>{throw Error('快捷操作体验不访问外部网络');};
electron.shell.openExternal=async()=>{throw Error('快捷操作体验不打开外部客户端');};
require(${JSON.stringify(path.join(root,'src/app/quota-config.cjs'))}).readQuotaConfig=()=>({tokenFile:${JSON.stringify(path.join(dir,'missing-token'))},baseUrl:'http://127.0.0.1:1'});
const reports=require(${JSON.stringify(path.join(root,'src/app/work-reports.cjs'))}),createReports=reports.createWorkReports;
reports.createWorkReports=options=>createReports({...options,readEnvironment:()=>({})});
if(process.env.WHALE_SHORTCUTS_PREVIEW==='1')electron.app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',()=>{
  const url=win.webContents.getURL();
  win.setFocusable=NativeWindow.prototype.setFocusable.bind(win);win.setFocusable(true);
  win.focus=NativeWindow.prototype.focus.bind(win);
  if(url.endsWith('/pet.html')||url.endsWith('/pet-storage.html')) {
    win.setAlwaysOnTop=NativeWindow.prototype.setAlwaysOnTop.bind(win);win.setAlwaysOnTop(true);
  }
  if(url.endsWith('/pet.html')){const area=electron.screen.getPrimaryDisplay().workArea;win.setPosition(area.x+90,Math.round(area.y+(area.height-320)/2));}
  if(url.endsWith('/index.html'))void win.webContents.executeJavaScript("document.getElementById('nav-shortcuts').click()").then(()=>console.log('Shortcuts preview ready'));
}));
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
const environment={...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_CURSOR_HOME:dir,
  WHALE_CURSOR_STATE_DB:path.join(dir,'missing-state.vscdb'),WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing-token')};

async function check() {
  const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
  let app,panel,pet;const errors=[];
  async function launch(mode) {
    app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...environment,WHALE_TEST_WINDOWS:mode},timeout:15000});
    app.context().setDefaultTimeout(10000);
    const observe=page=>page.on('pageerror',error=>errors.push(error.message));app.on('window',observe);
    await app.firstWindow({timeout:12000});for(const page of app.windows())observe(page);
    for(let i=0;i<100;i++) {
      panel=app.windows().find(page=>page.url().endsWith('/index.html'));
      pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
      if(panel&&pet)break;await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(panel&&pet);await panel.locator('#nav-shortcuts').click();
    await pet.waitForFunction(()=>document.querySelector('#rice-image').naturalWidth>0);
  }
  const snapshot=()=>panel.evaluate(()=>window.whale.snapshot());
  const rowBackgrounds=()=>panel.locator('.shortcuts-field').evaluateAll(rows=>rows.map(row=>getComputedStyle(row).backgroundColor));
  async function choose(gesture,label) {
    const double=gesture==='double';
    await panel.locator(double?'#shortcuts-double':'#shortcuts-triple').click();
    await panel.locator(double?'#shortcuts-double-options':'#shortcuts-options').getByRole('option',{name:label,exact:true}).click();
    await panel.waitForFunction(()=>document.getElementById('shortcuts-triple').getAttribute('aria-disabled')==='false');
  }
  async function visible() {
    return app.evaluate(({BrowserWindow})=>Object.fromEntries(['index','pet','pet-storage'].map(name=>[name,
      BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/'+name+'.html'))?.isVisible()||false])));
  }
  async function waitFor(predicate) {
    for(let i=0;i<100;i++){const state=await visible();if(predicate(state))return;await new Promise(resolve=>setTimeout(resolve,20));}
    throw Error('快捷操作窗口状态等待超时：'+String(predicate));
  }
  const hidePanel=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).hide());
  async function clickCharacter(count) {
    const box=await pet.locator('#pet-art').boundingBox();
    await pet.mouse.click(box.x+box.width/2,box.y+box.height/2,{clickCount:count,delay:70});
  }
  const waitStorageIcon=hidden=>pet.waitForFunction(hidden=>{
    const button=document.getElementById('pet-store-button');
    return button.hidden===hidden&&(getComputedStyle(button).display==='none')===hidden;
  },hidden);
  try {
    // 第一阶段保持窗口隐藏，检查设置、布局、保存和失败回退。
    await launch('hidden');
    assert.equal((await snapshot()).shortcuts.doubleClick,'none');
    await waitStorageIcon(false);
    for(const [gesture,ids] of [['double',['double-picker','double','double-options']],['triple',['picker','triple','options']]]) {
      const [picker,trigger,options]=ids;
      await panel.locator('#shortcuts-'+trigger).click();
      assert.equal(await panel.locator('#shortcuts-'+options).getByRole('option').count(),7);
      await panel.keyboard.press('Escape');assert.equal(await panel.locator('#shortcuts-'+picker).getAttribute('open'),null);
      await choose(gesture,'打开小屋');
    }
    assert.equal(await panel.locator('#shortcuts-gesture-heading').textContent(),'鼠标操作');
    assert.equal(await panel.locator('#shortcuts-double-label').textContent(),'双击');
    assert.equal(await panel.locator('#shortcuts-label').textContent(),'三连击');
    await panel.locator('#shortcuts-double-hint:not([hidden])').waitFor();
    assert.equal(await panel.locator('#shortcuts-double-hint').textContent(),'与三连击的动作相同');
    assert.equal(await panel.locator('#shortcuts-triple-hint').textContent(),'与双击的动作相同');
    const backgrounds=await rowBackgrounds();
    assert.equal(backgrounds[0],backgrounds[1],'关联的冲突配置行使用相同底色');
    assert.notEqual(backgrounds[0],'rgba(0, 0, 0, 0)','冲突底色应可见');
    await waitStorageIcon(false);
    fs.mkdirSync(path.join(root,'out'),{recursive:true});
    for(const width of [860,1060]) {
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
      for(const [trigger,hint] of [['double','double-hint'],['triple','triple-hint']]) {
        const field=await panel.locator('#shortcuts-'+trigger).boundingBox(),message=await panel.locator('#shortcuts-'+hint).boundingBox();
        assert.ok(message.x>=field.x+field.width,'重复提示放在对应下拉框右侧');
        assert.ok(Math.abs(message.y+message.height/2-field.y-field.height/2)<1,'提示与下拉框垂直居中');
        assert.ok(message.x+message.width<=width,'窄窗口中提示不溢出');
      }
      await panel.screenshot({path:path.join(root,`out/shortcuts-duplicate-${width}.png`)});
      await panel.locator('.shortcuts-card').first().screenshot({path:path.join(root,`out/shortcuts-conflict-${width}.png`)});
    }
    await choose('double','收纳到边缘');await waitStorageIcon(true);
    for(const id of ['double-hint','triple-hint'])assert.equal(await panel.locator('#shortcuts-'+id).isHidden(),true);
    assert.ok((await rowBackgrounds()).every(color=>color==='rgba(0, 0, 0, 0)'),'冲突解除后两行恢复原底色');
    await choose('double','打开小屋');await waitStorageIcon(false);
    await choose('triple','收纳到边缘');
    await waitStorageIcon(true);
    assert.equal((await snapshot()).shortcuts.doubleClick,'panel');assert.equal((await snapshot()).shortcuts.tripleClick,'store-pet');
    // 总开关关闭后手势失效，必须恢复图标入口；重新开启后再隐藏。
    for(const enabled of [false,true]) {
      const result=await panel.evaluate(enabled=>window.whale.modules({id:'shortcuts',enabled}),enabled);
      assert.equal(result.error,undefined);await waitStorageIcon(enabled);
    }
    fs.mkdirSync(path.join(dir,'shortcuts.json.tmp'));
    await choose('double','喂饭');await panel.locator('#shortcuts-error:not([hidden])').waitFor();
    assert.equal(await panel.locator('#shortcuts-double-selected').textContent(),'打开小屋');
    assert.equal((await snapshot()).shortcuts.tripleClick,'store-pet');
    fs.rmdirSync(path.join(dir,'shortcuts.json.tmp'));
    await choose('double','摸摸头');await choose('double','打开小屋');
    assert.equal(await panel.locator('#shortcuts-error').isHidden(),true,'修复存储后可重新保存并清除错误');
    fs.mkdirSync(path.join(root,'out'),{recursive:true});
    for(const width of [860,1060]) {
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
      for(const trigger of ['double','triple']) {
        const picker=trigger==='double'?'double-picker':'picker';
        await panel.locator('#shortcuts-'+trigger).click();
        const menu=await panel.locator('#shortcuts-'+picker+' .ui-select-menu').boundingBox();
        assert.ok(menu.x>=0&&menu.x+menu.width<=width&&menu.y+menu.height<=770);
        await panel.keyboard.press('Escape');
      }
      await panel.screenshot({path:path.join(root,`out/shortcuts-${width}.png`)});
    }
    assert.deepEqual(await app.evaluate(({BrowserWindow})=>({events:testWindowPolicy.events,visible:BrowserWindow.getAllWindows().some(win=>win.isVisible()||win.isFocused()||win.isAlwaysOnTop())})),{events:[],visible:false});
    await app.close();app=null;
    // 第二阶段需要真实可见状态来验证收纳和恢复；复用保存数据，同时验证重启生效。
    await launch('inactive');
    assert.equal((await snapshot()).shortcuts.doubleClick,'panel');assert.equal((await snapshot()).shortcuts.tripleClick,'store-pet');
    await hidePanel();await clickCharacter(2);await waitFor(state=>state.index&&state.pet);
    await hidePanel();await clickCharacter(3);await waitFor(state=>state['pet-storage']&&!state.pet);
    await pet.waitForTimeout(450);assert.equal((await visible()).index,false,'三击收纳不能先执行双击打开小屋');
    const tab=app.windows().find(page=>page.url().endsWith('/pet-storage.html'));
    await tab.locator('#pet-storage-tab').click();await waitFor(state=>state.pet&&!state['pet-storage']);
    await panel.evaluate(()=>window.whale.action('panel'));await choose('triple','不启用（保留默认互动）');
    await waitStorageIcon(false);
    await hidePanel();await clickCharacter(2);await waitFor(state=>state.index);
    await choose('double','不启用（保留默认互动）');
    assert.equal(await panel.locator('#shortcuts-status').textContent(),'未启用');
    for(const id of ['double-hint','triple-hint'])assert.equal(await panel.locator('#shortcuts-'+id).isHidden(),true);
    await hidePanel();await clickCharacter(3);await pet.waitForTimeout(450);
    assert.deepEqual(await visible(),{index:false,pet:true,'pet-storage':false});
    assert.deepEqual(errors,[]);
    console.log('Shortcuts UI OK: duplicate hint, storage icon follows both gestures and module toggle, independent selectors, 860/1060px layout, save rollback, restart persistence, double opens house, triple stores without opening house, double-only and both disabled');
  } catch(error) {
    if(fs.existsSync(path.join(dir,'bootstrap.log')))console.error(fs.readFileSync(path.join(dir,'bootstrap.log'),'utf8'));
    throw error;
  } finally {if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
}

if(preview) {
  const log=fs.openSync(path.join(dir,'preview.log'),'a');
  const child=require('node:child_process').spawn(require('electron'),[bootstrap],{detached:true,stdio:['ignore',log,log],
    env:{...environment,WHALE_TEST_WINDOWS:'inactive',WHALE_SHORTCUTS_PREVIEW:'1'}});
  child.unref();console.log(JSON.stringify({pid:child.pid,dataDir:dir,bootstrap}));
} else check().catch(error=>{console.error(error);process.exitCode=1;});
