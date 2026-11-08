'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createAiSessionStore}=require('../src/ai/session-store.cjs'),{createAiSessions}=require('../src/ai/sessions.cjs'),{createAiService}=require('../src/ai/service.cjs');
const config={baseUrl:'https://ai.example.test/v1',model:'fixture-model',protocol:'responses',apiKey:'fixture-key',reasoningEffort:'high'};
function storage(){const key=Buffer.alloc(32,7);return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()]);},decryptString:raw=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString();}};}
const response=()=>Response.json({status:'completed',output:[{type:'reasoning',encrypted_content:'opaque-fixture',summary:[]},{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'项目叫鲸鱼。'}]}],usage:{input_tokens:1600,output_tokens:5,input_tokens_details:{cached_tokens:1280}}});
function fixture(t,fetchImpl=async()=>response(),connection=config){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-ai-sessions-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const safeStorage=storage(),store=createAiSessionStore({dataDir:dir,safeStorage});
 const ai=createAiService({store:{load:()=>connection,save:()=>{}},fetchImpl});t.after(()=>ai.close());const make=()=>{const value=createAiSessions({store,ai});t.after(()=>value.close());return value;};
 return {dir,file:path.join(dir,'ai-sessions.enc'),safeStorage,store,ai,make,sessions:make()};
}
test('encrypted local history survives restart and replays the full conversation without exposing internal items',async t=>{
 const calls=[],f=fixture(t,async(_url,options)=>{calls.push(JSON.parse(options.body));return response();});const first=f.sessions.action('create');
 await f.sessions.action('send',{id:first.id,text:'项目叫鲸鱼，请记住。'});const saved=f.sessions.get(first.id);assert.equal(saved.messages.length,2);assert.equal(saved.messages[1].text,'项目叫鲸鱼。');assert.equal(saved.lastUsage.cacheReadTokens,1280);assert.ok(!JSON.stringify(saved).includes('opaque-fixture'));assert.ok(!JSON.stringify(saved).includes(config.apiKey));
 assert.equal(fs.statSync(f.file).mode&0o777,0o600);const bytes=fs.readFileSync(f.file);assert.equal(bytes.includes(Buffer.from('项目叫鲸鱼')),false);assert.equal(bytes.includes(Buffer.from(config.apiKey)),false);
 const reopened=f.make();assert.equal(reopened.get(first.id).title,'项目叫鲸鱼，请记住。');await reopened.action('send',{id:first.id,text:'项目叫什么？'});
 assert.equal(calls[1].input[0].content,'项目叫鲸鱼，请记住。');assert.equal(calls[1].input[1].encrypted_content,'opaque-fixture');assert.equal(calls[1].input[2].phase,'final_answer');assert.equal(calls[1].input[3].content,'项目叫什么？');assert.equal(calls[0].prompt_cache_key,calls[1].prompt_cache_key);assert.equal(reopened.get(first.id).messages.length,4);
 reopened.action('rename',{id:first.id,title:'鲸鱼项目讨论'});assert.equal(f.make().list().sessions[0].title,'鲸鱼项目讨论');
 const second=reopened.action('create');await reopened.action('send',{id:second.id,text:'新话题'});assert.equal(calls[2].input.length,1);assert.notEqual(calls[2].prompt_cache_key,calls[1].prompt_cache_key);reopened.action('remove',{id:second.id});assert.throws(()=>f.make().get(second.id),/找不到/);
});
test('Chat history and connection identity prevent silently sending history to changed providers',async t=>{
 const calls=[],f=fixture(t,async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({choices:[{finish_reason:'stop',message:{content:'收到'}}]});},{...config,protocol:'chat'});const session=f.sessions.action('create');
 await f.sessions.action('send',{id:session.id,text:'第一轮'});await f.sessions.action('send',{id:session.id,text:'第二轮'});assert.deepEqual(calls[1].messages.slice(1),[{role:'user',content:'第一轮'},{role:'assistant',content:'收到'},{role:'user',content:'第二轮'}]);
 f.ai.save({...config,protocol:'chat',model:'other-model'});assert.equal(f.sessions.get(session.id).connectionChanged,true);await assert.rejects(f.sessions.action('send',{id:session.id,text:'不能误发'}),/不一致/);assert.equal(calls.length,2);assert.equal(f.sessions.get(session.id).messages.length,4);
});
test('busy sessions reject duplicate sends, cancellation retains the message and explicit retry sends only once',async t=>{
 let began,hang=true,calls=0;const started=new Promise(resolve=>began=resolve);const f=fixture(t,async(_url,{signal})=>{calls++;if(!hang)return response();began();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});const session=f.sessions.action('create');
 const work=f.sessions.action('send',{id:session.id,text:'保留这条消息'});await started;await assert.rejects(f.sessions.action('send',{id:session.id,text:'重复'}),/正在/);assert.throws(()=>f.sessions.action('remove',{id:session.id}),/正在/);
 const restored=f.make().get(session.id);assert.equal(restored.messages[0].status,'failed');assert.match(restored.messages[0].error,/中断/);assert.equal(calls,1);
 f.sessions.action('cancel',{id:session.id});await assert.rejects(work,/取消/);assert.equal(f.sessions.get(session.id).messages.length,1);assert.equal(f.sessions.get(session.id).messages[0].status,'failed');
 hang=false;await f.sessions.action('retry',{id:session.id});assert.equal(calls,2);assert.equal(f.sessions.get(session.id).messages.length,2);assert.equal(f.sessions.get(session.id).busy,false);
});
test('failed writes before sending do not call upstream; replies with failed saves can be saved without another API call',async t=>{
 let count=0,failAfterReply=false,f;const failedEncryption=()=>{throw Error('fixture platform encryption failure');};f=fixture(t,async()=>{count++;if(failAfterReply)f.safeStorage.encryptString=failedEncryption;return response();});const session=f.sessions.action('create'),before=fs.readFileSync(f.file),encrypt=f.safeStorage.encryptString;
 f.safeStorage.encryptString=failedEncryption;await assert.rejects(f.sessions.action('send',{id:session.id,text:'不能丢失'}),/保存失败/);assert.equal(count,0);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.sessions.get(session.id).messages.length,0);f.safeStorage.encryptString=encrypt;
 failAfterReply=true;await f.sessions.action('send',{id:session.id,text:'回复后写入失败'});assert.equal(count,1);assert.equal(f.sessions.list().unsaved,true);assert.equal(f.sessions.get(session.id).messages.length,2);assert.match(f.sessions.list().error,/不要重新请求/);assert.throws(()=>f.sessions.action('create'),/尚未保存/);
 f.safeStorage.encryptString=encrypt;f.sessions.action('persist');assert.equal(count,1);assert.equal(f.sessions.list().unsaved,false);assert.equal(f.make().get(session.id).messages.length,2);
});
test('corrupt, linked or unavailable encrypted storage preserves files and blocks new history writes',t=>{
 const f=fixture(t);f.sessions.action('create');const before=fs.readFileSync(f.file);f.safeStorage.isEncryptionAvailable=()=>false;assert.throws(()=>f.sessions.action('create'),/安全存储/);assert.deepEqual(fs.readFileSync(f.file),before);assert.match(f.make().list().error,/无法读取/);
 f.safeStorage.isEncryptionAvailable=()=>true;fs.writeFileSync(f.file,'broken');const broken=f.make();assert.match(broken.list().error,/无法读取/);assert.throws(()=>broken.action('create'),/无法读取/);assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
 fs.unlinkSync(f.file);const target=path.join(f.dir,'target');fs.writeFileSync(target,before);fs.symlinkSync(target,f.file);assert.match(f.make().list().error,/无法读取/);assert.deepEqual(fs.readFileSync(target),before);
});
test('a temporary file left by an interrupted write does not block later session saves',t=>{
 const f=fixture(t);f.sessions.action('create');fs.writeFileSync(f.file+'.tmp','interrupted-write');
 f.sessions.action('create');assert.equal(f.make().list().sessions.length,2);assert.equal(fs.readFileSync(f.file+'.tmp','utf8'),'interrupted-write');
});
