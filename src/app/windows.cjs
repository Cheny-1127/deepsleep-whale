'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const SPECIAL_ACTIONS = require('../shared/special-actions.js');

// 此模块只负责 Electron 窗口、菜单和拖动；任务状态和交互规则由应用层传入。
function createWindows({ snapshot, performAction, collapseReminders }) {
  let panel, pet, tray, quitting = false;
  const preferences = () => ({ preload:path.join(__dirname, '../ui/preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true });
  function protect(win) {
    // 页面不接收任意导航，也不能借链接打开具有 Node 权限的新窗口。
    win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }
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
    pet = new BrowserWindow({ width:220, height:320, x:area.x + area.width - 240, y:area.y + area.height - 340,
      transparent:true, frame:false, resizable:false, hasShadow:false, alwaysOnTop:true, skipTaskbar:true, webPreferences:preferences() });
    protect(pet);
    pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:true });
    pet.loadFile(path.join(__dirname, '../ui/pet.html'));
    pet.on('show', updateTrayMenu);
    pet.on('hide', updateTrayMenu);
    pet.on('blur', collapseReminders);
    // 每次右键读取最新快照，小屋按钮与菜单共用应用层的动作入口和锁定规则。
    pet.webContents.on('context-menu', () => {
      const current = snapshot();
      const enabled = current.activity.state !== 'approval' && current.state !== 'feed' && !Object.hasOwn(SPECIAL_ACTIONS, current.state);
      Menu.buildFromTemplate([
        { label:'互动表情', submenu:[['喂饭','feed'], ['摸头','pat'], ['开心','happy'], ['生气','angry']]
          .map(([label, action]) => ({ label, enabled, click:() => performAction(action) })) },
        { label:'小节目', submenu:Object.entries(SPECIAL_ACTIONS)
          .map(([id, clip]) => ({ label:clip.label, enabled, click:() => performAction(id) })) },
        { type:'separator' },
        { label:'打开小屋', click:showPanel },
        { label:'隐藏桌宠', click:() => pet.hide() },
        { type:'separator' },
        { label:'重启', click:restartApp },
        { label:'退出', click:() => app.quit() }
      ]).popup({ window:pet });
    });
    pet.on('close', event => { if (!quitting) { event.preventDefault(); pet.hide(); } });
  }
  function resizePet(data) {
    if (!pet || pet.isDestroyed()) return;
    const bounds = pet.getBounds();
    const view = data.reminderView || (data.busyExpanded ? 'busy' : data.activity.pending ? 'pending' : 'completed');
    const count = view === 'pending' ? data.activity.pending : view === 'busy' ? data.activity.working : data.activity.unread;
    const expanded = view === 'pending' ? count > 0 : view === 'busy' ? data.busyExpanded : data.completionExpanded || (count > 0 && count <= 3);
    const width = data.state === 'fireworks' ? 340 : expanded ? 260 : 220;
    const height = expanded ? (count === 1 ? 380 : 440) : 320;
    if (bounds.width === width && bounds.height === height) return;
    // 提醒向上展开，烟花横向留白；人物倍率和脚底位置保持稳定，并限制在屏幕工作区。
    const area = screen.getDisplayMatching(bounds).workArea;
    const x = Math.max(area.x, Math.min(Math.round(bounds.x + (bounds.width - width) / 2), area.x + area.width - width));
    const y = Math.max(area.y, Math.min(bounds.y + bounds.height - height, area.y + area.height - height));
    pet.setBounds({ ...bounds, x, y, width, height });
  }

  // 只接受悬浮窗发起的拖动；屏幕坐标差避免窗口移动后页面坐标发生反馈抖动。
  let dragOrigin = null;
  ipcMain.on('pet-drag', (event, phase, point) => {
    if (event.sender !== pet?.webContents) return;
    if (phase === 'end') { dragOrigin = null; return; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (phase === 'start') dragOrigin = { mouse:point, bounds:pet.getBounds() };
    else if (phase === 'move' && dragOrigin) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const x = Math.round(dragOrigin.bounds.x + point.x - dragOrigin.mouse.x);
      const y = Math.round(dragOrigin.bounds.y + point.y - dragOrigin.mouse.y);
      const bounds = pet.getBounds();
      pet.setPosition(Math.max(area.x, Math.min(x, area.x + area.width - bounds.width)), Math.max(area.y, Math.min(y, area.y + area.height - bounds.height)));
    }
  });
  app.on('second-instance', showPanel);
  app.on('activate', showPanel);
  app.on('before-quit', () => { quitting = true; });

  return {
    showPanel, showReminders,
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
      for (const win of [panel, pet]) if (win && !win.isDestroyed()) win.webContents.send('snapshot', data);
    },
    chime() { pet.webContents.send('chime'); },
    showPet() { pet.show(); },
    hidePet() { pet.hide(); }
  };
}

module.exports = { createWindows };
