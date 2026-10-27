'use strict';
const fs=require('node:fs'),path=require('node:path');
function createGitlabStore({dataDir,safeStorage}){
  const file=path.join(dataDir,'report-gitlab.enc');
  const available=()=>safeStorage?.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text';
  return {
    load(){
      if(!fs.existsSync(file))return null;if(!available())throw Error('系统安全存储不可用，无法读取 GitLab Token');
      try{if(fs.statSync(file).size>32768)throw Error();const value=JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
        if(value.version!==1||!value.connection||typeof value.connection.url!=='string'||typeof value.connection.token!=='string')throw Error();return value.connection;
      }catch{throw Error('GitLab 连接无法解密或格式不兼容，原文件已保留');}
    },
    save(connection){
      if(!available())throw Error('系统安全存储不可用，GitLab Token 未保存');
      try{fs.mkdirSync(dataDir,{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',safeStorage.encryptString(JSON.stringify({version:1,connection})),{mode:0o600});fs.chmodSync(file+'.tmp',0o600);fs.renameSync(file+'.tmp',file);}
      catch{throw Error('GitLab 连接保存失败，已保留上次有效连接');}
    }
  };
}
module.exports={createGitlabStore};
