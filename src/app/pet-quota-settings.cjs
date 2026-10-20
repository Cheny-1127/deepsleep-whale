'use strict';
const fs = require('node:fs'), path = require('node:path');
const defaults = {accountId: null, yellowBelow: 30, redBelow: 10, accountsExpanded: true, configExpanded: true};

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length ||
    Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw Error('无效的桌宠配置');
  const next = {...defaults, ...value};
  if (next.accountId !== null && (!Number.isSafeInteger(next.accountId) || next.accountId <= 0)) throw Error('请选择有效账号');
  if (![next.yellowBelow, next.redBelow].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100) ||
    next.redBelow >= next.yellowBelow) throw Error('阈值需在 0～100 之间，淡红色阈值须小于淡黄色阈值');
  if (typeof next.accountsExpanded !== 'boolean' || typeof next.configExpanded !== 'boolean') throw Error('无效的折叠状态');
  return next;
}

function createPetQuotaSettings({dataDir}) {
  const file = path.join(dataDir, 'pet-quota-settings.json');
  let state = {...defaults};
  try {state = validate(JSON.parse(fs.readFileSync(file, 'utf8')));} catch {} // 保留损坏文件，使用默认值。
  return {
    snapshot: () => ({...state}),
    update(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
        Object.keys(patch).some(key => !Object.hasOwn(defaults, key))) throw Error('无效的桌宠配置');
      const next = validate({...state, ...patch});
      try {
        // 先原子写入再切换状态，保存失败时不丢失原配置。
        fs.writeFileSync(file + '.tmp', JSON.stringify(next), {mode: 0o600});
        fs.renameSync(file + '.tmp', file);
      } catch {throw Error('桌宠配置保存失败，请重试');}
      state = next;
      return {...state};
    }
  };
}
module.exports = {createPetQuotaSettings};
