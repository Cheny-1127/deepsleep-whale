'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const REFRESH_MS = 30 * 60 * 1000;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function shanghaiDate(at) {
  const parts = new Intl.DateTimeFormat('en', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(at);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function rankingRange(at, period = 'day') {
  const date = shanghaiDate(at), start = new Date(`${date}T00:00:00Z`);
  // 使用上海日历日期计算周一，避免受运行机器时区和夏令时影响。
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return {date, startDate: start.toISOString().slice(0, 10)};
}

function projectGroup(item) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0 || typeof item.name !== 'string') throw Error('invalid group');
  return {id: item.id, name: item.name.slice(0, 320)};
}

function projectUser(item) {
  if (!item || !Number.isSafeInteger(item.user_id) || item.user_id <= 0) throw Error('invalid user');
  // 仅保留排行展示字段，既不转发原始响应，也不把管理凭据写进缓存。
  return {user_id: item.user_id, email: typeof item.email === 'string' ? item.email.slice(0, 320) : '',
    requests: number(item.requests), input_tokens: number(item.input_tokens), output_tokens: number(item.output_tokens),
    cache_tokens: number(item.cache_tokens), total_tokens: number(item.total_tokens), actual_cost: number(item.actual_cost)};
}

function createGroupUsage({tokenFile, dataDir, baseUrl = 'https://openai.minitvclub.com', fetchImpl = fetch,
  clock = {now: () => Date.now(), setTimeout, clearTimeout}} = {}) {
  const origin = String(baseUrl).replace(/\/+$/, '');
  const file = dataDir ? path.join(dataDir, 'quota-group-usage.json') : null;
  const entries = new Map();
  let groupId = 13, period = 'day', groups = [], groupsCheckedAt = null, groupsAttemptedAt = null, groupsError = '';
  let flight = null, passiveFlight = false, flightEntryKey = null, timer, deadline, controller, closed = false, cacheError = '', nextRefreshAt = null;
  const key = (id, date, strategy = 'day') => `${id ?? 'all'}:${strategy}:${date}`;
  const source = () => createHash('sha256').update(JSON.stringify([origin, fs.readFileSync(tokenFile, 'utf8').trim()])).digest('hex');
  const validGroup = id => id === null || Number.isSafeInteger(id) && id > 0;
  const validPeriod = value => ['day', 'week'].includes(value);
  try {
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ([1, 2].includes(saved.version) && saved.source === source()) {
        if (!validGroup(saved.groupId) || !Array.isArray(saved.entries) || saved.entries.length > 20) throw Error('invalid cache');
        const loaded = saved.entries.map(item => {
          if (!validGroup(item.groupId) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Array.isArray(item.users) || item.users.length > 50) throw Error('invalid cache');
          const failedAt = timestamp(item.failedAt), strategy = item.period ?? 'day';
          if (!validPeriod(strategy)) throw Error('invalid period');
          return {groupId: item.groupId, ...rankingRange(Date.parse(`${item.date}T12:00:00+08:00`), strategy), period: strategy,
            users: item.users.map(projectUser), checkedAt: timestamp(item.checkedAt), attemptedAt: timestamp(item.attemptedAt), failedAt,
            error: failedAt === null ? '' : '读取用户排行失败，30 分钟后自动重试。'};
        });
        groupId = saved.groupId;
        period = validPeriod(saved.period) ? saved.period : 'day';
        groups = Array.isArray(saved.groups) && saved.groups.length <= 2000 ? saved.groups.map(projectGroup) : [];
        groupsCheckedAt = timestamp(saved.groupsCheckedAt);
        for (const item of loaded) entries.set(key(item.groupId, item.date, item.period), item);
      }
    }
  } catch { cacheError = '本地分组用量缓存无法读取，将重新同步。'; }
  function current(id = groupId, strategy = period) {
    const range = rankingRange(clock.now(), strategy);
    return entries.get(key(id, range.date, strategy)) || {groupId: id, period: strategy, ...range, users: [], checkedAt: null, attemptedAt: null, failedAt: null, error: ''};
  }
  function snapshot() {
    const item = current();
    return {...item, users: item.users.map(user => ({...user})), groups: groups.map(group => ({...group})), groupsError,
      busy: Boolean(flight), nextRefreshAt, cacheError};
  }
  function save() {
    if (!file) return;
    try {
      // 按分组、策略和日期隔离，最多保留 20 份摘要；兼容迁移旧版每日缓存。
      const values = [...entries.values()].slice(-20).map(({error, ...item}) => item);
      fs.writeFileSync(file + '.tmp', JSON.stringify({version: 2, source: source(), groupId, period, groups, groupsCheckedAt, entries: values}), {mode: 0o600});
      fs.renameSync(file + '.tmp', file);
      cacheError = '';
    } catch { cacheError = '本地分组用量缓存保存失败，重启后可能无法保留最新数据。'; }
  }
  function schedule(at = clock.now() + REFRESH_MS) {
    clock.clearTimeout(timer);
    nextRefreshAt = closed ? null : at;
    if (closed) return;
    timer = clock.setTimeout(() => void refresh(), Math.max(0, at - clock.now()));
    timer.unref?.();
  }
  const groupsDue = () => {
    const last = groupsAttemptedAt ?? groupsCheckedAt;
    return last == null || clock.now() - last >= REFRESH_MS;
  };
  async function loadGroups(signal, retry = false) {
    if (!groupsDue() && !retry) return;
    groupsAttemptedAt = clock.now();
    try {
      // 名称目录独立于排行缓存加载，旧版缓存迁移时也能立即补全 ID 与名称。
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      if (!token) throw Error('missing token');
      const response = await fetchImpl(`${origin}/api/v1/admin/groups/all`, {headers: {'x-api-key': token}, signal});
      if (!response.ok) throw Error('groups unavailable');
      const body = await response.json(), items = body?.data ?? body;
      if ((body?.code != null && body.code !== 0) || !Array.isArray(items) || items.length > 2000) throw Error('invalid groups');
      const projected = items.map(projectGroup);
      signal.throwIfAborted();
      if (closed) return;
      groups = projected;groupsCheckedAt = clock.now();groupsError = '';
    } catch {
      if (!closed) groupsError = '分组列表读取失败，已保留原列表；稍后刷新重试。';
    }
  }
  function refreshEntry(id, strategy, passive = false) {
    if (!validGroup(id)) throw Error('请输入有效的组 ID');
    if (closed) return Promise.resolve(snapshot());
    if (flight) {
      if (passive || passiveFlight) return flight.then(() => passive ? openDaily(id) : refresh(id));
      if (id !== groupId) throw Error('正在刷新，请稍后切换分组');
      return flight;
    }
    if (!passive) groupId = id;
    passiveFlight = passive;
    clock.clearTimeout(timer);nextRefreshAt = null;
    const previous = current(id, strategy), entryKey = key(id, previous.date, strategy);
    flightEntryKey = entryKey;
    const attempted = {...previous, attemptedAt: clock.now()};
    entries.delete(entryKey);entries.set(entryKey, attempted);
    while (entries.size > 20) entries.delete(entries.keys().next().value);
    controller = new AbortController();
    const signal = controller.signal;
    deadline = clock.setTimeout(() => controller?.abort(), 60000);
    deadline.unref?.();
    flight = Promise.resolve().then(async () => {
      if (closed) return;
      try {
        let token;
        try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { throw Error('尚未配置 token 文件'); }
        if (!token) throw Error('token 文件是空的');
        await loadGroups(signal, Boolean(groupsError));
        signal.throwIfAborted();
        const query = new URLSearchParams({start_date: previous.startDate, end_date: previous.date,
          timezone: 'Asia/Shanghai', sort_by: 'actual_cost', limit: '50'});
        if (id !== null) query.set('group_id', String(id));
        const response = await fetchImpl(`${origin}/api/v1/admin/dashboard/user-breakdown?${query}`, {headers: {'x-api-key': token}, signal});
        if (!response.ok) throw Error(response.status === 401 ? 'token 无效，无法读取分组用量' : '读取分组用量失败');
        const body = await response.json();
        signal.throwIfAborted();
        if (closed) return;
        const data = body?.data ?? body;
        if ((body?.code != null && body.code !== 0) || !Array.isArray(data?.users) || data.users.length > 50) throw Error('读取分组用量失败');
        const users = data.users.map(projectUser).sort((a, b) => (b.actual_cost ?? -1) - (a.actual_cost ?? -1));
        entries.set(entryKey, {...attempted, users, checkedAt: clock.now(), failedAt: null, error: ''});
      } catch (error) {
        if (closed) return;
        const known = ['尚未配置 token 文件', 'token 文件是空的', 'token 无效，无法读取分组用量'];
        // 保留本组当天的旧数据和首次失败时间，不向页面透传网络诊断或其他组的数据。
        entries.set(entryKey, {...attempted, failedAt: attempted.failedAt ?? clock.now(), error: signal.aborted ?
          '读取用户排行超时，30 分钟后自动重试。' : known.includes(error.message) ? error.message : '读取用户排行失败，30 分钟后自动重试。'});
      }
    }).finally(() => {
      clock.clearTimeout(deadline);controller = null;flight = null;passiveFlight = false;flightEntryKey = null;
      if (!closed) {
        // 桌宠补查今日数据不能推迟每周排行原定的刷新时间。
        const active = current(), last = active.attemptedAt ?? active.checkedAt;
        if (!passive || last != null) schedule(passive ? last + REFRESH_MS : clock.now() + REFRESH_MS);
        save();
      }
    }).then(() => snapshot());
    return flight;
  }
  function refresh(id = groupId) {return refreshEntry(id, period);}
  function openDirectory(last) {
    controller = new AbortController();
    const signal = controller.signal;
    deadline = clock.setTimeout(() => controller?.abort(), 60000);deadline.unref?.();
    flight = Promise.resolve().then(() => {if (!closed) return loadGroups(signal);}).finally(() => {
      clock.clearTimeout(deadline);controller = null;flight = null;
      if (!closed) {schedule(last + REFRESH_MS);save();}
    }).then(() => snapshot());
    return flight;
  }
  function open() {
    if (closed || flight) return flight && passiveFlight ? flight.then(() => open()) : flight || Promise.resolve(snapshot());
    const item = current(), last = item.attemptedAt ?? item.checkedAt;
    if (last == null || clock.now() - last >= REFRESH_MS) return refresh();
    if (groupsDue()) return openDirectory(last);
    if (!timer) schedule(last + REFRESH_MS);
    return Promise.resolve(snapshot());
  }
  function dailySnapshot(id = groupId) {
    return {...current(id, 'day'), groups: groups.map(group => ({...group})),
      users: current(id, 'day').users.map(user => ({...user})), busy: Boolean(flight)};
  }
  function openDaily(id = groupId) {
    if (!validGroup(id)) throw Error('请输入有效的组 ID');
    if (closed) return Promise.resolve(dailySnapshot(id));
    const item = current(id, 'day'), last = item.attemptedAt ?? item.checkedAt;
    if (last != null && clock.now() - last < REFRESH_MS) {
      if (!groupsDue()) return Promise.resolve(dailySnapshot(id));
      return (flight || openDirectory(last)).then(() => dailySnapshot(id));
    }
    if (flight) return flight.then(() => openDaily(id));
    return refreshEntry(id, 'day', true).then(() => dailySnapshot(id));
  }
  function refreshDaily(id = groupId) {
    if (!validGroup(id)) throw Error('请输入有效的组 ID');
    if (closed) return Promise.resolve(dailySnapshot(id));
    // 按分组和日期合并在途请求，独立榜单不修改主排行筛选。
    if (flight) return passiveFlight && flightEntryKey === key(id, shanghaiDate(clock.now()), 'day') ?
      flight.then(() => dailySnapshot(id)) : flight.then(() => refreshDaily(id));
    return refreshEntry(id, 'day', true).then(() => dailySnapshot(id));
  }
  function close() {closed = true;clock.clearTimeout(timer);clock.clearTimeout(deadline);timer = null;nextRefreshAt = null;controller?.abort();}
  function select(value) {
    if (!value || !validGroup(value.groupId) || !validPeriod(value.period)) throw Error('无效的排行筛选');
    if (flight) throw Error('正在刷新，请稍后切换筛选');
    groupId = value.groupId;period = value.period;
    clock.clearTimeout(timer);timer = null;nextRefreshAt = null;
    save();
    return open();
  }
  return {snapshot, open, refresh, select, close, dailySnapshot, openDaily, refreshDaily};
}

module.exports = {createGroupUsage, shanghaiDate, rankingRange, projectUser};
