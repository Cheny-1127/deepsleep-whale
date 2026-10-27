'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createArcheryCache}=require('../src/channels/archery-cache.cjs');
function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'archery-cache-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const key=crypto.randomBytes(32);let available=true;
  const safeStorage={isEncryptionAvailable:()=>available,getSelectedStorageBackend:()=> 'test',
    encryptString(text){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,body,cipher.getAuthTag()]);},
    decryptString(bytes){const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');}};
  return {dataDir,file:path.join(dataDir,'archery-details.enc'),safeStorage,create:()=>createArcheryCache({dataDir,safeStorage}),available:()=>available=true,unavailable:()=>available=false};
}
const detail={id:566,needsConfirmation:false,title:'缓存测试',status:'workflow_manreviewing',sql:'SELECT private_fixture;',execution:'未执行',review:'不要保存的审核信息',password:'private-password'};
test('details persist encrypted across restart and remain isolated by account and real order ID',t=>{
  const f=fixture(t),cache=f.create();cache.set('owner-a',detail);
  assert.doesNotMatch(fs.readFileSync(f.file).toString('utf8'),/private_fixture|private-password|不要保存/);
  const saved=f.create().get('owner-a',566);assert.equal(saved.sql,detail.sql);assert.equal(saved.cached,true);assert.equal(saved.review,undefined);assert.equal(saved.password,undefined);
  assert.equal(f.create().get('owner-b',566),null);assert.equal(cache.get('owner-a',567),null);
  assert.equal(fs.statSync(f.file).mode&0o777,0o600);
});
test('encryption unavailability keeps memory cache without plaintext files; corrupt files are preserved',t=>{
  const f=fixture(t);f.unavailable();const cache=f.create();cache.set('a',detail);assert.equal(cache.get('a',566).sql,detail.sql);
  assert.match(cache.get('a',566).cacheWarning,/仅.*本次运行/);assert.equal(fs.existsSync(f.file),false);
  f.available();fs.writeFileSync(f.file,'corrupt');const other=f.create();other.set('a',detail);assert.equal(fs.readFileSync(f.file,'utf8'),'corrupt');
  assert.match(other.get('a',566).cacheWarning,/原详情缓存无法读取/);
});
test('basic_text backend cannot create a plaintext cache',t=>{
  const f=fixture(t);f.safeStorage.getSelectedStorageBackend=()=> 'basic_text';const cache=f.create();cache.set('a',detail);
  assert.equal(fs.existsSync(f.file),false);assert.match(cache.get('a',566).cacheWarning,/安全存储不可用/);
});
test('cache evicts least recently used details after 100 entries',()=>{
  const cache=createArcheryCache();for(let id=1;id<=100;id++)cache.set('a',{...detail,id});
  cache.get('a',1);cache.set('a',{...detail,id:101});assert.ok(cache.get('a',1));assert.equal(cache.get('a',2),null);
});
