'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createAiStore}=require('../src/ai/store.cjs');
const {createAiService}=require('../src/ai/service.cjs');
const config={baseUrl:'https://ai.example.test/gateway/v1/',apiKey:'fixture-secret-key',model:'test-model',protocol:'chat'};
function storage(){const key=Buffer.alloc(32,9);return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()]);},decryptString:raw=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString();}};}
function setup(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-ai-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const safeStorage=storage(),store=createAiStore({dataDir:dir,safeStorage}),service=createAiService({store,...options});t.after(()=>service.close());return {dir,store,service,safeStorage};}
const answer=text=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}]});
test('encrypted shared settings survive restart without exposing the API key',t=>{
 const {dir,store,service}=setup(t);assert.equal(service.snapshot().configured,false);
 const saved=service.save(config);assert.equal(saved.baseUrl,'https://ai.example.test/gateway/v1');assert.equal(saved.configured,true);assert.equal(saved.hasKey,true);assert.ok(!JSON.stringify(saved).includes(config.apiKey));
 const file=path.join(dir,'ai-config.enc');assert.equal(fs.readFileSync(file).includes(Buffer.from(config.apiKey)),false);assert.equal(fs.statSync(file).mode&0o777,0o600);
 const reopened=createAiService({store});t.after(()=>reopened.close());assert.deepEqual(reopened.snapshot(),saved);
 reopened.save({...saved,apiKey:'',model:'next-model'});assert.equal(store.load().apiKey,config.apiKey);
 assert.throws(()=>reopened.save({...config,apiKey:'',baseUrl:'https://other.example.test/v1'}),/地址.*密钥|地址.*Key/);
 assert.equal(reopened.snapshot().model,'next-model');reopened.clear();assert.equal(createAiService({store}).snapshot().configured,false);
});
test('unavailable encryption, corrupt input and failed writes retain the old configuration',t=>{
 const {dir,store,service,safeStorage}=setup(t);service.save(config);const file=path.join(dir,'ai-config.enc'),old=fs.readFileSync(file);
 safeStorage.isEncryptionAvailable=()=>false;assert.throws(()=>service.save({...config,model:'changed'}),/安全存储/);assert.deepEqual(fs.readFileSync(file),old);assert.equal(service.snapshot().model,config.model);
 safeStorage.isEncryptionAvailable=()=>true;fs.mkdirSync(file+'.tmp');assert.throws(()=>service.save({...config,model:'changed'}),/保存失败/);assert.equal(service.snapshot().model,config.model);assert.deepEqual(fs.readFileSync(file),old);fs.rmdirSync(file+'.tmp');
 fs.writeFileSync(file,'broken');const corrupted=createAiService({store});t.after(()=>corrupted.close());assert.match(corrupted.snapshot().error,/解密|损坏/);assert.throws(()=>corrupted.save(config),/清除/);assert.equal(fs.readFileSync(file,'utf8'),'broken');corrupted.clear();assert.equal(corrupted.snapshot().error,'');
});
test('validation prevents invalid URLs, credentials in URLs, control characters and endpoint confusion',t=>{
 const {service}=setup(t);
 for(const baseUrl of ['file:///tmp/a','https://user:pass@ai.test/v1','https://ai.test/v1?key=secret','https://ai.test/v1#secret','https://ai.test/v1/chat/completions'])assert.throws(()=>service.save({...config,baseUrl}),/地址/);
 assert.throws(()=>service.save({...config,apiKey:'key\nsecret'}),/密钥|Key/);assert.throws(()=>service.save({...config,protocol:'other'}),/接口/);
 service.save({...config,baseUrl:'http://127.0.0.1:9999/v1'});assert.equal(service.snapshot().configured,true);
});
test('test sends only a fixed probe and shared generation uses the same saved connection',async t=>{
 const calls=[];const {service}=setup(t,{fetchImpl:async(url,options)=>{calls.push({url,options});return answer('OK');}});
 await service.test(config);assert.equal(service.snapshot().configured,false);assert.equal(calls.length,1);assert.match(JSON.parse(calls[0].options.body).messages[0].content,/OK/);
 service.save(config);assert.equal(await service.generate({system:'写作要求',prompt:'本期工作\n1. 接口调整\n2. 数据核对'}),'OK');
 const {url,options}=calls[1],body=JSON.parse(options.body);assert.equal(url,'https://ai.example.test/gateway/v1/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+config.apiKey);assert.equal(body.store,false);assert.equal(body.model,config.model);assert.deepEqual(body.messages,[{role:'system',content:'写作要求'},{role:'user',content:'本期工作\n1. 接口调整\n2. 数据核对'}]);
 assert.throws(()=>service.save({...config,model:''}),/模型/);
});
test('Responses API extracts final assistant text and rejects incomplete responses',async t=>{
 let payload={status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:'整理结果'}]}]},last;
 const {service}=setup(t,{fetchImpl:async(url,options)=>{last={url,body:JSON.parse(options.body)};return Response.json(payload);}});service.save({...config,protocol:'responses'});
 assert.equal(await service.generate({system:'要求',prompt:'事实'}),'整理结果');assert.ok(last.url.endsWith('/responses'));assert.equal(last.body.store,false);assert.equal(last.body.instructions,'要求');assert.equal(last.body.input,'事实');
 payload={...payload,status:'incomplete'};await assert.rejects(service.generate({prompt:'事实'}),/未完成/);
});
test('local conversations replay Responses items and keep their own stable cache identity',async t=>{
 const bodies=[],items=[{type:'reasoning',id:'rs_fixture',encrypted_content:'opaque-fixture',summary:[]},{type:'message',id:'msg_fixture',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'记住了',annotations:[]}]}];
 const {service}=setup(t,{fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return Response.json({status:'completed',output:items,usage:{input_tokens:1300,output_tokens:8,input_tokens_details:{cached_tokens:1024}}});}});service.save({...config,protocol:'responses'});
 const first=await service.chat({sessionId:'session-one',messages:[{role:'user',content:'项目叫鲸鱼'}]});assert.equal(first.text,'记住了');assert.deepEqual(first.items,items);assert.equal(first.usage.cacheReadTokens,1024);assert.ok(!JSON.stringify(service.sessionContext()).includes(config.apiKey));
 const history=[{role:'user',content:'项目叫鲸鱼'},...first.items,{role:'user',content:'项目叫什么？'}];await service.chat({sessionId:'session-one',messages:history});assert.deepEqual(bodies[1].input,history);assert.equal(bodies[0].prompt_cache_key,bodies[1].prompt_cache_key);assert.equal(bodies[1].store,false);assert.equal(Object.hasOwn(bodies[1],'previous_response_id'),false);
 await service.chat({sessionId:'session-two',messages:[{role:'user',content:'另一个话题'}]});assert.notEqual(bodies[2].prompt_cache_key,bodies[1].prompt_cache_key);
});
test('conversation boundaries reject oversized or unreplayable input before sending and unsupported tool output',async t=>{
 let count=0,tool=false;const {service}=setup(t,{fetchImpl:async()=>{count++;return Response.json({status:'completed',output:[{type:'reasoning',id:'legacy-reasoning',summary:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:'文本回复'}]},...(tool?[{type:'function_call',name:'unsupported'}]:[])]});}});service.save({...config,protocol:'responses'});
 for(const messages of [[],[{role:'assistant',content:'没有本次输入'}],[{role:'user',content:'x'.repeat(1024*1024)}],[{type:'reasoning',id:'missing-encrypted-content'},{role:'user',content:'继续'}]])await assert.rejects(service.chat({sessionId:'bounded-session',messages}),/上下文|内容|推理/);
 assert.equal(count,0);const result=await service.chat({sessionId:'bounded-session',messages:[{role:'user',content:'继续'}]});assert.equal(result.items.length,1);assert.equal(result.items[0].type,'message');
 tool=true;await assert.rejects(service.chat({sessionId:'bounded-session',messages:[{role:'user',content:'继续'}]}),/仅支持文本/);assert.equal(count,2);
});
test('reasoning effort survives encrypted restart and uses each protocol without changing the saved key',async t=>{
 const calls=[];const {store,service}=setup(t,{fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return url.endsWith('/responses')?Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}):answer('OK');}});
 assert.equal(service.snapshot().reasoningEffort,'');store.save(config);const legacy=createAiService({store});t.after(()=>legacy.close());assert.equal(legacy.snapshot().configured,true);assert.equal(legacy.snapshot().reasoningEffort,'');service.save(config);assert.equal(service.snapshot().reasoningEffort,'');
 service.save({...service.snapshot(),apiKey:'',protocol:'responses',reasoningEffort:'xhigh'});assert.equal(store.load().apiKey,config.apiKey);
 const restored=createAiService({store});t.after(()=>restored.close());assert.equal(restored.snapshot().reasoningEffort,'xhigh');
 await service.generate({prompt:'事实'});assert.deepEqual(calls.at(-1).body.reasoning,{effort:'xhigh'});assert.equal(Object.hasOwn(calls.at(-1).body,'reasoning_effort'),false);
 await service.test({...service.snapshot(),apiKey:'',reasoningEffort:'low'});assert.deepEqual(calls.at(-1).body.reasoning,{effort:'low'});assert.equal(service.snapshot().reasoningEffort,'xhigh');
 service.save({...service.snapshot(),apiKey:'',protocol:'chat',reasoningEffort:'high'});await service.generate({prompt:'事实'});assert.equal(calls.at(-1).body.reasoning_effort,'high');assert.equal(Object.hasOwn(calls.at(-1).body,'reasoning'),false);
 service.save({...service.snapshot(),apiKey:'',reasoningEffort:''});await service.generate({prompt:'事实'});assert.equal(Object.hasOwn(calls.at(-1).body,'reasoning_effort'),false);
 service.save({...service.snapshot(),apiKey:'',protocol:'responses'});await service.generate({prompt:'事实'});assert.equal(Object.hasOwn(calls.at(-1).body,'reasoning'),false);
 assert.throws(()=>service.save({...service.snapshot(),apiKey:'',reasoningEffort:'ultra'}),/推理强度/);assert.equal(service.snapshot().reasoningEffort,'');assert.equal(store.load().apiKey,config.apiKey);
});
test('unsupported explicit reasoning reports a safe suggestion without changing settings or retrying',async t=>{
 let count=0;const {service}=setup(t,{fetchImpl:async()=>{count++;return new Response('raw provider details '+config.apiKey,{status:400});}});service.save({...config,reasoningEffort:'max'});
 await assert.rejects(service.test({...service.snapshot(),apiKey:''}),error=>/模型默认/.test(error.message)&&!error.message.includes(config.apiKey));assert.equal(count,1);assert.equal(service.snapshot().reasoningEffort,'max');
});
test('cache identity stays stable across changing work and restart while isolating credentials and templates',async t=>{
 const bodies=[],fetchImpl=async(url,options)=>{bodies.push(JSON.parse(options.body));return url.endsWith('/responses')?Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}):answer('OK');};const {service,store}=setup(t,{fetchImpl});service.save(config);
 await service.generate({system:'固定模板',prompt:'第一份工作内容'});const key=bodies.at(-1).prompt_cache_key;assert.equal(typeof key,'string');assert.ok(key.length<=64);assert.match(key,/^whale-v1-[a-f0-9]+$/);assert.ok(!key.includes(config.apiKey));assert.ok(!key.includes('模板'));
 await service.generate({system:'固定模板',prompt:'第二份工作内容'});assert.equal(bodies.at(-1).prompt_cache_key,key);
 const restored=createAiService({store,fetchImpl});t.after(()=>restored.close());await restored.generate({system:'固定模板',prompt:'第三份内容'});assert.equal(bodies.at(-1).prompt_cache_key,key);
 await service.generate({system:'另一个模板',prompt:'第一份工作内容'});assert.notEqual(bodies.at(-1).prompt_cache_key,key);
 for(const patch of [{model:'other-model'},{baseUrl:'https://other.example.test/v1'},{apiKey:'other-fixture-key'},{reasoningEffort:'high'}]){service.save({...config,...patch});await service.generate({system:'固定模板',prompt:'第一份工作内容'});assert.notEqual(bodies.at(-1).prompt_cache_key,key);}
 service.save({...config,protocol:'responses'});await service.test(service.snapshot());assert.equal(typeof bodies.at(-1).prompt_cache_key,'string');
});
test('reported cache usage is retained without raw responses, guessed zeroes or changing text generation',async t=>{
 let usage={input_tokens:1600,output_tokens:5,input_tokens_details:{cached_tokens:1280,cache_write_tokens:256},private:'must-not-escape'};
 const {service}=setup(t,{fetchImpl:async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],usage})});service.save({...config,protocol:'responses'});
 assert.equal(await service.generate({prompt:'测试文本'}),'OK');assert.deepEqual(service.snapshot().lastUsage,{model:config.model,protocol:'responses',inputTokens:1600,outputTokens:5,cacheReadTokens:1280,cacheWriteTokens:256});
 const detached=service.snapshot();detached.lastUsage.cacheReadTokens=0;assert.equal(service.snapshot().lastUsage.cacheReadTokens,1280);
 const result=await service.test({...service.snapshot(),apiKey:''});assert.deepEqual(result.usage,{inputTokens:1600,outputTokens:5,cacheReadTokens:1280,cacheWriteTokens:256});assert.ok(!JSON.stringify(result).includes('must-not-escape'));
 usage={prompt_tokens:1200,completion_tokens:4,prompt_tokens_details:{cached_tokens:0},cache_read_input_tokens:100,cache_creation_input_tokens:256};const zero=await service.test({...service.snapshot(),apiKey:''});assert.equal(zero.usage.cacheReadTokens,0);assert.equal(zero.usage.cacheWriteTokens,256);assert.equal(zero.usage.inputTokens,1200);
 usage={input_tokens:200,output_tokens:1};assert.equal((await service.test({...service.snapshot(),apiKey:''})).usage.cacheReadTokens,null);
 usage={input_tokens:'200',output_tokens:-1,cached_tokens:'128',cache_write_tokens:Infinity};assert.equal((await service.test({...service.snapshot(),apiKey:''})).usage,null);
 service.save({...service.snapshot(),apiKey:''});assert.equal(service.snapshot().lastUsage,null);
});
test('errors never echo server secrets; no retries, bounded output and no partial answers',async t=>{
 let response=()=>new Response(config.apiKey,{status:401}),count=0;
 const {service}=setup(t,{fetchImpl:async()=>{count++;return response();}});service.save(config);
 await assert.rejects(service.test({...service.snapshot(),apiKey:''}),error=>/密钥|授权/.test(error.message)&&!error.message.includes(config.apiKey));assert.equal(count,1);
 response=()=>{throw Error('token='+config.apiKey);};await assert.rejects(service.generate({prompt:'事实'}),error=>!error.message.includes(config.apiKey));
 response=()=>Response.json({choices:[{finish_reason:'length',message:{content:'截断'}}]});await assert.rejects(service.generate({prompt:'事实'}),/未完成/);
 response=()=>new Response('x'.repeat(2*1024*1024+1));await assert.rejects(service.generate({prompt:'事实'}),/过大/);
});
test('cancellation, timeout, shutdown and concurrent tests release the connection safely',async t=>{
 let began;const started=new Promise(resolve=>began=resolve);
 const {service}=setup(t,{timeoutMs:35,fetchImpl:async(_url,{signal})=>{began();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});service.save(config);
 const request=service.test({...service.snapshot(),apiKey:''});await started;await assert.rejects(service.test(config),/正在/);assert.throws(()=>service.clear(),/正在/);await assert.rejects(request,/超时/);
 const controller=new AbortController(),cancelled=service.generate({prompt:'事实',signal:controller.signal});controller.abort();await assert.rejects(cancelled,/取消/);
 const closing=service.generate({prompt:'事实'});service.close();await assert.rejects(closing,/取消/);await assert.rejects(service.generate({prompt:'事实'}),/关闭/);
});
test('real HTTP redirects do not forward credentials or retry another endpoint',async t=>{
 const http=require('node:http'),paths=[];
 const server=http.createServer((request,response)=>{paths.push(request.url);response.writeHead(302,{Location:'/stolen'});response.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const {service}=setup(t);service.save({...config,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'});
 await assert.rejects(service.generate({prompt:'事实'}),/无法连接/);assert.deepEqual(paths,['/v1/chat/completions']);
});
