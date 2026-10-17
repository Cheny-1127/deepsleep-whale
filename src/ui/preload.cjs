'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// 只向页面开放桌宠所需的固定操作，不暴露完整 ipcRenderer、文件系统或 Node.js。
contextBridge.exposeInMainWorld('whale', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  action: (name, value) => ipcRenderer.invoke('action', name, value),
  drag: (phase, point) => ipcRenderer.send('pet-drag', phase, point),
  subscribe: callback => ipcRenderer.on('snapshot', (_event, data) => callback(data)),
  showReminders: callback => ipcRenderer.on('show-reminders', callback),
  chime: callback => ipcRenderer.on('chime', callback)
});
