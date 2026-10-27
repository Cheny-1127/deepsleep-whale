'use strict';
const fs=require('node:fs'),path=require('node:path');
const MODULE_IDS=['subscriptions','archery','hooks','wechat','mail','quota','shortcuts','planner','reports'];

function createModuleSettings({dataDir}) {
  const file=path.join(dataDir,'modules.json');
  // 升级时沿用原有功能；总开关独立保存，不覆盖账号或事件的细项开关。
  let state=Object.fromEntries(MODULE_IDS.map(id=>[id,true]));
  try {const saved=JSON.parse(fs.readFileSync(file,'utf8'));for(const id of MODULE_IDS)if(typeof saved[id]==='boolean')state[id]=saved[id];}catch {}
  return {snapshot:()=>({...state}),enabled:id=>state[id]===true,update(id,enabled){
    if(!MODULE_IDS.includes(id)||typeof enabled!=='boolean')throw Error('无效的模块开关');
    const next={...state,[id]:enabled};
    // 原子替换成功后再发布新状态，写入失败保留上次有效配置。
    try{fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file);}
    catch{throw Error('模块开关保存失败，请检查本机存储后重试。');}
    state=next;return {...state};
  }};
}
module.exports={createModuleSettings,MODULE_IDS};
