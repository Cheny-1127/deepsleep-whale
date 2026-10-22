'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('accounts', {
  snapshot: () => ipcRenderer.invoke('pet-accounts-data'),
  select: id => ipcRenderer.send('pet-accounts-select', id),
  close: () => ipcRenderer.send('pet-accounts-close'),
  onOpen: callback => ipcRenderer.on('pet-accounts-open', callback)
});
