'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createMailReceiver,createImapMail,validateConfig,MAX_SOURCE}=require('../src/channels/imap-mail.cjs');
const {createMailStore}=require('../src/channels/mail-store.cjs');
const config={type:'feishu',email:'owner@example.com',password:'private-app-password',host:'imap.feishu.cn',port:993};
function storage(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-imap-')),key=crypto.randomBytes(32);let enabled=true;
  const safeStorage={isEncryptionAvailable:()=>enabled,getSelectedStorageBackend:()=> 'test',
    encryptString:value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},
    decryptString:value=>{const cipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString();}};
  const store=createMailStore({dataDir:dir,safeStorage});t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,store,disable:()=>enabled=false};
}
function fixture(t) {
  const s=storage(t);let messages=[{id:'10:1',subject:'首封邮件'}],uidValidity='10';const alerts=[],reads=[];
  const imap={list:async()=>({messages,hasMore:false,uidValidity}),read:async(_config,id)=>{reads.push(id);return {id,body:'private-body',attachments:[]};}};
  const receiver=createMailReceiver({store:s.store,imap,onNew:n=>alerts.push(n)});t.after(()=>receiver.close());
  return {...s,receiver,imap,alerts,reads,setMessages:value=>messages=value,setValidity:value=>uidValidity=value};
}
test('recent messages and bodies persist encrypted, restore offline and do not download twice',async t=>{
  const f=fixture(t);await f.receiver.action('connect',config);
  assert.deepEqual(f.reads,['10:1'],'synchronization must cache the body without a click');
  assert.equal(f.store.load().cache.details[0].body,'private-body');
  const bytes=fs.readFileSync(path.join(f.dir,'mail.enc'));assert.ok(!bytes.includes(Buffer.from('private-body')));
  assert.ok(!JSON.stringify(f.receiver.snapshot()).includes('private-body'),'mail snapshots must not expose cached bodies');
  await f.receiver.action('read','10:1');await f.receiver.action('refresh');assert.equal(f.reads.length,1);
  const checked=f.receiver.snapshot().lastChecked;f.receiver.close();
  const offline={list:async()=>{throw Error('offline');},read:async()=>{throw Error('offline');}};
  const r=createMailReceiver({store:f.store,imap:offline});t.after(()=>r.close());
  assert.equal(r.snapshot().messages[0].id,'10:1');assert.equal(r.snapshot().lastChecked,checked);
  await r.action('refresh');assert.equal(r.snapshot().state,'error');assert.equal(r.snapshot().messages.length,1);
  assert.equal((await r.action('read','10:1')).body,'private-body');
  await r.action('pause');assert.equal((await r.action('read','10:1')).body,'private-body');
});
test('cache follows the configured count and UIDVALIDITY; switching accounts never reuses old bodies',async t=>{
  const f=fixture(t);f.setMessages([{id:'10:2'},{id:'10:1'}]);await f.receiver.action('connect',config);
  await f.receiver.action('connect',{...config,limit:1});
  assert.deepEqual(f.receiver.snapshot().messages.map(item=>item.id),['10:2']);
  assert.deepEqual(f.store.load().cache.details.map(item=>item.id),['10:2']);
  f.setValidity('11');f.setMessages([{id:'11:2'}]);await f.receiver.action('refresh');
  assert.deepEqual(f.store.load().cache.details.map(item=>item.id),['11:2']);
  f.imap.read=async(_config,id)=>({id,body:'other-account-body',attachments:[]});
  await f.receiver.action('connect',{...config,email:'other@example.com'});
  assert.equal((await f.receiver.action('read','11:2')).body,'other-account-body');
  assert.ok(!JSON.stringify(f.store.load()).includes('private-body'));
});
test('individual body failures keep the list usable and are retried by the next sync',async t=>{
  const f=fixture(t);f.setMessages([{id:'10:2'},{id:'10:1'}]);const read=f.imap.read;let fail=true;
  f.imap.read=async(c,id)=>{if(id==='10:1'&&fail)throw Error('temporary failure');return read(c,id);};
  await f.receiver.action('connect',config);assert.equal(f.receiver.snapshot().messages.length,2);
  assert.equal(f.receiver.snapshot().cacheCount,1);assert.equal((await f.receiver.action('read','10:2')).body,'private-body');
  fail=false;await f.receiver.action('refresh');assert.equal(f.receiver.snapshot().cacheCount,2);
  assert.deepEqual(f.reads,['10:2','10:1']);
});
test('pausing during automatic body download prevents late plaintext from entering the encrypted record',{timeout:2000},async t=>{
  const f=fixture(t);let finish,started;
  const reading=new Promise(resolve=>started=resolve);
  f.imap.read=()=>{started();return new Promise(resolve=>finish=resolve);};
  const sync=f.receiver.action('connect',config);await reading;await f.receiver.action('pause');
  finish({id:'10:1',body:'late-body',attachments:[]});await sync;
  assert.equal(f.receiver.snapshot().state,'paused');assert.equal(f.store.load().enabled,false);
  assert.ok(!JSON.stringify(f.store.load()).includes('late-body'));
});
test('unavailable encryption retains cached mail and leaves the encrypted file untouched',async t=>{
  const f=fixture(t);await f.receiver.action('connect',config);
  const file=path.join(f.dir,'mail.enc'),before=fs.readFileSync(file);f.disable();
  await assert.rejects(f.receiver.action('refresh'),/安全存储不可用/);
  await assert.rejects(f.receiver.action('connect',{...config,email:'other@example.com'}),/未保存/);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(f.receiver.snapshot().email,config.email);
  assert.equal((await f.receiver.action('read','10:1')).body,'private-body');
});
test('failed server replacement removes the previous server cache even with matching UIDs',async t=>{
  const f=fixture(t);await f.receiver.action('connect',config);
  f.imap.list=async()=>{throw Error('offline');};
  await f.receiver.action('connect',{...config,type:'custom',host:'other.example.com'});
  assert.equal(f.receiver.snapshot().messages.length,0);assert.equal(f.receiver.snapshot().cacheCount,0);
  assert.ok(!JSON.stringify(f.store.load()).includes('private-body'));
  await assert.rejects(f.receiver.action('read','10:1'),/选择邮件/);
});
test('provider settings, TLS endpoint and credential reuse are validated',()=>{
  assert.equal(validateConfig({...config,host:'wrong',port:1}).host,'imap.feishu.cn');
  assert.equal(validateConfig({...config,password:''},config).password,config.password);
  assert.throws(()=>validateConfig({...config,email:'other@example.com',password:''},config),/专用密码/);
  assert.throws(()=>validateConfig({...config,type:'custom',host:'https://example.com'}),/服务器地址/);
  assert.throws(()=>validateConfig({...config,type:'custom',port:0}),/端口/);
  assert.throws(()=>validateConfig({...config,email:'invalid'}),/邮箱地址/);
});
test('mail count defaults to 20, accepts configurable integers and rejects invalid counts',()=>{
  assert.equal(validateConfig(config).limit,20);
  for(const limit of [1,20,100,'50'])assert.equal(validateConfig({...config,limit}).limit,Number(limit));
  for(const limit of [0,101,1.5,'invalid','',null])assert.throws(()=>validateConfig({...config,limit}),/邮件数量/);
});
test('legacy settings default to 20; changed count persists and older mail does not trigger notifications',async t=>{
  const f=fixture(t);
  f.store.save({version:1,enabled:true,config,seen:['10:30'],uidValidity:'10'});
  const r=createMailReceiver({store:f.store,imap:f.imap,onNew:n=>f.alerts.push(n)});t.after(()=>r.close());
  assert.equal(r.snapshot().config.limit,20);
  f.setMessages([{id:'10:31'},{id:'10:30'},{id:'10:10'}]);
  await r.action('connect',{...config,password:'',limit:50});
  assert.equal(r.snapshot().config.limit,50);assert.equal(f.store.load().config.limit,50);
  assert.deepEqual(f.alerts,[1],'only the new higher UID is notified when expanding the history');
  await r.action('refresh');assert.deepEqual(f.alerts,[1]);
  r.close();
  const restarted=createMailReceiver({store:f.store,imap:f.imap});t.after(()=>restarted.close());
  assert.equal(restarted.snapshot().config.limit,50);
});
test('credentials are encrypted on disk, omitted from snapshots, and never saved as plaintext',async t=>{
  const f=fixture(t);await f.receiver.action('connect',config);
  assert.equal(f.receiver.snapshot().state,'connected');
  assert.ok(!JSON.stringify(f.receiver.snapshot()).includes(config.password));
  const bytes=fs.readFileSync(path.join(f.dir,'mail.enc'));
  assert.ok(!bytes.includes(Buffer.from(config.password)));assert.ok(!bytes.includes(Buffer.from(config.email)));
  assert.equal(f.store.load().config.password,config.password);
  assert.equal(fs.statSync(path.join(f.dir,'mail.enc')).mode&0o777,0o600);
  await f.receiver.action('read','10:1');assert.equal(f.store.load().cache.details[0].body,'private-body');
  f.disable();assert.throws(()=>f.store.save({config}),/未保存/);
});
test('opt-in, baseline, poll dedup, restart, UIDVALIDITY reset and account isolation',async t=>{
  const f=fixture(t);f.receiver.start();assert.equal(f.receiver.snapshot().state,'disconnected');
  await f.receiver.action('connect',config);assert.deepEqual(f.alerts,[]);
  f.setMessages([{id:'10:2'},{id:'10:1'}]);await f.receiver.action('refresh');await f.receiver.action('refresh');assert.deepEqual(f.alerts,[1]);
  f.receiver.close();const r=createMailReceiver({store:f.store,imap:f.imap,onNew:n=>f.alerts.push(n)});t.after(()=>r.close());
  await r.action('refresh');assert.deepEqual(f.alerts,[1]);
  f.setValidity('11');f.setMessages([{id:'11:1'}]);await r.action('refresh');assert.deepEqual(f.alerts,[1],'UID reset establishes a fresh baseline');
  await r.action('connect',{...config,email:'other@example.com'});assert.deepEqual(f.alerts,[1]);assert.equal(r.snapshot().email,'other@example.com');
});
test('pause cancels in-flight requests while preserving previously cached messages',async t=>{
  const f=fixture(t);await f.receiver.action('connect',config);let finish,signal;
  f.imap.list=(_config,options)=>new Promise(resolve=>{finish=resolve;signal=options.signal;});
  const refresh=f.receiver.action('refresh');await f.receiver.action('pause');assert.ok(signal.aborted);
  finish({messages:[{id:'10:2'}],uidValidity:'10'});await refresh;
  assert.equal(f.receiver.snapshot().state,'paused');assert.deepEqual(f.receiver.snapshot().messages.map(item=>item.id),['10:1']);
  f.imap.list=async()=>({messages:[{id:'10:2'}],uidValidity:'10'});
  f.imap.read=async()=>{throw Error('not cached');};await f.receiver.action('connect',config);
  f.imap.read=()=>new Promise(resolve=>{finish=resolve;});
  const read=f.receiver.action('read','10:2');await f.receiver.action('pause');finish({body:'late-private'});
  await assert.rejects(read,/连接已改变/);
});
test('failed replacement connection pauses the old account instead of resuming it',async t=>{
  const f=fixture(t);await f.receiver.action('connect',config);
  f.imap.list=async()=>{throw Error('连接失败');};
  const result=await f.receiver.action('connect',{...config,email:'other@example.com'});
  assert.equal(result.state,'error');assert.equal(result.enabled,false);assert.equal(f.store.load().enabled,false);
});
test('automatic interval receives new mail, and unsupported or unknown reads fail',async t=>{
  const f=fixture(t);await f.receiver.action('connect',config);f.receiver.close();
  let notify;const arrived=new Promise(resolve=>notify=resolve),r=createMailReceiver({store:f.store,imap:f.imap,intervalMs:10,onNew:notify});t.after(()=>r.close());
  await r.action('refresh');f.setMessages([{id:'10:2'}]);const timeout=setTimeout(()=>notify('timeout'),1000);
  try{assert.equal(await arrived,1);}finally{clearTimeout(timeout);}
  await assert.rejects(r.action('read','unknown'),/选择邮件/);await assert.rejects(r.action('send'),/不支持/);
});
function mockClient(options={}) {
  const calls=[];
  class Client extends EventEmitter {
    constructor(config){super();calls.push(['config',config]);this.mailbox={exists:options.exists??1,uidValidity:10n};}
    async connect(){calls.push(['connect']);if(options.error)throw options.error;}
    async getMailboxLock(folder,opts){calls.push(['lock',folder,opts]);return {release:()=>calls.push(['release'])};}
    async *fetch(range,query){calls.push(['fetch',range,query]);const [start,end]=range.split(':').map(Number);for(let uid=start;uid<=end;uid++)yield {uid,envelope:{subject:'中文主题',from:[{name:'发件人',address:'sender@example.com'}],date:new Date('2026-10-19T00:00:00Z')}};}
    async fetchOne(uid,query,opts){calls.push(['fetchOne',uid,query,opts]);return query.size?{size:options.size??120}:{source:Buffer.from('From: sender@example.com\r\nSubject: fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello <script>example</script>')};}
    close(){calls.push(['close']);}
  }
  return {Client,calls};
}
test('IMAP fetches only the configured latest messages and reports remaining history',async()=>{
  for(const [exists,limit,expected,count,hasMore] of [[120,undefined,'101:120',20,true],[120,50,'71:120',50,true],[20,20,'1:20',20,false],[3,100,'1:3',3,false],[0,20,null,0,false]]) {
    const f=mockClient({exists}),result=await createImapMail({Client:f.Client}).list({...config,limit});
    assert.equal(f.calls.find(c=>c[0]==='fetch')?.[1]??null,expected);
    assert.equal(result.messages.length,count);assert.equal(result.hasMore,hasMore);
    if(count)assert.equal(result.messages[0].id,`10:${exists}`);
  }
});
test('adapter enforces TLS, disables logging, opens INBOX read-only and parses MIME as text',async()=>{
  const f=mockClient(),imap=createImapMail({Client:f.Client});
  assert.equal((await imap.list(config)).messages[0].id,'10:1');
  const result=await imap.read(config,'10:1');assert.match(result.body,/Hello <script>/);
  const settings=f.calls.find(c=>c[0]==='config')[1];assert.equal(settings.secure,true);assert.equal(settings.tls.rejectUnauthorized,true);assert.equal(settings.logger,false);
  assert.ok(f.calls.filter(c=>c[0]==='lock').every(c=>c[1]==='INBOX'&&c[2].readOnly===true));
  assert.ok(f.calls.filter(c=>c[0]==='fetchOne').every(c=>c[3].uid===true));
  await assert.rejects(imap.read(config,'9:1'),/标识已变化/);
});
test('batch body downloads share one read-only session and isolate individual failures',async()=>{
  const f=mockClient(),imap=createImapMail({Client:f.Client});
  const results=await imap.readMany(config,['10:1','9:2','10:3']);
  assert.match(results[0].body,/Hello/);assert.match(results[1].error,/标识已变化/);assert.match(results[2].body,/Hello/);
  assert.equal(f.calls.filter(call=>call[0]==='connect').length,1);
  assert.deepEqual(f.calls.find(call=>call[0]==='lock').slice(1),['INBOX',{readOnly:true}]);
});
test('oversized messages are rejected before source retrieval; authentication errors omit secrets',async()=>{
  const f=mockClient({size:MAX_SOURCE+1}),imap=createImapMail({Client:f.Client});
  await assert.rejects(imap.read(config,'10:1'),/超过 5 MB/);assert.ok(!f.calls.some(c=>c[2]?.source));
  const auth=mockClient({error:{authenticationFailed:true,message:config.password}});
  await assert.rejects(createImapMail({Client:auth.Client}).list(config),error=>/认证失败/.test(error.message)&&!error.message.includes(config.password));
});

test('saved credentials are revealed only by an explicit account-matched action and remain absent from snapshots',async t=>{
  const f=fixture(t);await assert.rejects(f.receiver.action('reveal-password',config),/没有已保存/);
  await f.receiver.action('connect',config);await f.receiver.action('pause');
  const before=fs.readFileSync(path.join(f.dir,'mail.enc'));
  assert.deepEqual(await f.receiver.action('reveal-password',f.receiver.snapshot().config),{password:config.password});
  for(const value of [{...config,email:'other@example.com'},{...config,host:'other.example.com'},{...config,port:1993},null])await assert.rejects(f.receiver.action('reveal-password',value),/没有已保存/);
  assert.ok(!JSON.stringify(f.receiver.snapshot()).includes(config.password));
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'mail.enc')),before,'revealing must not rewrite the encrypted record');
});
