'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function fixture({enabled=true}={}) {
  const handlers={},windowHandlers={},actions=[],drags=[],jobs=new Map();
  let now=0,nextId=0;
  const element={addEventListener:(name,fn)=>handlers[name]=fn,setPointerCapture(){},contains:target=>target===element};
  const clock={now:()=>now,setTimeout:(fn,ms)=>{const id=++nextId;jobs.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>jobs.delete(id)};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/pet-gestures.mjs'),'utf8').replace('export function','function');
  vm.runInNewContext(source+'\ncreatePetGestures({element,action:name=>actions.push(name),drag:(...args)=>drags.push(args),enabled:()=>enabled,clock});',
    {element,actions,drags,clock,enabled,window:{addEventListener:(name,fn)=>windowHandlers[name]=fn}});
  const emit=(name,extra={})=>handlers[name]?.({button:0,pointerId:1,screenX:100,screenY:100,preventDefault(){},...extra});
  const advance=ms=>{now+=ms;for(const [id,job] of [...jobs])if(job.at<=now){jobs.delete(id);job.fn();}};
  return {actions,drags,emit,advance,click(){emit('pointerdown');emit('pointerup');},blur:()=>windowHandlers.blur?.(),outside:()=>windowHandlers.pointerdown?.({target:{}})};
}
test('three clicks perform the shortcut once without ordinary touch actions',()=>{
  const f=fixture();f.click();f.advance(100);f.click();f.advance(100);f.click();
  assert.deepEqual(f.actions,['shortcut-triple']);f.advance(500);assert.deepEqual(f.actions,['shortcut-triple']);
});
test('single and double clicks retain normal interactions after the multi-click window',()=>{
  const f=fixture();f.click();assert.deepEqual(f.actions,[]);f.advance(401);assert.deepEqual(f.actions,['touch']);
  f.click();f.advance(100);f.click();f.advance(401);assert.deepEqual(f.actions,['touch','touch','touch']);
});
test('drag, cancellation, right click and focus loss cannot complete a triple click',()=>{
  for(const interrupt of ['drag','pointercancel','lostpointercapture','right','blur']) {
    const f=fixture();f.click();f.advance(50);f.click();f.emit('pointerdown');
    if(interrupt==='drag'){f.emit('pointermove',{screenX:120});f.emit('pointerup');}
    else if(interrupt==='right')f.emit('pointerdown',{button:2});
    else if(interrupt==='blur')f.blur();
    else f.emit(interrupt);
    f.advance(500);assert.deepEqual(f.actions,[],interrupt);
  }
});
test('disabled shortcut keeps immediate touches, keyboard activation remains a normal touch',()=>{
  const f=fixture({enabled:false});f.click();f.click();f.click();assert.deepEqual(f.actions,['touch','touch','touch']);
  f.emit('keydown',{key:'Enter'});assert.equal(f.actions.at(-1),'touch');
});
test('normal capture release retains clicks, while a slow third click stays ordinary',()=>{
  const f=fixture();f.click();f.emit('lostpointercapture');f.advance(100);f.click();f.emit('lostpointercapture');
  f.advance(100);f.click();f.emit('lostpointercapture');assert.deepEqual(f.actions,['shortcut-triple']);
  const slow=fixture();slow.click();slow.advance(401);slow.click();slow.advance(401);slow.click();slow.advance(401);
  assert.deepEqual(slow.actions,['touch','touch','touch']);
});
test('clicking a bubble or another control breaks the character click sequence',()=>{
  const f=fixture();f.click();f.advance(50);f.click();f.outside();f.click();f.advance(401);
  assert.deepEqual(f.actions,['touch']);
});
