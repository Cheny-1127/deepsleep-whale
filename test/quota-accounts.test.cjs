'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {projectAccount, listAccountQuotas, createQuotaPanel} = require('../src/channels/quota-accounts.cjs');

test('account quota is the remaining percent and drops credentials', () => {
  const account = projectAccount({id: 5, name: 'yuchaoyuan-codex', platform: 'openai', codex_5h_used_percent: 0, codex_7d_used_percent: 4, credentials: {access_token: 'secret'}});
  assert.deepEqual(account, {id: 5, name: 'yuchaoyuan-codex', fiveHourRemaining: 100, sevenDayRemaining: 96, fiveHourResetAt: null, sevenDayResetAt: null, fiveHourWindowMinutes: null, sevenDayWindowMinutes: null, resetCardCount: null, subscriptionType: null, platform: 'openai', authType: null, subscriptionExpiresAt: null});
  assert.equal(projectAccount({id: 6, name: 'zzz-codex', extra: {codex_5h_used_percent: 85, codex_7d_used_percent: 120}}).fiveHourRemaining, 15);
  assert.equal(projectAccount({id: 6, name: 'zzz-codex', extra: {codex_5h_used_percent: 85, codex_7d_used_percent: 120}}).sevenDayRemaining, 0);
  assert.equal(projectAccount({id: 1, name: 'no-quota'}), null);
});

test('platform details expose only type and a valid subscription expiry', () => {
  const account = projectAccount({id: 5, platform: 'openai', type: 'oauth', codex_5h_used_percent: 20, credentials: {subscription_expires_at: '2026-11-19T15:07:00+00:00', refresh_token: 'private-token'}});
  assert.equal(account.platform, 'openai');assert.equal(account.authType, 'oauth');
  assert.equal(account.subscriptionExpiresAt, '2026-11-19T15:07:00+00:00');
  assert.ok(!JSON.stringify(account).includes('private-token'));
  const missing = projectAccount({id: 5, platform: 42, type: {}, codex_5h_used_percent: 20, credentials: {subscription_expires_at: 'not-a-date'}});
  assert.equal(missing.platform, null);assert.equal(missing.authType, null);assert.equal(missing.subscriptionExpiresAt, null);
});

test('quota reset timestamps use verified API fields and ignore invalid values', () => {
  const at = '2026-10-27T14:32:55+08:00';
  const account = projectAccount({id: 5, codex_7d_used_percent: 20, codex_5h_reset_at: at,
    extra: {codex_7d_reset_at: at, codex_7d_reset_after_seconds: 604489}});
  assert.equal(account.fiveHourResetAt, at);assert.equal(account.sevenDayResetAt, at);
  const invalid = projectAccount({id: 5, codex_7d_used_percent: 20, extra: {codex_5h_reset_at: 1000, codex_7d_reset_at: 'broken'}});
  assert.equal(invalid.fiveHourResetAt, null);assert.equal(invalid.sevenDayResetAt, null);
});

test('window length distinguishes an unsupported zero window from missing or invalid metadata', () => {
  const account = extra => projectAccount({id: 5, codex_5h_used_percent: 0, extra});
  assert.equal(account({codex_5h_window_minutes: 0}).fiveHourWindowMinutes, 0);
  assert.equal(account({codex_7d_window_minutes: 10080}).sevenDayWindowMinutes, 10080);
  for (const value of [undefined, null, -1, '0', Infinity]) assert.equal(account({codex_5h_window_minutes: value}).fiveHourWindowMinutes, null);
});

test('subscription labels follow the platform plan type without exposing credentials', () => {
  const account = plan_type => projectAccount({id: 5, codex_5h_used_percent: 20, credentials: {plan_type, access_token: 'private-token'}});
  assert.equal(account('prolite').subscriptionType, 'Pro 100');
  assert.equal(account('pro').subscriptionType, 'Pro 200');
  assert.equal(account(' ChatGPT_Pro ').subscriptionType, 'Pro 200');
  assert.equal(account('promax').subscriptionType, 'Pro 500');
  assert.equal(account('future-plan').subscriptionType, 'future-plan');
  for (const value of [undefined, null, '', '  ', 200, {}]) assert.equal(account(value).subscriptionType, null);
  assert.ok(!JSON.stringify(account('pro')).includes('private-token'));
});

test('reset cards distinguish zero, available cards and missing or invalid snapshots', () => {
  const account = count => projectAccount({id: 5, codex_5h_used_percent: 20, extra: {codex_reset_credit_snapshot: {available_count: count, credits: [{expires_at: 'private-details'}]}}});
  assert.equal(account(0).resetCardCount, 0);
  assert.equal(account(2).resetCardCount, 2);
  for (const value of [undefined, null, -1, 1.5, '2', Infinity]) assert.equal(account(value).resetCardCount, null);
  assert.ok(!JSON.stringify(account(2)).includes('private-details'));
});

test('list reads account quotas and never returns the token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'secret-token\n');
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({url, key: options.headers['x-api-key']});
    const page = Number(new URL(url).searchParams.get('page'));
    const body = page === 1
      ? {data: {items: [{id: 5, name: 'yuchaoyuan-codex', codex_5h_used_percent: 0, codex_7d_used_percent: 4, credentials: {plan_type: 'prolite', access_token: 'private-token'}}, {id: 9, name: 'empty'}], pages: 2}}
      : {data: {items: [{id: 6, name: 'zzz-codex', codex_5h_used_percent: 0, codex_7d_used_percent: 85, credentials: {plan_type: 'pro'}}], pages: 2}};
    return {ok: true, status: 200, json: async () => body};
  };
  const accounts = await listAccountQuotas({tokenFile, baseUrl: 'https://gateway.test', fetchImpl});
  assert.deepEqual(accounts.map(account => account.name), ['yuchaoyuan-codex', 'zzz-codex']);
  assert.equal(accounts[1].sevenDayRemaining, 15);
  assert.deepEqual(accounts.map(account => account.subscriptionType), ['Pro 100', 'Pro 200']);
  assert.equal(seen[0].url.includes('/api/v1/admin/accounts'), true);
  assert.equal(JSON.stringify(accounts).includes('secret-token'), false);
  assert.equal(JSON.stringify(accounts).includes('private-token'), false);
  const panel = createQuotaPanel({tokenFile, baseUrl: 'https://gateway.test', fetchImpl});
  t.after(() => panel.close());
  const snapshot = await panel.refresh();
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(JSON.stringify(snapshot).includes('secret-token'), false);
});

test('missing or rejected token stays in the error', async t => {
  const missingPanel = createQuotaPanel({tokenFile: path.join(os.tmpdir(), 'missing-whale-token'), fetchImpl: async () => { throw new Error('should not fetch'); }});
  t.after(() => missingPanel.close());
  const missing = await missingPanel.refresh();
  assert.equal(missing.error, '尚未配置 token 文件');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'bad');
  const rejectedPanel = createQuotaPanel({tokenFile, fetchImpl: async () => ({ok: false, status: 401, json: async () => ({})})});
  t.after(() => rejectedPanel.close());
  const rejected = await rejectedPanel.refresh();
  assert.equal(rejected.error, 'token 无效，无法读取账号额度');
});

function pollingFixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-quota-poll-')),tokenFile=path.join(dir,'token');
  fs.writeFileSync(tokenFile,'fixture-token');
  let now=1000,request=async url=>({ok:true,json:async()=>new URL(url).pathname.endsWith('/5')?{id:5,name:'账号',codex_5h_used_percent:20}:{items:[{id:5,name:'账号',codex_5h_used_percent:20}],pages:1}});
  const jobs=new Set(),calls=[];
  const clock={now:()=>now,setTimeout:(fn,ms)=>{const job={fn,ms};jobs.add(job);return job;},clearTimeout:job=>jobs.delete(job)};
  const panel=createQuotaPanel({tokenFile,clock,fetchImpl:(url,options)=>{calls.push(options);return request(url,options);}});
  t.after(()=>{panel.close?.();fs.rmSync(dir,{recursive:true,force:true});});
  return {panel,jobs,calls,setNow:value=>now=value,setRequest:fn=>request=fn,
    async fire(ms){const job=[...jobs].find(job=>job.ms===ms);assert.ok(job,`missing ${ms}ms timer`);jobs.delete(job);now+=ms;job.fn();await new Promise(setImmediate);}};
}

test('quota only starts polling after first refresh and schedules five minutes after completion',async t=>{
  const f=pollingFixture(t);assert.equal(f.jobs.size,0);assert.equal(f.calls.length,0);
  f.panel.snapshot();assert.equal(f.calls.length,0);
  await f.panel.refresh();assert.equal(f.panel.snapshot().nextRefreshAt,301000);
  assert.equal([...f.jobs][0].ms,300000);await f.fire(300000);
  assert.equal(f.calls.length,2);assert.equal(f.panel.snapshot().checkedAt,301000);
  assert.equal(f.panel.snapshot().nextRefreshAt,601000);
});

test('manual refresh resets the schedule and overlaps share one request',async t=>{
  const f=pollingFixture(t);await f.panel.refresh();f.setNow(120000);
  let done;f.setRequest(()=>new Promise(resolve=>done=resolve));
  const first=f.panel.refresh(),second=f.panel.refresh();await new Promise(setImmediate);
  assert.equal(f.calls.length,2);assert.equal([...f.jobs].filter(job=>job.ms===300000).length,0);
  f.setNow(123000);done({ok:true,json:async()=>({items:[],pages:1})});await Promise.all([first,second]);
  assert.equal(f.panel.snapshot().nextRefreshAt,423000);
  assert.equal([...f.jobs].filter(job=>job.ms===300000).length,1);
});

test('failed refresh keeps last data and success time and retries only after another five minutes',async t=>{
  const f=pollingFixture(t);await f.panel.refresh();const before=f.panel.snapshot();
  f.setRequest(async()=>{throw Error('fixture-token private diagnostics');});await f.fire(300000);
  const after=f.panel.snapshot();assert.deepEqual(after.accounts,before.accounts);assert.equal(after.checkedAt,before.checkedAt);
  assert.ok(after.error);assert.ok(!after.error.includes('fixture-token'));assert.equal(after.nextRefreshAt,601000);
});

test('quota timeout aborts the request, records an error and keeps the recurring timer',async t=>{
  const f=pollingFixture(t);f.setRequest((_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')))));
  const task=f.panel.refresh();await new Promise(setImmediate);await f.fire(60000);await task;
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.panel.snapshot().busy,false);
  assert.match(f.panel.snapshot().error,/超时/);assert.equal(f.panel.snapshot().nextRefreshAt,361000);
});

test('quitting cancels the pending request and timer and ignores late responses',async t=>{
  const f=pollingFixture(t);let done;f.setRequest(()=>new Promise(resolve=>done=resolve));
  const task=f.panel.refresh();await new Promise(setImmediate);f.panel.close();
  assert.equal(f.calls[0].signal.aborted,true);done({ok:true,json:async()=>({items:[{id:5,codex_5h_used_percent:0}],pages:1})});await task;
  assert.equal(f.panel.snapshot().checkedAt,null);assert.equal(f.jobs.size,0);
  await f.panel.refresh();assert.equal(f.calls.length,1);
});


test('failure timestamp and message survive a retry and only successful sync clears them', async t => {
  const f = pollingFixture(t);
  await f.panel.refresh();
  f.setNow(2000);
  f.setRequest(async () => { throw new Error('offline'); });
  await f.panel.refresh();
  const failed = f.panel.snapshot();
  assert.equal(failed.failedAt, 2000);
  assert.equal(failed.checkedAt, 1000);
  let done;
  f.setRequest(() => new Promise(resolve => { done = resolve; }));
  const task = f.panel.refresh();
  await new Promise(setImmediate);
  assert.equal(f.panel.snapshot().busy, true);
  assert.equal(f.panel.snapshot().failedAt, failed.failedAt);
  assert.equal(f.panel.snapshot().error, failed.error);
  f.setNow(3000);
  done({ok: true, json: async () => ({id: 5, codex_5h_used_percent: 10})});
  await task;
  assert.equal(f.panel.snapshot().failedAt, null);
  assert.equal(f.panel.snapshot().error, '');
  assert.equal(f.panel.snapshot().checkedAt, 3000);
});


test('consecutive failures keep the first failure time until recovery starts a new failure period', async t => {
  const f = pollingFixture(t);
  f.setNow(0);
  f.setRequest(async () => { throw new Error('offline'); });
  await f.panel.refresh();
  assert.equal(f.panel.snapshot().failedAt, 0);
  await f.fire(300000);
  assert.equal(f.panel.snapshot().failedAt, 0);
  assert.equal(f.panel.snapshot().nextRefreshAt, 600000);
  f.setRequest(async () => ({ok: true, json: async () => ({items: [], pages: 1})}));
  await f.fire(300000);
  assert.equal(f.panel.snapshot().failedAt, null);
  f.setRequest(async () => { throw new Error('offline again'); });
  await f.fire(300000);
  assert.equal(f.panel.snapshot().failedAt, 900000);
});

function selectedAccountsFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-selected-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'fixture-token');
  const calls = [];
  let failId = null, invalidId = null;
  const fetchImpl = async url => {
    const endpoint = new URL(url).pathname;
    calls.push(endpoint);
    const id = Number(endpoint.split('/').at(-1));
    if (id === failId) throw Error('private diagnostics');
    const item = id => ({id, name: `账号 ${id}`, codex_5h_used_percent: calls.length, extra: {codex_7d_used_percent: 20}});
    return {ok: true, json: async () => ({data: Number.isSafeInteger(id) && id > 0 ? item(id === invalidId ? 999 : id) : {items: [item(5), item(6)], pages: 1}})};
  };
  const create = () => createQuotaPanel({tokenFile, dataDir: dir, fetchImpl});
  const panel = create();
  t.after(() => {panel.close(); fs.rmSync(dir, {recursive: true, force: true});});
  return {panel, calls, dir, create, fail: id => {failId = id;}, invalid: id => {invalidId = id;}};
}

test('refresh choices persist and subsequent refreshes only request enabled account details', async t => {
  const f = selectedAccountsFixture(t);
  await f.panel.refresh();
  assert.deepEqual(f.calls, ['/api/v1/admin/accounts']);
  const original = f.panel.snapshot().accounts[0];
  f.panel.setRefreshEnabled({id: 5, enabled: false});
  await f.panel.refresh();
  assert.deepEqual(f.calls, ['/api/v1/admin/accounts', '/api/v1/admin/accounts/6']);
  assert.deepEqual(f.panel.snapshot().accounts[0], {...original, refreshEnabled: false});
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'quota-refresh.json'), 'utf8'));
  assert.deepEqual(saved, {disabledAccountIds: [5]});
  const restarted = f.create();t.after(() => restarted.close());
  await restarted.refresh();
  assert.equal(restarted.snapshot().accounts[0].refreshEnabled, false);
  await restarted.refresh();
  assert.equal(f.calls.at(-1), '/api/v1/admin/accounts/6');
  restarted.setRefreshEnabled({id: 5, enabled: true});
  await restarted.refresh();
  assert.deepEqual(f.calls.slice(-2), ['/api/v1/admin/accounts/5', '/api/v1/admin/accounts/6']);
});

test('all paused accounts issue no requests and keep the last successful timestamp', async t => {
  const f = selectedAccountsFixture(t);await f.panel.refresh();
  const before = f.panel.snapshot();
  f.panel.setRefreshEnabled({id: 5, enabled: false});f.panel.setRefreshEnabled({id: 6, enabled: false});
  assert.equal(f.panel.snapshot().nextRefreshAt, null);
  await f.panel.refresh();assert.equal(f.calls.length, 1);
  assert.equal(f.panel.snapshot().checkedAt, before.checkedAt);
  f.panel.setRefreshEnabled({id: 6, enabled: true});
  assert.ok(f.panel.snapshot().nextRefreshAt != null);
});

test('partial failure retains the failed account and still refreshes other enabled accounts', async t => {
  const f = selectedAccountsFixture(t);await f.panel.refresh();
  const before = f.panel.snapshot();f.fail(5);
  await f.panel.refresh();const failed = f.panel.snapshot();
  assert.deepEqual(failed.accounts[0], before.accounts[0]);
  assert.notDeepEqual(failed.accounts[1], before.accounts[1]);
  assert.equal(failed.checkedAt, before.checkedAt);assert.ok(failed.error);assert.ok(!failed.error.includes('private'));
  await f.panel.refresh();assert.equal(f.panel.snapshot().failedAt, failed.failedAt);
  f.fail(null);await f.panel.refresh();assert.equal(f.panel.snapshot().error, '');
  f.invalid(5);const previous = f.panel.snapshot().accounts[0];await f.panel.refresh();
  assert.deepEqual(f.panel.snapshot().accounts[0], previous);assert.ok(f.panel.snapshot().error);
});

test('invalid choices and failed saves cannot change the running refresh configuration', async t => {
  const f = selectedAccountsFixture(t);await f.panel.refresh();
  for (const value of [{id: '../5', enabled: false}, {id: 5, enabled: 'false'}, {id: 99, enabled: false}, null]) assert.throws(() => f.panel.setRefreshEnabled(value));
  fs.mkdirSync(path.join(f.dir, 'quota-refresh.json.tmp'));
  assert.throws(() => f.panel.setRefreshEnabled({id: 5, enabled: false}), /保存/);
  assert.equal(f.panel.snapshot().accounts[0].refreshEnabled, true);
});

test('single account refresh requests only that account and preserves other data and the full refresh schedule', async t => {
  const f = selectedAccountsFixture(t);await f.panel.refresh();
  const before = f.panel.snapshot();
  await f.panel.refreshAccount(6);
  assert.deepEqual(f.calls.slice(1), ['/api/v1/admin/accounts/6']);
  const after = f.panel.snapshot();
  assert.deepEqual(after.accounts[0], before.accounts[0]);
  assert.notDeepEqual(after.accounts[1], before.accounts[1]);
  for (const key of ['checkedAt','attemptedAt','nextRefreshAt']) assert.equal(after[key], before[key]);
  const restarted = f.create();t.after(() => restarted.close());
  assert.deepEqual(restarted.snapshot().accounts, after.accounts);
  f.panel.setRefreshEnabled({id:6,enabled:false});
  await assert.rejects(f.panel.refreshAccount(6), /暂停/);
  for (const id of [null, '../5', 99]) await assert.rejects(f.panel.refreshAccount(id), /账号/);
  assert.equal(f.calls.length,2);
});

test('single account errors stay with that account and recovery clears only its error', async t => {
  const f = selectedAccountsFixture(t);await f.panel.refresh();
  const before = f.panel.snapshot();f.fail(6);
  await f.panel.refreshAccount(6);
  let after = f.panel.snapshot();
  assert.deepEqual(after.accounts,before.accounts);assert.equal(after.error,before.error);
  assert.ok(after.accountRefreshErrors[6]);assert.equal(after.accountRefreshErrors[5],undefined);
  assert.ok(!after.accountRefreshErrors[6].includes('private'));
  f.fail(null);await f.panel.refreshAccount(6);
  assert.equal(f.panel.snapshot().accountRefreshErrors[6],'');
});

test('single account refresh merges duplicates, queues other scopes, and exposes only the active account as busy', async t => {
  const f = pollingFixture(t);await f.panel.refresh();
  let done;f.setRequest(()=>new Promise(resolve=>{done=resolve;}));
  const a=f.panel.refreshAccount(5),b=f.panel.refreshAccount(5);await new Promise(setImmediate);
  assert.equal(f.calls.length,2);assert.deepEqual(f.panel.snapshot().refreshingAccountIds,[5]);
  const all=f.panel.refresh();
  done({ok:true,json:async()=>({id:5,codex_5h_used_percent:10})});await Promise.all([a,b]);
  await new Promise(setImmediate);assert.equal(f.calls.length,3);
  done({ok:true,json:async()=>({id:5,codex_5h_used_percent:15})});await all;
  assert.deepEqual(f.panel.snapshot().refreshingAccountIds,[]);
});

test('single account refresh cancels on timeout or close and ignores late responses', async t => {
  const f = pollingFixture(t);await f.panel.refresh();
  const before=f.panel.snapshot();
  f.setRequest((_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')))));
  const timeout=f.panel.refreshAccount(5);await new Promise(setImmediate);await f.fire(60000);await timeout;
  assert.match(f.panel.snapshot().accountRefreshErrors[5],/超时/);
  assert.deepEqual(f.panel.snapshot().accounts,before.accounts);
  let done;f.setRequest(()=>new Promise(resolve=>{done=resolve;}));
  const task=f.panel.refreshAccount(5);await new Promise(setImmediate);f.panel.close();
  done({ok:true,json:async()=>({id:5,codex_5h_used_percent:0})});await task;
  assert.deepEqual(f.panel.snapshot().accounts,before.accounts);assert.equal(f.jobs.size,0);
});
