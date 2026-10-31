'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createModuleSettings,MODULE_IDS}=require('../src/app/module-settings.cjs');
function fixture(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-modules-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));return {dataDir,file:path.join(dataDir,'modules.json'),create:()=>createModuleSettings({dataDir})};}
test('module switches default on, persist independently and never include home',t=>{
  const f=fixture(t),settings=f.create();assert.ok(MODULE_IDS.every(id=>settings.enabled(id)));assert.equal(MODULE_IDS.includes('home'),false);
  settings.update('wechat',false);settings.update('mail',false);assert.equal(f.create().enabled('wechat'),false);assert.equal(f.create().enabled('quota'),true);
  const snapshot=settings.snapshot();snapshot.quota=false;assert.equal(settings.enabled('quota'),true);
  assert.throws(()=>settings.update('home',false),/无效/);assert.throws(()=>settings.update('quota','false'),/无效/);
});
test('failed module writes preserve the running state and malformed files are not rewritten',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,'broken');const settings=f.create();assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
  fs.mkdirSync(f.file+'.tmp');assert.throws(()=>settings.update('planner',false));assert.equal(settings.enabled('planner'),true);assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
});
test('trial Archery switch is inherited only until a built-in module setting is saved',t=>{
  const f=fixture(t),plugin=path.join(f.dataDir,'plugins/archery/installed.json');fs.mkdirSync(path.dirname(plugin),{recursive:true});fs.writeFileSync(plugin,JSON.stringify({id:'archery',enabled:false}));
  const settings=f.create();assert.equal(settings.enabled('archery'),false);assert.equal(fs.existsSync(f.file),false);
  settings.update('mail',false);fs.writeFileSync(plugin,JSON.stringify({id:'archery',enabled:true}));
  assert.equal(f.create().enabled('archery'),false);settings.update('archery',true);assert.equal(f.create().enabled('archery'),true);
  assert.equal(f.create().enabled('mail'),false);
});
test('trial metadata never overrides explicit module choices and malformed values are ignored',t=>{
  const f=fixture(t),plugin=path.join(f.dataDir,'plugins/archery/installed.json');fs.mkdirSync(path.dirname(plugin),{recursive:true});
  for(const enabled of [false,true]){fs.writeFileSync(plugin,JSON.stringify({id:'archery',enabled:!enabled}));fs.writeFileSync(f.file,JSON.stringify({archery:enabled}));assert.equal(f.create().enabled('archery'),enabled);}
  fs.unlinkSync(f.file);
  for(const metadata of ['broken',JSON.stringify({id:'other',enabled:false}),JSON.stringify({id:'archery',enabled:'false'})]){fs.writeFileSync(plugin,metadata);assert.equal(f.create().enabled('archery'),true);assert.equal(fs.readFileSync(plugin,'utf8'),metadata);}
});
