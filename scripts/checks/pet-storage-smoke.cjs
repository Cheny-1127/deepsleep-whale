'use strict';
// 只启动真实窗口层和本地动画，不加载账号、Hooks 或外部业务服务。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const preview=process.argv.includes('--preview');

async function boot() {
  const electron=require('electron'),{app,ipcMain}=electron,NativeWindow=electron.BrowserWindow;
  app.setPath('userData',process.env.WHALE_DATA_DIR);
  require('./test-window-policy.cjs').installTestWindowPolicy();
  // 体验实例从创建起隐藏；加载后才恢复真实置顶和键盘操作，不影响日常实例。
  if(preview)app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',()=>{
    win.setAlwaysOnTop=NativeWindow.prototype.setAlwaysOnTop.bind(win);
    win.setFocusable=NativeWindow.prototype.setFocusable.bind(win);
    win.focus=NativeWindow.prototype.focus.bind(win);
    win.setAlwaysOnTop(true);win.setFocusable(true);
  }));
  await app.whenReady();
  const {createWindows}=require('../../src/app/windows.cjs');
  const data={state:'idle',revision:1,demo:false,cycle:false,modules:{subscriptions:true},
    activity:{state:'idle',count:0,working:0,pending:0,unread:0,sessions:[],notices:[]},
    planner:{active:[],items:[]},subscriptions:{unread:0},shortcuts:{tripleClick:'none'},
    nurture:{satiety:80,affection:80,totalWorkSessions:0},settings:{notifications:false,sound:false,showPanelOnStartup:false}};
  const snapshot=()=>({...data,petVisible:windows.isPetVisible()});
  async function performAction(name) {
    if(name==='store-pet')await windows.storePet();
    else if(name==='restore-pet'||name==='show-pet')windows.showPet();
    else if(name==='hide-pet')windows.hidePet();
    windows.broadcast(snapshot());return snapshot();
  }
  const windows=createWindows({snapshot,performAction,collapseReminders(){}});
  ipcMain.handle('snapshot',snapshot);
  ipcMain.handle('action',(_event,name)=>performAction(name));
  ipcMain.handle('pet-quota',()=>({value:{tracking:null,extraTrackings:[]}}));
  windows.start({showPanelOnStartup:false});
  global.fixture={windows,data,snapshot};
  if(preview) {
    const area=electron.screen.getPrimaryDisplay().workArea;
    const pet=NativeWindow.getAllWindows()[0];
    pet.setPosition(area.x+90,Math.round(area.y+(area.height-320)/2));
    if(pet.webContents.isLoadingMainFrame())await new Promise(resolve=>pet.webContents.once('did-finish-load',resolve));
    pet.showInactive();console.log('Pet storage preview ready');
  }
}

async function check() {
  const assert=require('node:assert/strict');
  const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-storage-'));
  // 验证依赖原生 isVisible 和窗口切换，因此用独立的非激活观察实例。
  const app=await electron.launch({executablePath:require('electron'),args:[__filename],
    env:{...process.env,WHALE_DATA_DIR:dir,WHALE_TEST_WINDOWS:'inactive'}});
  const errors=[];
  const observe=page=>page.on('pageerror',error=>errors.push(error.message));
  app.on('window',observe);for(const page of app.windows())observe(page);
  const info=()=>app.evaluate(({BrowserWindow,screen})=>{
    const find=name=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/'+name+'.html'));
    const pet=find('pet'),tab=find('pet-storage');
    return {pet:{visible:pet.isVisible(),bounds:pet.getBounds()},tab:tab?{visible:tab.isVisible(),bounds:tab.getBounds(),area:screen.getDisplayMatching(tab.getBounds()).workArea}:null,
      house:Boolean(find('index'))};
  });
  async function waitFor(predicate) {
    for(let i=0;i<100;i++){const state=await info();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,20));}
    throw Error('窗口状态等待超时：'+String(predicate));
  }
  try {
    const pet=await app.firstWindow();await pet.waitForSelector('#rice-image[src]');
    await waitFor(state=>state.pet.visible);
    const before=await info();
    await pet.locator('#pet-art').hover();
    assert.equal(await pet.locator('#pet-store-button').evaluate(el=>getComputedStyle(el).pointerEvents),'auto');
    const button=await pet.locator('#pet-store-button').boundingBox();
    assert.ok(button.x>=0&&button.x+button.width<=before.pet.bounds.width,'收纳按钮不能被窗口裁切');
    await pet.locator('#pet-store-button').click();
    const stored=await waitFor(state=>state.tab?.visible&&!state.pet.visible);
    assert.equal(stored.house,false);
    assert.equal(stored.tab.bounds.width,34);assert.equal(stored.tab.bounds.height,64);
    const tab=app.windows().find(page=>page.url().endsWith('/pet-storage.html'));
    await tab.locator('#pet-storage-tab').waitFor();
    await tab.waitForFunction(()=>document.body.dataset.side==='right');
    fs.mkdirSync(path.join(root,'out'),{recursive:true});
    await tab.screenshot({path:path.join(root,'out/pet-storage-right.png'),animations:'disabled'});
    await app.evaluate(()=>{
      fixture.data.activity.unread=1;fixture.data.activity.notices=[{id:'sample',session_id:'sample',title:'测试任务完成'}];
      fixture.windows.broadcast(fixture.snapshot());
    });
    await tab.waitForFunction(()=>!document.getElementById('attention').hidden);
    const notified=await info();assert.deepEqual(notified.pet,stored.pet);assert.deepEqual(notified.tab.bounds,stored.tab.bounds);
    assert.equal(notified.house,false);
    await app.evaluate(()=>{fixture.data.activity.unread=0;fixture.data.activity.notices=[];fixture.windows.broadcast(fixture.snapshot());});
    await tab.waitForFunction(()=>document.getElementById('attention').hidden);
    // 真实指针捕获覆盖跨边缘拖动；松手应吸边并继续保持收纳。
    const targetX=stored.tab.area.x+5;
    await tab.mouse.move(14,36);await tab.mouse.down();
    await tab.mouse.move(targetX-stored.tab.bounds.x,-4);await tab.mouse.up();
    const moved=await waitFor(state=>state.tab.visible&&!state.pet.visible&&state.tab.bounds.x===stored.tab.area.x);
    await tab.waitForFunction(()=>document.body.dataset.side==='left');
    assert.ok(moved.tab.bounds.y>=moved.tab.area.y);
    await tab.screenshot({path:path.join(root,'out/pet-storage-left.png'),animations:'disabled'});
    await tab.locator('#pet-storage-tab').click();
    const restored=await waitFor(state=>state.pet.visible&&!state.tab.visible);
    assert.deepEqual(restored.pet.bounds,before.pet.bounds);assert.equal(restored.house,false);
    const area=stored.tab.area,centerX=Math.round(area.x+(area.width-220)/2),centerY=Math.round(area.y+(area.height-320)/2);
    const positions={left:{x:area.x+8,y:centerY},right:{x:area.x+area.width-228,y:centerY},
      top:{x:centerX,y:area.y+8},bottom:{x:centerX,y:area.y+area.height-328}};
    for(const [side,position] of Object.entries(positions)) {
      await app.evaluate(({BrowserWindow},position)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).setPosition(position.x,position.y),position);
      await pet.locator('#pet-art').hover();await pet.locator('#pet-store-button').click();
      await waitFor(state=>state.tab.visible&&!state.pet.visible);
      await tab.waitForFunction(side=>document.body.dataset.side===side,side);
      const current=await info(),horizontal=['top','bottom'].includes(side);
      assert.equal(current.tab.bounds.width,horizontal?64:34);assert.equal(current.tab.bounds.height,horizontal?34:64);
      assert.ok(current.tab.bounds.x>=area.x&&current.tab.bounds.y>=area.y&&current.tab.bounds.x+current.tab.bounds.width<=area.x+area.width&&current.tab.bounds.y+current.tab.bounds.height<=area.y+area.height);
      await tab.screenshot({path:path.join(root,`out/pet-storage-${side}.png`),animations:'disabled'});
      await tab.locator('#pet-storage-tab').press('Enter');
      const returned=await waitFor(state=>state.pet.visible&&!state.tab.visible);
      assert.equal(returned.pet.bounds.x,position.x);assert.equal(returned.pet.bounds.y,position.y);
    }
    await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).setBounds(bounds),before.pet.bounds);
    const driver=require('./pet-menu-driver.cjs')(app,pet);
    let menu=await driver.open();
    await menu.getByRole('menuitem',{name:'收纳到边缘',exact:true}).click();
    await waitFor(state=>state.tab.visible&&!state.pet.visible);
    await tab.locator('#pet-storage-tab').click({button:'right'});
    await menu.getByRole('menuitem',{name:'恢复桌宠',exact:true}).waitFor();
    assert.equal(await menu.getByRole('menuitem',{name:'互动表情',exact:true}).count(),0);
    await menu.getByRole('menuitem',{name:'恢复桌宠',exact:true}).click();
    await waitFor(state=>state.pet.visible&&!state.tab.visible);
    await pet.locator('#pet-art').hover();
    await pet.screenshot({path:path.join(root,'out/pet-storage-button.png')});
    assert.equal((await info()).house,false);assert.deepEqual(errors,[]);
    console.log('Pet storage OK: four edges and orientation, character movement overrides old dock, keyboard/click restore, hover button, unread indicator, drag/snap, both menus, house stays closed');
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
}

if(process.versions.electron)boot().catch(error=>{console.error(error);require('electron').app.exit(1);});
else if(preview) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-storage-preview-'));
  const child=require('node:child_process').spawn(require('electron'),[__filename,'--preview'],{
    detached:true,stdio:['ignore',fs.openSync(path.join(dir,'preview.log'),'a'),fs.openSync(path.join(dir,'preview.log'),'a')],
    env:{...process.env,WHALE_DATA_DIR:dir,WHALE_TEST_WINDOWS:'inactive'}});
  child.unref();console.log(JSON.stringify({pid:child.pid,dataDir:dir}));
} else check().catch(error=>{console.error(error);process.exitCode=1;});
