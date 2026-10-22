'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createQuotaCache}=require('./quota-cache.cjs');
const DEFAULT_REFRESH_INTERVAL = {value:5, unit:'minutes'};
const INTERVAL_UNITS = {seconds:1000, minutes:60000, hours:3600000};
function normalizeInterval(value) {
  if (!value || typeof value.unit !== 'string' || !Object.hasOwn(INTERVAL_UNITS,value.unit) || !Number.isSafeInteger(value.value) ||
    value.value * INTERVAL_UNITS[value.unit] < 5000 || value.value * INTERVAL_UNITS[value.unit] > 86400000) throw Error('刷新间隔须为正整数，范围为 5 秒至 24 小时。');
  return {value:value.value,unit:value.unit};
}
const REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_LIST_SETTINGS = {showName: true, showPlatform: true, showRemaining: true, showRefresh: true, showFiveHour: true};

function remainingPercent(used) {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return Math.max(0, Math.round(100 - used));
}

function readPercent(item, key) {
  if (typeof item?.[key] === 'number') return item[key];
  const extra = item?.extra;
  return extra && typeof extra[key] === 'number' ? extra[key] : null;
}

function subscriptionLabel(credentials) {
  const plan = typeof credentials?.plan_type === 'string' ? credentials.plan_type.trim() : '';
  // 与账号平台的显示名称一致；未知类型保留原值，不按额度推测订阅。
  switch (plan.toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'prolite': return 'Pro 100';
    case 'pro': case 'chatgptpro': return 'Pro 200';
    case 'promax': return 'Pro 500';
    default: return plan || null;
  }
}

function projectAccount(item) {
  if (!item || !Number.isSafeInteger(item.id)) return null;
  const fiveHourUsed = readPercent(item, 'codex_5h_used_percent');
  const sevenDayUsed = readPercent(item, 'codex_7d_used_percent');
  if (fiveHourUsed == null && sevenDayUsed == null) return null;
  // 剩余额度由网关已保存的已用百分比折算，不携带凭据，也不据此请求上游。
  // 只读取可用张数，不向页面传递完整重置卡快照。
  const resetCardCount = item.extra?.codex_reset_credit_snapshot?.available_count;
  const expiresAt = item.credentials?.subscription_expires_at;
  const resetAt = key => {
    const value = item[key] ?? item.extra?.[key];
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  };
  const windowMinutes = key => {
    const value = item[key] ?? item.extra?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    fiveHourRemaining: remainingPercent(fiveHourUsed),
    sevenDayRemaining: remainingPercent(sevenDayUsed),
    fiveHourResetAt: resetAt('codex_5h_reset_at'),
    sevenDayResetAt: resetAt('codex_7d_reset_at'),
    fiveHourWindowMinutes: windowMinutes('codex_5h_window_minutes'),
    sevenDayWindowMinutes: windowMinutes('codex_7d_window_minutes'),
    resetCardCount: Number.isSafeInteger(resetCardCount) && resetCardCount >= 0 ? resetCardCount : null,
    subscriptionType: subscriptionLabel(item.credentials),
    platform: typeof item.platform === 'string' ? item.platform : null,
    authType: typeof item.type === 'string' ? item.type : null,
    subscriptionExpiresAt: typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : null
  };
}

// 只 GET 网关库里的账号快照。不调用 quota 或 quota/refresh，因此不会探测上游。
async function readAccountData({tokenFile, baseUrl, fetchImpl = fetch, signal}, route) {
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch { throw new Error('尚未配置 token 文件'); }
  if (!token) throw new Error('token 文件是空的');
  const origin = String(baseUrl || 'https://openai.minitvclub.com').replace(/\/+$/, '');
  signal?.throwIfAborted();
  const response = await fetchImpl(`${origin}/api/v1/admin/accounts${route}`, {headers: {'x-api-key': token}, signal});
  if (!response.ok) throw new Error(response.status === 401 ? 'token 无效，无法读取账号额度' : '读取账号额度失败');
  const body = await response.json();
  signal?.throwIfAborted();
  return body?.data && typeof body.data === 'object' ? body.data : body;
}

async function listAccountQuotas(options = {}) {
  const accounts = [];
  for (let page = 1; page <= 10; page++) {
    const data = await readAccountData(options, `?page=${page}&page_size=100`);
    if (!Array.isArray(data?.items)) throw new Error('读取账号额度失败');
    for (const item of data.items) {
      const account = projectAccount(item);
      if (account) accounts.push(account);
    }
    const pages = Number.isInteger(data?.pages) ? data.pages : 1;
    if (page >= pages) break;
  }
  return accounts;
}

// 首次请求后启动轮询；由主进程持有，切换或关闭小屋不影响后续刷新。
function createQuotaPanel({tokenFile, dataDir, baseUrl, fetchImpl, clock = {now: () => Date.now(), setTimeout, clearTimeout}} = {}) {
  let state = {accounts: [], error: '', checkedAt: null, attemptedAt: null, failedAt: null, busy: false};
  let closed = false, flight = null, flightAccountId = null, timer, deadline, controller, nextRefreshAt = null;
  const accountRefreshErrors = new Map();
  let initialized = false, disabledAccountIds = new Set();
  let resumeCache = false, cacheError = '';
  let refreshInterval = {...DEFAULT_REFRESH_INTERVAL}, cachedIntervalMs = 300000;
  const intervalMs = () => refreshInterval.value * INTERVAL_UNITS[refreshInterval.unit];
  const cache = createQuotaCache({dataDir, tokenFile, baseUrl});
  try {
    const saved = cache.load();
    if (saved) {
      const {nextRefreshAt: next, refreshIntervalMs: savedIntervalMs, ...cachedState} = saved;
      cachedIntervalMs = savedIntervalMs;
      state = {...state, ...cachedState};nextRefreshAt = next;resumeCache = true;
    }
  } catch { cacheError = '本地额度缓存无法读取，将重新同步。'; }
  const settingsFile = dataDir ? path.join(dataDir, 'quota-refresh.json') : null;
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (Array.isArray(saved.disabledAccountIds)) disabledAccountIds = new Set(saved.disabledAccountIds.filter(id => Number.isSafeInteger(id) && id > 0));
    if (saved.refreshInterval) refreshInterval = normalizeInterval(saved.refreshInterval);
  } catch {} // 无配置或文件损坏时默认全部开启，不自动覆盖原文件。
  // 缓存写入失败或配置由旧版恢复时，剩余等待仍以已保存的新周期为准。
  if (nextRefreshAt !== null && cachedIntervalMs !== intervalMs()) nextRefreshAt = Math.max(0,nextRefreshAt - cachedIntervalMs + intervalMs());
  const listSettingsFile = dataDir ? path.join(dataDir, 'quota-list.json') : null;
  let listSettings = {...DEFAULT_LIST_SETTINGS};
  try {
    const saved = JSON.parse(fs.readFileSync(listSettingsFile, 'utf8'));
    for (const key of Object.keys(DEFAULT_LIST_SETTINGS)) if (typeof saved?.[key] === 'boolean') listSettings[key] = saved[key];
    if (!['showName', 'showPlatform', 'showRemaining', 'showRefresh'].some(key => listSettings[key])) listSettings = {...DEFAULT_LIST_SETTINGS};
  } catch {} // 列配置独立于额度缓存，切换账号或刷新失败也保留显示偏好。
  const allPaused = () => state.accounts.length > 0 && state.accounts.every(account => disabledAccountIds.has(account.id));
  function snapshot() {
    // 首次读取时恢复轮询；先返回缓存，按原定刷新时间计算剩余等待。
    if (resumeCache && !closed) {
      resumeCache = false;
      schedule(nextRefreshAt ?? (state.attemptedAt ?? state.checkedAt ?? clock.now()) + intervalMs());
    }
    return {accounts: state.accounts.map(account => ({...account, refreshEnabled: !disabledAccountIds.has(account.id)})), error: state.error, checkedAt: state.checkedAt,
      attemptedAt: state.attemptedAt, failedAt: state.failedAt, busy: state.busy,
      refreshingAccountIds: !state.busy ? [] : flightAccountId === null ? state.accounts.filter(account => !disabledAccountIds.has(account.id)).map(account => account.id) : [flightAccountId],
      accountRefreshErrors: Object.fromEntries(accountRefreshErrors), nextRefreshAt, cacheError, listSettings: {...listSettings},
      refreshInterval:{...refreshInterval}, refreshIntervalMs:intervalMs(),
      refreshIntervalLabel:`${refreshInterval.value} ${{seconds:'秒',minutes:'分钟',hours:'小时'}[refreshInterval.unit]}`};
  }
  function clearTimer() { clock.clearTimeout(timer); timer = null; nextRefreshAt = null; }
  function saveCache() {
    try { cache.save({...state, nextRefreshAt, refreshIntervalMs:intervalMs()});cacheError = ''; }
    catch { cacheError = '本地额度缓存保存失败，重启后可能无法保留最新数据。'; }
  }
  function schedule(at = clock.now() + intervalMs()) {
    clearTimer();
    if (closed || allPaused()) return;
    // 请求完成后再等待配置的间隔，避免短周期堆积请求；单账号刷新沿用原计划。
    nextRefreshAt = at;
    timer = clock.setTimeout(() => void refresh(), Math.max(0, at - clock.now()));
    timer.unref?.();
  }
  function refresh(accountId = null) {
    if (closed) return Promise.resolve(snapshot());
    if (accountId !== null) {
      if (!Number.isSafeInteger(accountId) || !state.accounts.some(account => account.id === accountId)) return Promise.reject(Error('该账号已不可用，请重新选择'));
      if (disabledAccountIds.has(accountId)) return Promise.reject(Error('跟踪账号已暂停刷新，请先在小屋开启'));
    }
    // 全量请求覆盖所有账号，同账号请求可合并；其他刷新范围等待当前请求完成。
    if (flight) return flightAccountId === null || flightAccountId === accountId ? flight : flight.then(() => refresh(accountId));
    if (accountId === null && allPaused()) return Promise.resolve(snapshot());
    resumeCache = false;
    flightAccountId = accountId;
    // 单账号刷新不重置全量同步时间，避免推迟其他账号的自动刷新。
    if (accountId === null) clearTimer();
    // 重试开始时保留失败提示，只有成功取得完整列表后才清除。
    state = {...state, busy: true, ...(accountId === null ? {attemptedAt: clock.now()} : {})};
    controller = new AbortController();
    const signal = controller.signal;
    flight = Promise.resolve().then(async () => {
      if (closed) return;
      deadline = clock.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      deadline.unref?.();
      try {
        const options = {tokenFile, baseUrl, fetchImpl, signal};
        if (accountId !== null) {
          // 只读取并替换目标账号摘要，其他账号继续使用已有缓存。
          const account = projectAccount(await readAccountData(options, `/${accountId}`));
          if (!account || account.id !== accountId) throw new Error('读取账号额度失败');
          if (closed) return;
          state = {...state, accounts: state.accounts.map(item => item.id === accountId ? account : item)};
          accountRefreshErrors.set(accountId, '');
          return;
        }
        // 首次发现账号；后续只读取开启的账号详情，关闭的账号保留旧值。
        if (!initialized || !state.accounts.length) {
          const accounts = await listAccountQuotas(options);
          if (closed) return;
          const previous = new Map(state.accounts.map(account => [account.id, account]));
          state = {...state, accounts: accounts.map(account => disabledAccountIds.has(account.id) ? previous.get(account.id) || account : account)};
          initialized = true;
        } else {
          let failed = false;
          for (const previous of state.accounts) {
            if (disabledAccountIds.has(previous.id)) continue;
            try {
              const account = projectAccount(await readAccountData(options, `/${previous.id}`));
              if (!account || account.id !== previous.id) throw new Error('读取账号额度失败');
              if (closed) return;
              state = {...state, accounts: state.accounts.map(item => item.id === account.id ? account : item)};
            } catch {
              if (closed) return;
              signal.throwIfAborted();
              failed = true; // 单笔失败不阻止其他账号更新，失败账号继续显示原值。
            }
          }
          if (failed) throw new Error('读取账号额度失败');
        }
        if (!closed) {state = {...state, error: '', failedAt: null, checkedAt: clock.now()};accountRefreshErrors.clear();}
      } catch (error) {
        if (closed) return;
        // 失败保留上次成功数据；不向页面透传网络库可能包含凭据的原始错误。
        const known = ['尚未配置 token 文件', 'token 文件是空的', 'token 无效，无法读取账号额度', '读取账号额度失败'];
        // 记录本轮连续失败的起点；后续重试失败不推进此时间。
        const message = signal.aborted ? '读取账号额度超时，将按刷新间隔自动重试。' :
          known.includes(error.message) ? error.message : '读取账号额度失败，将按刷新间隔自动重试。';
        // 单账号失败只影响对应额度条，不把错误扩散到其他账号。
        if (accountId !== null) accountRefreshErrors.set(accountId, message);
        else {state = {...state, failedAt: state.failedAt ?? clock.now(), error: message};accountRefreshErrors.clear();}
      }
    }).finally(() => {
      clock.clearTimeout(deadline); deadline = null; controller = null;
      state = {...state, busy: false}; flight = null; flightAccountId = null;
      if (accountId === null) schedule();
      if (!closed) saveCache();
    }).then(() => snapshot());
    return flight;
  }
  function refreshAccount(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(Error('请选择有效账号'));
    return refresh(id);
  }
  function close() {
    closed = true; clearTimer(); clock.clearTimeout(deadline); controller?.abort();
    state = {...state, busy: false};
  }
  function setRefreshEnabled(value) {
    if (closed) throw new Error('额度页面已关闭');
    if (flight) throw new Error('正在刷新，请稍后修改设置');
    if (!Number.isSafeInteger(value?.id) || value.id <= 0 || typeof value.enabled !== 'boolean' || !state.accounts.some(account => account.id === value.id)) throw new Error('无效的账号刷新设置');
    const next = new Set(disabledAccountIds);
    if (value.enabled) next.delete(value.id);else next.add(value.id);
    saveRefreshSettings(next,refreshInterval);
    disabledAccountIds = next;
    if (allPaused()) clearTimer();
    else if (!timer && state.accounts.length) schedule();
    saveCache();
    return snapshot();
  }
  function saveRefreshSettings(disabled, interval) {
    // 账号开关和周期共用配置文件，每次完整保存，避免互相覆盖；成功后才更新内存。
    try {
      if (!settingsFile) throw new Error();
      fs.writeFileSync(settingsFile + '.tmp', JSON.stringify({disabledAccountIds:[...disabled],refreshInterval:interval}), {mode: 0o600});
      fs.renameSync(settingsFile + '.tmp', settingsFile);
    } catch { throw new Error('账号刷新设置保存失败，请重试'); }
  }
  function setRefreshInterval(value) {
    if (closed) throw Error('额度页面已关闭');
    if (flight) throw Error('正在刷新，请稍后修改设置');
    const next = normalizeInterval(value);
    saveRefreshSettings(disabledAccountIds,next);refreshInterval = next;resumeCache = false;
    // 修改周期从保存时重新计时；全部暂停时只保存配置，重新启用后再恢复轮询。
    if (timer || state.attemptedAt !== null || state.checkedAt !== null || state.accounts.length) schedule();
    saveCache();
    return snapshot();
  }
  function setListSettings(value) {
    if (closed) throw new Error('额度页面已关闭');
    if (!value || typeof value !== 'object' || !Object.keys(value).length ||
      Object.entries(value).some(([key, enabled]) => !Object.hasOwn(DEFAULT_LIST_SETTINGS, key) || typeof enabled !== 'boolean')) throw new Error('无效的列表配置');
    const next = {...listSettings, ...value};
    if (!['showName', 'showPlatform', 'showRemaining', 'showRefresh'].some(key => next[key])) throw new Error('请至少保留一列');
    // 显示列只改变本地界面，不触发远程刷新或重置下次刷新时间。
    try {
      if (!listSettingsFile) throw new Error();
      fs.writeFileSync(listSettingsFile + '.tmp', JSON.stringify(next), {mode: 0o600});
      fs.renameSync(listSettingsFile + '.tmp', listSettingsFile);
    } catch { throw new Error('列表配置保存失败，请重试'); }
    listSettings = next;
    return snapshot();
  }
  return {snapshot, refresh: () => refresh(), refreshAccount, close, setRefreshEnabled, setRefreshInterval, setListSettings};
}

module.exports = {projectAccount, listAccountQuotas, createQuotaPanel, remainingPercent};
