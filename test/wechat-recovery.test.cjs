'use strict';
// 将真实桌面 socket、加密文件与网关串起来，重建网关模拟进程重启；不访问微信或模型。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {desktopFixture}=require('./fixtures/codex-desktop.cjs');
const {createWechatGateway}=require('../src/channels/wechat-gateway.cjs');
const {createWechatStore,fresh,bindingKey}=require('../src/channels/wechat-store.cjs');
async function until(check){for(let i=0;i<300;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('recovery integration condition timed out');}
async function setup(t) {
  const home=fs.mkdtempSync('/tmp/whale-recovery-');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const desktop=await desktopFixture({home});t.after(()=>desktop.close());
  const key=crypto.randomBytes(32),safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'test',
    encryptString(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},
    decryptString(value){const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');}};
  const store=createWechatStore({dataDir:home,safeStorage}),state=fresh();
  state.enabled=true;state.account={id:'test-bot',token:'private-token',owner:'test-owner'};state.allowed=['test-owner'];state.clients[0].configHome=home;
  state.bindings[bindingKey('test-bot','test-owner')]={id:'binding',clientId:state.clients[0].id,cwd:fs.realpathSync(home),threadId:'desktop-fixture',transport:'desktop'};store.save(state);
  const sent=[],gateways=[],queue=[];let sendError=false;
  function boot(){
    const gateway=createWechatGateway({store,makeQr:async()=>'',pollDelay:1,api:{
      updates:async(_account,_cursor,signal)=>{await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,3);signal.addEventListener('abort',done,{once:true});});return {msgs:queue.splice(0)};},
      send:async(_account,sender,text,context,id)=>{if(sendError)throw Error('offline');sent.push({sender,text,context,id});}
    }});gateways.push(gateway);gateway.start();return gateway;
  }
  t.after(()=>gateways.forEach(gateway=>gateway.close()));
  const push=text=>queue.push({message_id:'original-inbound',message_type:1,from_user_id:'test-owner',to_user_id:'test-bot',context_token:'original-context',item_list:[{type:1,text_item:{text}}]});
  return {home,desktop,store,sent,boot,push,set sendError(value){sendError=value;}};
}
test('real restart recovers a completed original turn from encrypted checkpoints and resumes failed delivery once',async t=>{
  const h=await setup(t),first=h.boot();h.push('重启前的问题');
  await until(()=>h.store.load().jobs[0]?.checkpoint?.turnId==='forwarded-turn');
  const checkpoint=h.store.load().jobs[0].checkpoint;assert.ok(!fs.readFileSync(path.join(h.home,'wechat.enc')).includes(Buffer.from('重启前的问题')));
  first.close();assert.equal(h.desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'),false);
  h.desktop.complete('原任务最终结果');h.sendError=true;const second=h.boot();
  await until(()=>h.store.load().jobs[0]?.delivery==='failed');const pending=h.store.load().outbox[0];
  assert.equal(h.store.load().jobs[0].state,'completed');assert.deepEqual(h.store.load().jobs[0].checkpoint,checkpoint);assert.equal(h.sent.length,0);
  second.close();h.sendError=false;const third=h.boot();await until(()=>h.sent.length===1);
  assert.deepEqual(h.sent[0],{sender:'test-owner',text:'原任务最终结果',context:'original-context',id:pending.id+'-0'});
  assert.equal(h.desktop.wire.filter(m=>m.method==='thread-follower-start-turn').length,1);assert.equal(h.store.load().jobs[0].delivery,'sent');
  third.close();h.boot();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.sent.length,1);
});
test('real restart attaches to an in-progress original turn and reports its later interruption',async t=>{
  const h=await setup(t),first=h.boot();h.push('还在运行的问题');
  await until(()=>h.store.load().jobs[0]?.checkpoint?.turnId==='forwarded-turn');first.close();
  const second=h.boot();await until(()=>second.snapshot().jobs[0].state==='running');assert.equal(h.sent.length,0);
  h.desktop.state.turnHistory.history.entitiesByKey.current.status='interrupted';h.desktop.state.threadRuntimeStatus.type='idle';h.desktop.snapshot();
  await until(()=>h.sent.length===1);assert.match(h.sent[0].text,/原 Codex 轮次已中断/);assert.equal(h.store.load().jobs[0].state,'interrupted');
  assert.equal(h.desktop.wire.filter(m=>m.method==='thread-follower-start-turn').length,1);
});
