'use strict';
const {contextBridge, ipcRenderer} = require('electron');
// 榜单窗口只能读取、刷新、选择消费分组、调整高度和关闭。
contextBridge.exposeInMainWorld('ranking', {
  snapshot: () => ipcRenderer.invoke('pet-ranking-data'),
  onOpen: callback => ipcRenderer.on('pet-ranking-open', callback),
  refresh: () => ipcRenderer.invoke('pet-ranking-refresh'),
  selectGroup: groupId => ipcRenderer.invoke('pet-ranking-select', groupId),
  resize: height => ipcRenderer.send('pet-ranking-size', height),
  close: () => ipcRenderer.send('pet-ranking-close')
});
