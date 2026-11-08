'use strict';
const fs=require('node:fs'),path=require('node:path');

function createAiStore({dataDir,safeStorage}){
  const file=path.join(dataDir,'ai-config.enc');
  const available=()=>safeStorage?.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text';
  return {
    load(){
      if(!fs.existsSync(file))return null;
      if(!available())throw Error('系统安全存储不可用，无法读取 AI 配置');
      let fd;
      try{
        fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>32768)throw Error();
        const value=JSON.parse(safeStorage.decryptString(fs.readFileSync(fd)));
        if(value.version!==1||!value.connection||typeof value.connection.apiKey!=='string')throw Error();
        return value.connection;
      }catch{throw Error('AI 配置无法解密或已损坏，原文件已保留');}
      finally{if(fd!==undefined)fs.closeSync(fd);}
    },
    save(connection){
      if(!available())throw Error('系统安全存储不可用，AI 密钥未保存');
      let fd,created=false;
      try{
        const encrypted=safeStorage.encryptString(JSON.stringify({version:1,connection}));
        fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
        fd=fs.openSync(file+'.tmp','wx',0o600);created=true;
        fs.writeFileSync(fd,encrypted);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
        fs.renameSync(file+'.tmp',file);created=false;
      }catch{throw Error('AI 配置保存失败，已保留上次有效配置');}
      finally{if(fd!==undefined)fs.closeSync(fd);if(created)try{fs.unlinkSync(file+'.tmp');}catch{}}
    },
    clear(){try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw Error('AI 配置清除失败，原配置已保留');}}
  };
}
module.exports={createAiStore};
