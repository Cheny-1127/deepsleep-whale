'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createPetQuotaSettings} = require('../src/app/pet-quota-settings.cjs');
const {createPetQuota} = require('../src/channels/pet-quota.cjs');
const {createGroupUsage} = require('../src/channels/quota-group-usage.cjs');

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
  assert.deepEqual(restored.snapshot(), {accountId:5, yellowBelow:40, redBelow:15, accountsExpanded:false, configExpanded:false, trackingConfigs:[], nextConfigId:2});
  restored.update({accountsExpanded:true});assert.equal(restored.snapshot().configExpanded, false);
  fs.mkdirSync(path.join(f.dir, 'pet-quota-settings.json.tmp'));
  assert.throws(() => restored.update({accountId:6}), /保存失败/);
  assert.equal(restored.snapshot().accountId, 5);
  assert.equal(createPetQuotaSettings({dataDir:f.dir}).snapshot().accountId, 5);
});
test('invalid thresholds, account IDs and unknown settings cannot overwrite saved settings', t => {
  const f = fixture(t), before = f.settings.snapshot();
  for (const value of [null, [], {}, {accountId:'5'}, {accountId:-1}, {redBelow:30}, {yellowBelow:101},
    {yellowBelow:NaN}, {configExpanded:0}, {trackingConfigs:1}, {unknown:true}]) {
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
  const service = createPetQuota({settings:f.settings, quota:{snapshot:()=>data, refreshAccount:async id=>{
    assert.equal(id,5);calls++;data.accounts[0].sevenDayRemaining = 60;
  }}, groups:{dailySnapshot:()=>({groups:[], users:[], groupId:null})}});
  await assert.rejects(service.refresh(), /选择跟踪账号/);assert.equal(calls, 0);
  f.settings.update({accountId:5});data.accounts[0].refreshEnabled = false;
  await assert.rejects(service.refresh(), /暂停刷新/);assert.equal(calls, 0);
  data.accounts[0].refreshEnabled = true;
  assert.equal((await service.refresh()).tracking.remaining, 60);assert.equal(calls, 1);
  data.busy = true;assert.equal(service.snapshot().tracking.busy, true);
});
test('selecting tracking validates the current account list, persists only the account, and preserves selection on save failure', t => {
  const f = fixture(t);
  f.settings.update({yellowBelow: 45, redBelow: 15, configExpanded: false});
  const data = {accounts: [{id: 5, name: 'first', sevenDayRemaining: 70}, {id: 6, name: 'second', sevenDayRemaining: 25}]};
  const service = createPetQuota({settings: f.settings, quota: {snapshot: () => data},
    groups: {dailySnapshot: () => ({groups: [], users: [], groupId: null})}});
  assert.equal(service.selectAccount(5).tracking.accountId, 5);
  const switched = service.selectAccount(6);
  assert.equal(switched.tracking.accountId, 6);assert.equal(switched.tracking.remaining, 25);assert.equal(switched.tracking.tone, 'yellow');
  assert.deepEqual(createPetQuotaSettings({dataDir: f.dir}).snapshot(), {...f.settings.snapshot(), accountId: 6});
  assert.equal(f.settings.snapshot().yellowBelow, 45);assert.equal(f.settings.snapshot().configExpanded, false);
  assert.equal(service.selectAccount(5).tracking.accountId, 5);
  fs.mkdirSync(path.join(f.dir, 'pet-quota-settings.json.tmp'));
  assert.throws(() => service.selectAccount(6), /保存失败/);assert.equal(f.settings.snapshot().accountId, 5);
  data.accounts = [data.accounts[0]];
  assert.equal(service.selectAccount(5).tracking.accountId, 5, '选择当前账号时不重复写入');
  data.accounts = [];
  for (const id of [5, 6, null, '5', -1]) assert.throws(() => service.selectAccount(id), /账号已不可用/);assert.equal(f.settings.snapshot().accountId, 5);
});
test('ranking group selection loads today, preserves weekly strategy, persists the group and rejects unknown groups', async t => {
  const f = fixture(t), tokenFile = path.join(f.dir, 'token'), calls = [];
  fs.writeFileSync(tokenFile, 'synthetic-key');
  const options = {dataDir:f.dir, tokenFile, clock:{now:() => Date.parse('2026-10-22T12:00:00+08:00'), setTimeout, clearTimeout},
    fetchImpl:async url => {
      const endpoint = new URL(url);calls.push(endpoint);
      return {ok:true, json:async() => ({data:endpoint.pathname.endsWith('/groups/all') ? [{id:13, name:'first'}, {id:14, name:'second'}] :
        {users:[{user_id:14, email: endpoint.searchParams.get('group_id') || 'all', actual_cost:5}]}})};
    }};
  const groups = createGroupUsage(options);t.after(() => groups.close());
  await groups.select({groupId:13, period:'week'});
  const service = createPetQuota({settings:f.settings, quota:{snapshot:() => ({accounts:[]})}, groups});
  const selected = await service.selectRankingGroup(14);
  assert.equal(selected.groupId, 14);assert.equal(selected.groupName, 'second');assert.equal(selected.users[0].email, '14');
  assert.equal(groups.snapshot().period, 'week');
  const query = calls.at(-1).searchParams;
  assert.equal(query.get('start_date'), '2026-10-22');assert.equal(query.get('end_date'), '2026-10-22');
  const restored = createGroupUsage(options);t.after(() => restored.close());
  assert.equal(restored.snapshot().groupId, 14);assert.equal(restored.snapshot().period, 'week');
  const before = calls.length;
  for (const id of [undefined, '14', 999, -1]) await assert.rejects(service.selectRankingGroup(id), /有效分组/);
  assert.equal(calls.length, before);
  assert.equal((await service.selectRankingGroup(null)).groupName, '全部分组');
  assert.equal(calls.at(-1).searchParams.has('group_id'), false);
});


test('multiple configs have stable IDs and independent temporary accounts, thresholds and deletion', async t => {
  const f=fixture(t);f.settings.update({accountId:5});
  const accounts={accounts:[{id:5,name:'primary',sevenDayRemaining:70},{id:6,name:'other',sevenDayRemaining:8},{id:7,sevenDayRemaining:60},{id:8,sevenDayRemaining:50}]};
  const daily=id=>({groupId:id ?? 13,groups:[{id:13,name:'main'},{id:14,name:'other'}],users:[],date:'2026-10-22'});
  let calls=0;
  const options={settings:f.settings,quota:{snapshot:()=>accounts,refreshAccount:async id=>{assert.equal(id,8);calls++;}},
    groups:{snapshot:()=>({groupId:13,groups:daily().groups}),dailySnapshot:daily,openDaily:async()=>{},refreshDaily:async()=>{}}};
  const service=createPetQuota(options);
  assert.throws(()=>service.selectAccount(6,2),/已不可用/);
  service.copyConfig();service.copyConfig(2);
  assert.deepEqual(f.settings.snapshot().trackingConfigs.map(c=>c.id),[2,3]);
  service.updateConfig(2,{accountId:6,yellowBelow:90,redBelow:80,groupId:14});
  assert.equal(service.snapshot().extraTrackings[0].ranking.groupId,14);
  assert.equal(service.snapshot().extraTrackings[1].ranking.groupId,13);
  service.updateConfig(3,{accountId:7});
  const saved=fs.readFileSync(path.join(f.dir,'pet-quota-settings.json'),'utf8');
  service.selectAccount(6,2);service.selectAccount(8,3);
  assert.equal(service.snapshot().extraTrackings[0].tracking.accountId,6);
  assert.equal(service.snapshot().extraTrackings[0].tracking.tone,'red');
  assert.equal(service.snapshot().tracking.tone,'green');
  assert.equal(fs.readFileSync(path.join(f.dir,'pet-quota-settings.json'),'utf8'),saved);
  service.selectAccount(6);assert.equal(f.settings.snapshot().accountId,6);
  await service.refresh(3);assert.equal(calls,1);
  accounts.accounts[3].refreshEnabled=false;await assert.rejects(service.refresh(3),/暂停刷新/);
  service.deleteConfig(2);service.copyConfig();
  assert.deepEqual(f.settings.snapshot().trackingConfigs.map(c=>c.id),[3,4]);
  assert.equal(service.snapshot().extraTrackings[0].tracking.accountId,8);
  assert.throws(()=>service.deleteConfig('primary'),/不可删除/);
  assert.throws(()=>service.selectAccount(6,2),/已不可用/);
  assert.throws(()=>service.updateConfig(3,{groupId:999}),/有效分组/);
  assert.throws(()=>service.updateConfig(3,{accountId:999}),/账号已不可用/);
  const restored=createPetQuota({...options,settings:createPetQuotaSettings({dataDir:f.dir})});
  assert.equal(restored.snapshot().extraTrackings[0].tracking.accountId,7,'重启恢复保存账号');
});

test('copy allows three secondary configs, rejects every source at the limit and resumes after deletion', t => {
  const f=fixture(t);
  const options={settings:f.settings,quota:{snapshot:()=>({accounts:[]})},
    groups:{snapshot:()=>({groupId:13}),dailySnapshot:()=>({groups:[],users:[],groupId:13})}};
  const service=createPetQuota(options);
  service.copyConfig();service.copyConfig(2);service.copyConfig(3);
  assert.deepEqual(f.settings.snapshot().trackingConfigs.map(config=>config.id),[2,3,4]);
  const saved=fs.readFileSync(path.join(f.dir,'pet-quota-settings.json'),'utf8');
  for(const id of ['primary',2,3,4])assert.throws(()=>service.copyConfig(id),/最多只能创建 3 条副配置/);
  assert.equal(fs.readFileSync(path.join(f.dir,'pet-quota-settings.json'),'utf8'),saved);
  const restarted=createPetQuota({...options,settings:createPetQuotaSettings({dataDir:f.dir})});
  assert.throws(()=>restarted.copyConfig(),/最多只能创建 3 条副配置/);
  service.deleteConfig(3);service.copyConfig(4);
  assert.deepEqual(f.settings.snapshot().trackingConfigs.map(config=>config.id),[2,4,5]);
  assert.equal(f.settings.snapshot().nextConfigId,6);
});

test('refresh status and errors follow the tracked account including temporary secondary selections', t => {
  const f=fixture(t);f.settings.update({accountId:5});
  const data={accounts:[{id:5},{id:6}],busy:true,refreshingAccountIds:[6],accountRefreshErrors:{6:'读取账号额度失败'}};
  const service=createPetQuota({settings:f.settings,quota:{snapshot:()=>data},groups:{snapshot:()=>({groupId:13}),dailySnapshot:()=>({groups:[],users:[]})}});
  service.copyConfig();service.copyConfig();service.updateConfig(2,{accountId:6});
  let value=service.snapshot();
  assert.equal(value.tracking.busy,false);assert.equal(value.tracking.error,'');
  assert.equal(value.extraTrackings[0].tracking.busy,true);assert.match(value.extraTrackings[0].tracking.error,/失败/);
  assert.equal(value.extraTrackings[1].tracking.busy,false);
  service.updateConfig(2,{accountId:null});service.selectAccount(6,3);value=service.snapshot();
  assert.equal(value.extraTrackings[1].tracking.busy,true);assert.match(value.extraTrackings[1].tracking.error,/失败/);
});
test('ranking identifies its source config and effective temporary account without exposing account details', t => {
  const f=fixture(t);f.settings.update({accountId:5});
  const data={accounts:[{id:5,name:'主账号'},{id:6,name:'副账号',credentials:'private-token'}]};
  const service=createPetQuota({settings:f.settings,quota:{snapshot:()=>data},groups:{snapshot:()=>({groupId:13}),dailySnapshot:()=>({groups:[],users:[],groupId:13})}});
  service.copyConfig();
  assert.deepEqual(service.rankingSnapshot().source,{configName:'流量跟踪配置',accountName:'主账号'});
  assert.deepEqual(service.rankingSnapshot(2).source,{configName:'流量跟踪配置-2',accountName:'暂不跟踪'});
  service.selectAccount(6,2);
  assert.deepEqual(service.rankingSnapshot(2).source,{configName:'流量跟踪配置-2',accountName:'副账号'});
  assert.equal(f.settings.snapshot().trackingConfigs[0].accountId,null);assert.ok(!JSON.stringify(service.rankingSnapshot(2)).includes('private-token'));
});

test('legacy single secondary config and multi toggle migrate without losing primary values', t => {
  const f=fixture(t),file=path.join(f.dir,'pet-quota-settings.json');
  for(const extra of [{},{multiAccountTracking:false},{multiAccountTracking:true},{secondaryConfig:{accountId:6,yellowBelow:60,redBelow:20,configExpanded:false}}]) {
    fs.writeFileSync(file,JSON.stringify({accountId:5,yellowBelow:45,redBelow:15,...extra}));
    const settings=createPetQuotaSettings({dataDir:f.dir}),data=settings.snapshot();
    assert.equal(data.accountId,5);assert.equal(data.yellowBelow,45);
    assert.equal(data.trackingConfigs.length,extra.multiAccountTracking||extra.secondaryConfig?1:0);
    if(extra.secondaryConfig)assert.deepEqual(data.trackingConfigs[0],{id:2,...extra.secondaryConfig,groupId:13});
    settings.update({accountsExpanded:false});
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(Object.hasOwn(saved,'secondaryConfig'),false);assert.equal(Object.hasOwn(saved,'multiAccountTracking'),false);
  }
});

test('invalid and externally mutated nested configs cannot overwrite saved settings', t => {
  const f=fixture(t),config={id:2,accountId:6,yellowBelow:50,redBelow:10,configExpanded:true,groupId:null};
  f.settings.update({trackingConfigs:[config]});config.accountId=99;
  const saved=f.settings.snapshot();saved.trackingConfigs[0].groupId=99;
  assert.equal(f.settings.snapshot().trackingConfigs[0].accountId,6);assert.equal(f.settings.snapshot().trackingConfigs[0].groupId,null);
  const before=f.settings.snapshot();
  for(const value of [[{},{}],[{...config,id:1}],[{...config,groupId:-1}],[{...config,redBelow:80}],[{...config},{...config}]]) {
    assert.throws(()=>f.settings.update({trackingConfigs:value}));assert.deepEqual(f.settings.snapshot(),before);
  }
});

test('secondary ranking changes and refreshes do not change primary group or weekly period', async t => {
  const f=fixture(t),tokenFile=path.join(f.dir,'token');fs.writeFileSync(tokenFile,'synthetic');
  const calls=[];
  const groups=createGroupUsage({dataDir:f.dir,tokenFile,fetchImpl:async url=>{
    const endpoint=new URL(url);calls.push(endpoint);
    return {ok:true,json:async()=>({data:endpoint.pathname.endsWith('/groups/all')?[{id:13,name:'main'},{id:14,name:'other'}]:
      {users:[{user_id:1,email:endpoint.searchParams.get('group_id')||'all',actual_cost:1}]}})};
  }});t.after(()=>groups.close());
  await groups.select({groupId:13,period:'week'});
  const service=createPetQuota({settings:f.settings,quota:{snapshot:()=>({accounts:[]})},groups});
  service.copyConfig();service.copyConfig();
  const results=await Promise.all([service.selectRankingGroup(14,2),service.selectRankingGroup(null,3)]);
  assert.equal(results[0].users[0].email,'14');assert.equal(results[1].users[0].email,'all');
  assert.equal(groups.snapshot().groupId,13);assert.equal(groups.snapshot().period,'week');
  assert.equal(service.snapshot().extraTrackings[0].ranking.groupId,14);
  await service.refreshRanking(2);assert.equal(groups.snapshot().groupId,13);
  await service.selectRankingGroup(14);assert.equal(groups.snapshot().groupId,14);
  assert.equal(service.snapshot().extraTrackings[1].ranking.groupId,null);
  assert.ok(calls.some(url=>url.searchParams.get('group_id')==='14'&&url.searchParams.get('start_date')===url.searchParams.get('end_date')));
});

function exclusiveFixture(t) {
  const f=fixture(t);f.settings.update({accountId:5});
  const service=createPetQuota({settings:f.settings,quota:{snapshot:()=>({accounts:[5,6,7,8].map(id=>({id}))})},
    groups:{snapshot:()=>({groupId:13}),dailySnapshot:()=>({groups:[],users:[]})}});
  service.copyConfig();service.copyConfig();
  return {...f,service};
}

test('secondary account choices exclude primary, saved and temporary accounts of other configs', t => {
  const {service,settings}=exclusiveFixture(t);
  assert.deepEqual(settings.snapshot().trackingConfigs.map(config=>config.accountId),[null,null]);
  service.updateConfig(2,{accountId:6});service.selectAccount(7,2);
  for(const accountId of [5,6,7]) {
    assert.throws(()=>service.updateConfig(3,{accountId}),/占用/);
    assert.throws(()=>service.selectAccount(accountId,3),/占用/);
  }
  assert.deepEqual(service.availableAccounts(3).map(account=>account.id),[8]);
  assert.deepEqual(service.availableAccounts().map(account=>account.id),[5,6,7,8]);
  service.updateConfig(3,{accountId:8});
  assert.deepEqual(service.snapshot().extraTrackings.map(item=>item.tracking.accountId),[7,8]);
  service.deleteConfig(2);
  assert.deepEqual(service.availableAccounts(3).map(account=>account.id),[6,7,8]);
});

test('primary always wins and clears conflicting secondary saved and temporary selections atomically', t => {
  const {service,settings,dir}=exclusiveFixture(t);
  service.updateConfig(2,{accountId:6,yellowBelow:50,groupId:null});service.selectAccount(7,2);
  service.updateConfig(3,{accountId:8});
  service.selectAccount(7);
  assert.equal(settings.snapshot().accountId,7);assert.equal(settings.snapshot().trackingConfigs[0].accountId,null);
  assert.equal(service.accountIdFor(2),null);assert.equal(settings.snapshot().trackingConfigs[0].yellowBelow,50);
  service.updateConfig('primary',{accountId:8});
  assert.equal(service.accountIdFor(3),null);assert.equal(settings.snapshot().accountId,8);
  service.updateConfig(2,{accountId:6});service.selectAccount(5,2);
  fs.mkdirSync(path.join(dir,'pet-quota-settings.json.tmp'));
  assert.throws(()=>service.selectAccount(5),/保存失败/);
  assert.equal(settings.snapshot().accountId,8);assert.equal(settings.snapshot().trackingConfigs[0].accountId,6);
  assert.equal(service.accountIdFor(2),5);
});

test('old duplicate selections keep the primary and earliest secondary account without losing other settings', t => {
  const f=fixture(t),file=path.join(f.dir,'pet-quota-settings.json');
  const configs=[5,6,6].map((accountId,index)=>({id:index+2,accountId,yellowBelow:60,redBelow:20,groupId:14,configExpanded:false}));
  fs.writeFileSync(file,JSON.stringify({...f.settings.snapshot(),accountId:5,trackingConfigs:configs}));
  const restored=createPetQuotaSettings({dataDir:f.dir});
  assert.equal(restored.snapshot().accountId,5);
  assert.deepEqual(restored.snapshot().trackingConfigs.map(config=>config.accountId),[null,6,null]);
  assert.deepEqual(restored.snapshot().trackingConfigs.map(config=>config.groupId),[14,14,14]);
  restored.update({accountsExpanded:false});
  assert.deepEqual(createPetQuotaSettings({dataDir:f.dir}).snapshot(),restored.snapshot());
});
