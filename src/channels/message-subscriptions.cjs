'use strict';
const fs = require('node:fs'), path = require('node:path');
const {xUsername, validPostId, compareIds, projectPost} = require('./x-posts.cjs');
const INTERVAL = 60 * 60 * 1000, LIMIT = 100, ACCOUNT_LIMIT = 20;
const stamp = value => value === null || Number.isSafeInteger(value) && value >= 0;

function createMessageSubscriptions({dataDir, readPosts, onChange = () => {}, clock = {now:() => Date.now(), setTimeout, clearTimeout}}) {
  const file = path.join(dataDir, 'message-subscriptions.json');
  let state = {version:1, accounts:[]}, storeError = '', retryAt = 0, blocked = false, timer, flight = null, controller, activeUsername = null, epoch = 0, closed = false, started = false, revision = 0;
  try {
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 64000000) throw Error();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.accounts) || saved.accounts.length > ACCOUNT_LIMIT) throw Error();
      const names = new Set();
      state.accounts = saved.accounts.map(a => {
        const username = xUsername(a.username);
        if (names.has(username) || typeof a.enabled !== 'boolean' || typeof a.initialized !== 'boolean' ||
          !stamp(a.attemptedAt) || !stamp(a.checkedAt) || (a.latestId !== null && !validPostId(a.latestId)) ||
          !Array.isArray(a.unreadIds) || a.unreadIds.length > LIMIT || !a.unreadIds.every(validPostId) ||
          !Array.isArray(a.posts) || a.posts.length > LIMIT) throw Error();
        names.add(username);
        return {username, enabled:a.enabled, initialized:a.initialized, latestId:a.latestId, unreadIds:[...new Set(a.unreadIds)],
          attemptedAt:a.attemptedAt, checkedAt:a.checkedAt, error:typeof a.error === 'string' ? a.error.slice(0, 160) : '',
          posts:a.posts.map(item => projectPost(item, username, clock.now()))};
      });
    }
  } catch {state = {version:1, accounts:[]};blocked = true;storeError = '消息订阅文件无法读取，原文件已保留，请检查本地文件后重启。';}
  const nextAt = a => a.attemptedAt === null ? clock.now() : Math.min(a.attemptedAt, clock.now()) + INTERVAL;
  function summary() {
    return {unread:state.accounts.reduce((sum,a) => sum + a.posts.filter(p => a.unreadIds.includes(p.id)).length, 0), busy:Boolean(flight), revision};
  }
  function snapshot() {
    const accounts = state.accounts.map(a => ({username:a.username, enabled:a.enabled, checkedAt:a.checkedAt, attemptedAt:a.attemptedAt,
      error:a.error, count:a.posts.length, unread:a.posts.filter(p => a.unreadIds.includes(p.id)).length,
      nextCheckAt:a.enabled ? nextAt(a) : null}));
    const posts = state.accounts.flatMap(a => a.posts.map(p => ({...p, unread:a.unreadIds.includes(p.id)})))
      .sort((a,b) => compareIds(b.id,a.id));
    return {accounts, posts, ...summary(), storeError, interval:INTERVAL, limit:LIMIT, accountLimit:ACCOUNT_LIMIT};
  }
  function commit(next) {
    if (blocked) throw Error(storeError);
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(next), {mode:0o600});
      fs.renameSync(file + '.tmp', file);
    } catch {storeError = '消息订阅保存失败，已有文件和内容已保留，请重试。';retryAt = clock.now() + INTERVAL;revision++;onChange();throw Error(storeError);}
    state = next;storeError = '';retryAt = 0;revision++;onChange();
  }
  function schedule() {
    clock.clearTimeout(timer);timer = null;
    const enabled = state.accounts.filter(a => a.enabled);
    if (closed || !started || blocked || flight || !enabled.length) return;
    const at = Math.max(retryAt, Math.min(...enabled.map(nextAt)));
    timer = clock.setTimeout(() => {timer = null;void refresh(false);}, Math.max(0, at - clock.now()));timer.unref?.();
  }
  // 配置、清理和暂停会使旧批次失效；迟到的网页结果不能重新写回被清空或删除的内容。
  function invalidate() {epoch++;controller?.abort();clock.clearTimeout(timer);timer = null;}
  function mutate(fn, invalidateBatch = false) {
    if (closed) throw Error('消息订阅已停止。');
    const next = structuredClone(state);fn(next);commit(next);
    if (invalidateBatch) invalidate();
    schedule();return snapshot();
  }
  function refresh(force = true) {
    if (closed || blocked) return Promise.resolve(snapshot());
    if (flight) return flight;
    const names = state.accounts.filter(a => a.enabled && (force || nextAt(a) <= clock.now())).map(a => a.username);
    if (!names.length) {schedule();return Promise.resolve(snapshot());}
    clock.clearTimeout(timer);timer = null;const batch = epoch;
    flight = Promise.resolve().then(async () => {
      for (const username of names) {
        if (closed || epoch !== batch) break;
        let a = state.accounts.find(item => item.username === username);
        if (!a?.enabled) continue;
        const attempted = structuredClone(state);attempted.accounts.find(item => item.username === username).attemptedAt = clock.now();
        try {commit(attempted);} catch {break;}
        controller = new AbortController();activeUsername = username;
        try {
          const result = await readPosts(username, {signal:controller.signal});
          if (closed || epoch !== batch) break;
          if (!Array.isArray(result) || result.length > LIMIT) throw Error('invalid response');
          const incoming = result.map(item => projectPost(item, username, clock.now()));
          const next = structuredClone(state);a = next.accounts.find(item => item.username === username);
          const unread = new Set(a.unreadIds);
          // 首次成功只建立基线；后续按单调增长的帖子 ID 去重，清缓存也保留这个游标。
          if (a.initialized) for (const post of incoming) if (a.latestId === null || compareIds(post.id,a.latestId) > 0) unread.add(post.id);
          for (const post of incoming) if (a.latestId === null || compareIds(post.id,a.latestId) > 0) a.latestId = post.id;
          a.unreadIds = [...unread].sort((a,b) => compareIds(b,a)).slice(0,LIMIT);
          a.posts = [...new Map([...a.posts,...incoming].map(p => [p.id,p])).values()].sort((a,b) => compareIds(b.id,a.id)).slice(0,LIMIT);
          a.initialized = true;a.checkedAt = clock.now();a.error = '';commit(next);
        } catch (error) {
          if (closed || epoch !== batch) break;
          const next = structuredClone(state);a = next.accounts.find(item => item.username === username);
          a.error = error.code === 'X_PUBLIC_UNAVAILABLE' ? '公开页面暂未提供可读取的动态，可能需要登录；请打开主页确认。' : '动态读取失败，已保留上次内容，将在一小时后重试。';
          try {commit(next);} catch {break;}
        } finally {controller = null;activeUsername = null;}
      }
    }).finally(() => {flight = null;schedule();onChange();}).then(snapshot);
    onChange();return flight;
  }
  function account(next, value) {
    const name = xUsername(value), found = next.accounts.find(a => a.username === name);
    if (!found) throw Error('订阅账号不存在。');return found;
  }
  function add(value) {
    const username = xUsername(value);
    return mutate(next => {
      if (next.accounts.some(a => a.username === username)) throw Error('这个账号已在订阅列表中。');
      if (next.accounts.length >= ACCOUNT_LIMIT) throw Error(`最多订阅 ${ACCOUNT_LIMIT} 个账号。`);
      next.accounts.push({username, enabled:true, initialized:false, latestId:null, unreadIds:[], posts:[], checkedAt:null, attemptedAt:null, error:''});
    });
  }
  function setEnabled(value) {
    if (typeof value?.enabled !== 'boolean') throw Error('无效的订阅开关。');
    const username = xUsername(value.username);
    // 只中止当前被暂停的账号；操作队列中其他账号时，正在读取的账号继续完成。
    return mutate(next => {account(next,username).enabled = value.enabled;},!value.enabled && activeUsername === username);
  }
  function remove(value) {
    const username = xUsername(value);
    return mutate(next => {const a = account(next,username);next.accounts = next.accounts.filter(item => item !== a);},activeUsername === username);
  }
  function clearCache() {return mutate(next => {for (const a of next.accounts) a.posts = [];},true);}
  function markRead(value) {
    return mutate(next => {
      if (value === null) {for (const a of next.accounts) a.unreadIds = [];return;}
      const a = account(next,value?.username);
      if (!validPostId(value?.id) || !a.posts.some(p => p.id === value.id)) throw Error('动态不存在。');
      a.unreadIds = a.unreadIds.filter(id => id !== value.id);
    });
  }
  function postUrl(value) {
    const a = account(state,value?.username), post = a.posts.find(p => p.id === value?.id);
    if (!post) throw Error('动态不存在。');return `https://x.com/${a.username}/status/${post.id}`;
  }
  return {snapshot, summary, add, setEnabled, remove, clearCache, markRead, refresh, postUrl,
    start() {if (closed || started) return;started = true;void refresh(false);},
    checkDue:() => refresh(false),
    close() {closed = true;invalidate();}};
}
module.exports = {createMessageSubscriptions, INTERVAL};
