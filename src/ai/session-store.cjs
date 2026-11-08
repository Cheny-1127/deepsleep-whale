'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const MAX_BYTES=32*1024*1024;

function createAiSessionStore({dataDir,safeStorage}){
  const file=path.join(dataDir,'ai-sessions.enc');
  const available=()=>safeStorage?.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text';
  return {
    load(){
      if(!fs.existsSync(file))return {version:1,sessions:[]};
      if(!available())throw Error('系统安全存储不可用，无法读取 AI 会话');
      let fd;
      try{
        fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES)throw Error();
        return JSON.parse(safeStorage.decryptString(fs.readFileSync(fd)));
      }catch{throw Error('AI 会话无法解密或已损坏，原文件已保留');}
      finally{if(fd!==undefined)fs.closeSync(fd);}
    },
    save(state){
      if(!available())throw Error('系统安全存储不可用，AI 会话未保存');
      const serialized=JSON.stringify(state);if(Buffer.byteLength(serialized)>MAX_BYTES-65536)throw Error('AI 会话存储已达上限，请先删除不需要的会话');
      const temporary=file+'.'+randomUUID()+'.tmp';let fd,created=false;
      try{
        const encrypted=safeStorage.encryptString(serialized);if(encrypted.length>MAX_BYTES)throw Error();
        fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
        fd=fs.openSync(temporary,'wx',0o600);created=true;fs.writeFileSync(fd,encrypted);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
        fs.renameSync(temporary,file);created=false;
      }catch{throw Error('AI 会话保存失败，已保留上次有效记录');}
      finally{if(fd!==undefined)fs.closeSync(fd);if(created)try{fs.unlinkSync(temporary);}catch{}}
    }
  };
}
module.exports={createAiSessionStore};
