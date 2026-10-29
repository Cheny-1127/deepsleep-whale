'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createArcheryConfirmation}=require('../src/app/archery-confirmation.cjs');
function fixture(t,options={}) {
  const sender=new EventEmitter(),window=new EventEmitter(),messages=[];
  sender.isDestroyed=()=>false;sender.send=(channel,value)=>messages.push({channel,...value});
  const bridge=createArcheryConfirmation({getWindow:()=>window,...options});t.after(()=>bridge.cancel());
  return {sender,window,messages,bridge,item:{id:566,title:'测试工单'}};
}
test('rejection token requires a reason and returns it only for its bound operation',async t=>{
  const f=fixture(t),waiting=f.bridge.request(f.sender,f.item,{operation:'reject'}),message=f.messages[0];
  assert.equal(message.operation,'reject');
  for(const remark of [undefined,'  ','x'.repeat(1001)])assert.equal(f.bridge.reply(f.sender,{token:message.token,confirmed:true,remark}),false);
  assert.equal(f.bridge.reply(f.sender,{token:message.token,confirmed:true,remark:'  不符合变更要求  '}),true);
  assert.deepEqual(await waiting,{confirmed:true,remark:'不符合变更要求'});
  assert.equal(f.bridge.reply(f.sender,{token:message.token,confirmed:true,remark:'再次拒绝'}),false);
  const approving=f.bridge.request(f.sender,f.item,{operation:'approve'}),token=f.messages.at(-1).token;
  f.bridge.reply(f.sender,{token,confirmed:true,remark:'不能变成拒绝'});assert.equal(await approving,true);
});

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
test('detail reads require the original confirmation and block approval until the read finishes',async t=>{
  const f=fixture(t);let release,reads=0;
  const cachedDetail={id:566,sql:'SELECT cached;'};
  const waiting=f.bridge.request(f.sender,f.item,{cachedDetail,canDetail:true,loadDetail:async()=>{reads++;return new Promise(resolve=>release=resolve);}}),token=f.messages[0].token;
  assert.deepEqual(f.messages[0].cachedDetail,cachedDetail);
  await assert.rejects(f.bridge.detail(new EventEmitter(),{token,allowLarge:false}),/失效/);
  await assert.rejects(f.bridge.detail(f.sender,{token:'stale',allowLarge:false}),/失效/);
  assert.equal(reads,0);
  const reading=f.bridge.detail(f.sender,{token,allowLarge:false});assert.equal(f.bridge.reply(f.sender,{token,confirmed:true}),false);
  await assert.rejects(f.bridge.detail(f.sender,{token,allowLarge:false}),/正在读取/);
  release(cachedDetail);assert.deepEqual(await reading,cachedDetail);
  assert.equal(f.bridge.reply(f.sender,{token,confirmed:true}),true);assert.equal(await waiting,true);
  await assert.rejects(f.bridge.detail(f.sender,{token,allowLarge:false}),/失效/);
});
test('cancellation remains available while loading and rejects the late detail result',async t=>{
  const f=fixture(t);let release;
  const waiting=f.bridge.request(f.sender,f.item,{canDetail:true,loadDetail:()=>new Promise(resolve=>release=resolve)}),token=f.messages[0].token;
  const reading=f.bridge.detail(f.sender,{token,allowLarge:false}),rejected=assert.rejects(reading,/取消/);
  assert.equal(f.bridge.reply(f.sender,{token,confirmed:false}),true);assert.equal(await waiting,false);
  release({sql:'late'});await rejected;
});
test('execution confirmation is tagged by the main process and the review token cannot be reused',async t=>{
  const f=fixture(t);const review=f.bridge.request(f.sender,f.item),old=f.messages[0].token;
  assert.equal(f.messages[0].operation,'approve');f.bridge.reply(f.sender,{token:old,confirmed:true});await review;
  const executing=f.bridge.request(f.sender,f.item,{operation:'execute'}),message=f.messages.at(-1);
  assert.equal(message.operation,'execute');assert.notEqual(message.token,old);
  assert.equal(f.bridge.reply(f.sender,{token:old,confirmed:true}),false);
  assert.equal(f.bridge.reply(f.sender,{token:message.token,confirmed:false}),true);assert.equal(await executing,false);
});
