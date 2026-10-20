'use strict';
const {BrowserWindow, ipcMain, screen} = require('electron');
const path = require('node:path');

// 榜单使用独立小窗，避免改变人物几何和透明区域的点击穿透。
function createPetRanking({getPet, snapshot, refresh, protect}) {
  let panel, loading, placement, sequence = 0, active = false;
  function close() {sequence++;active = false;if (panel && !panel.isDestroyed()) panel.hide();}
  async function toggle() {
    if (active) {close();return;}
    const pet = getPet(), request = ++sequence;
    if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
    let art;
    try {art = await pet.webContents.executeJavaScript(`(() => {const r=document.getElementById('pet-art').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);} catch {return;}
    if (request !== sequence || !art || !['left', 'right', 'top', 'bottom'].every(key => Number.isFinite(art[key]))) return;
    if (!panel || panel.isDestroyed()) {
      panel = new BrowserWindow({width:306, height:320, show:false, transparent:true, frame:false, resizable:false,
        hasShadow:false, alwaysOnTop:true, skipTaskbar:true,
        webPreferences:{preload:path.join(__dirname, '../ui/pet-ranking-preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true}});
      protect(panel);panel.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true});
      panel.on('blur', close);
      loading = panel.loadFile(path.join(__dirname, '../ui/pet-ranking.html'));
    }
    try {await loading;} catch {return;}
    if (request !== sequence || pet.isDestroyed() || !pet.isVisible()) return;
    const bounds = pet.getContentBounds(), area = screen.getDisplayMatching(pet.getBounds()).workArea;
    const width = Math.min(306, area.width), height = Math.min(320, area.height), left = bounds.x + art.left - width - 8;
    // 优先放在人物左侧，靠左边缘时翻到右侧，再约束到当前屏幕。
    const x = Math.max(area.x, Math.min(area.x + area.width - width, left >= area.x ? left : bounds.x + art.right + 8));
    const y = Math.max(area.y, Math.min(area.y + area.height - height, bounds.y + art.bottom - height));
    placement = {area, bottom:bounds.y + art.bottom};
    panel.setBounds({x:Math.round(x), y:Math.round(y), width, height});
    active = true;panel.show();panel.focus();
  }
  const ownFrame = event => panel && !panel.isDestroyed() && event.sender === panel.webContents && event.senderFrame === panel.webContents.mainFrame;
  ipcMain.handle('pet-ranking-data', event => {
    if (!ownFrame(event)) throw Error('仅允许在榜单窗口读取排行');
    return snapshot();
  });
  ipcMain.handle('pet-ranking-refresh', event => {
    if (!ownFrame(event)) throw Error('仅允许在榜单窗口刷新排行');
    return refresh();
  });
  ipcMain.on('pet-ranking-close', event => {if (ownFrame(event)) close();});
  ipcMain.on('pet-ranking-size', (event, requested) => {
    if (!ownFrame(event) || !active || !Number.isInteger(requested) || requested < 60 || requested > 400) return;
    const {area, bottom} = placement, bounds = panel.getBounds(), height = Math.min(requested, area.height);
    const y = Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bottom - height)));
    if (height !== bounds.height || y !== bounds.y) panel.setBounds({...bounds, y, height});
  });
  return {toggle, close, isOpen:() => active};
}
module.exports = {createPetRanking};
