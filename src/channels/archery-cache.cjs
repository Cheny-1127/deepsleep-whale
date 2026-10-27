'use strict';
const fs=require('node:fs'),path=require('node:path');
const MAX_ITEMS=100,MAX_BYTES=32*1024*1024;
const FIELDS=['title','submitter','instance','database','status','group','createdAt','sql','execution'];

function cleanDetail(value){
  if(!value||!Number.isSafeInteger(value.id)||value.id<1||value.needsConfirmation!==false||typeof value.sql!=='string')throw Error('invalid_cache');
  const detail={id:value.id,needsConfirmation:false};
  // 只保存展示字段，不保留审核大字段、凭据、链接或上游新增内容。
  for(const field of FIELDS){if(value[field]!==undefined&&typeof value[field]!=='string')throw Error('invalid_cache');detail[field]=value[field]||'';}
  return detail;
}
function createArcheryCache({dataDir,safeStorage}={}){
  const file=dataDir&&path.join(dataDir,'archery-details.enc'),entries=new Map();let warning='',blocked=false;
  // 同编号可存在于不同服务器或账号，缓存键必须同时包含账号身份与工单编号。
  const key=(account,id)=>JSON.stringify([account,id]);
  // Linux 的 basic_text 并非有效加密，不能用它把 SQL 伪装成密文落盘。
  const available=()=>Boolean(safeStorage?.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text');
  function load(){
    if(!file||!fs.existsSync(file))return;
    try{
      if(!available()||fs.statSync(file).size>MAX_BYTES*2)throw Error();
      const text=safeStorage.decryptString(fs.readFileSync(file));if(Buffer.byteLength(text)>MAX_BYTES)throw Error();
      const saved=JSON.parse(text);
      if(saved.version!==1||!Array.isArray(saved.entries)||saved.entries.length>MAX_ITEMS)throw Error();
      const records=saved.entries.map(record=>{
        if(typeof record.account!=='string'||!record.account||record.account.length>256)throw Error();
        return {account:record.account,detail:cleanDetail(record.detail)};
      });
      for(const record of records)entries.set(key(record.account,record.detail.id),record);
    }catch{
      // 无法解密时保留原文件；本次会话可继续缓存，但不能覆盖尚未恢复的数据。
      blocked=true;warning='原详情缓存无法读取，文件已保留；新详情仅在本次运行中缓存。';
    }
  }
  const serialize=()=>JSON.stringify({version:1,entries:[...entries.values()]});
  function save(){
    if(!file||blocked)return;
    if(!available()){warning='系统安全存储不可用，详情仅在本次运行中缓存。';return;}
    try{
      fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
      // 临时文件同样只有密文，先限制权限，再原子替换；不降级写入明文 SQL。
      fs.writeFileSync(file+'.tmp',safeStorage.encryptString(serialize()),{mode:0o600});
      fs.chmodSync(file+'.tmp',0o600);fs.renameSync(file+'.tmp',file);warning='';
    }catch{warning='详情缓存保存失败，仅在本次运行中缓存。';}
  }
  load();
  return {
    has:(account,id)=>entries.has(key(account,id)),
    get(account,id){
      const name=key(account,id),record=entries.get(name);if(!record)return null;
      // Map 末尾表示最近使用；只返回副本，界面的状态更新不会改写缓存原记录。
      entries.delete(name);entries.set(name,record);
      return {...record.detail,cached:true,...(warning?{cacheWarning:warning}:{})};
    },
    set(account,value){
      if(typeof account!=='string'||!account||account.length>256)throw Error('invalid_account');
      const detail=cleanDetail(value),name=key(account,detail.id);entries.delete(name);entries.set(name,{account,detail});
      // 条数和序列化字节数同时限额，按最久未访问顺序淘汰，避免大 SQL 长期占用空间。
      while(entries.size>MAX_ITEMS||Buffer.byteLength(serialize())>MAX_BYTES)entries.delete(entries.keys().next().value);
      save();
    }
  };
}
module.exports={createArcheryCache};
