'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const SHORTCUT_ACTIONS=require('../src/shared/shortcut-actions.js');
function fixture() {
  class Element {
    constructor(){this.children=[];this.handlers={};this.attributes={};this.value='';this.textContent='';this.disabled=false;this.hidden=false;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=[...children];}
    addEventListener(name,handler){this.handlers[name]=handler;}
    setAttribute(name,value){this.attributes[name]=value;}
    focus(){}
  }
  const elements=new Map();
  for(const [,id] of fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8').matchAll(/id="(shortcuts-[^"]+)"/g))elements.set(id,new Element());
  let confirmed={doubleClick:'none',tripleClick:'panel',reminderCollapseThreshold:3};
  let save=async patch=>({shortcuts:confirmed={...confirmed,...patch}});
  const calls=[],document={getElementById:id=>elements.get(id),createElement:()=>new Element(),addEventListener(){}};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/select-view.mjs'),'utf8').replace('export function','function')+'\n'+fs.readFileSync(path.join(__dirname,'../src/ui/shortcuts-view.mjs'),'utf8').replace(/^import .*;\n/,'').replace('export function','function');
  const context={document,SHORTCUT_ACTIONS,window:{whale:{shortcuts:value=>{const patch=JSON.parse(JSON.stringify(value));calls.push(patch);return save(patch);}}}};
  vm.runInNewContext(source+'\nvar view=createShortcutsView();',context);
  const get=id=>elements.get('shortcuts-'+id);
  return {get,calls,render:context.view.render,setSave:fn=>save=fn,
    change(value,gesture='triple'){return get(gesture==='double'?'double-options':'options').children.find(option=>option.value===value).handlers.click();}};
}
test('page shows persisted binding and action choices, then saves a change',async()=>{
  const f=fixture();assert.equal(f.get('selected').textContent,SHORTCUT_ACTIONS.panel);
  assert.ok(f.get('options').children.some(option=>option.value==='none'));
  f.render({shortcuts:{tripleClick:'pat'}});assert.equal(f.get('selected').textContent,SHORTCUT_ACTIONS.pat);
  await f.change('panel');assert.deepEqual(f.calls,[{tripleClick:'panel'}]);
  assert.equal(f.get('selected').textContent,SHORTCUT_ACTIONS.panel);assert.equal(f.get('triple').attributes['aria-disabled'],'false');
  assert.equal(f.get('options').children.filter(option=>option.attributes['aria-selected']==='true').length,1);
  assert.match(f.get('feedback').textContent,/已保存/);
});
test('pending save resists broadcast overwrite and failed save restores the confirmed binding',async()=>{
  const f=fixture();let reject;
  f.setSave(()=>new Promise((_resolve,fail)=>reject=fail));
  const task=f.change('feed');assert.equal(f.get('triple').attributes['aria-disabled'],'true');
  assert.ok(f.get('options').children.every(option=>option.disabled));
  f.render({shortcuts:{tripleClick:'panel'}});assert.equal(f.get('selected').textContent,SHORTCUT_ACTIONS.feed);
  reject(Error('disk'));await task;
  assert.equal(f.get('selected').textContent,SHORTCUT_ACTIONS.panel);assert.equal(f.get('triple').attributes['aria-disabled'],'false');
  assert.equal(f.get('error').hidden,false);assert.match(f.get('error').textContent,/未保存/);
  f.setSave(async patch=>({shortcuts:patch}));await f.change('none');
  assert.equal(f.get('status').textContent,'未启用');assert.equal(f.get('error').hidden,true);
});
test('double and triple selections save independently and either enabled binding keeps the status enabled',async()=>{
  const f=fixture();assert.equal(f.get('double-selected').textContent,SHORTCUT_ACTIONS.none);
  await f.change('panel','double');await f.change('store-pet');
  assert.deepEqual(f.calls,[{doubleClick:'panel'},{tripleClick:'store-pet'}]);
  assert.equal(f.get('double-selected').textContent,SHORTCUT_ACTIONS.panel);
  assert.equal(f.get('selected').textContent,SHORTCUT_ACTIONS['store-pet']);
  await f.change('none');assert.equal(f.get('status').textContent,'已启用');
  await f.change('none','double');assert.equal(f.get('status').textContent,'未启用');
});
test('failed double binding save rolls both selectors back without losing the triple binding',async()=>{
  const f=fixture();f.render({shortcuts:{doubleClick:'panel',tripleClick:'store-pet'}});
  let reject;f.setSave(()=>new Promise((_resolve,fail)=>reject=fail));
  const task=f.change('feed','double');
  assert.equal(f.get('double-selected').textContent,SHORTCUT_ACTIONS.feed);
  assert.equal(f.get('triple').attributes['aria-disabled'],'true');
  assert.equal(f.get('double').attributes['aria-disabled'],'true');
  reject(Error('disk'));await task;
  assert.equal(f.get('double-selected').textContent,SHORTCUT_ACTIONS.panel);
  assert.equal(f.get('selected').textContent,SHORTCUT_ACTIONS['store-pet']);
  assert.equal(f.get('error').hidden,false);
});

test('identical enabled gestures show a hint without blocking saving; distinct or disabled bindings clear it',async()=>{
  const f=fixture();await f.change('panel','double');
  assert.equal(f.get('double-hint').textContent,'与三连击的动作相同');
  assert.equal(f.get('triple-hint').textContent,'与双击的动作相同');
  assert.equal(f.get('double-hint').hidden,false);assert.equal(f.get('triple-hint').hidden,false);
  assert.deepEqual(f.calls,[{doubleClick:'panel'}],'duplicate bindings remain a valid user choice');
  await f.change('store-pet');
  for(const id of ['double-hint','triple-hint']){assert.equal(f.get(id).hidden,true);assert.equal(f.get(id).textContent,'');}
  f.render({shortcuts:{doubleClick:'none',tripleClick:'none'}});
  for(const id of ['double-hint','triple-hint'])assert.equal(f.get(id).hidden,true);
  f.render({shortcuts:{doubleClick:'store-pet',tripleClick:'store-pet'}});
  for(const id of ['double-hint','triple-hint'])assert.equal(f.get(id).hidden,false);
});

test('a failed duplicate binding save removes the optimistic hint after rollback',async()=>{
  const f=fixture();let reject;
  f.setSave(()=>new Promise((_resolve,fail)=>reject=fail));
  const task=f.change('panel','double');assert.equal(f.get('double-hint').hidden,false);
  f.render({shortcuts:{doubleClick:'none',tripleClick:'panel'}});
  assert.equal(f.get('double-hint').hidden,false,'pending choices survive an old snapshot');
  reject(Error('disk'));await task;
  for(const id of ['double-hint','triple-hint'])assert.equal(f.get(id).hidden,true);
  assert.equal(f.get('error').hidden,false);
});

test('threshold save previews pending value and restores on failure',async()=>{
  const f=fixture();let reject;
  f.setSave(()=>new Promise((_resolve,fail)=>reject=fail));
  f.get('threshold').value='2';const task=f.get('threshold').handlers.change();
  assert.equal(f.get('threshold').disabled,true);assert.match(f.get('preview').textContent,/从 3 条/);
  f.render({shortcuts:{tripleClick:'panel',reminderCollapseThreshold:3}});
  assert.equal(f.get('threshold').value,'2');
  reject(Error('disk'));await task;
  assert.equal(f.get('threshold').value,'3');assert.equal(f.get('error').hidden,false);
  f.setSave(async value=>({shortcuts:{tripleClick:'panel',...value}}));
  f.get('threshold').value='2';await f.get('threshold').handlers.change();
  assert.equal(f.get('threshold').value,'2');assert.equal(f.get('error').hidden,true);
  f.get('threshold').value='0';await f.get('threshold').handlers.change();
  assert.equal(f.get('threshold').value,'2');assert.equal(f.get('error').hidden,false);
});
