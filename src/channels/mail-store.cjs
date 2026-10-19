'use strict';
const fs=require('node:fs'),path=require('node:path');
// 配置、去重记录和最近邮件正文统一保存在系统加密文件中，不写原始 MIME 或附件。
function createMailStore({dataDir,safeStorage}) {
  const file=path.join(dataDir,'mail.enc');
  // Linux 的 basic_text 后端不提供有效加密，不允许退化为明文存储。
  function available(){return safeStorage.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text';}
  return {
    available,
    // 解密或版本校验失败时只报错，保留原文件供后续恢复。
    load(){
      if(!fs.existsSync(file))return null;
      if(!available())throw new Error('系统安全存储不可用，无法读取邮箱配置。');
      try {
        const value=JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
        if(value.version!==1||typeof value.enabled!=='boolean'||!value.config||!Array.isArray(value.seen))throw Error();
        return value;
      }catch{throw new Error('邮箱配置无法解密或格式不兼容，原文件已保留。');}
    },
    save(value){
      if(!available())throw new Error('系统安全存储不可用，邮箱密码未保存。');
      fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
      // 临时文件也只含密文；限制为当前用户可读写，再原子替换正式文件。
      fs.writeFileSync(file+'.tmp',safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});
      fs.chmodSync(file+'.tmp',0o600);fs.renameSync(file+'.tmp',file);
    }
  };
}
module.exports={createMailStore};
