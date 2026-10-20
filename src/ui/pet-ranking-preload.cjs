'use strict';
const {contextBridge, ipcRenderer} = require('electron');
// 榜单窗口只能读取、刷新、调整高度和关闭，不能操作小屋、额度管理或其他通道。
contextBridge.exposeInMainWorld('ranking', {
  snapshot: () => ipcRenderer.invoke('pet-ranking-data'),
  refresh: () => ipcRenderer.invoke('pet-ranking-refresh'),
  resize: height => ipcRenderer.send('pet-ranking-size', height),
  close: () => ipcRenderer.send('pet-ranking-close')
});
