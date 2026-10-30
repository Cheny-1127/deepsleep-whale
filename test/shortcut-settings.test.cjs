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
  assert.deepEqual(settings.snapshot(),{doubleClick:'none',tripleClick:'panel',reminderCollapseThreshold:3});
  settings.update('pat');
  assert.deepEqual(f.create().snapshot(),{doubleClick:'none',tripleClick:'pat',reminderCollapseThreshold:3});
  settings.update('none');
  assert.deepEqual(f.create().snapshot(),{doubleClick:'none',tripleClick:'none',reminderCollapseThreshold:3});
});
test('unknown actions are rejected and a failed save retains the previous binding',t=>{
  const f=fixture(t),settings=f.create();
  assert.throws(()=>settings.update('quit'),/无效/);
  assert.throws(()=>settings.update({doubleClick:'quit'}),/无效/);
  fs.mkdirSync(path.join(f.dataDir,'shortcuts.json'));
  assert.throws(()=>settings.update('feed'));
  assert.deepEqual(settings.snapshot(),{doubleClick:'none',tripleClick:'panel',reminderCollapseThreshold:3});
});
test('invalid saved bindings use the default without rewriting the file',t=>{
  const f=fixture(t),file=path.join(f.dataDir,'shortcuts.json');
  fs.writeFileSync(file,'{"tripleClick":"quit"}');
  assert.deepEqual(f.create().snapshot(),{doubleClick:'none',tripleClick:'panel',reminderCollapseThreshold:3});
  assert.equal(fs.readFileSync(file,'utf8'),'{"tripleClick":"quit"}');
});

test('shared reminder threshold persists independently and rejects invalid values',t=>{
  const f=fixture(t),settings=f.create();
  settings.update({reminderCollapseThreshold:1});settings.update('feed');
  assert.deepEqual(f.create().snapshot(),{doubleClick:'none',tripleClick:'feed',reminderCollapseThreshold:1});
  for(const value of [0,11,1.5,'2',null])assert.throws(()=>settings.update({reminderCollapseThreshold:value}),/无效/);
  settings.update({reminderCollapseThreshold:10});
  assert.equal(f.create().snapshot().reminderCollapseThreshold,10);
});
test('legacy settings retain action and default threshold; failed threshold save rolls back',t=>{
  const f=fixture(t),file=path.join(f.dataDir,'shortcuts.json');
  fs.writeFileSync(file,JSON.stringify({tripleClick:'pat'}));
  const settings=f.create();assert.deepEqual(settings.snapshot(),{doubleClick:'none',tripleClick:'pat',reminderCollapseThreshold:3});
  fs.mkdirSync(file+'.tmp');assert.throws(()=>settings.update({reminderCollapseThreshold:2}));
  assert.equal(settings.snapshot().reminderCollapseThreshold,3);
});

test('previous busy-only threshold migrates to the shared setting',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dataDir,'shortcuts.json'),JSON.stringify({tripleClick:'pat',busyCollapseThreshold:2}));
  const settings=f.create();assert.deepEqual(settings.snapshot(),{doubleClick:'none',tripleClick:'pat',reminderCollapseThreshold:2});
  settings.update('feed');assert.equal(f.create().snapshot().reminderCollapseThreshold,2);
});
test('double and triple bindings can be configured independently, including storage, and survive restart',t=>{
  const f=fixture(t),settings=f.create();
  settings.update({doubleClick:'panel',tripleClick:'store-pet'});
  assert.deepEqual(f.create().snapshot(),{doubleClick:'panel',tripleClick:'store-pet',reminderCollapseThreshold:3});
  settings.update({doubleClick:'none'});assert.equal(settings.snapshot().tripleClick,'store-pet');
  settings.update('feed');assert.equal(settings.snapshot().doubleClick,'none');
});
test('a mixed invalid update or disk failure cannot partially change gesture bindings',t=>{
  const f=fixture(t),settings=f.create();
  settings.update({doubleClick:'panel',tripleClick:'store-pet'});
  for(const patch of [{doubleClick:'pat',tripleClick:'quit'},{doubleClick:'pat',unknown:1},{}])assert.throws(()=>settings.update(patch),/无效/);
  fs.mkdirSync(path.join(f.dataDir,'shortcuts.json.tmp'));
  assert.throws(()=>settings.update({doubleClick:'none',tripleClick:'none'}));
  assert.deepEqual(settings.snapshot(),{doubleClick:'panel',tripleClick:'store-pet',reminderCollapseThreshold:3});
});
