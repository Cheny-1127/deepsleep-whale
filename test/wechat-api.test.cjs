'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createWechatApi,trustedBase,checkResult,incoming,splitText}=require('../src/channels/wechat-api.cjs');
const {fresh,createWechatStore}=require('../src/channels/wechat-store.cjs');

test('iLink wire format retains account, cursor, context and stable delivery ID',async()=>{
  const requests=[],api=createWechatApi({fetchImpl:async(url,options)=>{requests.push({url,...options});return {ok:true,text:async()=>'{}'};}});
  const account={token:'private-test-token',baseUrl:'https://ilinkai.weixin.qq.com'};
  await api.qr();await api.qrStatus('a+b/c?',account.baseUrl);await api.updates(account,'cursor-1');
  await api.send(account,'owner','你好😀','context-1','delivery-1');
  assert.match(requests[0].url,/get_bot_qrcode\?bot_type=3$/);
  assert.match(requests[1].url,/qrcode=a%2Bb%2Fc%3F$/);
  assert.deepEqual(JSON.parse(requests[2].body),{get_updates_buf:'cursor-1',base_info:{channel_version:'2.2.0'}});
  assert.equal(requests[3].headers.Authorization,'Bearer private-test-token');
  assert.equal(requests[3].headers.AuthorizationType,'ilink_bot_token');
  assert.equal(requests[3].headers['iLink-App-ClientVersion'],'131584');
  assert.equal(requests[3].redirect,'error');
  assert.deepEqual(JSON.parse(requests[3].body).msg,{from_user_id:'',to_user_id:'owner',client_id:'delivery-1',message_type:2,message_state:2,item_list:[{type:1,text_item:{text:'你好😀'}}],context_token:'context-1'});
});
test('credentials cannot follow untrusted service addresses and API expiry is explicit',()=>{
  for(const value of ['http://ilinkai.weixin.qq.com','https://weixin.qq.com.evil.test','https://user:pass@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com/path','https://127.0.0.1'])assert.throws(()=>trustedBase(value));
  assert.equal(trustedBase('https://ilinkai.weixin.qq.com/'),'https://ilinkai.weixin.qq.com');
  assert.throws(()=>checkResult({ret:-14}),error=>error.code===-14);
  assert.throws(()=>checkResult({ret:0,errcode:-2}),error=>error.code===-2);
  assert.deepEqual(checkResult({ret:0,msgs:[]}),{ret:0,msgs:[]});
});
test('large numeric message IDs match quoted string IDs without changing JSON strings',async()=>{
  const payload='{"ret":0,"message_id":7517268656584639368,"seq":12,"label":"message_id: 7517268656584639368 and \\\"quote\\\"","msgs":[{"message_id":7517268656584639369,"message_type":1,"from_user_id":"owner","to_user_id":"bot","item_list":[{"type":1,"text_item":{"text":"  /help\\n123  "},"ref_msg":{"message_item":{"type":0,"msg_id":"7517268656584639368"}}}]}]}';
  const api=createWechatApi({fetchImpl:async()=>({ok:true,text:async()=>payload})});
  const sent=await api.send({token:'test'},'owner','table','ctx','stable');
  assert.equal(sent.message_id,'7517268656584639368');assert.equal(sent.seq,12);
  assert.equal(sent.label,'message_id: 7517268656584639368 and "quote"');
  const message=incoming((await api.updates({token:'test'},'')).msgs[0],'bot');
  assert.equal(message.id,'7517268656584639369');assert.equal(message.text,'  /help\n123  ');
});
test('stale send context retries once without that context and preserves the delivery identity',async()=>{
  for(const failure of [{ret:-14},{ret:-2,errmsg:'prepare failed'}]){
    const requests=[],responses=[failure,{ret:0}];
    const api=createWechatApi({fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,text:async()=>JSON.stringify(responses.shift())};}});
    await api.send({token:'test'},'owner','result','stale-context','stable-id');assert.equal(requests.length,2);
    assert.equal(requests[0].msg.context_token,'stale-context');assert.ok(!('context_token' in requests[1].msg));assert.equal(requests[1].msg.client_id,'stable-id');
  }
  let attempts=0;const api=createWechatApi({fetchImpl:async()=>{attempts++;return {ok:true,text:async()=>JSON.stringify({ret:-2,errmsg:'rate limit'})};}});
  await assert.rejects(api.send({token:'test'},'owner','result','context','id'));assert.equal(attempts,1);
});
test('only identified private inbound messages are eligible; Unicode chunks stay intact',()=>{
  const msg={message_id:'1',message_type:1,from_user_id:'owner',to_user_id:'bot',context_token:'ctx',item_list:[{type:1,text_item:{text:'你好'}}]};
  assert.deepEqual(incoming(msg,'bot'),{id:'1',sender:'owner',context:'ctx',text:'你好'});
  for(const value of [{...msg,message_id:''},{...msg,message_type:2},{...msg,room_id:'group'},{...msg,to_user_id:'other'},{...msg,from_user_id:'bot'}])assert.equal(incoming(value,'bot'),null);
  const text='甲😀'.repeat(2000),parts=splitText(text);assert.equal(parts.join(''),text);assert.ok(parts.every(part=>Array.from(part).length<=1800));
});
test('store encrypts the whole state atomically and refuses plaintext fallback',t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-wechat-store-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  let encrypted=0;
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:text=>{encrypted++;return Buffer.from(Buffer.from(text).toString('base64'));},decryptString:buffer=>Buffer.from(buffer.toString(),'base64').toString()};
  const store=createWechatStore({dataDir,safeStorage}),value=fresh();value.account={token:'secret-test-token'};value.jobs=[{text:'private prompt'}];
  store.save(value);assert.equal(encrypted,1);assert.deepEqual(store.load(),value);
  const raw=fs.readFileSync(path.join(dataDir,'wechat.enc'),'utf8');assert.ok(!raw.includes('secret-test-token')&&!raw.includes('private prompt'));
  assert.equal(fs.statSync(path.join(dataDir,'wechat.enc')).mode&0o777,0o600);
  safeStorage.getSelectedStorageBackend=()=> 'basic_text';assert.equal(store.available(),false);assert.throws(()=>store.save(value));assert.throws(()=>store.load());
});
