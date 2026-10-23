'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {shanghaiDate} = require('./quota-group-usage.cjs');
const FRESH_MS = 30 * 60 * 1000;
const validID = id => Number.isSafeInteger(id) && id > 0;
const userFields = item => {
  if (!validID(item?.id) || typeof item.email !== 'string') throw Error('invalid user');
  return {id:item.id, email:item.email.slice(0,320)};
};

// 只读取站内数据，批量统计 Key 今日扣费；完整 Key、token 和管理端原始响应不进入快照或缓存。
function createKeyUsage({tokenFile, dataDir, baseUrl = 'https://openai.minitvclub.com', fetchImpl = fetch,
  clock = {now:() => Date.now(), setTimeout, clearTimeout}} = {}) {
  const origin = String(baseUrl).replace(/\/+$/, '');
  const file = dataDir ? path.join(dataDir,'quota-key-usage.json') : null;
  const entries = new Map(), directory = new Map(), flights = new Map(), searches = new Map(), controllers = new Set();
  let selected = null, expanded = true, closed = false, cacheError = '';
  // 缓存绑定站点和凭据指纹，切换管理凭据后不复用上一来源的数据，也不保存凭据原文。
  const source = () => createHash('sha256').update(JSON.stringify([origin,fs.readFileSync(tokenFile,'utf8').trim()])).digest('hex');
  const entryKey = (id, date = shanghaiDate(clock.now())) => `${id}:${date}`;
  const keyFields = item => {
    if (!validID(item?.id) || item.groupId !== null && !validID(item.groupId) || typeof item.name !== 'string' ||
      typeof item.groupName !== 'string' || typeof item.todayCost !== 'number' || !Number.isFinite(item.todayCost) || item.todayCost < 0) throw Error('invalid key');
    return {id:item.id,name:item.name.slice(0,320),groupId:item.groupId,groupName:item.groupName.slice(0,320),
      status:typeof item.status === 'string' ? item.status.slice(0,32) : '',todayCost:item.todayCost};
  };
  try {
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file,'utf8'));
      if (saved.version === 1 && saved.source === source()) {
        // 兼容没有折叠偏好的旧缓存，默认展开。
        expanded = saved.expanded !== false;
        selected = saved.selected === null ? null : userFields(saved.selected);
        if (!Array.isArray(saved.entries) || saved.entries.length > 10) throw Error('invalid cache');
        for (const item of saved.entries) {
          if (!validID(item.userId) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isSafeInteger(item.checkedAt) || item.checkedAt < 0 ||
            !Array.isArray(item.keys) || item.keys.length > 1000) throw Error('invalid cache');
          entries.set(entryKey(item.userId,item.date),{userId:item.userId,date:item.date,keys:item.keys.map(keyFields),
            checkedAt:item.checkedAt,attemptedAt:item.checkedAt,error:''});
        }
      }
    }
  } catch {selected = null;expanded = true;entries.clear();cacheError = '本地 Key 用量缓存无法读取，将重新同步。';}
  function save() {
    if (!file || closed) return;
    try {
      const items = [...entries.values()].filter(item => item.checkedAt !== null).slice(-10)
        .map(({userId,date,keys,checkedAt}) => ({userId,date,keys,checkedAt}));
      fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,source:source(),selected,expanded,entries:items}),{mode:0o600});
      fs.renameSync(file+'.tmp',file);cacheError = '';
    } catch {cacheError = '本地 Key 用量缓存保存失败，重启后可能无法保留最新数据。';}
  }
  function snapshot() {
    // 只取当前账号、当天的条目；跨日或切换账号时不会短暂显示上一份消费。
    const date = shanghaiDate(clock.now()), item = selected && entries.get(entryKey(selected.id,date));
    const keys = (item?.keys || []).map(key => ({...key}));
    return {user:selected && {...selected},expanded,date,keys,totalCost:keys.reduce((sum,key) => sum+key.todayCost,0),
      checkedAt:item?.checkedAt ?? null,attemptedAt:item?.attemptedAt ?? null,error:item?.error || '',cacheError,
      busy:Boolean(selected && flights.has(entryKey(selected.id,date)))};
  }
  async function request(route, signal, body) {
    signal.throwIfAborted();
    let token;
    try {token = fs.readFileSync(tokenFile,'utf8').trim();} catch {throw Error('尚未配置 token 文件');}
    if (!token) throw Error('token 文件是空的');
    const response = await fetchImpl(`${origin}/api/v1/admin/${route}`,{method:body ? 'POST' : 'GET',
      headers:{'x-api-key':token,...(body ? {'Content-Type':'application/json'} : {})},signal,...(body ? {body:JSON.stringify(body)} : {})});
    if (!response.ok) throw Error(response.status === 401 ? 'token 无效，无法读取 Key 用量' : 'request failed');
    const result = await response.json();signal.throwIfAborted();
    if (result?.code != null && result.code !== 0) throw Error('API error');
    return result?.data ?? result;
  }
  async function bounded(work) {
    const controller = new AbortController();controllers.add(controller);
    const timer = clock.setTimeout(() => controller.abort(),60000);timer.unref?.();
    try {return await work(controller.signal);} finally {clock.clearTimeout(timer);controllers.delete(controller);}
  }
  function search(raw = '') {
    if (typeof raw !== 'string' || raw.length > 100) return Promise.reject(Error('搜索内容最多 100 字'));
    const query = raw.trim(), previous = directory.get(query);
    if (closed) return Promise.resolve([]);
    if (previous && clock.now()-previous.checkedAt < FRESH_MS) return Promise.resolve(previous.users.map(user => ({...user})));
    // 同一搜索词的并发调用共用请求，减少重复展开和输入造成的管理接口访问。
    if (searches.has(query)) return searches.get(query);
    const flight = bounded(async signal => {
      try {
        const params = new URLSearchParams({page:'1',page_size:'30',sort_by:'email',sort_order:'asc',include_subscriptions:'false',search:query});
        const data = await request(`users?${params}`,signal);
        if (!Array.isArray(data?.items) || data.items.length > 30) throw Error('invalid users');
        const users = data.items.map(userFields);
        if (closed) return [];
        directory.delete(query);directory.set(query,{users,checkedAt:clock.now()});
        while (directory.size > 10) directory.delete(directory.keys().next().value);
        return users.map(user => ({...user}));
      } catch {throw Error('读取 Sub2API 用户账号失败，请稍后重试。');}
    }).finally(() => searches.delete(query));
    searches.set(query,flight);return flight;
  }
  function refresh(force = true) {
    if (!selected || closed) return Promise.resolve(snapshot());
    const user = {...selected}, date = shanghaiDate(clock.now()), id = entryKey(user.id,date), previous = entries.get(id);
    // 合并同账号当天的在途查询；失败也记录尝试时间，避免自动轮询连续重试。
    if (flights.has(id)) return flights.get(id);
    if (!force && previous && clock.now()-previous.attemptedAt < FRESH_MS) return Promise.resolve(snapshot());
    const attemptedAt = clock.now();
    const flight = bounded(async signal => {
      try {
        const keys = [], seen = new Set();
        // 先收齐并核验所有分页；不把截断、重复或归属异常的 Key 列表当作账号完整消费。
        for (let page = 1; page <= 10; page++) {
          const data = await request(`users/${user.id}/api-keys?page=${page}&page_size=100`,signal);
          if (!Array.isArray(data?.items) || data.items.length > 100) throw Error('invalid keys');
          for (const item of data.items) {
            if (!validID(item?.id) || item.user_id !== user.id || seen.has(item.id) ||
              item.group_id != null && !validID(item.group_id)) throw Error('invalid key ownership');
            seen.add(item.id);
            keys.push({id:item.id,name:typeof item.name === 'string' ? item.name.slice(0,320) : '',groupId:item.group_id ?? null,
              groupName:typeof item.group?.name === 'string' ? item.group.name.slice(0,320) : '',status:item.status});
          }
          const total = data.total;
          if (!Number.isSafeInteger(total) || total < keys.length || total > 1000) throw Error('incomplete key list');
          if (keys.length === total) break;
          if (page === 10 || data.items.length === 0) throw Error('incomplete key list');
        }
        let stats = {};
        // 所有 Key 一次批量查费，避免每个 Key 单独请求；today_actual_cost 才是今日实际扣费。
        if (keys.length) stats = (await request('dashboard/api-keys-usage',signal,{api_key_ids:keys.map(key => key.id)}))?.stats;
        // 缺失统计不是零消费；整次失败时保留同账号、同一天的上次结果。
        const projected = keys.map(key => keyFields({...key,todayCost:stats?.[key.id]?.today_actual_cost}));
        // 请求跨过午夜时丢弃响应，防止把新一天的扣费写入昨天的缓存。
        if (closed || date !== shanghaiDate(clock.now())) return;
        entries.delete(id);entries.set(id,{userId:user.id,date,keys:projected,checkedAt:clock.now(),attemptedAt,error:''});
      } catch (error) {
        if (closed || date !== shanghaiDate(clock.now())) return;
        const known = ['尚未配置 token 文件','token 文件是空的','token 无效，无法读取 Key 用量'];
        entries.set(id,{userId:user.id,date,keys:previous?.keys || [],checkedAt:previous?.checkedAt ?? null,attemptedAt,
          error:signal.aborted ? '读取 Key 今日消费超时，请稍后刷新。' : known.includes(error.message) ? error.message : '读取 Key 今日消费失败，请稍后刷新。'});
      } finally {
        while (entries.size > 10) entries.delete(entries.keys().next().value);
        save();
      }
    }).finally(() => flights.delete(id)).then(() => snapshot());
    flights.set(id,flight);return flight;
  }
  function select(id) {
    if (!validID(id)) return Promise.reject(Error('请选择有效的 Sub2API 用户账号'));
    const user = selected?.id === id ? selected : [...directory.values()].flatMap(item => item.users).find(item => item.id === id);
    if (!user) return Promise.reject(Error('请从账号列表中选择'));
    selected = {...user};save();return refresh(false);
  }
  function close() {closed = true;for (const controller of controllers) controller.abort();}
  function setExpanded(value) {
    // 保存整卡显示偏好，不查费；重启后仍收起，展开时再检查消费缓存是否到期。
    if (typeof value !== 'boolean') throw Error('无效的折叠状态');
    expanded = value;save();return snapshot();
  }
  return {snapshot,search,select,refresh,setExpanded,open:() => expanded ? refresh(false) : Promise.resolve(snapshot()),close};
}

module.exports = {createKeyUsage};
