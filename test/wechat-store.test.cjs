'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fresh,migrate,createWechatStore,bindingKey}=require('../src/channels/wechat-store.cjs');
const {validateClients}=require('../src/agents/clients.cjs');
test('encrypted legacy state migrates the original client and conversation without losing delivery or dedup',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-wechat-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'test',encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
  const settings={backend:'codex',cwd:dir,binary:'',configHome:dir,profile:'existing'};
  const key=JSON.stringify(['bot','owner','codex',dir,'',dir,'existing']);
  const legacy={...fresh(),version:1,settings,account:{id:'bot',token:'secret'},allowed:['owner'],sessions:{[key]:'desktop-thread'},seen:['message'],outbox:[{id:'reply',parts:['result'],index:0,sender:'owner'}]};
  delete legacy.clients;delete legacy.bindings;
  fs.writeFileSync(path.join(dir,'wechat.enc'),JSON.stringify(legacy));
  const store=createWechatStore({dataDir:dir,safeStorage}),value=store.load();
  assert.equal(value.version,2);assert.equal(value.clients[0].profile,'existing');assert.equal(value.bindings[bindingKey('bot','owner')].threadId,'desktop-thread');
  assert.deepEqual(value.seen,['message']);assert.equal(value.outbox[0].id,'reply');assert.ok(!('settings' in value)&&!('sessions' in value));
  store.save(value);assert.deepEqual(store.load(),value);assert.equal(fs.statSync(path.join(dir,'wechat.enc')).mode&0o777,0o600);
  assert.throws(()=>migrate({...fresh(),version:99}),/版本/);
});
test('multiple clients retain explicit order and enabled states, without requiring projects',()=>{
  const a=fresh().clients[0],b={...a,id:'custom',name:'Another Codex',enabled:false,binary:'/uninstalled/codex',configHome:'/uninstalled/home'};
  const result=validateClients([b,a]);assert.equal(result[0].id,'custom');assert.equal(result[1].enabled,true);assert.ok(!('cwd' in result[0]));
  assert.throws(()=>validateClients([a,a]),/重复/);assert.throws(()=>validateClients([{...a,profile:'bad;command'}]),/profile/);
  assert.throws(()=>validateClients([{...a,binary:'relative'}]),/可执行/);assert.throws(()=>validateClients([{...a,enabled:'yes'}]),/启用/);
  assert.deepEqual(validateClients([]),[]);
});
