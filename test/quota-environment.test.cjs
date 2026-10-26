'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {readQuotaConfig} = require('../src/app/quota-config.cjs');
const {createQuotaPanel} = require('../src/channels/quota-accounts.cjs');
const {createGroupUsage} = require('../src/channels/quota-group-usage.cjs');
const {createKeyUsage} = require('../src/channels/quota-key-usage.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-quota-env-')), calls = [], panels = [];
  let fail = false;
  const clock = {now:() => Date.parse('2026-10-26T12:00:00+08:00'),setTimeout:() => 0,clearTimeout() {}};
  function create(env) {
    const options = {...readQuotaConfig({rootDir:dir,env}),dataDir:dir,clock,fetchImpl:async (url,options) => {
      calls.push({url,options});if (fail) throw Error('inline-fixture-key private-network-diagnostics');
      const route = new URL(url).pathname;
      const data = route.endsWith('/accounts') ? {items:[{id:1,name:'fixture-account',codex_7d_used_percent:20}],pages:1} :
        route.endsWith('/groups/all') ? [{id:13,name:'fixture-group'}] :
        route.endsWith('/user-breakdown') ? {users:[{user_id:9,email:'fixture@example.test',actual_cost:1}]} :
        route.endsWith('/api-keys') ? {items:[],total:0} : {items:[{id:9,email:'fixture@example.test'}],total:1};
      return {ok:true,json:async () => ({code:0,data})};
    }};
    const group = {quota:createQuotaPanel(options),ranking:createGroupUsage(options),keys:createKeyUsage(options)};
    panels.push(...Object.values(group));return group;
  }
  t.after(() => {panels.forEach(panel => panel.close());fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,calls,create,fail:() => {fail=true;}};
}

test('.env drives all requests, supports no token file, and keeps credentials out of snapshots and caches', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir,'.env'),'WHALE_QUOTA_BASE_URL=https://gateway.test/sub2api/\nWHALE_QUOTA_API_KEY=inline-fixture-key\n');
  const group = f.create({});
  assert.equal((await group.quota.refresh()).accounts.length,1);
  assert.equal((await group.ranking.refresh()).users.length,1);
  await group.keys.search();assert.equal((await group.keys.select(9)).user.id,9);
  assert.equal(f.calls.length,5);
  for (const {url,options} of f.calls) {
    assert.ok(url.startsWith('https://gateway.test/sub2api/api/v1/admin/'));
    assert.equal(options.headers['x-api-key'],'inline-fixture-key');
  }
  const restarted = f.create({});
  assert.equal(restarted.quota.snapshot().accounts.length,1);assert.equal(restarted.ranking.snapshot().users.length,1);
  assert.equal(restarted.keys.snapshot().user.id,9);assert.equal(f.calls.length,5);
  f.fail();await group.quota.refresh();await group.ranking.refresh();await group.keys.refresh();
  for (const panel of Object.values(group)) assert.ok(!JSON.stringify(panel.snapshot()).includes('inline-fixture-key'));
  for (const file of ['quota-cache.json','quota-group-usage.json','quota-key-usage.json']) {
    assert.ok(!fs.readFileSync(path.join(f.dir,file),'utf8').includes('inline-fixture-key'));
  }
  for (const env of [{WHALE_QUOTA_API_KEY:'different-fixture-key'}, {WHALE_QUOTA_BASE_URL:'https://other.test'}]) {
    const changed = f.create(env);
    assert.deepEqual(changed.quota.snapshot().accounts,[]);assert.deepEqual(changed.ranking.snapshot().users,[]);
    assert.equal(changed.keys.snapshot().user,null);
  }
});

test('switching from legacy token file to the same inline Key preserves all three caches', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir,'token'),'legacy-fixture-key\n');
  const legacy = f.create({});
  await legacy.quota.refresh();await legacy.ranking.refresh();await legacy.keys.search();await legacy.keys.select(9);
  const restored = f.create({WHALE_QUOTA_API_KEY:'legacy-fixture-key'});
  assert.deepEqual(restored.quota.snapshot().accounts,legacy.quota.snapshot().accounts);
  assert.deepEqual(restored.ranking.snapshot().users,legacy.ranking.snapshot().users);
  assert.deepEqual(restored.keys.snapshot().user,legacy.keys.snapshot().user);
  const changed = f.create({WHALE_QUOTA_API_KEY:'inline-fixture-key'});
  await changed.quota.refresh();await changed.ranking.refresh();await changed.keys.search();
  assert.equal(f.calls.at(-1).options.headers['x-api-key'],'inline-fixture-key');
  assert.deepEqual(restored.quota.snapshot().accounts,legacy.quota.snapshot().accounts);
});
