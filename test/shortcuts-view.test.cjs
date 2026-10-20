'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const SHORTCUT_ACTIONS=require('../src/shared/shortcut-actions.js');
function fixture() {
  class Element {
    constructor(){this.children=[];this.handlers={};this.value='';this.textContent='';this.disabled=false;this.hidden=false;}
    append(child){this.children.push(child);}
    addEventListener(name,handler){this.handlers[name]=handler;}
  }
  const elements=new Map();
  for(const [,id] of fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8').matchAll(/id="(shortcuts-[^"]+)"/g))elements.set(id,new Element());
  let save=async tripleClick=>({shortcuts:{tripleClick}});
  const calls=[],document={getElementById:id=>elements.get(id),createElement:()=>new Element()};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/shortcuts-view.mjs'),'utf8').replace('export function','function');
  const context={document,SHORTCUT_ACTIONS,window:{whale:{shortcuts:value=>{calls.push(value);return save(value);}}}};
  vm.runInNewContext(source+'\nvar view=createShortcutsView();',context);
  const get=id=>elements.get('shortcuts-'+id);
  return {get,calls,render:context.view.render,setSave:fn=>save=fn,
    change(value){get('triple').value=value;return get('triple').handlers.change();}};
}
test('page shows persisted binding and action choices, then saves a change',async()=>{
  const f=fixture();assert.equal(f.get('triple').value,'panel');
  assert.ok(f.get('triple').children.some(option=>option.value==='none'));
  f.render({shortcuts:{tripleClick:'pat'}});assert.equal(f.get('triple').value,'pat');
  await f.change('panel');assert.deepEqual(f.calls,['panel']);
  assert.equal(f.get('triple').value,'panel');assert.equal(f.get('triple').disabled,false);
  assert.match(f.get('feedback').textContent,/已保存/);
});
test('pending save resists broadcast overwrite and failed save restores the confirmed binding',async()=>{
  const f=fixture();let reject;
  f.setSave(()=>new Promise((_resolve,fail)=>reject=fail));
  const task=f.change('feed');assert.equal(f.get('triple').disabled,true);
  f.render({shortcuts:{tripleClick:'panel'}});assert.equal(f.get('triple').value,'feed');
  reject(Error('disk'));await task;
  assert.equal(f.get('triple').value,'panel');assert.equal(f.get('triple').disabled,false);
  assert.equal(f.get('error').hidden,false);assert.match(f.get('error').textContent,/未保存/);
  f.setSave(async tripleClick=>({shortcuts:{tripleClick}}));await f.change('none');
  assert.equal(f.get('status').textContent,'未启用');assert.equal(f.get('error').hidden,true);
});
