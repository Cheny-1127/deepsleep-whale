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
  const next={visible:initial.visible.slice(2).reverse(),more:[...initial.visible.slice(0,2),...initial.more]};
  settings.update(next);assert.deepEqual(f.create().snapshot(),next);
  const all={visible:[],more:[...next.more,...next.visible]};
  settings.update(all);assert.deepEqual(f.create().snapshot(),all);
  all.more.pop();assert.equal(settings.snapshot().more.length,11);
});
test('older layouts retain known ordering and append new entries without duplicates',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({visible:['quota','quota','old'],more:['home','quota']}));
  const state=f.create().snapshot();assert.equal(state.visible[0],'quota');assert.deepEqual(state.more,['home','ai-sessions']);
  assert.equal(new Set([...state.visible,...state.more]).size,11);
  assert.equal(state.visible.at(-1),'reports');
  assert.equal(state.visible.includes('old'),false);
});
test('invalid updates and write failures preserve the last good layout',t=>{
  const f=fixture(t),settings=f.create(),before=settings.snapshot();
  for(const input of [null,{}, {visible:[],more:[]},{visible:before.visible,more:['home']},{visible:before.visible.map(()=> 'home'),more:[]}])assert.throws(()=>settings.update(input),/无效/);
  fs.mkdirSync(f.file);assert.throws(()=>settings.update({visible:[],more:[...before.visible,...before.more]}));assert.deepEqual(settings.snapshot(),before);
});
test('corrupt config falls back without overwriting user data',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,'broken');assert.equal(f.create().snapshot().visible.length,10);assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
});
test('trial plugin layout restores Archery in the same section and drops the plugin manager',t=>{
  const f=fixture(t),saved={visible:['quota','plugins','home'],more:['plugin:archery','mail','plugin:other']};fs.writeFileSync(f.file,JSON.stringify(saved));
  const settings=f.create(),state=settings.snapshot();assert.deepEqual(state.more,['archery','mail','ai-sessions']);assert.deepEqual(state.visible.slice(0,2),['quota','home']);
  assert.equal(state.visible.includes('archery'),false);assert.equal([...state.visible,...state.more].some(id=>id.startsWith('plugin')),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),saved,'读取兼容状态不改写原文件');
  settings.update(state);assert.deepEqual(f.create().snapshot(),state);
});
test('trial aliases are deduplicated while new layout writes still require built-in identifiers',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({visible:['archery','plugin:archery','quota'],more:['plugin:archery','plugins']}));
  const settings=f.create(),state=settings.snapshot();assert.equal(state.visible[0],'archery');assert.equal([...state.visible,...state.more].filter(id=>id==='archery').length,1);
  assert.throws(()=>settings.update({visible:state.visible.map(id=>id==='archery'?'plugin:archery':id),more:state.more}),/无效/);
});

test('AI features default to More without changing other menu positions or writing legacy files',t=>{
  const fresh=fixture(t).create().snapshot();assert.deepEqual(fresh.more,['ai-sessions']);assert.equal(fresh.visible.includes('ai-sessions'),false);
  for(const section of ['visible','more']) {
    const f=fixture(t),saved={visible:['quota','home'],more:['reports','mail']};saved[section].splice(1,0,'ai-sessions');
    fs.writeFileSync(f.file,JSON.stringify(saved));const settings=f.create(),state=settings.snapshot();
    assert.deepEqual(state.visible.slice(0,2),['quota','home']);assert.equal(state.visible.includes('ai-sessions'),false);
    assert.deepEqual(state.more.filter(id=>id!=='ai-sessions'),['reports','mail']);assert.equal(state.more.filter(id=>id==='ai-sessions').length,1);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),saved,'读取旧布局不改写原文件');
    settings.update(state);assert.deepEqual(f.create().snapshot(),state);
    const custom={visible:[...state.visible,'ai-sessions'],more:state.more.filter(id=>id!=='ai-sessions')};settings.update(custom);assert.deepEqual(f.create().snapshot(),custom,'新布局保留用户主动整理的位置');
  }
});
