'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// 只向页面开放桌宠所需的固定操作，不暴露完整 ipcRenderer、文件系统或 Node.js。
contextBridge.exposeInMainWorld('whale', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  action: (name, value) => ipcRenderer.invoke('action', name, value),
  wechat: (name, value) => ipcRenderer.invoke('wechat', name, value),
  // 仅转发固定邮箱通道，调用者身份与实际操作在主进程校验。
  mail: (name, value) => ipcRenderer.invoke('mail', name, value),
  drag: (phase, point) => ipcRenderer.send('pet-drag', phase, point),
  subscribe: callback => ipcRenderer.on('snapshot', (_event, data) => callback(data)),
  showReminders: callback => ipcRenderer.on('show-reminders', callback),
  chime: callback => ipcRenderer.on('chime', callback)
});
