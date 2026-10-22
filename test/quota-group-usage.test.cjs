'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createGroupUsage, shanghaiDate, rankingRange, projectUser} = require('../src/channels/quota-group-usage.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-group-')), tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'fixture-secret');
  let now = Date.parse('2026-10-20T12:00:00+08:00');
  const calls = [], groupCalls = [], jobs = new Set(), panels = [];
  let groupRequest = async () => ({ok: true, json: async () => ({data: [{id: 13, name: 'group thirteen', secret: 'private-group-details'}, {id: 14, name: 'group fourteen'}]})});
  let request = async url => ({ok: true, json: async () => ({code: 0, data: {users: [
    {user_id: 4, email: 'one@example.test', actual_cost: 2, requests: 0, total_tokens: 1000},
    {user_id: 8, email: `group-${new URL(url).searchParams.get('group_id')}@example.test`, actual_cost: 20, cache_tokens: 70000000, extra_secret: 'do-not-cache'}]}})});
  const clock = {now: () => now, setTimeout(fn, ms) {const job = {fn, ms};jobs.add(job);return job;}, clearTimeout: job => jobs.delete(job)};
  const create = () => {const panel = createGroupUsage({dataDir: dir, tokenFile, baseUrl: 'https://gateway.test', clock,
    fetchImpl: (url, options) => {
      if (new URL(url).pathname.endsWith('/groups/all')) {groupCalls.push({url, options});return groupRequest(url, options);}
      calls.push({url, options});return request(url, options);
    }});panels.push(panel);return panel;};
  const panel = create();
  t.after(() => {panels.forEach(item => item.close());fs.rmSync(dir, {recursive: true, force: true});});
  return {panel, create, calls, groupCalls, jobs, dir, tokenFile, setNow: value => {now = value;}, setRequest: value => {request = value;}, setGroupRequest: value => {groupRequest = value;},
    async fire(ms) {const job = [...jobs].find(item => item.ms === ms);assert.ok(job, `missing timer ${ms}`);jobs.delete(job);now += ms;job.fn();await new Promise(setImmediate);}};
}

test('today follows Shanghai midnight, independently of the machine timezone', () => {
  assert.equal(shanghaiDate(Date.parse('2026-10-20T15:59:59Z')), '2026-10-20');
  assert.equal(shanghaiDate(Date.parse('2026-10-20T16:00:00Z')), '2026-10-21');
});

test('weekly ranking starts on Monday across Sunday, Monday, and year boundaries', () => {
  for (const [at, start] of [['2026-10-20', '2026-10-19'], ['2026-10-25', '2026-10-19'], ['2026-10-26', '2026-10-26'], ['2027-01-01', '2026-12-28']]) {
    assert.deepEqual(rankingRange(Date.parse(`${at}T12:00:00+08:00`), 'week'), {date: at, startDate: start});
  }
});

test('group names are allowlisted, cached, and retained if the group API later fails', async t => {
  const f = fixture(t);await f.panel.open();
  assert.deepEqual(f.panel.snapshot().groups, [{id: 13, name: 'group thirteen'}, {id: 14, name: 'group fourteen'}]);
  assert.equal(f.groupCalls.length, 1);assert.ok(!JSON.stringify(f.panel.snapshot()).includes('private-group-details'));
  f.panel.close();const restarted = f.create();await restarted.open();assert.equal(f.groupCalls.length, 1);
  f.setNow(Date.parse('2026-10-20T12:30:00+08:00'));
  f.setGroupRequest(async () => {throw Error('fixture-secret');});await restarted.refresh();
  assert.equal(restarted.snapshot().groups.length, 2);assert.ok(restarted.snapshot().groupsError);
  assert.equal(restarted.snapshot().error, '', '分组目录失败不阻止排行更新');
});

test('all groups omit group_id, while daily and weekly results stay isolated and selections persist', async t => {
  const f = fixture(t);await f.panel.open();const daily = f.panel.snapshot();
  await f.panel.select({groupId: 13, period: 'week'});
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get('start_date'), '2026-10-19');
  assert.equal(f.panel.snapshot().period, 'week');const count = f.calls.length;
  await f.panel.select({groupId: 13, period: 'day'});assert.equal(f.calls.length, count);assert.deepEqual(f.panel.snapshot().users, daily.users);
  await f.panel.select({groupId: null, period: 'week'});
  assert.equal(new URL(f.calls.at(-1).url).searchParams.has('group_id'), false);
  f.panel.close();const restarted = f.create();
  assert.equal(restarted.snapshot().groupId, null);assert.equal(restarted.snapshot().period, 'week');
  await restarted.open();assert.equal(f.calls.length, count + 1);
  for (const value of [{groupId: 0, period: 'day'}, {groupId: 13, period: 'month'}, {period: 'day'}, null]) assert.throws(() => restarted.select(value), /筛选/);
});

test('legacy daily cache migrates without refetching and uses the new thirty-minute interval', async t => {
  const f = fixture(t);await f.panel.open();f.panel.close();
  const file = path.join(f.dir, 'quota-group-usage.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.version = 1;delete saved.period;delete saved.groups;delete saved.groupsCheckedAt;
  for (const item of saved.entries) {delete item.period;delete item.startDate;}
  fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = f.create();assert.equal(restarted.snapshot().period, 'day');assert.equal(restarted.snapshot().users.length, 2);
  await restarted.open();assert.equal(f.calls.length, 1);
  assert.equal(f.groupCalls.length, 2, '旧排行仍新鲜时也要补取分组名称');
  assert.equal(restarted.snapshot().groups.find(group => group.id === 13)?.name, 'group thirteen');
  assert.equal(restarted.snapshot().nextRefreshAt, Date.parse('2026-10-20T12:30:00+08:00'));
  await restarted.refresh();assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('opening queries group 13 today, whitelists fields, and sorts by actual cost', async t => {
  const f = fixture(t);assert.equal(f.calls.length, 0);
  const data = await f.panel.open(), url = new URL(f.calls[0].url);
  assert.equal(url.pathname, '/api/v1/admin/dashboard/user-breakdown');
  assert.deepEqual(Object.fromEntries(url.searchParams), {group_id: '13', start_date: '2026-10-20', end_date: '2026-10-20', timezone: 'Asia/Shanghai', sort_by: 'actual_cost', limit: '20'});
  assert.equal(f.calls[0].options.headers['x-api-key'], 'fixture-secret');
  assert.deepEqual(data.users.map(user => user.user_id), [8, 4]);
  assert.equal(data.users[1].requests, 0);assert.equal(data.users[1].input_tokens, null);
  assert.ok(!JSON.stringify(data).includes('do-not-cache'));assert.ok(!JSON.stringify(data).includes('fixture-secret'));
  const file = fs.readFileSync(path.join(f.dir, 'quota-group-usage.json'), 'utf8');
  assert.ok(!file.includes('do-not-cache'));assert.ok(!file.includes('fixture-secret'));
  assert.equal(fs.statSync(path.join(f.dir, 'quota-group-usage.json')).mode & 0o777, 0o600);
});

test('oversized API results are sorted before limiting both the view and persisted cache to twenty users', async t => {
  const f = fixture(t), users = Array.from({length: 50}, (_, i) => ({user_id: i + 1, actual_cost: i}));
  f.setRequest(async () => ({ok: true, json: async () => ({data: {users}})}));
  const data = await f.panel.open(), expected = Array.from({length: 20}, (_, i) => 50 - i);
  assert.deepEqual(data.users.map(user => user.user_id), expected);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'quota-group-usage.json'), 'utf8'));
  assert.deepEqual(saved.entries[0].users.map(user => user.user_id), expected);
});

test('legacy fifty-user caches immediately display only twenty users without another request', async t => {
  const f = fixture(t);await f.panel.open();f.panel.close();
  const file = path.join(f.dir, 'quota-group-usage.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.entries[0].users = Array.from({length: 50}, (_, i) => ({user_id: i + 1, actual_cost: 50 - i}));
  fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = f.create(), expected = Array.from({length: 20}, (_, i) => i + 1);
  assert.deepEqual(restarted.snapshot().users.map(user => user.user_id), expected);
  await restarted.open();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(restarted.snapshot().users.map(user => user.user_id), expected);
});

test('missing group names retry on manual refresh without discarding fresh ranking data', async t => {
  const f = fixture(t);await f.panel.open();f.panel.close();
  const file = path.join(f.dir, 'quota-group-usage.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.groups;delete saved.groupsCheckedAt;fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = f.create(), before = restarted.snapshot();
  f.setGroupRequest(async () => {throw Error('fixture-secret');});
  await restarted.open();assert.equal(f.calls.length, 1);assert.equal(f.groupCalls.length, 2);
  assert.deepEqual(restarted.snapshot().users, before.users);assert.equal(restarted.snapshot().checkedAt, before.checkedAt);
  assert.ok(restarted.snapshot().groupsError);assert.equal(restarted.snapshot().error, '');
  await restarted.open();assert.equal(f.groupCalls.length, 2, '目录失败不因反复打开而密集重试');
  f.setGroupRequest(async () => ({ok: true, json: async () => ({data: [{id: 13, name: 'restored name'}]})}));
  await restarted.refresh();assert.equal(f.groupCalls.length, 3);
  assert.equal(restarted.snapshot().groups[0].name, 'restored name');assert.equal(restarted.snapshot().groupsError, '');
});

test('independent group name loading merges duplicate opens and stops cleanly on close', async t => {
  const f = fixture(t);await f.panel.open();f.panel.close();
  const file = path.join(f.dir, 'quota-group-usage.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.groups;delete saved.groupsCheckedAt;fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = f.create();let done, signal;
  f.setGroupRequest((_url, options) => {signal = options.signal;return new Promise(resolve => {done = resolve;});});
  const first = restarted.open(), second = restarted.open();assert.equal(first, second);
  await new Promise(setImmediate);assert.equal(f.groupCalls.length, 2);
  restarted.close();assert.equal(signal.aborted, true);assert.equal(f.jobs.size, 0);
  done({ok: true, json: async () => ({data: [{id: 13, name: 'late name'}]})});await first;
  assert.equal(restarted.snapshot().groups.length, 0);assert.equal(f.calls.length, 1);assert.equal(f.jobs.size, 0);
});

test('fresh data survives restart, expiry refreshes, and overlapping refreshes share one request', async t => {
  const f = fixture(t);await f.panel.open();f.panel.close();
  const restarted = f.create();assert.equal(restarted.snapshot().users.length, 2);
  await restarted.open();assert.equal(f.calls.length, 1);
  f.setNow(Date.parse('2026-10-20T12:29:59+08:00'));await restarted.open();assert.equal(f.calls.length, 1);
  f.setNow(Date.parse('2026-10-20T12:30:00+08:00'));
  let done;f.setRequest(() => new Promise(resolve => {done = resolve;}));
  const first = restarted.open(), second = restarted.refresh();await new Promise(setImmediate);
  assert.equal(first, second);assert.equal(f.calls.length, 2);
  assert.throws(() => restarted.refresh(14), /稍后切换/);
  done({ok: true, json: async () => ({data: {users: []}})});await first;
  assert.equal(restarted.snapshot().nextRefreshAt, Date.parse('2026-10-20T13:00:00+08:00'));
});

test('failures keep this group data and the first failure time, then successful sync clears them', async t => {
  const f = fixture(t);await f.panel.open();const before = f.panel.snapshot();
  f.setNow(Date.parse('2026-10-20T12:01:00+08:00'));
  f.setRequest(async () => {throw Error('fixture-secret private network detail');});
  const failed = await f.panel.refresh();
  assert.deepEqual(failed.users, before.users);assert.equal(failed.checkedAt, before.checkedAt);
  assert.ok(failed.failedAt);assert.ok(!failed.error.includes('fixture-secret'));
  await f.fire(1800000);assert.equal(f.panel.snapshot().failedAt, failed.failedAt);
  f.panel.close();const restarted = f.create();assert.equal(restarted.snapshot().failedAt, failed.failedAt);
  assert.deepEqual(restarted.snapshot().users, before.users);
  f.setRequest(async () => ({ok: true, json: async () => ({data: {users: []}})}));
  const recovered = await restarted.refresh();assert.equal(recovered.error, '');assert.equal(recovered.failedAt, null);
});

test('switching groups and crossing midnight never reuses another group or day', async t => {
  const f = fixture(t);await f.panel.open();const original = f.panel.snapshot();
  await f.panel.refresh(14);assert.equal(f.panel.snapshot().groupId, 14);
  f.setRequest(async () => {throw Error('offline');});
  const group15 = await f.panel.refresh(15);assert.equal(group15.users.length, 0);assert.equal(group15.checkedAt, null);
  const group13 = await f.panel.refresh(13);assert.deepEqual(group13.users, original.users);
  f.setNow(Date.parse('2026-10-21T00:00:00+08:00'));
  assert.equal(f.panel.snapshot().date, '2026-10-21');assert.equal(f.panel.snapshot().users.length, 0);
  await f.panel.open();assert.equal(new URL(f.calls.at(-1).url).searchParams.get('start_date'), '2026-10-21');
  assert.equal(f.panel.snapshot().checkedAt, null);
});

test('invalid input, malformed responses, and API failures cannot replace good cached data', async t => {
  const f = fixture(t);await f.panel.open();const before = f.panel.snapshot().users;
  for (const id of [0, -1, 1.5, '13', '../13', NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.panel.refresh(id), /组 ID/);
  for (const body of [{data: {}}, {code: 1, data: {users: []}}, {data: {users: [{user_id: -1}]}}]) {
    f.setRequest(async () => ({ok: true, json: async () => body}));await f.panel.refresh();
    assert.deepEqual(f.panel.snapshot().users, before);assert.ok(f.panel.snapshot().error);
  }
  f.setRequest(async () => ({ok: false, status: 401}));await f.panel.refresh();assert.match(f.panel.snapshot().error, /token 无效/);
  assert.equal(projectUser({user_id: 1, actual_cost: '20', total_tokens: -1}).actual_cost, null);
});

test('credential changes invalidate cached users and cache write failure preserves the last file', async t => {
  const f = fixture(t);await f.panel.open();const file = path.join(f.dir, 'quota-group-usage.json'), saved = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(file + '.tmp');await f.panel.refresh();
  assert.match(f.panel.snapshot().cacheError, /保存失败/);assert.equal(fs.readFileSync(file, 'utf8'), saved);
  fs.writeFileSync(f.tokenFile, 'different-key');const restarted = f.create();assert.equal(restarted.snapshot().users.length, 0);
});

test('timeout aborts the request and close clears timers and ignores late responses', async t => {
  const f = fixture(t);
  f.setRequest((_url, {signal}) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))));
  const first = f.panel.open();await new Promise(setImmediate);await f.fire(60000);await first;
  assert.match(f.panel.snapshot().error, /超时/);assert.equal(f.panel.snapshot().busy, false);
  let done;f.setRequest(() => new Promise(resolve => {done = resolve;}));
  const second = f.panel.refresh();await new Promise(setImmediate);f.panel.close();assert.equal(f.jobs.size, 0);
  done({ok: true, json: async () => ({data: {users: []}})});await second;
  assert.equal(f.panel.snapshot().checkedAt, null);assert.equal(f.jobs.size, 0);
});

test('pet today ranking follows the queried group without changing the weekly strategy or fetching fresh daily data twice', async t => {
  const f = fixture(t);await f.panel.open();await f.panel.select({groupId:13, period:'week'});
  const weekly = f.panel.snapshot(), count = f.calls.length;
  await f.panel.openDaily();assert.equal(f.calls.length, count);
  assert.equal(f.panel.dailySnapshot().period, 'day');assert.equal(f.panel.snapshot().period, 'week');
  assert.equal(f.panel.snapshot().nextRefreshAt, weekly.nextRefreshAt);
  await f.panel.select({groupId:14, period:'week'});
  assert.equal(f.panel.dailySnapshot().users.length, 0, '切组后不能展示上一组的今日用户');
  await Promise.all([f.panel.openDaily(), f.panel.openDaily()]);
  assert.equal(f.calls.length, count + 2, '一笔周查询和一笔合并的今日查询');
  const query = new URL(f.calls.at(-1).url).searchParams;
  assert.equal(query.get('group_id'), '14');assert.equal(query.get('start_date'), query.get('end_date'));
  assert.equal(f.panel.snapshot().period, 'week');assert.equal(f.panel.snapshot().groupId, 14);
  f.panel.close();const restarted = f.create();await restarted.openDaily();assert.equal(f.calls.length, count + 2);
  assert.equal(restarted.snapshot().period, 'week');assert.equal(restarted.dailySnapshot().users.length, 2);
});

test('daily failures preserve daily data independently of weekly results and crossing midnight removes yesterday users', async t => {
  const f = fixture(t);await f.panel.openDaily();await f.panel.select({groupId:13, period:'week'});
  const weekly = f.panel.snapshot(), daily = f.panel.dailySnapshot();
  f.setNow(Date.parse('2026-10-20T12:31:00+08:00'));
  f.setRequest(async () => {throw Error('offline');});await f.panel.openDaily();
  assert.deepEqual(f.panel.dailySnapshot().users, daily.users);assert.equal(f.panel.dailySnapshot().checkedAt, daily.checkedAt);
  assert.ok(f.panel.dailySnapshot().error);assert.equal(f.panel.snapshot().error, weekly.error);
  f.setNow(Date.parse('2026-10-21T00:00:00+08:00'));assert.equal(f.panel.dailySnapshot().users.length, 0);
  await f.panel.openDaily();assert.equal(f.panel.dailySnapshot().checkedAt, null);
});
test('manual daily refresh bypasses fresh cache, merges overlaps and preserves weekly strategy and schedule', async t => {
  const f = fixture(t);await f.panel.openDaily();await f.panel.select({groupId:14, period:'week'});await f.panel.openDaily();
  const weekly = f.panel.snapshot(), count = f.calls.length;
  let done;f.setRequest(() => new Promise(resolve => {done = resolve;}));
  const first = f.panel.refreshDaily(), second = f.panel.refreshDaily();await new Promise(setImmediate);
  assert.equal(f.calls.length, count + 1);
  const query = new URL(f.calls.at(-1).url).searchParams;
  assert.equal(query.get('group_id'), '14');assert.equal(query.get('start_date'), query.get('end_date'));
  done({ok:true,json:async()=>({data:{users:[]}})});await Promise.all([first, second]);
  assert.equal(f.panel.dailySnapshot().users.length, 0);
  assert.equal(f.panel.snapshot().period, 'week');assert.equal(f.panel.snapshot().groupId, 14);
  assert.equal(f.panel.snapshot().nextRefreshAt, weekly.nextRefreshAt);
  assert.deepEqual(f.panel.snapshot().users, weekly.users);
});
