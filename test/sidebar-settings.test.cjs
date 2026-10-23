'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createSidebarSettings}=require('../src/app/sidebar-settings.cjs');
function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-sidebar-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  return {file:path.join(dataDir,'sidebar.json'),create:()=>createSidebarSettings({dataDir})};
}
test('menu order and collected items survive restart, including an empty visible list',t=>{
  const f=fixture(t),settings=f.create(),initial=settings.snapshot();
  const next={visible:initial.visible.slice(2).reverse(),more:initial.visible.slice(0,2)};
  settings.update(next);assert.deepEqual(f.create().snapshot(),next);
  const all={visible:[],more:[...next.more,...next.visible]};
  settings.update(all);assert.deepEqual(f.create().snapshot(),all);
  all.more.pop();assert.equal(settings.snapshot().more.length,8);
});
test('older layouts retain known ordering and append new entries without duplicates',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({visible:['quota','quota','old'],more:['home','quota']}));
  const state=f.create().snapshot();assert.equal(state.visible[0],'quota');assert.deepEqual(state.more,['home']);
  assert.equal(new Set([...state.visible,...state.more]).size,8);
  assert.equal(state.visible.includes('old'),false);
});
test('invalid updates and write failures preserve the last good layout',t=>{
  const f=fixture(t),settings=f.create(),before=settings.snapshot();
  for(const input of [null,{}, {visible:[],more:[]},{visible:before.visible,more:['home']},{visible:before.visible.map(()=> 'home'),more:[]}])assert.throws(()=>settings.update(input),/无效/);
  fs.mkdirSync(f.file);assert.throws(()=>settings.update({visible:[],more:before.visible}));assert.deepEqual(settings.snapshot(),before);
});
test('corrupt config falls back without overwriting user data',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,'broken');assert.equal(f.create().snapshot().visible.length,8);assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
});
