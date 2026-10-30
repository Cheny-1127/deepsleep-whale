'use strict';
const {BrowserWindow,ipcMain,screen}=require('electron');
const path=require('node:path');

// 收纳入口使用独立的非激活面板；人物窗口真正隐藏，避免透明的大窗口继续挡住操作。
function createPetStorage({getPet,protect,closeOverlays,onRestore,onChange,onContextMenu,onHide}) {
  const narrow=34,long=64;
  let tab,loading,stored=false,side='right',attention=false,original=null,lastDock=null,dragOrigin=null,sequence=0,stopping=false,observing=false;
  const live=win=>Boolean(win&&!win.isDestroyed());
  const from=(event,win)=>live(win)&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;
  const state=()=>({stored,side,attention});
  function publish() {
    const data=state();
    for(const win of [getPet(),tab])if(live(win))win.webContents.send('pet-storage-state',data);
  }
  const clamp=(value,min,max)=>Math.max(min,Math.min(value,Math.max(min,max)));
  function dock(bounds,display,preferredSide) {
    const area=display.workArea;
    const center={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
    // 以人物中心到工作区四边的距离择近停靠，避免总往固定方向收纳。
    const distances={left:Math.abs(center.x-area.x),right:Math.abs(area.x+area.width-center.x),
      top:Math.abs(center.y-area.y),bottom:Math.abs(area.y+area.height-center.y)};
    side=preferredSide||Object.keys(distances).reduce((nearest,key)=>distances[key]<distances[nearest]?key:nearest);
    const horizontal=side==='top'||side==='bottom',width=horizontal?long:narrow,height=horizontal?narrow:long;
    let x=Math.round(clamp(center.x-width/2,area.x,area.x+area.width-width));
    let y=Math.round(clamp(center.y-height/2,area.y,area.y+area.height-height));
    if(side==='left')x=area.x;else if(side==='right')x=area.x+area.width-width;
    else if(side==='top')y=area.y;else y=area.y+area.height-height;
    tab.setBounds({x,y,width,height});
    lastDock={displayId:display.id,side,bounds:{x,y,width,height},anchor:original?.bounds};
    publish();
  }
  function ensureTab() {
    if(live(tab))return loading;
    // 窗口管理器在 app.ready 前装配；等实际创建书签后再访问 Electron screen。
    if(!observing){for(const event of ['display-removed','display-metrics-changed'])screen.on(event,relocate);observing=true;}
    tab=new BrowserWindow({width:narrow,height:long,show:false,transparent:true,frame:false,resizable:false,hasShadow:false,
      type:'panel',alwaysOnTop:true,skipTaskbar:true,
      webPreferences:{preload:path.join(__dirname,'../ui/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    protect(tab);tab.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
    tab.on('close',event=>{if(!stopping){event.preventDefault();onHide();}});
    tab.webContents.on('context-menu',onContextMenu);
    // 失去焦点或捕获时只结束拖动，不能把一次拖拽误当成点击恢复。
    tab.on('blur',()=>{if(dragOrigin)finishDrag();});
    loading=tab.loadFile(path.join(__dirname,'../ui/pet-storage.html')).catch(error=>{
      // 加载失败时保留人物，并允许下次点击重试，不能留下不可用的恢复入口。
      if(live(tab))tab.destroy();tab=null;loading=null;throw error;
    });
    return loading;
  }
  async function store() {
    const pet=getPet();
    if(stopping||stored||!live(pet)||!pet.isVisible())return state();
    const request=++sequence;
    await ensureTab();
    // 页面加载期间的隐藏、恢复或退出会作废这次请求，防止晚到的收纳重新弹出窗口。
    if(stopping||request!==sequence||!live(pet)||!pet.isVisible())return state();
    const bounds=pet.getBounds(),display=screen.getDisplayMatching(bounds);
    // 人物移动后重新就近选边；只有人物仍在原处，才沿用用户上次调整的书签位置。
    const remembered=lastDock?.displayId===display.id&&['x','y','width','height'].every(key=>lastDock.anchor?.[key]===bounds[key])?lastDock:null;
    original={bounds:{...bounds},displayId:display.id};
    dock(remembered?.bounds||bounds,display,remembered?.side);
    closeOverlays();dragOrigin=null;stored=true;
    pet.hide();tab.showInactive();publish();onChange();
    return state();
  }
  function restore() {
    sequence++;dragOrigin=null;
    const pet=getPet();
    if(!live(pet)||stopping)return state();
    const wasStored=stored;stored=false;
    if(live(tab))tab.hide();
    if(wasStored&&original) {
      let bounds={...original.bounds};
      const displays=screen.getAllDisplays();
      // 原显示器断开后，在书签所在的可用屏幕恢复，保证人物和恢复入口都能找回。
      if(!displays.some(display=>display.id===original.displayId)) {
        const area=screen.getDisplayMatching(tab.getBounds()).workArea;
        const docked=tab.getBounds();
        bounds.x=Math.round(clamp(docked.x+docked.width/2-bounds.width/2,area.x,area.x+area.width-bounds.width));
        bounds.y=Math.round(clamp(docked.y+docked.height/2-bounds.height/2,area.y,area.y+area.height-bounds.height));
        if(side==='left')bounds.x=area.x;else if(side==='right')bounds.x=Math.max(area.x,area.x+area.width-bounds.width);
        else if(side==='top')bounds.y=area.y;else bounds.y=Math.max(area.y,area.y+area.height-bounds.height);
      }
      pet.setBounds(bounds);
      onRestore();
    }
    // 恢复人物只展示悬浮窗，不激活应用或打开小屋。
    pet.showInactive();publish();onChange();
    return state();
  }
  function hide() {
    // 彻底隐藏只收起入口，保留收纳位置；下次“显示桌宠”仍能恢复原人物位置。
    sequence++;dragOrigin=null;
    if(live(tab))tab.hide();
    onChange();
  }
  function finishDrag() {
    if(!dragOrigin)return;
    dragOrigin=null;
    if(stored&&live(tab))dock(tab.getBounds(),screen.getDisplayMatching(tab.getBounds()));
  }
  ipcMain.handle('pet-storage',(event,name)=>{
    // 只接受本实例人物或书签的主框架请求，小屋及子框架不能借此控制收纳。
    if(!from(event,getPet())&&!from(event,tab))throw Error('仅允许在桌宠窗口操作收纳');
    if(name==='snapshot')return state();
    if(name==='restore')return restore();
    throw Error('不支持的桌宠收纳操作');
  });
  ipcMain.on('pet-storage-drag',(event,phase,point)=>{
    // 拖动仅允许来自当前可见的书签，不能移动已隐藏的入口或人物窗口。
    if(!from(event,tab)||!stored||!tab.isVisible())return;
    if(phase==='end'){finishDrag();return;}
    if(!point||![point.x,point.y].every(Number.isFinite))return;
    if(phase==='start'){closeOverlays();dragOrigin={mouse:point,bounds:tab.getBounds()};}
    else if(phase==='move'&&dragOrigin) {
      tab.setPosition(Math.round(dragOrigin.bounds.x+point.x-dragOrigin.mouse.x),Math.round(dragOrigin.bounds.y+point.y-dragOrigin.mouse.y));
    }
  });
  function relocate() {
    if(!stored||!live(tab))return;
    finishDrag();
    dock(tab.getBounds(),screen.getDisplayMatching(tab.getBounds()),side);
  }
  return {
    store,restore,hide,isStored:()=>stored,isVisible:()=>live(tab)&&tab.isVisible(),activeWindow:()=>stored?tab:getPet(),
    refresh(data) {
      const next=Boolean(data.activity?.pending||data.activity?.unread||
        (data.modules?.subscriptions!==false&&data.subscriptions?.unread)||data.planner?.active?.length);
      if(next!==attention){attention=next;publish();}
    },
    stop() {
      stopping=true;hide();
      if(observing)for(const event of ['display-removed','display-metrics-changed'])screen.removeListener(event,relocate);
    }
  };
}
module.exports={createPetStorage};
