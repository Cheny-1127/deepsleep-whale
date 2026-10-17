'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {defaultClients,validateClients}=require('../agents/clients.cjs');
const fresh=()=>({version:2,enabled:false,account:null,allowed:[],pending:[],cursor:'',contexts:{},seen:[],bindings:{},clients:defaultClients(),jobs:[],outbox:[]});
const bindingKey=(account,sender)=>JSON.stringify([account,sender]);
function migrate(value) {
  if(!value||![1,2].includes(value.version)||!Array.isArray(value.allowed)||!Array.isArray(value.jobs)||!Array.isArray(value.outbox))throw new Error('微信连接数据版本无法识别，原文件已保留');
  if(value.version===2){if(!Array.isArray(value.clients)||!value.bindings||typeof value.bindings!=='object'||Array.isArray(value.bindings))throw new Error('微信连接数据格式无法识别，原文件已保留');return {...fresh(),...value,clients:validateClients(value.clients,{checkPaths:false})};}
  if(!value.settings)throw new Error('微信连接数据版本无法识别，原文件已保留');
  const {settings,sessions,...rest}=value,client={...defaultClients()[0],...Object.fromEntries(['backend','binary','configHome','profile'].map(key=>[key,settings[key]||'']))};
  client.name=client.backend==='cursor'?'原 Cursor CLI':'本机 Codex';
  const result={...fresh(),...rest,version:2,clients:[client],bindings:{}};
  if(value.account?.id&&settings.cwd)for(const sender of value.allowed) {
    const oldKey=JSON.stringify([value.account.id,sender,settings.backend,settings.cwd,settings.binary||'',settings.configHome||'',settings.profile||'']);
    result.bindings[bindingKey(value.account.id,sender)]={clientId:client.id,cwd:settings.cwd,threadId:sessions?.[oldKey]||'',transport:'local',automatic:true};
  }
  return result;
}
function createWechatStore({dataDir,safeStorage}) {
  const file=path.join(dataDir,'wechat.enc');
  function available(){return safeStorage.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text';}
  return {
    available,
    load() {
      if(!fs.existsSync(file))return fresh();
      if(!available())throw new Error('系统安全存储不可用，无法读取微信连接');
      let value;
      try {value=JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));}catch {throw new Error('微信连接数据无法解密，原文件已保留');}
      return migrate(value);
    },
    save(value) {
      if(!available())throw new Error('系统安全存储不可用，微信凭据未保存');
      fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
      // 先写加密临时文件再原子替换，避免中途退出破坏原凭据；不可用时不降级为明文。
      fs.writeFileSync(file+'.tmp',safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});
      fs.chmodSync(file+'.tmp',0o600);fs.renameSync(file+'.tmp',file);
    },
    remove(){try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
  };
}
module.exports={fresh,migrate,bindingKey,createWechatStore};
