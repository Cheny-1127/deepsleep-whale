'use strict';

// 凭据和管理响应留在主进程，每条仅提供额度及对应榜单摘要。
function createPetQuota({settings, quota, groups, clock = {now:() => Date.now(), setTimeout, clearTimeout}}) {
  let timer, closed = false, started = false;
  // 副账号的桌宠切换只存内存，重启后恢复各配置保存的账号。
  const temporaryAccounts = new Map();
  function configFor(id = 'primary') {
    const state = settings.snapshot();
    if (id === 'primary') return state;
    const config = state.trackingConfigs.find(item => item.id === id);
    if (!config) throw Error('该流量跟踪配置已不可用');
    return config;
  }
  function accountIdFor(id = 'primary') {
    const config = configFor(id);
    return id === 'primary' ? config.accountId : temporaryAccounts.get(id) ?? config.accountId;
  }
  function resetTemporaryTracking(id) {if (id === undefined) temporaryAccounts.clear();else temporaryAccounts.delete(id);}
  function accountOwner(accountId, id) {
    // 主配置有选择优先权；暂不跟踪不占用任何账号。
    if (id === 'primary' || accountId === null) return null;
    const state = settings.snapshot();
    if (state.accountId === accountId) return '流量跟踪配置';
    // 保存与临时选择都占用账号，避免重启恢复时产生重复。
    const owner = state.trackingConfigs.find(config => config.id !== id &&
      (config.accountId === accountId || temporaryAccounts.get(config.id) === accountId));
    return owner ? `流量跟踪配置-${owner.id}` : null;
  }
  function availableAccounts(id = 'primary') {
    configFor(id);
    return quota.snapshot().accounts.filter(account => !accountOwner(account.id, id));
  }
  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
      Object.keys(patch).some(key => !['accountId','yellowBelow','redBelow','accountsExpanded','configExpanded'].includes(key))) throw Error('无效的流量跟踪配置');
    if (Object.hasOwn(patch,'accountId') && patch.accountId !== settings.snapshot().accountId) validateAccount(patch.accountId);
    const conflicts = Object.hasOwn(patch,'accountId') && patch.accountId !== null ? settings.snapshot().trackingConfigs.filter(config =>
      config.accountId === patch.accountId || temporaryAccounts.get(config.id) === patch.accountId).map(config => config.id) : [];
    // 主账号与冲突副账号一次性落盘；保存成功后才清理临时选择，失败时保持原状态。
    settings.update({...patch, ...(conflicts.length ? {trackingConfigs:settings.snapshot().trackingConfigs.map(config =>
      conflicts.includes(config.id) ? {...config,accountId:null} : config)} : {})});
    for (const id of conflicts) resetTemporaryTracking(id);
    return snapshot();
  }
  function rankingSnapshot(id = 'primary') {
    // 主榜跟随用户排行分组，副榜按自身分组取今日缓存，不改变用户排行的每日／每周筛选。
    const config = configFor(id), daily = id === 'primary' ? groups.dailySnapshot() : groups.dailySnapshot(config.groupId);
    const groupName = daily.groupId === null ? '全部分组' : daily.groups.find(item => item.id === daily.groupId)?.name || `分组 #${daily.groupId}`;
    return {groupId:daily.groupId, groupName, groups:daily.groups.map(({id,name}) => ({id,name})), date:daily.date, checkedAt:daily.checkedAt,
      error:daily.error, busy:daily.busy, users:daily.users.slice(0,5).map(({user_id,email,actual_cost}) => ({user_id,email,actual_cost}))};
  }
  function snapshot() {
    const config = settings.snapshot(), accounts = quota.snapshot();
    for (const id of temporaryAccounts.keys()) if (!config.trackingConfigs.some(item => item.id === id)) temporaryAccounts.delete(id);
    function tracking(accountId, thresholds) {
      const selected = accounts.accounts.find(account => account.id === accountId);
      const remaining = selected && selected.sevenDayWindowMinutes !== 0 && typeof selected.sevenDayRemaining === 'number' ? selected.sevenDayRemaining : null;
      return {accountId, name:selected?.name || '', remaining, resetAt:selected?.sevenDayResetAt || null, checkedAt:accounts.checkedAt,
        paused:selected?.refreshEnabled === false,
        busy:accounts.refreshingAccountIds ? accounts.refreshingAccountIds.includes(accountId) : accounts.busy === true,
        error:accounts.accountRefreshErrors?.[accountId] ?? accounts.error ?? '',
        tone:remaining === null ? 'unknown' : remaining < thresholds.redBelow ? 'red' : remaining < thresholds.yellowBelow ? 'yellow' : 'green'};
    }
    return {settings:config, tracking:tracking(config.accountId,config), ranking:rankingSnapshot(),
      extraTrackings:config.trackingConfigs.map(item => ({id:item.id, tracking:tracking(temporaryAccounts.get(item.id) ?? item.accountId,item), ranking:rankingSnapshot(item.id)}))};
  }
  function validateAccount(id) {
    if (id !== null && (!Number.isSafeInteger(id) || !quota.snapshot().accounts.some(account => account.id === id))) throw Error('该账号已不可用，请重新选择');
  }
  function validateGroup(id) {
    if (id !== null && (!Number.isSafeInteger(id) || !groups.snapshot().groups.some(group => group.id === id))) throw Error('请选择有效分组');
  }
  function updateConfig(id, patch) {
    const config = configFor(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
      Object.keys(patch).some(key => !['accountId','yellowBelow','redBelow','configExpanded','groupId'].includes(key))) throw Error('无效的流量跟踪配置');
    if (Object.hasOwn(patch,'accountId') && patch.accountId !== config.accountId) validateAccount(patch.accountId);
    // 保存时重新检查占用，防止页面选项过期或多个窗口先后选择同一账号。
    if (Object.hasOwn(patch,'accountId')) {
      const owner = accountOwner(patch.accountId,id);
      if (owner) throw Error(`该账号已被${owner}占用，请选择其他账号`);
    }
    if (Object.hasOwn(patch,'groupId')) validateGroup(patch.groupId);
    if (id === 'primary') {
      if (Object.hasOwn(patch,'groupId')) throw Error('主配置分组跟随用户排行');
      return updateSettings(patch);
    } else {
      settings.update({trackingConfigs:settings.snapshot().trackingConfigs.map(item => item.id === id ? {...item,...patch} : item)});
      if (Object.hasOwn(patch,'accountId')) resetTemporaryTracking(id);
    }
    return snapshot();
  }
  function copyConfig(id = 'primary') {
    const config = configFor(id), state = settings.snapshot(), nextId = state.nextConfigId;
    // 复制阈值和榜单分组，账号留空，避免新副配置立即与来源配置冲突。
    const clone = {id:nextId, accountId:null, yellowBelow:config.yellowBelow, redBelow:config.redBelow, configExpanded:true,
      groupId:id === 'primary' ? groups.snapshot().groupId : config.groupId};
    settings.update({trackingConfigs:[...state.trackingConfigs,clone]});
    return snapshot();
  }
  function deleteConfig(id) {
    if (id === 'primary') throw Error('主配置不可删除');
    configFor(id);
    settings.update({trackingConfigs:settings.snapshot().trackingConfigs.filter(config => config.id !== id)});
    resetTemporaryTracking(id);return snapshot();
  }
  async function sync() {
    if (closed) return;
    const accountState = quota.snapshot(), last = accountState.attemptedAt ?? accountState.checkedAt;
    const paused = accountState.accounts.length > 0 && accountState.accounts.every(account => account.refreshEnabled === false);
    const due = accountState.nextRefreshAt == null ? last == null || clock.now()-last >= 300000 : clock.now() >= accountState.nextRefreshAt;
    const ids = new Set(settings.snapshot().trackingConfigs.map(config => config.groupId));
    await Promise.allSettled([!paused && !accountState.busy && due ? quota.refresh() : null, groups.openDaily(), ...[...ids].map(id => groups.openDaily(id))]);
  }
  async function refresh(id = 'primary') {
    const accountId = accountIdFor(id), selected = quota.snapshot().accounts.find(account => account.id === accountId);
    if (!selected) throw Error('请先选择跟踪账号');
    if (selected.refreshEnabled === false) throw Error('跟踪账号已暂停刷新，请先在小屋开启');
    // 按当前生效账号刷新，包含副条的临时选择，不触发全部账号同步。
    await quota.refreshAccount(accountId);return snapshot();
  }
  async function refreshRanking(id = 'primary') {
    const config = configFor(id);
    if (id === 'primary') await groups.refreshDaily();else await groups.refreshDaily(config.groupId);
    return rankingSnapshot(id);
  }
  async function selectRankingGroup(groupId, id = 'primary') {
    validateGroup(groupId);
    if (id === 'primary') {const current = groups.snapshot();await groups.select({groupId,period:current.period});await groups.openDaily();}
    else {updateConfig(id,{groupId});await groups.openDaily(groupId);}
    return rankingSnapshot(id);
  }
  function selectAccount(accountId, id = 'primary') {
    configFor(id);validateAccount(accountId);
    if (accountId === null) throw Error('该账号已不可用，请重新选择');
    if (id === 'primary') return settings.snapshot().accountId === accountId ? snapshot() : updateSettings({accountId});
    // 选择窗打开期间账号可能被其他配置占用，确认选择时仍需再次校验。
    const owner = accountOwner(accountId,id);
    if (owner) throw Error(`该账号已被${owner}占用，请选择其他账号`);
    temporaryAccounts.set(id,accountId);
    return snapshot();
  }
  function start() {
    if (closed || started) return;
    started = true;
    const run = async () => {try {await sync();} finally {if (!closed) {timer=clock.setTimeout(run,5000);timer.unref?.();}}};
    void run();
  }
  return {snapshot,rankingSnapshot,accountIdFor,availableAccounts,updateSettings,updateConfig,copyConfig,deleteConfig,sync,refresh,refreshRanking,selectRankingGroup,selectAccount,resetTemporaryTracking,start,
    close() {closed=true;clock.clearTimeout(timer);}};
}
module.exports = {createPetQuota};
