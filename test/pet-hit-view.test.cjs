'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(setImmediate);
function fixture({floating=true}={}) {
  const handlers=new Map(),windowHandlers=new Map(),frames=[],changes=[],reads=[];
  let cursor={x:1,y:1},pointerChanged,mutation,resize;
  const root={closest:()=>null};
  function target(name,rect,visible=true) {
    const node={name,rect,visible,closest:selector=>selector.split(',').some(s=>s.trim()===name)?node:null};return node;
  }
  const art=target('#pet-art',{x:30,y:100,w:160,h:176}),speech=target('.speech',{x:50,y:40,w:120,h:30},false),
    controls=target('.pet-controls',{x:40,y:275,w:140,h:25},false);
  const badge=target('#pet-subscriptions-badge',{x:185,y:90,w:24,h:24},false);
  const targets=[badge,controls,speech,art];
  const document={body:{classList:{contains:()=>floating}},
    querySelectorAll:()=>targets,elementFromPoint:(x,y)=>targets.find(n=>n.visible&&x>=n.rect.x&&x<n.rect.x+n.rect.w&&y>=n.rect.y&&y<n.rect.y+n.rect.h)||root,
    addEventListener:(name,handler)=>handlers.set(name,handler)};
  const window={addEventListener:(name,handler)=>windowHandlers.set(name,handler),whale:{
    petInteractive:value=>changes.push(value),petPointer:()=>{reads.push(true);return typeof cursor==='function'?cursor():Promise.resolve(cursor);},
    petPointerChanged:callback=>pointerChanged=callback}};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/pet-hit-test.mjs'),'utf8').replace('export function','function');
  vm.runInNewContext(source+'\ncreatePetHitTest();',{document,window,
    MutationObserver:class{constructor(fn){mutation=fn;}observe(){}},ResizeObserver:class{constructor(fn){resize=fn;}observe(){}},
    requestAnimationFrame:fn=>frames.push(fn)});
  function emit(name,x=1,y=1,node=root) {handlers.get(name)?.({clientX:x,clientY:y,pointerId:1,target:node});}
  return {changes,reads,art,speech,controls,badge,emit,windowHandlers,get current(){return changes.at(-1);},
    move:(x,y)=>emit('mousemove',x,y),setCursor:value=>cursor=value,
    async layout(){mutation();for(const fn of frames.splice(0))fn();await tick();},
    async nativeMove(){pointerChanged();for(const fn of frames.splice(0))fn();await tick();},
    async resize(){resize();for(const fn of frames.splice(0))fn();await tick();}};
}
test('transparent gaps pass through while character and visible bubbles retain clicks',async()=>{
  const f=fixture();await tick();assert.equal(f.current,false);
  f.move(100,150);assert.equal(f.current,true);f.move(10,100);assert.equal(f.current,false);
  f.speech.visible=true;f.move(80,50);assert.equal(f.current,true);
  f.controls.visible=true;f.move(100,280);assert.equal(f.current,true);
  f.controls.visible=false;f.move(100,280);assert.equal(f.current,false);
});
test('stationary cursor is reevaluated when a bubble appears, disappears or expands',async()=>{
  const f=fixture();await tick();f.setCursor({x:80,y:50});f.move(80,50);assert.equal(f.current,false);
  f.speech.visible=true;await f.layout();assert.equal(f.current,true);
  f.speech.visible=false;await f.layout();assert.equal(f.current,false);
  f.setCursor({x:80,y:90});f.speech.visible=true;await f.layout();assert.equal(f.current,false);
  f.speech.rect.h=65;await f.resize();assert.equal(f.current,true);
});
test('unread badge captures clicks and restores pass-through when hidden',async()=>{
  const f=fixture();await tick();f.setCursor({x:195,y:95});f.move(195,95);assert.equal(f.current,false);
  f.badge.visible=true;await f.layout();assert.equal(f.current,true);
  f.emit('pointerdown',195,95,f.badge);f.move(5,5);assert.equal(f.current,true);
  f.emit('pointerup',5,5);assert.equal(f.current,false);
  f.move(195,95);f.badge.visible=false;await f.layout();assert.equal(f.current,false);
});
test('pressing and dragging across transparent space retains capture until release or cancellation',async()=>{
  const f=fixture();await tick();f.emit('pointerdown',100,150,f.art);f.move(5,5);assert.equal(f.current,true);
  f.emit('mouseleave');assert.equal(f.current,true);
  f.emit('pointerup',5,5);assert.equal(f.current,false);
  f.emit('pointerdown',100,150,f.art);f.move(5,5);f.emit('pointercancel');assert.equal(f.current,false);
  f.emit('pointerdown',100,150,f.art);f.move(5,5);f.emit('lostpointercapture');assert.equal(f.current,false);
});
test('native moves recalculate local cursor position and stale async positions cannot override newer movement',async()=>{
  const f=fixture();await tick();f.move(100,150);assert.equal(f.current,true);
  f.setCursor({x:5,y:5});await f.nativeMove();assert.equal(f.current,false);
  let resolve;f.setCursor(()=>new Promise(done=>resolve=done));const task=f.nativeMove();
  f.move(100,150);resolve({x:5,y:5});await task;assert.equal(f.current,true);
});
test('repeated movement in one region avoids redundant IPC and the studio never enables this feature',async()=>{
  const f=fixture();await tick();f.move(100,150);const count=f.changes.length;
  f.move(101,151);f.move(102,152);assert.equal(f.changes.length,count);
  const studio=fixture({floating:false});await tick();assert.equal(studio.changes.length,0);assert.equal(studio.reads.length,0);
});
