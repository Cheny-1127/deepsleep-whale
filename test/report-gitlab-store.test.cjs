'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
test('GitLab credentials use encrypted atomic storage and preserve the previous file on failure',t=>{
  const {createGitlabStore}=require('../src/reports/gitlab-store.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-gitlab-secret-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),safeStorage={isEncryptionAvailable:()=>true,encryptString:text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()]);},decryptString:raw=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString();}};
  const store=createGitlabStore({dataDir:dir,safeStorage}),value={url:'https://gitlab.example.test',token:'do-not-expose',username:'cy',authors:'cy@example.test'};
  assert.equal(store.load(),null);store.save(value);assert.deepEqual(store.load(),value);
  const file=path.join(dir,'report-gitlab.enc'),before=fs.readFileSync(file);assert.equal(before.includes('do-not-expose'),false);assert.equal(fs.statSync(file).mode&0o777,0o600);
  fs.mkdirSync(file+'.tmp');assert.throws(()=>store.save({...value,token:'new-token'}));assert.deepEqual(fs.readFileSync(file),before);fs.rmdirSync(file+'.tmp');
  const disabled=createGitlabStore({dataDir:dir,safeStorage:{...safeStorage,isEncryptionAvailable:()=>false}});assert.throws(()=>disabled.save(value),/安全存储/);assert.throws(()=>disabled.load(),/安全存储/);
  assert.throws(()=>createGitlabStore({dataDir:dir,safeStorage:{...safeStorage,getSelectedStorageBackend:()=> 'basic_text'}}).save(value),/安全存储/);
  fs.writeFileSync(file,'damaged');assert.throws(()=>store.load(),/解密|格式/);assert.equal(fs.readFileSync(file,'utf8'),'damaged');
});
