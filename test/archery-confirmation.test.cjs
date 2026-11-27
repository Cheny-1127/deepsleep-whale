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

test('large-detail confirmation is answered once by the originating page and withdrawn when the read is cancelled',async t=>{
  const {createLargeDetailConfirmation}=require('../src/app/archery-confirmation.cjs');
  const f=fixture(t),large=createLargeDetailConfirmation();t.after(()=>large.cancel());
  const item={id:779,title:'补代运营',bytes:70000,sql:'不应下发'};
  const waiting=large.request(f.sender,item),message=f.messages.at(-1);
  assert.equal(message.channel,'archery-large-confirmation');assert.deepEqual(message.item,{id:779,title:'补代运营',bytes:70000});
  assert.equal(large.reply(new EventEmitter(),{token:message.token,confirmed:true}),false,'其他页面不能回答');
  assert.equal(large.reply(f.sender,{token:message.token,confirmed:'yes'}),false);
  assert.equal(large.reply(f.sender,{token:message.token,confirmed:true}),true);assert.equal(await waiting,true);
  assert.equal(large.reply(f.sender,{token:message.token,confirmed:true}),false,'令牌只能用一次');
  const controller=new AbortController(),aborted=large.request(f.sender,item,controller.signal),second=f.messages.at(-1).token;
  controller.abort();assert.equal(await aborted,false);
  assert.deepEqual({token:f.messages.at(-1).token,cancelled:f.messages.at(-1).cancelled},{token:second,cancelled:true},'取消时收起页面上的询问');
  const left=large.request(f.sender,item);f.sender.emit('did-start-navigation');assert.equal(await left,false);
  const timed=createLargeDetailConfirmation({timeoutMs:5}).request(f.sender,item);assert.equal(await timed,false,'超时不默认加载');
});

test('a large read inside an approval asks the same page through the large-detail confirmation',async t=>{
  const asked=[];let seen;
  const f=fixture(t,{confirmLarge:async(sender,item,signal)=>{asked.push({sender,item,signal});return true;}});
  const waiting=f.bridge.request(f.sender,f.item,{canDetail:true,loadDetail:async(allowLarge,confirmLarge)=>{seen=allowLarge;return {confirmed:await confirmLarge({id:566,bytes:9},'signal')};}});
  const token=f.messages[0].token;
  assert.deepEqual(await f.bridge.detail(f.sender,{token,allowLarge:true}),{confirmed:true});
  assert.equal(seen,true);assert.equal(asked[0].sender,f.sender);assert.equal(asked[0].signal,'signal');
  f.bridge.reply(f.sender,{token,confirmed:false});assert.equal(await waiting,false);
});
