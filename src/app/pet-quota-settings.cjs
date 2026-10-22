'use strict';
const fs = require('node:fs'), path = require('node:path');
const defaults = {accountId:null, yellowBelow:30, redBelow:10, accountsExpanded:true, configExpanded:true, trackingConfigs:[], nextConfigId:2};
function validateTracking(value) {
  if (value.accountId !== null && (!Number.isSafeInteger(value.accountId) || value.accountId <= 0)) throw Error('请选择有效账号');
  if (![value.yellowBelow, value.redBelow].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100) ||
    value.redBelow >= value.yellowBelow) throw Error('阈值需在 0～100 之间，淡红色阈值须小于淡黄色阈值');
  if (typeof value.configExpanded !== 'boolean') throw Error('无效的折叠状态');
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length ||
    Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw Error('无效的流量跟踪配置');
  const next = {...defaults, ...value};
  validateTracking(next);
  if (typeof next.accountsExpanded !== 'boolean') throw Error('无效的折叠状态');
  if (!Array.isArray(next.trackingConfigs) || !Number.isSafeInteger(next.nextConfigId) || next.nextConfigId < 2) throw Error('无效的流量跟踪配置');
  const ids = new Set();
  next.trackingConfigs = next.trackingConfigs.map(config => {
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== 6 ||
      Object.keys(config).some(key => !['id','accountId','yellowBelow','redBelow','configExpanded','groupId'].includes(key)) ||
      !Number.isSafeInteger(config.id) || config.id < 2 || config.id >= Number.MAX_SAFE_INTEGER || ids.has(config.id) ||
      (config.groupId !== null && (!Number.isSafeInteger(config.groupId) || config.groupId <= 0))) throw Error('无效的流量跟踪配置');
    validateTracking(config);ids.add(config.id);
    // 编号只递增，删除配置后不复用旧编号，避免旧窗口操作指向新配置。
    next.nextConfigId = Math.max(next.nextConfigId, config.id + 1);
    return {...config};
  });
  return next;
}
function createPetQuotaSettings({dataDir}) {
  const file = path.join(dataDir, 'pet-quota-settings.json');
  let state = {...defaults};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const old = saved.secondaryConfig;
      if (!Object.hasOwn(saved, 'trackingConfigs') && (old || saved.multiAccountTracking === true)) saved.trackingConfigs = [{
        id:2, accountId:old?.accountId ?? null, yellowBelow:old?.yellowBelow ?? saved.yellowBelow ?? 30,
        redBelow:old?.redBelow ?? saved.redBelow ?? 10, configExpanded:old?.configExpanded ?? true, groupId:13
      }];
      if (Object.hasOwn(saved,'multiAccountTracking') && typeof saved.multiAccountTracking !== 'boolean') throw Error('无效的旧配置');
      delete saved.secondaryConfig;delete saved.multiAccountTracking;
    }
    state = validate(saved);
    // 旧配置允许重复账号：保留主配置及最先选择的副配置，其余待重新选择。
    const occupied = new Set(state.accountId === null ? [] : [state.accountId]);
    for (const config of state.trackingConfigs) {
      if (config.accountId === null) continue;
      if (occupied.has(config.accountId)) config.accountId = null;
      else occupied.add(config.accountId);
    }
  } catch {} // 保留损坏文件，使用默认值。
  // 副配置也逐项复制，调用方修改快照不会绕过校验或改动已保存状态。
  const snapshot = () => ({...state, trackingConfigs:state.trackingConfigs.map(config => ({...config}))});
  return {snapshot, update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
      Object.keys(patch).some(key => !Object.hasOwn(defaults, key))) throw Error('无效的流量跟踪配置');
    const next = validate({...state, ...patch});
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(next), {mode:0o600});
      fs.renameSync(file + '.tmp', file);
    } catch {throw Error('流量跟踪配置保存失败，请重试');}
    state = next;return snapshot();
  }};
}
module.exports = {createPetQuotaSettings};
