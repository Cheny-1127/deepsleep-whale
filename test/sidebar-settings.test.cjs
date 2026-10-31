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
  all.more.pop();assert.equal(settings.snapshot().more.length,10);
});
test('older layouts retain known ordering and append new entries without duplicates',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({visible:['quota','quota','old'],more:['home','quota']}));
  const state=f.create().snapshot();assert.equal(state.visible[0],'quota');assert.deepEqual(state.more,['home']);
  assert.equal(new Set([...state.visible,...state.more]).size,10);
  assert.equal(state.visible.includes('old'),false);
});
test('invalid updates and write failures preserve the last good layout',t=>{
  const f=fixture(t),settings=f.create(),before=settings.snapshot();
  for(const input of [null,{}, {visible:[],more:[]},{visible:before.visible,more:['home']},{visible:before.visible.map(()=> 'home'),more:[]}])assert.throws(()=>settings.update(input),/无效/);
  fs.mkdirSync(f.file);assert.throws(()=>settings.update({visible:[],more:before.visible}));assert.deepEqual(settings.snapshot(),before);
});
test('corrupt config falls back without overwriting user data',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,'broken');assert.equal(f.create().snapshot().visible.length,10);assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
});
test('trial plugin layout restores Archery in the same section and drops the plugin manager',t=>{
  const f=fixture(t),saved={visible:['quota','plugins','home'],more:['plugin:archery','mail','plugin:other']};fs.writeFileSync(f.file,JSON.stringify(saved));
  const settings=f.create(),state=settings.snapshot();assert.deepEqual(state.more,['archery','mail']);assert.deepEqual(state.visible.slice(0,2),['quota','home']);
  assert.equal(state.visible.includes('archery'),false);assert.equal([...state.visible,...state.more].some(id=>id.startsWith('plugin')),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),saved,'读取兼容状态不改写原文件');
  settings.update(state);assert.deepEqual(f.create().snapshot(),state);
});
test('trial aliases are deduplicated while new layout writes still require built-in identifiers',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({visible:['archery','plugin:archery','quota'],more:['plugin:archery','plugins']}));
  const settings=f.create(),state=settings.snapshot();assert.equal(state.visible[0],'archery');assert.equal([...state.visible,...state.more].filter(id=>id==='archery').length,1);
  assert.throws(()=>settings.update({visible:state.visible.map(id=>id==='archery'?'plugin:archery':id),more:state.more}),/无效/);
});
