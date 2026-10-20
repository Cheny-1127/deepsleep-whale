'use strict';

// 只向桌宠提供选中账号和今日前五摘要；管理接口与凭据仍留在主进程。
function createPetQuota({settings, quota, groups, clock = {now: () => Date.now(), setTimeout, clearTimeout}}) {
  let timer, closed = false, started = false;
  function snapshot() {
    const config = settings.snapshot(), accounts = quota.snapshot(), daily = groups.dailySnapshot();
    const selected = accounts.accounts.find(account => account.id === config.accountId);
    const available = selected && selected.sevenDayWindowMinutes !== 0 && typeof selected.sevenDayRemaining === 'number';
    const remaining = available ? selected.sevenDayRemaining : null;
    const groupName = daily.groupId === null ? '全部分组' : daily.groups.find(item => item.id === daily.groupId)?.name || `分组 #${daily.groupId}`;
    return {settings: config, tracking: {
      accountId: config.accountId, name: selected?.name || '', remaining,
      resetAt: selected?.sevenDayResetAt || null, checkedAt: accounts.checkedAt,
      paused: selected?.refreshEnabled === false, busy: accounts.busy === true, error: accounts.error || '',
      tone: remaining === null ? 'unknown' : remaining < config.redBelow ? 'red' : remaining < config.yellowBelow ? 'yellow' : 'green'
    }, ranking: {groupId: daily.groupId, groupName, date: daily.date, checkedAt: daily.checkedAt,
      error: daily.error, busy: daily.busy, users: daily.users.slice(0, 5).map(({user_id, email, actual_cost}) => ({user_id, email, actual_cost}))}};
  }
  async function sync() {
    if (closed) return;
    const accountState = quota.snapshot(), last = accountState.attemptedAt ?? accountState.checkedAt;
    const paused = accountState.accounts.length > 0 && accountState.accounts.every(account => account.refreshEnabled === false);
    const due = accountState.nextRefreshAt == null ? last == null || clock.now() - last >= 300000 : clock.now() >= accountState.nextRefreshAt;
    // 两个服务自己合并在途请求并保留缓存；读取桌宠快照不触发网络。
    await Promise.allSettled([!paused && !accountState.busy && due ? quota.refresh() : null, groups.openDaily()]);
  }
  async function refresh() {
    const accountId = settings.snapshot().accountId;
    const selected = quota.snapshot().accounts.find(account => account.id === accountId);
    if (!selected) throw Error('请先在 API 额度中选择跟踪账号');
    if (selected.refreshEnabled === false) throw Error('跟踪账号已暂停刷新，请先在小屋开启');
    // 复用额度服务的同步、请求合并和本地缓存，不提供账号管理能力。
    await quota.refresh();
    return snapshot();
  }
  async function refreshRanking() {
    await groups.refreshDaily();
    return snapshot().ranking;
  }
  function start() {
    if (closed || started) return;
    started = true;
    const run = async () => {
      try {await sync();} finally {
        if (!closed) {timer = clock.setTimeout(run, 5000);timer.unref?.();}
      }
    };
    void run();
  }
  return {snapshot, sync, refresh, refreshRanking, start, close() {closed = true;clock.clearTimeout(timer);}};
}
module.exports = {createPetQuota};
