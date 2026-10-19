'use strict';
const {BrowserWindow,ipcMain,screen}=require('electron');
const path=require('node:path');
const SPECIAL_ACTIONS=require('../shared/special-actions.js');

// 参考 dsh-pet 的独立面板与实测布局；单独承载菜单，人物窗口不扩容、不位移。
function createPetMenu({getPet,snapshot,performAction,showPanel,restartApp,protect}) {
  let menu,loading,active=null,sequence=0;
  const enabled=()=>{
    const current=snapshot();
    return current.activity.state!=='approval'&&current.state!=='feed'&&!Object.hasOwn(SPECIAL_ACTIONS,current.state);
  };
  // 主进程只执行白名单动作；点击时重查锁定状态，不能依赖菜单打开时的旧状态。
  const actions=new Map([
    ...['feed','pat','happy','angry',...Object.keys(SPECIAL_ACTIONS)].map(id=>[id,()=>{if(enabled())performAction(id);}]),
    ['panel',showPanel],['hide',()=>getPet()?.hide()],['restart',restartApp]
  ]);
  const items=[
    {id:'emotions',label:'互动表情',icon:'♡',children:[['喂饭','feed'],['摸头','pat'],['开心','happy'],['生气','angry']].map(([label,id])=>({id,label}))},
    {id:'programs',label:'小节目',icon:'✦',children:Object.entries(SPECIAL_ACTIONS).map(([id,clip])=>({id,label:clip.label}))},
    {separator:true},
    {id:'panel',label:'打开小屋',icon:'⌂'},
    {id:'hide',label:'隐藏桌宠',icon:'◌'},
    {separator:true},
    {id:'restart',label:'重启',icon:'↻'}
  ];
  function close() {
    // 同时作废尚未完成的几何读取、页面加载，以及旧菜单发来的布局或点击事件。
    sequence++;active=null;
    if(menu&&!menu.isDestroyed())menu.hide();
  }
  async function open() {
    const pet=getPet(),request=++sequence;
    if(!pet||pet.isDestroyed()||!pet.isVisible())return;
    // 锚点来自人物边界，不随右击点变化；先读取几何，异步期间失效的请求不再弹出。
    let art;
    try {
      art=await pet.webContents.executeJavaScript(`(() => {
        const r=document.getElementById('pet-art')?.getBoundingClientRect();
        return r?{left:r.left,right:r.right,top:r.top}:null;
      })()`);
    }catch{return;}
    if(request!==sequence||pet.isDestroyed()||!pet.isVisible()||!art||![art.left,art.right,art.top].every(Number.isFinite))return;
    if(!menu||menu.isDestroyed()) {
      menu=new BrowserWindow({width:400,height:400,show:false,transparent:true,frame:false,resizable:false,hasShadow:false,
        alwaysOnTop:true,skipTaskbar:true,webPreferences:{preload:path.join(__dirname,'../ui/pet-menu-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      protect(menu);
      menu.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
      menu.on('blur',close);
      loading=menu.loadFile(path.join(__dirname,'../ui/pet-menu.html'));
    }
    try {await loading;}catch{return;}
    if(request!==sequence||pet.isDestroyed()||!pet.isVisible())return;
    const bounds=pet.getContentBounds(),area=screen.getDisplayMatching(pet.getBounds()).workArea;
    active={id:request,area,enabled:enabled()};
    menu.webContents.send('pet-menu-open',{id:request,area,enabled:active.enabled,items,
      anchor:{left:bounds.x+art.left,right:bounds.x+art.right,top:bounds.y+art.top}});
  }
  const isCurrent=(event,id)=>event.sender===menu?.webContents&&active?.id===id;
  // 只允许菜单自己的渲染器调整窗口；尺寸与坐标被限制在打开时所在屏幕工作区。
  ipcMain.handle('pet-menu-layout',(event,id,bounds)=>{
    if(!isCurrent(event,id)||!bounds||!['x','y','width','height'].every(key=>Number.isInteger(bounds[key])))return false;
    const area=active.area;
    if(bounds.width<1||bounds.height<1||bounds.x<area.x||bounds.y<area.y||
      bounds.x+bounds.width>area.x+area.width||bounds.y+bounds.height>area.y+area.height)return false;
    menu.setBounds(bounds);
    if(!menu.isVisible()){menu.show();menu.focus();}
    return true;
  });
  ipcMain.on('pet-menu-close',(event,id)=>{if(isCurrent(event,id))close();});
  ipcMain.on('pet-menu-choose',(event,id,action)=>{
    if(!isCurrent(event,id)||!actions.has(action))return;
    close();actions.get(action)();
  });
  return {
    open,close,isOpen:()=>Boolean(active),
    refresh() {
      if(!active)return;
      const next=enabled();
      // 菜单打开期间也同步任务锁，避免开始执行后仍显示可点击的互动项。
      if(next!==active.enabled){active.enabled=next;menu.webContents.send('pet-menu-state',next);}
    }
  };
}
module.exports={createPetMenu};
