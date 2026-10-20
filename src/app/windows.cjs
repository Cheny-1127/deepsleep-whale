'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const {createPetMenu}=require('./pet-menu.cjs');

// 此模块只负责 Electron 窗口、菜单和拖动；任务状态和交互规则由应用层传入。
function createWindows({ snapshot, performAction, collapseReminders }) {
  let panel, pet, tray, quitting = false;
  let dragOrigin=null,petInteractive=false,ignoredMouse;
  const fromPet=event=>Boolean(pet&&!pet.isDestroyed()&&event.sender===pet.webContents&&event.senderFrame===pet.webContents.mainFrame);
  function updatePetMouse() {
    if(!pet||pet.isDestroyed())return;
    const ignore=!petInteractive&&!dragOrigin;
    if(ignore===ignoredMouse)return;
    ignoredMouse=ignore;
    // 保留移动事件，鼠标重新进入人物或气泡时才能恢复点击。
    pet.setIgnoreMouseEvents(ignore,{forward:true});
  }
  function pointerChanged(){if(pet&&!pet.isDestroyed())pet.webContents.send('pet-pointer-changed');}
  const preferences = () => ({ preload:path.join(__dirname, '../ui/preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true });
  function protect(win) {
    // 页面不接收任意导航，也不能借链接打开具有 Node 权限的新窗口。
    win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }
  const petMenu=createPetMenu({getPet:()=>pet,snapshot,performAction,showPanel,restartApp,protect});
  function createPanel() {
    panel = new BrowserWindow({ width:1060, height:770, minWidth:860, minHeight:680, title:'', backgroundColor:'#f5f7f4', webPreferences:preferences() });
    panel.on('page-title-updated', event => { event.preventDefault(); panel.setTitle(''); });
    protect(panel);
    panel.loadFile(path.join(__dirname, '../ui/index.html'));
    panel.on('close', event => { if (!quitting) { event.preventDefault(); panel.hide(); } });
  }
  function showPanel() {
    if (!panel || panel.isDestroyed()) createPanel();
    else { panel.show(); panel.focus(); }
  }
  function showReminders() {
    showPanel();
    const reveal = () => panel.webContents.send('show-reminders');
    if (panel.webContents.isLoadingMainFrame()) panel.webContents.once('did-finish-load', reveal);
    else reveal();
  }
  function restartApp() { app.relaunch(); app.quit(); }
  function updateTrayMenu() {
    if (!tray || tray.isDestroyed() || !pet || pet.isDestroyed()) return;
    const visible = pet.isVisible();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label:'打开小屋', click:showPanel },
      { label:visible ? '隐藏桌宠' : '显示桌宠', click:() => pet.isVisible() ? pet.hide() : pet.show() },
      { type:'separator' },
      { label:'重启', click:restartApp },
      { label:'退出', click:() => app.quit() }
    ]));
  }
  function createPet() {
    const area = screen.getPrimaryDisplay().workArea;
    // macOS 无边框窗口还需关闭原生屏幕约束，否则向上移动仍会停在菜单栏下方。
    pet = new BrowserWindow({ width:220, height:320, x:area.x + area.width - 240, y:area.y + area.height - 340,
      transparent:true, frame:false, resizable:false, enableLargerThanScreen:true, hasShadow:false, alwaysOnTop:true, skipTaskbar:true, webPreferences:preferences() });
    protect(pet);
    updatePetMouse();
    pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:true });
    pet.loadFile(path.join(__dirname, '../ui/pet.html'));
    pet.on('show', () => {pointerChanged();updateTrayMenu();});
    pet.on('hide', () => {dragOrigin=null;updatePetMouse();petMenu.close();updateTrayMenu();});
    // 焦点进入自绘菜单不折叠提醒，避免人物几何在弹出过程中变化。
    pet.on('blur', () => {dragOrigin=null;updatePetMouse();pointerChanged();if(!petMenu.isOpen())collapseReminders();});
    pet.on('move',()=>{petMenu.close();pointerChanged();});
    pet.on('resize',()=>{petMenu.close();pointerChanged();});
    pet.webContents.on('context-menu',petMenu.open);
    pet.on('close', event => { if (!quitting) { event.preventDefault(); pet.hide(); } });
  }
  function resizePet(data) {
    if (!pet || pet.isDestroyed()) return;
    const bounds = pet.getBounds();
    // 分类及展开规则与提醒视图一致，避免自动展示的列表被收起尺寸的窗口裁切。
    const view = data.reminderView || (data.busyExpanded ? 'busy' : data.activity.pending ? 'pending' : data.activity.unread ? 'completed' : data.activity.working ? 'busy' : 'completed');
    const count = view === 'pending' ? data.activity.pending : view === 'busy' ? data.activity.working : data.activity.unread;
    const expanded = view === 'pending' ? count > 0 : (view === 'busy' ? data.busyExpanded : data.completionExpanded) || (count > 0 && count <= 3);
    const width = data.state === 'fireworks' ? 340 : expanded ? 260 : 220;
    const height = expanded ? (count === 1 ? 380 : 440) : 320;
    if (bounds.width === width && bounds.height === height) return;
    // 提醒向上展开，烟花横向留白；只保持人物中心与脚底，不把用户选择的位置拉回屏幕内。
    const x = Math.round(bounds.x + (bounds.width - width) / 2);
    const y = bounds.y + bounds.height - height;
    pet.setBounds({ ...bounds, x, y, width, height });
  }

  // 只接受悬浮窗发起的拖动；按屏幕坐标差自由移动，允许气泡或人物部分移出屏幕。
  ipcMain.on('pet-interactive',(event,value)=>{
    if(!fromPet(event)||typeof value!=='boolean')return;
    petInteractive=value;updatePetMouse();
  });
  ipcMain.handle('pet-pointer',event=>{
    if(!fromPet(event)||!pet.isVisible())return null;
    const point=screen.getCursorScreenPoint(),bounds=pet.getContentBounds();
    return {x:point.x-bounds.x,y:point.y-bounds.y};
  });
  ipcMain.on('pet-drag', (event, phase, point) => {
    if (!fromPet(event)) return;
    if (phase === 'end') { dragOrigin = null;updatePetMouse(); return; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    // 以按下时的鼠标与窗口位置为基准，避免窗口移动后重复叠加位移造成跳动。
    if (phase === 'start') {dragOrigin = { mouse:point, bounds:pet.getBounds() };updatePetMouse();}
    else if (phase === 'move' && dragOrigin) {
      const x = Math.round(dragOrigin.bounds.x + point.x - dragOrigin.mouse.x);
      const y = Math.round(dragOrigin.bounds.y + point.y - dragOrigin.mouse.y);
      pet.setPosition(x,y);
    }
  });
  app.on('second-instance', showPanel);
  app.on('activate', showPanel);
  app.on('before-quit', () => { quitting = true;petMenu.close(); });

  return {
    showPanel, showReminders,
    isPetVisible:()=>Boolean(pet&&!pet.isDestroyed()&&pet.isVisible()),
    isPanel:sender=>sender===panel?.webContents,
    isPet:sender=>sender===pet?.webContents,
    start() {
      createPanel(); createPet();
      const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/icon.png')).resize({ width:20, height:20 });
      tray = new Tray(icon);
      tray.setToolTip('鲸鱼娘');
      updateTrayMenu();
      tray.on('click', showPanel);
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ label:'鲸鱼娘', submenu:[{ role:'about' }, { type:'separator' }, { role:'quit' }] }, { role:'editMenu' }, { role:'windowMenu' }]));
    },
    broadcast(data) {
      resizePet(data);
      petMenu.refresh();
      for (const win of [panel, pet]) if (win && !win.isDestroyed()) win.webContents.send('snapshot', data);
    },
    chime() { pet.webContents.send('chime'); },
    showPet() { pet.show(); },
    hidePet() { pet.hide(); }
  };
}

module.exports = { createWindows };
