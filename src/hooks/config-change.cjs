'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
function readOriginal(file,label) {
  // 不跟随符号链接，也不覆盖异常文件；修改基于本次读取的原始内容进行并发校验。
  try {
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`${label} 配置不是普通文件，请手动检查`);
    if(stat.size>1024*1024)throw new Error(`${label} 配置过大，请手动检查`);
    return {text:fs.readFileSync(file,'utf8'),mode:stat.mode&0o777};
  }catch(error){if(error.code==='ENOENT')return {text:null,mode:0o600};throw error;}
}
// 合并规则由各客户端提供；读取校验、备份、原子替换和回滚共用一套。
function prepareConfigChange({file,label,merge}) {
  const original=readOriginal(file,label);
  let next;
  try {next=original.text===null?null:JSON.parse(original.text);}catch {throw new Error(`${label} 配置不是有效 JSON，未修改文件`);}
  next=merge(next,original.text===null);
  if(original.text!==null&&JSON.stringify(next)===JSON.stringify(JSON.parse(original.text)))return {created:false,commit(){},rollback(){}};
  const text=JSON.stringify(next,null,2)+'\n';let committed=false;
  const assertUnchanged=()=>{if(readOriginal(file,label).text!==original.text)throw new Error(`${label} 配置已被其他程序修改，请重新检测后重试`);};
  return {
    created:original.text===null,
    commit() {
      // 同目录临时文件与备份保证可恢复；再次校验避免覆盖用户或客户端刚写入的配置。
      assertUnchanged();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      const temp=file+'.whale-'+randomUUID()+'.tmp';
      try {
        fs.writeFileSync(temp,text,{flag:'wx',mode:original.mode});
        if(original.text!==null)fs.writeFileSync(file+'.whale-backup-'+Date.now()+'-'+randomUUID(),original.text,{flag:'wx',mode:0o600});
        assertUnchanged();
        if(original.text===null) {fs.linkSync(temp,file);fs.unlinkSync(temp);}else fs.renameSync(temp,file);
        committed=true;
      }finally {try {fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
    },
    rollback() {
      if(!committed)return;
      // 只撤回本次提交，提交后若另有修改则保留现场，交由用户检查备份。
      if(readOriginal(file,label).text!==text)throw new Error(`${label} 配置随后发生变化，请手动检查备份`);
      if(original.text===null)fs.unlinkSync(file);
      else {
        const temp=file+'.whale-'+randomUUID()+'.tmp';
        try {fs.writeFileSync(temp,original.text,{flag:'wx',mode:original.mode});fs.renameSync(temp,file);}finally {try {fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
      }
      committed=false;
    }
  };
}
module.exports={prepareConfigChange};
