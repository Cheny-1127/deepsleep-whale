'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createShortcutSettings}=require('../src/app/shortcut-settings.cjs');

function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-shortcuts-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  return {dataDir,create:()=>createShortcutSettings({dataDir})};
}
test('triple click defaults to opening the house and custom actions persist across restarts',t=>{
  const f=fixture(t),settings=f.create();
  assert.deepEqual(settings.snapshot(),{tripleClick:'panel'});
  settings.update('pat');
  assert.deepEqual(f.create().snapshot(),{tripleClick:'pat'});
  settings.update('none');
  assert.deepEqual(f.create().snapshot(),{tripleClick:'none'});
});
test('unknown actions are rejected and a failed save retains the previous binding',t=>{
  const f=fixture(t),settings=f.create();
  assert.throws(()=>settings.update('quit'),/无效/);
  assert.throws(()=>settings.update({tripleClick:'panel'}),/无效/);
  fs.mkdirSync(path.join(f.dataDir,'shortcuts.json'));
  assert.throws(()=>settings.update('feed'));
  assert.deepEqual(settings.snapshot(),{tripleClick:'panel'});
});
test('invalid saved bindings use the default without rewriting the file',t=>{
  const f=fixture(t),file=path.join(f.dataDir,'shortcuts.json');
  fs.writeFileSync(file,'{"tripleClick":"quit"}');
  assert.deepEqual(f.create().snapshot(),{tripleClick:'panel'});
  assert.equal(fs.readFileSync(file,'utf8'),'{"tripleClick":"quit"}');
});
