'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createArcheryConfirmation}=require('../src/app/archery-confirmation.cjs');
function fixture(t,options={}) {
  const sender=new EventEmitter(),window=new EventEmitter(),messages=[];
  sender.isDestroyed=()=>false;sender.send=(channel,value)=>messages.push({channel,...value});
  const bridge=createArcheryConfirmation({getWindow:()=>window,...options});t.after(()=>bridge.cancel());
  return {sender,window,messages,bridge,item:{id:566,title:'测试工单'}};
}
test('confirmation is bound to the originating page and one-use token; no reply is not approval',async t=>{
  const f=fixture(t),waiting=f.bridge.request(f.sender,f.item),token=f.messages[0].token;
  assert.equal(f.messages[0].channel,'archery-confirmation');assert.deepEqual(f.messages[0].item,f.item);
  assert.equal(f.bridge.reply(new EventEmitter(),{token,confirmed:true}),false);
  assert.equal(f.bridge.reply(f.sender,{token:'forged',confirmed:true}),false);
  assert.equal(f.bridge.reply(f.sender,{token,confirmed:1}),false);
  assert.equal(f.bridge.reply(f.sender,{token,confirmed:true}),true);assert.equal(await waiting,true);
  assert.equal(f.bridge.reply(f.sender,{token,confirmed:true}),false);
  assert.equal(f.sender.listenerCount('destroyed'),0);assert.equal(f.window.listenerCount('hide'),0);
  const next=f.bridge.request(f.sender,{id:567});assert.notEqual(f.messages.at(-1).token,token);
  assert.equal(f.bridge.reply(f.sender,{token,confirmed:true}),false);f.bridge.cancel();assert.equal(await next,false);
});
test('a second request cannot replace a pending confirmation and cancellation never approves',async t=>{
  const f=fixture(t),waiting=f.bridge.request(f.sender,f.item),token=f.messages[0].token;
  assert.equal(await f.bridge.request(f.sender,{id:567}),false);assert.equal(f.messages.length,1);
  assert.equal(f.bridge.reply(f.sender,{token,confirmed:false}),true);assert.equal(await waiting,false);
  assert.equal(f.messages.at(-1).cancelled,true);
});
test('hiding, closing, reloading, renderer loss or module cancellation invalidates old confirmation',async t=>{
  for(const [target,event] of [['window','hide'],['window','close'],['sender','did-start-navigation'],['sender','render-process-gone'],['sender','destroyed'],['bridge','cancel']]){
    const f=fixture(t),waiting=f.bridge.request(f.sender,f.item),token=f.messages[0].token;
    if(event==='cancel')f.bridge.cancel();else f[target].emit(event);
    assert.equal(await waiting,false,event);assert.equal(f.bridge.reply(f.sender,{token,confirmed:true}),false,event);
    assert.equal(f.sender.listenerCount('destroyed'),0,event);assert.equal(f.window.listenerCount('hide'),0,event);
  }
});
test('undeliverable and expired confirmations resolve to cancellation',async t=>{
  const f=fixture(t,{timeoutMs:10});f.sender.send=()=>{throw Error('renderer unavailable');};
  assert.equal(await f.bridge.request(f.sender,f.item),false);
  f.sender.send=(channel,value)=>f.messages.push({channel,...value});
  const keepAlive=setTimeout(()=>{},1000);t.after(()=>clearTimeout(keepAlive));
  assert.equal(await f.bridge.request(f.sender,f.item),false);assert.equal(f.messages.at(-1).cancelled,true);
});
