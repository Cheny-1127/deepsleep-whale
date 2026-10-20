'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createPetQuotaSettings} = require('../src/app/pet-quota-settings.cjs');
const {createPetQuota} = require('../src/channels/pet-quota.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pet-quota-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return {dir, settings:createPetQuotaSettings({dataDir:dir})};
}
test('tracking, independent collapsed sections and thresholds survive restart and failed saves', t => {
  const f = fixture(t);
  f.settings.update({accountId:5, yellowBelow:40, redBelow:15, accountsExpanded:false});
  f.settings.update({configExpanded:false});
  const restored = createPetQuotaSettings({dataDir:f.dir});
  assert.deepEqual(restored.snapshot(), {accountId:5, yellowBelow:40, redBelow:15, accountsExpanded:false, configExpanded:false});
  restored.update({accountsExpanded:true});assert.equal(restored.snapshot().configExpanded, false);
  fs.mkdirSync(path.join(f.dir, 'pet-quota-settings.json.tmp'));
  assert.throws(() => restored.update({accountId:6}), /保存失败/);
  assert.equal(restored.snapshot().accountId, 5);
  assert.equal(createPetQuotaSettings({dataDir:f.dir}).snapshot().accountId, 5);
});
test('invalid thresholds, account IDs and unknown settings cannot overwrite saved settings', t => {
  const f = fixture(t), before = f.settings.snapshot();
  for (const value of [null, [], {}, {accountId:'5'}, {accountId:-1}, {redBelow:30}, {yellowBelow:101},
    {yellowBelow:NaN}, {configExpanded:0}, {unknown:true}]) {
    assert.throws(() => f.settings.update(value));assert.deepEqual(f.settings.snapshot(), before);
  }
  f.settings.update({yellowBelow:80});f.settings.update({redBelow:50});assert.equal(f.settings.snapshot().redBelow, 50);
});
test('pet projects only one tracked account and at most five daily users, with exact threshold boundaries', t => {
  const f = fixture(t);f.settings.update({accountId:5});
  const account = {id:5, name:'test', sevenDayRemaining:30, sevenDayResetAt:'2026-10-21T00:00:00Z'};
  const accounts = {accounts:[account, {id:6, name:'other', sevenDayRemaining:99}], checkedAt:1, error:''};
  const daily = {groupId:13, groups:[{id:13, name:'selected group'}], date:'2026-10-20', checkedAt:2, error:'',
    users:Array.from({length:7}, (_, i) => ({user_id:i+1, email:`user-${i}`, actual_cost:7-i, secret:'never-forward'}))};
  const service = createPetQuota({settings:f.settings, quota:{snapshot:()=>accounts}, groups:{dailySnapshot:()=>daily}});
  assert.equal(service.snapshot().ranking.users.length, 5);assert.equal(service.snapshot().ranking.groupName, 'selected group');
  assert.ok(!JSON.stringify(service.snapshot()).includes('never-forward'));assert.ok(!JSON.stringify(service.snapshot()).includes('other'));
  for (const [remaining, tone] of [[30,'green'], [29,'yellow'], [10,'yellow'], [9,'red'], [0,'red']]) {
    account.sevenDayRemaining = remaining;assert.equal(service.snapshot().tracking.tone, tone);
  }
  daily.users = daily.users.slice(0, 2);assert.equal(service.snapshot().ranking.users.length, 2);
  account.sevenDayWindowMinutes = 0;assert.equal(service.snapshot().tracking.remaining, null);
  assert.equal(service.snapshot().tracking.tone, 'unknown');
  accounts.accounts = [];assert.equal(service.snapshot().tracking.accountId, 5);assert.equal(service.snapshot().tracking.remaining, null);
});
test('pet reads reuse fresh caches, respect paused accounts and retry only when due', async t => {
  const f = fixture(t);let accountCalls = 0, dailyCalls = 0;
  const data = {accounts:[{id:5, refreshEnabled:true}], checkedAt:1000, attemptedAt:1000, busy:false, nextRefreshAt:301000};
  const service = createPetQuota({settings:f.settings, quota:{snapshot:()=>data, refresh:async()=>{accountCalls++;}},
    groups:{openDaily:async()=>{dailyCalls++;}}, clock:{now:()=>1000, setTimeout, clearTimeout}});
  await service.sync();assert.equal(accountCalls, 0);assert.equal(dailyCalls, 1);
  data.nextRefreshAt = 1000;await service.sync();assert.equal(accountCalls, 1);
  data.accounts[0].refreshEnabled = false;await service.sync();assert.equal(accountCalls, 1);
  service.close();await service.sync();assert.equal(dailyCalls, 3);
});
test('manual pet refresh reuses quota service and rejects missing or paused tracking', async t => {
  const f = fixture(t);let calls = 0;
  const data = {accounts:[{id:5, refreshEnabled:true, sevenDayRemaining:70}], busy:false};
  const service = createPetQuota({settings:f.settings, quota:{snapshot:()=>data, refresh:async()=>{
    calls++;data.accounts[0].sevenDayRemaining = 60;
  }}, groups:{dailySnapshot:()=>({groups:[], users:[], groupId:null})}});
  await assert.rejects(service.refresh(), /选择跟踪账号/);assert.equal(calls, 0);
  f.settings.update({accountId:5});data.accounts[0].refreshEnabled = false;
  await assert.rejects(service.refresh(), /暂停刷新/);assert.equal(calls, 0);
  data.accounts[0].refreshEnabled = true;
  assert.equal((await service.refresh()).tracking.remaining, 60);assert.equal(calls, 1);
  data.busy = true;assert.equal(service.snapshot().tracking.busy, true);
});
