'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {DEFAULT_BASE_URL,readQuotaToken}=require('./quota-credentials.cjs');

const timestamp=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?value:null;
const text=value=>typeof value==='string'?value:null;
const percent=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
function cachedAccount(item) {
  if(!item||!Number.isSafeInteger(item.id)||item.id<=0)throw Error('invalid account');
  const expiresAt=text(item.subscriptionExpiresAt);
  // 只保存界面所需的摘要；读取时也过滤额外字段，不能带入凭据。
  // 旧缓存缺少账号同步时间时保留未知，不能用整轮时间补齐暂停或失败账号的时间。
  return {id:item.id,name:text(item.name)||'',lastSyncedAt:timestamp(item.lastSyncedAt),fiveHourRemaining:percent(item.fiveHourRemaining),sevenDayRemaining:percent(item.sevenDayRemaining),
    creditsBalance:typeof item.creditsBalance==='number'&&Number.isFinite(item.creditsBalance)&&item.creditsBalance>=0?item.creditsBalance:null,
    fiveHourResetAt:text(item.fiveHourResetAt)&&Number.isFinite(Date.parse(item.fiveHourResetAt))?item.fiveHourResetAt:null,
    sevenDayResetAt:text(item.sevenDayResetAt)&&Number.isFinite(Date.parse(item.sevenDayResetAt))?item.sevenDayResetAt:null,
    fiveHourWindowMinutes:typeof item.fiveHourWindowMinutes==='number'&&Number.isFinite(item.fiveHourWindowMinutes)&&item.fiveHourWindowMinutes>=0?item.fiveHourWindowMinutes:null,
    sevenDayWindowMinutes:typeof item.sevenDayWindowMinutes==='number'&&Number.isFinite(item.sevenDayWindowMinutes)&&item.sevenDayWindowMinutes>=0?item.sevenDayWindowMinutes:null,
    resetCardCount:Number.isSafeInteger(item.resetCardCount)&&item.resetCardCount>=0?item.resetCardCount:null,
    subscriptionType:text(item.subscriptionType),platform:text(item.platform),authType:text(item.authType),
    subscriptionExpiresAt:expiresAt&&Number.isFinite(Date.parse(expiresAt))?expiresAt:null};
}

function createQuotaCache({dataDir,token,tokenFile,baseUrl}) {
  const file=dataDir?path.join(dataDir,'quota-cache.json'):null;
  function source() {
    const origin=String(baseUrl||DEFAULT_BASE_URL).replace(/\/+$/,'');
    // 缓存绑定接口地址和账号凭据的摘要，文件内不保存 token 原文。
    // 指纹只取有效 Key，不记录配置来源，同一个 Key 从旧文件迁入 .env 仍可复用缓存。
    return createHash('sha256').update(JSON.stringify([origin,readQuotaToken({token,tokenFile})])).digest('hex');
  }
  return {
    load() {
      if(!file)return null;
      let serialized;
      try {serialized=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
      const saved=JSON.parse(serialized);
      if(saved.version!==1||saved.source!==source())return null;
      if(!Array.isArray(saved.accounts)||saved.accounts.length>1000)throw Error('invalid cache');
      const accounts=saved.accounts.map(cachedAccount);
      if(new Set(accounts.map(item=>item.id)).size!==accounts.length)throw Error('duplicate accounts');
      const failedAt=timestamp(saved.failedAt);
      return {accounts,checkedAt:timestamp(saved.checkedAt),attemptedAt:timestamp(saved.attemptedAt),failedAt,
        error:failedAt!==null?'读取账号额度失败，将按刷新间隔自动重试。':'',nextRefreshAt:timestamp(saved.nextRefreshAt),
        refreshIntervalMs:Number.isSafeInteger(saved.refreshIntervalMs)&&saved.refreshIntervalMs>=5000&&saved.refreshIntervalMs<=86400000?saved.refreshIntervalMs:300000};
    },
    save(state) {
      if(!file)return;
      const saved={version:1,source:source(),accounts:state.accounts.map(cachedAccount),checkedAt:timestamp(state.checkedAt),
        attemptedAt:timestamp(state.attemptedAt),failedAt:timestamp(state.failedAt),nextRefreshAt:timestamp(state.nextRefreshAt),refreshIntervalMs:state.refreshIntervalMs};
      // 原子替换：写入失败时，上一次完整缓存仍可使用。
      fs.writeFileSync(file+'.tmp',JSON.stringify(saved),{mode:0o600});
      fs.renameSync(file+'.tmp',file);
    }
  };
}
module.exports={createQuotaCache};
