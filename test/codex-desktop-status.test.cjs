'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {desktopFixture}=require('./fixtures/codex-desktop.cjs');
const {readDesktopStatus}=require('../src/agents/codex-desktop-status.cjs');
async function setup(t,options={}) {
  const home=fs.mkdtempSync('/tmp/whale-status-');
  const desktop=await desktopFixture({home,...options});
  t.after(async()=>{await desktop.close();fs.rmSync(home,{recursive:true,force:true});});
  return {desktop,read:options=>readDesktopStatus({configHome:home},'desktop-fixture',options)};
}
test('reads live idle, running, approval and question states without sending tasks or retaining history',async t=>{
  const {desktop,read}=await setup(t);
  for(const [type,flags,expected] of [['idle',[],'idle'],['active',[],'active'],['active',['waitingOnApproval'],'approval'],['active',['waitingOnUserInput'],'question'],['active',['futureFlag'],'unknown'],['notLoaded',[],'unknown']]) {
    desktop.state.threadRuntimeStatus={type,activeFlags:flags};
    assert.equal(await read(),expected);
  }
  assert.ok(desktop.wire.every(m=>['initialize','thread-owner-discovery','thread-stream-following-changed'].includes(m.method)));
  assert.ok(!JSON.stringify(desktop.wire).includes('private-history'));
});
test('unavailable desktop, cancellation and missing thread snapshots return unknown',async t=>{
  const {desktop,read}=await setup(t);
  assert.equal(await readDesktopStatus({configHome:'/nonexistent-whale-status'},'thread'),'unknown');
  assert.equal(await read({signal:AbortSignal.abort()}),'unknown');
  assert.equal(desktop.wire.length,0);
  assert.equal(await readDesktopStatus({configHome:fs.realpathSync(desktop.state.cwd)},'another-thread',{timeoutMs:30}),'unknown');
  const controller=new AbortController(),pending=readDesktopStatus({configHome:desktop.state.cwd},'another-thread',{signal:controller.signal});
  controller.abort();assert.equal(await pending,'unknown');
});
test('untrusted protocol, owner and conversation identity cannot report idle',async t=>{
  for(const failure of ['version','owner','id']) {
    const streamEnvelope=failure==='version'?{version:999}:failure==='owner'?{sourceClientId:'wrong-owner'}:{};
    const {desktop,read}=await setup(t,{streamEnvelope});
    if(failure==='id')desktop.state.id='wrong-thread';
    assert.equal(await read(),'unknown');
  }
});

test('waits for a cold desktop snapshot arriving after three seconds',async t=>{
  const {read}=await setup(t,{snapshotDelayMs:3200});
  assert.equal(await read(),'idle');
});
