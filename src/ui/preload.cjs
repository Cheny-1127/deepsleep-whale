'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// 只向页面开放桌宠所需的固定操作，不暴露完整 ipcRenderer、文件系统或 Node.js。
contextBridge.exposeInMainWorld('whale', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  action: (name, value) => ipcRenderer.invoke('action', name, value),
  openChat: value => ipcRenderer.invoke('open-chat', value),
  wechat: (name, value) => ipcRenderer.invoke('wechat', name, value),
  // 仅转发固定邮箱通道，调用者身份与实际操作在主进程校验。
  mail: (name, value) => ipcRenderer.invoke('mail', name, value),
  // Archery 凭据留在主进程；界面只接收主进程校验后的逐笔确认请求。
  archery: (name, value) => ipcRenderer.invoke('archery', name, value),
  onArcheryConfirmation: callback => ipcRenderer.on('archery-confirmation', (_event, data) => callback(data)),
  subscriptions: (name, value) => ipcRenderer.invoke('message-subscriptions', name, value),
  quota: (name, value) => ipcRenderer.invoke('quota', name, value),
  quotaGroup: (name, value) => ipcRenderer.invoke('quota-group', name, value),
  petQuota: (name, value) => ipcRenderer.invoke('pet-quota', name, value),
  sidebar: value => ipcRenderer.invoke('sidebar-settings', value),
  modules: value => ipcRenderer.invoke('module-settings', value),
  planner: (name,value) => ipcRenderer.invoke('planner',name,value),
  reports: (name,value) => ipcRenderer.invoke('work-reports',name,value),
  shortcuts: value => ipcRenderer.invoke('shortcut-settings', value),
  drag: (phase, point) => ipcRenderer.send('pet-drag', phase, point),
  petInteractive: value => ipcRenderer.send('pet-interactive', value),
  petPointer: () => ipcRenderer.invoke('pet-pointer'),
  petPointerChanged: callback => ipcRenderer.on('pet-pointer-changed', callback),
  subscribe: callback => ipcRenderer.on('snapshot', (_event, data) => callback(data)),
  showReminders: callback => ipcRenderer.on('show-reminders', callback),
  showPlanner: callback => ipcRenderer.on('show-planner',callback),
  chime: callback => ipcRenderer.on('chime', callback)
});
