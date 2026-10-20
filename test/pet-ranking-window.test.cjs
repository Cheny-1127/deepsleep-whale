'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
function fixture(x = 800) {
  const ipcMain = new EventEmitter(), handlers = new Map(), windows = [];
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  class Window extends EventEmitter {
    constructor() {super();this.visible = false;this.bounds = {};this.webContents = {mainFrame:{},setWindowOpenHandler(){}};windows.push(this);}
    isDestroyed() {return false;} isVisible() {return this.visible;} loadFile() {return Promise.resolve();}
    setVisibleOnAllWorkspaces() {} setBounds(value) {this.bounds = value;} getBounds() {return this.bounds;}
    show() {this.visible = true;} hide() {this.visible = false;} focus() {}
  }
  const pet = {isDestroyed:()=>false, isVisible:()=>true, getContentBounds:()=>({x, y:450}), getBounds:()=>({x, y:450, width:220, height:320}),
    webContents:{executeJavaScript:async()=>({left:30, right:190, top:96, bottom:272})}};
  const area = {x:0, y:0, width:1200, height:800}, module = {exports:{}};
  const electron = {BrowserWindow:Window, ipcMain, screen:{getDisplayMatching:()=>({workArea:area})}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/app/pet-ranking.cjs'), 'utf8'), {
    module, __dirname:path.join(__dirname, '../src/app'), require:name=>name==='electron'?electron:require(name)
  });
  const api = module.exports.createPetRanking({getPet:()=>pet, snapshot:()=>({users:[]}), refresh:async()=>({refreshed:true}), protect(){}});
  return {api, ipcMain, handlers, windows, pet, area};
}
test('ranking sits beside the pet, flips at the left edge, fits the screen and shrinks its click area to its content', async () => {
  for (const x of [800, 0]) {
    const f = fixture(x);await f.api.toggle();const panel = f.windows[0], before = f.pet.getContentBounds();
    assert.equal(panel.visible, true);assert.equal(f.api.isOpen(), true);
    assert.ok(panel.bounds.x >= 0 && panel.bounds.x + panel.bounds.width <= f.area.width);
    assert.ok(x === 800 ? panel.bounds.x + panel.bounds.width < x + 30 : panel.bounds.x > x + 190);
    const event = {sender:panel.webContents, senderFrame:panel.webContents.mainFrame};
    f.ipcMain.emit('pet-ranking-size', event, 198);assert.equal(panel.bounds.height, 198);
    assert.equal(panel.bounds.y + panel.bounds.height, 722);assert.deepEqual(f.pet.getContentBounds(), before);
    for (const height of [0, 1000, '200', 200.1]) f.ipcMain.emit('pet-ranking-size', event, height);
    f.ipcMain.emit('pet-ranking-size', {...event,senderFrame:{}}, 250);assert.equal(panel.bounds.height, 198);
    assert.throws(() => f.handlers.get('pet-ranking-data')({...event,senderFrame:{}}), /榜单窗口/);
    assert.deepEqual(f.handlers.get('pet-ranking-data')(event), {users:[]});
    assert.throws(() => f.handlers.get('pet-ranking-refresh')({...event,senderFrame:{}}), /榜单窗口/);
    assert.deepEqual(await f.handlers.get('pet-ranking-refresh')(event), {refreshed:true});
    await f.api.toggle();assert.equal(panel.visible, false);assert.equal(f.api.isOpen(), false);
  }
});
test('closing during pending geometry prevents a late popup', async () => {
  const f = fixture();let resolve;
  f.pet.webContents.executeJavaScript = () => new Promise(done => {resolve = done;});
  const task = f.api.toggle();f.api.close();resolve({left:30,right:190,top:96,bottom:272});await task;
  assert.equal(f.windows.length, 0);assert.equal(f.api.isOpen(), false);
});
