'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createModuleRuntime}=require('../src/app/module-runtime.cjs');
test('suspending closes the old instance, keeps readonly data and restores saved account switches',()=>{
  let saved={accounts:[{id:1,enabled:false},{id:2,enabled:true}]};const instances=[];
  const runtime=createModuleRuntime({create:()=>{const value=structuredClone(saved),instance={started:0,closed:false,snapshot:()=>value,start(){this.started++;},close(){this.closed=true;value.accounts=[];},setEnabled(patch){value.accounts.find(a=>a.id===patch.id).enabled=patch.enabled;saved=structuredClone(value);}};instances.push(instance);return instance;}});
  runtime.start();runtime.setEnabled({id:2,enabled:false});runtime.setModuleEnabled(false);
  assert.equal(instances[0].closed,true);assert.deepEqual(runtime.snapshot(),saved);assert.throws(()=>runtime.setEnabled({id:1,enabled:true}),/已关闭/);
  const copy=runtime.snapshot();copy.accounts.length=0;assert.equal(runtime.snapshot().accounts.length,2);
  runtime.setModuleEnabled(true);assert.equal(instances.length,2);assert.equal(instances[1].started,1);assert.deepEqual(runtime.snapshot().accounts.map(a=>a.enabled),[false,false]);runtime.close();
});
test('disabled startup never starts a service, enabling is idempotent and late results stay on the closed instance',async()=>{
  const instances=[];let release;
  const runtime=createModuleRuntime({enabled:false,create:()=>{const state={value:0};const instance={closed:false,starts:0,snapshot:()=>state,start(){this.starts++;},close(){this.closed=true;},async refresh(){await new Promise(resolve=>release=resolve);if(!this.closed)state.value=99;}};instances.push(instance);return instance;}});
  runtime.start();assert.equal(instances[0].starts,0);assert.equal(instances[0].closed,true);
  runtime.setModuleEnabled(true);const pending=runtime.refresh();runtime.setModuleEnabled(false);runtime.setModuleEnabled(true);runtime.setModuleEnabled(true);
  release();await pending;assert.equal(instances.length,3);assert.equal(instances[2].starts,1);assert.equal(runtime.snapshot().value,0);runtime.close();assert.throws(()=>runtime.setModuleEnabled(true),/退出/);
});
