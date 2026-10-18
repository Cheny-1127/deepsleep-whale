'use strict';
const {contextBridge,ipcRenderer}=require('electron');
// 菜单仅有布局、关闭和固定动作三个入口，不接收小屋、微信或文件操作能力。
contextBridge.exposeInMainWorld('petMenu',{
  onOpen:callback=>ipcRenderer.on('pet-menu-open',(_event,data)=>callback(data)),
  onState:callback=>ipcRenderer.on('pet-menu-state',(_event,enabled)=>callback(enabled)),
  layout:(id,bounds)=>ipcRenderer.invoke('pet-menu-layout',id,bounds),
  close:id=>ipcRenderer.send('pet-menu-close',id),
  choose:(id,action)=>ipcRenderer.send('pet-menu-choose',id,action)
});
