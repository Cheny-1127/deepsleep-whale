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
