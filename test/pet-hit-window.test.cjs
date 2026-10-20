'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
function fixture() {
  const app=new EventEmitter(),ipcMain=new EventEmitter(),handlers=new Map(),windows=[];
  ipcMain.handle=(name,handler)=>handlers.set(name,handler);
  class Window extends EventEmitter {
    constructor(options){super();this.bounds={...options};this.ignored=[];this.visible=true;this.messages=[];
      this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.setWindowOpenHandler=()=>{};
      this.webContents.send=(...args)=>this.messages.push(args);windows.push(this);}
    loadFile(){} setVisibleOnAllWorkspaces(){} isDestroyed(){return false;}isVisible(){return this.visible;}
    setIgnoreMouseEvents(ignore,options){this.ignored.push({ignore,...options});}
    getBounds(){return this.bounds;}getContentBounds(){return this.bounds;}
    setPosition(x,y){Object.assign(this.bounds,{x,y});this.emit('move');}
    setBounds(bounds){this.bounds=bounds;this.emit('resize');}
  }
  class Tray extends EventEmitter {setContextMenu(){}setToolTip(){}isDestroyed(){return false;}}
  const electron={app,ipcMain,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:v=>v,setApplicationMenu(){}},
    nativeImage:{createFromPath:()=>({resize:()=>({})})},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1000,height:800}}),getCursorScreenPoint:()=>({x:810,y:500})}};
  const module={exports:{}};
  const source=fs.readFileSync(path.join(__dirname,'../src/app/windows.cjs'),'utf8');
  vm.runInNewContext(source,{module,__dirname:path.join(__dirname,'../src/app'),require:name=>name==='electron'?electron:name==='./pet-menu.cjs'?
    {createPetMenu:()=>({close(){},open(){},isOpen:()=>false,refresh(){}})}:name==='./pet-ranking.cjs'?{createPetRanking:()=>({close(){},toggle(){},isOpen:()=>false})}:require(name)});
  const api=module.exports.createWindows({snapshot:()=>({}),performAction(){},collapseReminders(){}});api.start();
  const [panel,pet]=windows,event={sender:pet.webContents,senderFrame:pet.webContents.mainFrame};
  return {ipcMain,handlers,api,panel,pet,event};
}
test('pet starts click-through, enables visible hit targets and forwards movement while ignoring clicks',()=>{
  const f=fixture();assert.equal(f.pet.ignored.at(-1)?.ignore,true,'transparent startup area must not block other apps');
  f.ipcMain.emit('pet-interactive',f.event,true);assert.equal(f.pet.ignored.at(-1).ignore,false);
  f.ipcMain.emit('pet-interactive',f.event,false);assert.equal(f.pet.ignored.at(-1).ignore,true);
  assert.equal(f.pet.ignored.at(-1).forward,true);
  const count=f.pet.ignored.length;
  f.ipcMain.emit('pet-interactive',{sender:f.panel.webContents,senderFrame:f.panel.webContents.mainFrame},true);
  f.ipcMain.emit('pet-interactive',{...f.event,senderFrame:{}},true);
  f.ipcMain.emit('pet-interactive',f.event,'false');assert.equal(f.pet.ignored.length,count);
});
test('dragging keeps capture even over transparent regions and restores requested pass-through on release',()=>{
  const f=fixture();f.ipcMain.emit('pet-drag',f.event,'start',{x:800,y:500});
  f.ipcMain.emit('pet-interactive',f.event,false);assert.equal(f.pet.ignored.at(-1).ignore,false);
  f.ipcMain.emit('pet-drag',f.event,'move',{x:850,y:540});assert.equal(f.pet.bounds.x,810);assert.equal(f.pet.bounds.y,500);
  f.ipcMain.emit('pet-drag',f.event,'end');assert.equal(f.pet.ignored.at(-1).ignore,true);
});
test('cursor query uses content coordinates and rejects the panel and child frames',()=>{
  const f=fixture(),query=f.handlers.get('pet-pointer');assert.equal(typeof query,'function');
  assert.deepEqual(JSON.parse(JSON.stringify(query(f.event))),{x:50,y:40});
  assert.equal(query({sender:f.panel.webContents,senderFrame:f.panel.webContents.mainFrame}),null);
  assert.equal(query({...f.event,senderFrame:{}}),null);
});

test('hiding and showing retains the renderer hit state so a stationary cursor over the pet stays clickable',()=>{
  const f=fixture();f.ipcMain.emit('pet-interactive',f.event,true);
  f.pet.emit('hide');f.pet.emit('show');
  assert.equal(f.pet.ignored.at(-1).ignore,false,'renderer may deduplicate the unchanged true hit state after show');
});
