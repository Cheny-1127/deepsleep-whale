'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createKeyGroups} = require('../src/channels/quota-key-groups.cjs');
const {createKeyUsage} = require('../src/channels/quota-key-usage.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-key-groups-')), calls = [], changes = [], panels = [], jobs = new Map();
  const tokenFile = path.join(dir,'token');fs.writeFileSync(tokenFile,'admin-fixture-secret');
  const user = {id:9,email:'one@example.com',status:'active',allowed_groups:[14],restrict_public_groups:false,password:'private-password'};
  const group = (id,name,is_exclusive = false,subscription_type = 'standard',status = 'active') => ({id,name,is_exclusive,subscription_type,status});
  const groups = [group(13,'公开'),group(14,'授权专属',true),group(15,'未授权专属',true),group(16,'有效订阅',true,'subscription'),group(17,'过期订阅',false,'subscription'),group(18,'停用',false,'standard','inactive')];
  const key = (id,user_id,group_id) => ({id,user_id,group_id,name:`Key ${id}`,status:'active',group:{name:groups.find(item => item.id === group_id).name},key:'sk-fixture-secret'});
  const records = new Map([[9,[key(1,9,13),key(2,9,14)]],[10,[key(101,10,13)]]]);
  let handler, now = Date.parse('2026-11-07T12:00:00+08:00'), job = 0;
  const clock = {now:() => now,setTimeout(fn) {const id = ++job;jobs.set(id,fn);return id;},clearTimeout:id => jobs.delete(id)};
  async function route(endpoint,options) {
    const ids = endpoint.split('/');
    if (endpoint === 'groups/all') return groups;
    if (/^users\/\d+$/.test(endpoint)) return {...user,id:Number(ids[1]),email:Number(ids[1]) === 9 ? 'one@example.com' : 'two@example.com'};
    if (endpoint.endsWith('/subscriptions')) return [16,17].map(group_id => ({id:group_id,user_id:Number(ids[1]),group_id,status:'active',starts_at:'2026-01-01T00:00:00Z',expires_at:group_id === 16 ? '2027-01-01T00:00:00Z' : '2026-01-02T00:00:00Z'}));
    if (endpoint.endsWith('/api-keys')) {const items = records.get(Number(ids[1])) || [];return {items:structuredClone(items),total:items.length};}
    if (endpoint.startsWith('api-keys/') && options.method === 'PUT') {
      const item = [...records.values()].flat().find(item => item.id === Number(ids[1]));
      const body = JSON.parse(options.body);item.group_id = body.group_id;item.group = {name:groups.find(group => group.id === body.group_id).name};
      return {api_key:structuredClone(item),auto_granted_group_access:true};
    }
    throw Error(`Unexpected fixture endpoint: ${endpoint}`);
  }
  const options = {tokenFile,dataDir:dir,clock,searchUsers:async () => [{id:9,email:'one@example.com'},{id:10,email:'two@example.com'}],onChanged:value => changes.push(value),fetchImpl:async (url,request) => {
    const endpoint = new URL(url).pathname.replace('/api/v1/admin/','');calls.push({endpoint,...request});
    const body = await (handler ? handler(endpoint,request,() => route(endpoint,request)) : route(endpoint,request));
    return {ok:body?.__status ? body.__status < 400 : true,status:body?.__status || 200,json:async () => ({code:0,data:body})};
  }};
  function create(extra = {}) {const panel = createKeyGroups({...options,...extra});panels.push(panel);return panel;}
  const panel = create();
  t.after(() => {panels.forEach(panel => panel.close());fs.rmSync(dir,{recursive:true,force:true});});
  return {panel,create,user,groups,records,calls,changes,dir,tokenFile,jobs,options,setHandler:fn => {handler = fn;},setNow:value => {now = value;},
    writes:() => calls.filter(call => call.method === 'PUT'),select:async () => {await panel.search();return panel.select(9);},
    change:(extra = {}) => panel.switchGroup({userId:9,keyId:1,expectedGroupId:13,groupId:14,...extra})};
}

test('shows only active groups allowed by public restrictions, explicit grants or unexpired subscriptions; does not expose credentials',async t => {
  const f = fixture(t);const data = await f.select();
  assert.deepEqual(data.groups.map(group => group.id),[13,14,16]);assert.equal(data.keys.length,2);
  for (const secret of ['admin-fixture-secret','sk-fixture-secret','private-password','allowed_groups']) assert.ok(!JSON.stringify(data).includes(secret));
  f.user.restrict_public_groups = true;
  assert.deepEqual((await f.panel.refresh()).groups.map(group => group.id),[14,16]);
  f.user.status = 'disabled';assert.deepEqual((await f.panel.refresh()).groups,[]);
  assert.equal(f.writes().length,0);
});

test('opening, expanding and reselecting the loaded user reuse results until manual refresh; restored preferences do not fetch keys',async t => {
  const f = fixture(t);await f.select();
  const count = f.calls.length;f.records.get(9)[0].group_id = 14;
  assert.equal((await f.panel.open()).keys[0].groupId,13,'打开页面保留已有结果');
  f.panel.setExpanded(false);f.panel.setExpanded(true);
  assert.equal((await f.panel.select(9)).keys[0].groupId,13,'重新选择当前用户不刷新');
  assert.equal(f.calls.length,count,'打开和展开不请求管理接口');
  assert.equal((await f.panel.refresh()).keys[0].groupId,14,'手动刷新才取得远端变化');
  const restarted = f.create(), afterRefresh = f.calls.length;
  assert.equal((await restarted.open()).user.id,9);assert.deepEqual(restarted.snapshot().keys,[]);
  assert.equal(f.calls.length,afterRefresh,'重启恢复用户选择时不自动读取 Key');
  assert.equal((await restarted.refresh()).keys[0].groupId,14);
});

test('favorite groups and options restore from a safe snapshot without requiring another refresh',async t => {
  const f = fixture(t);await f.select();let count = f.calls.length;
  assert.throws(() => f.panel.setFavorite({userId:10,keyId:101,favorite:true}));
  assert.throws(() => f.panel.setFavorite({userId:9,keyId:101,favorite:true}));
  let data = f.panel.setFavorite({userId:9,keyId:1,favorite:true});
  assert.equal(f.calls.length,count,'收藏只写本地偏好');assert.equal(data.favorites[0].key.id,1);
  await f.panel.select(10);f.panel.setFavorite({userId:10,keyId:101,favorite:true});
  assert.deepEqual(f.panel.snapshot().favorites.map(item => [item.user.id,item.keyId]),[[9,1],[10,101]]);
  const saved = fs.readFileSync(path.join(f.dir,'quota-key-groups.json'),'utf8');
  for (const secret of ['admin-fixture-secret','sk-fixture-secret','private-password']) assert.ok(!saved.includes(secret));
  count = f.calls.length;const restarted = f.create();data = await restarted.open();
  assert.equal(data.favorites.length,2);assert.deepEqual(data.favorites.map(item => item.key?.groupId),[13,13]);assert.equal(f.calls.length,count);
  assert.deepEqual(data.favorites[0].groups.map(item => item.id),[13,14,16]);assert.deepEqual(data.keys,[],'收藏摘要不冒充完整用户列表');
  data = await restarted.switchGroup({userId:9,keyId:1,expectedGroupId:13,groupId:14});
  assert.equal(data.favorites[0].key.groupId,14,'重启后无需先手动刷新即可保存');
  assert.equal(f.create().snapshot().favorites[0].key.groupId,14,'保存成功后的分组也持久化');
  count = f.calls.length;
  data = await restarted.refreshFavorites();assert.deepEqual(data.favorites.map(item => item.key.id),[1,101]);
  assert.equal(f.calls.slice(count).filter(call => call.endpoint.endsWith('/api-keys')).length,2);
  fs.writeFileSync(f.tokenFile,'another-admin');assert.deepEqual(f.create().snapshot().favorites,[],'更换来源凭据不复用收藏');
});

test('stale cached groups only prompt refresh after a missing group or lost permission is detected',async t => {
  const f = fixture(t);await f.select();f.panel.setFavorite({userId:9,keyId:1,favorite:true});
  for (const invalidation of ['permission','missing','subscription']) {
    const groupId = invalidation === 'subscription' ? 16 : 14;
    const restarted = f.create();assert.ok(restarted.snapshot().favorites[0].groups.some(group => group.id === groupId));
    if (invalidation === 'permission') f.user.allowed_groups = [];
    else if (invalidation === 'missing') f.groups.splice(f.groups.findIndex(group => group.id === 14),1);
    else f.setNow(Date.parse('2027-01-02T00:00:00Z'));
    const data = await restarted.switchGroup({userId:9,keyId:1,expectedGroupId:13,groupId});
    assert.equal(data.favorites[0].key.groupId,13);assert.match(data.favorites[0].key.notice.text,/刷新/);assert.equal(f.writes().length,0);
    f.user.allowed_groups = [14];
  }
});

test('cached options cannot grant permissions and malformed cache keeps the favorite reference',async t => {
  const f = fixture(t);await f.select();f.panel.setFavorite({userId:9,keyId:1,favorite:true});
  const file = path.join(f.dir,'quota-key-groups.json'), saved = JSON.parse(fs.readFileSync(file,'utf8'));
  saved.favorites[0].cached.groups.push({id:15,name:'本地声称已授权'});fs.writeFileSync(file,JSON.stringify(saved));
  let restarted = f.create(), data = await restarted.switchGroup({userId:9,keyId:1,expectedGroupId:13,groupId:15});
  assert.match(data.favorites[0].key.notice.text,/刷新/);assert.equal(f.writes().length,0);
  saved.favorites[0].cached.key.id = 999;fs.writeFileSync(file,JSON.stringify(saved));
  restarted = f.create();assert.equal(restarted.snapshot().favorites[0].keyId,1);assert.equal(restarted.snapshot().favorites[0].key,null);
  delete saved.favorites[0].cached;fs.writeFileSync(file,JSON.stringify(saved));
  assert.equal(f.create().snapshot().favorites[0].key,null,'兼容只有收藏引用的旧偏好');
});

test('uncertain and in-flight favorite writes remain locked across restart until reconciled',async t => {
  const f = fixture(t);await f.select();f.panel.setFavorite({userId:9,keyId:1,favorite:true});let release;
  f.setHandler((_endpoint,options,next) => options.method === 'PUT' ? new Promise(resolve => {release = async () => resolve(await next());}) : next());
  const pending = f.change();await new Promise(setImmediate);
  let restarted = f.create();assert.equal(restarted.snapshot().favorites[0].key.uncertain,true,'退出时尚未确认的请求不得当作可重试');
  await assert.rejects(restarted.switchGroup({userId:9,keyId:1,expectedGroupId:13,groupId:14}));
  release();await pending;assert.equal(f.create().snapshot().favorites[0].key.uncertain,false);
  let sent = false;
  f.setHandler((endpoint,options,next) => {if (options.method === 'PUT') {sent = true;return next();}if (sent && endpoint.endsWith('/api-keys')) throw Error('lost readback');return next();});
  await f.change({expectedGroupId:14,groupId:13});restarted = f.create();
  assert.equal(restarted.snapshot().favorites[0].key.uncertain,true);
  f.setHandler(null);const data = await restarted.refreshFavorite({userId:9,keyId:1});
  assert.equal(data.favorites[0].key.uncertain,false);assert.equal(data.favorites[0].key.groupId,13);
  assert.equal(f.create().snapshot().favorites[0].key.uncertain,false);
});

test('saving a favorite snapshot preserves a usage synchronization failure message',async t => {
  const f = fixture(t);await f.select();f.panel.setFavorite({userId:9,keyId:1,favorite:true});
  const panel = f.create({onChanged:() => {throw Error('cache unavailable');}});
  const data = await panel.switchGroup({userId:9,keyId:1,expectedGroupId:13,groupId:14});
  assert.equal(data.favorites[0].key.groupId,14);assert.match(data.cacheError,/消费缓存未同步/);
  assert.equal(f.create().snapshot().favorites[0].key.groupId,14);
});

test('favorites can switch independently across users without authorizing other keys, and removed keys stay visible but cannot be changed',async t => {
  const f = fixture(t);await f.select();f.panel.setFavorite({userId:9,keyId:1,favorite:true});
  await f.panel.select(10);f.panel.setFavorite({userId:10,keyId:101,favorite:true});
  let data = await f.change();
  assert.equal(data.user.id,10);assert.equal(data.favorites[0].key.groupId,14);assert.equal(data.favorites[1].key.groupId,13);
  assert.equal(f.writes().length,1);await assert.rejects(f.change({keyId:2,expectedGroupId:14,groupId:13}));
  data = await f.panel.switchGroup({userId:10,keyId:101,expectedGroupId:13,groupId:14});
  assert.equal(data.favorites[0].key.groupId,14);assert.equal(data.favorites[1].key.groupId,14);assert.equal(f.writes().length,2);
  f.records.set(9,[]);data = await f.panel.refreshFavorites();
  assert.equal(data.favorites[0].missing,true);assert.equal(data.favorites[0].key,null);
  const count = f.calls.length;await assert.rejects(f.change({expectedGroupId:14,groupId:13}));assert.equal(f.calls.length,count);
  data = f.panel.setFavorite({userId:9,keyId:1,favorite:false});assert.equal(data.favorites.length,1);
});

test('manual favorite refresh deduplicates owners and an in-flight selected-user refresh; one failed owner keeps its previous keys',async t => {
  const f = fixture(t);await f.select();
  for (const keyId of [1,2]) f.panel.setFavorite({userId:9,keyId,favorite:true});
  await f.panel.select(10);f.panel.setFavorite({userId:10,keyId:101,favorite:true});await f.panel.select(9);
  let release;
  f.setHandler((endpoint,_request,next) => endpoint === 'users/9/api-keys' ? new Promise(resolve => {release = () => resolve(next());}) : next());
  const count = f.calls.length, current = f.panel.refresh(), favorites = f.panel.refreshFavorites();
  await new Promise(setImmediate);release();await Promise.all([current,favorites]);
  assert.deepEqual(f.calls.slice(count).filter(call => call.endpoint.endsWith('/api-keys')).map(call => call.endpoint).sort(),['users/10/api-keys','users/9/api-keys']);
  f.records.get(10)[0].group_id = 14;
  f.setHandler((endpoint,_request,next) => {if (endpoint === 'users/9/api-keys') throw Error('private-error');return next();});
  const data = await f.panel.refreshFavorites();
  assert.equal(data.favorites[0].key.groupId,13);assert.match(data.favorites[0].error,/失败/);assert.equal(data.favorites[0].busy,false);
  assert.equal(data.favorites[2].key.groupId,14);assert.equal(data.favorites[2].error,'');assert.ok(!JSON.stringify(data).includes('private-error'));
});

test('concurrent favorite saves and uncertain outcomes are isolated by user and key',async t => {
  const f = fixture(t);await f.select();f.panel.setFavorite({userId:9,keyId:1,favorite:true});
  await f.panel.select(10);f.panel.setFavorite({userId:10,keyId:101,favorite:true});
  let release, written = false;
  f.setHandler((endpoint,options,next) => {
    if (endpoint === 'api-keys/1' && options.method === 'PUT') return new Promise(resolve => {release = async () => {written = true;resolve(await next());};});
    if (written && endpoint === 'users/9/api-keys') throw Error('readback unavailable');
    return next();
  });
  const first = f.change();await new Promise(setImmediate);
  assert.throws(() => f.panel.setFavorite({userId:9,keyId:1,favorite:false}));
  await assert.rejects(f.change());
  await f.panel.switchGroup({userId:10,keyId:101,expectedGroupId:13,groupId:14});
  release();await first;let data = f.panel.snapshot();
  assert.equal(data.favorites[0].key.uncertain,true);assert.equal(data.favorites[1].key.groupId,14);assert.equal(data.favorites[1].key.uncertain,false);
  await f.panel.refresh();assert.equal(f.panel.snapshot().favorites[0].key.uncertain,true,'刷新另一个用户不能解锁不确定结果');
  f.setHandler(null);data = await f.panel.refreshFavorites();assert.equal(data.favorites[0].key.uncertain,false);assert.equal(data.favorites[0].key.groupId,14);
  assert.equal(f.writes().length,2,'两把 Key 各只提交一次');
});

test('a favorite refresh only updates that key, preserves peer state and rejects unpinned IDs',async t => {
  const f = fixture(t);await f.select();
  for (const keyId of [1,2]) f.panel.setFavorite({userId:9,keyId,favorite:true});
  f.records.get(9)[0].group_id = 14;f.records.get(9)[1].group_id = 13;
  let data = await f.panel.refreshFavorite({userId:9,keyId:1});
  assert.deepEqual(data.favorites.map(item => item.key.groupId),[14,14],'同用户的其他常用 Key 保留现值');
  assert.deepEqual(data.keys.map(item => item.groupId),[14,14]);assert.equal(f.writes().length,0);
  const count = f.calls.length;await assert.rejects(f.panel.refreshFavorite({userId:10,keyId:101}));assert.equal(f.calls.length,count);
  const restarted = f.create();data = await restarted.refreshFavorite({userId:9,keyId:1});
  assert.equal(data.favorites[0].key.groupId,14);assert.equal(data.favorites[1].key.groupId,14);assert.equal(data.favorites[1].missing,false);
  assert.deepEqual(data.keys,[],'仅刷新常用 Key 不把部分结果当成搜索完整列表');
  f.records.set(9,[]);data = await restarted.refreshFavorite({userId:9,keyId:1});
  assert.equal(data.favorites[0].missing,true);assert.equal(data.favorites[1].missing,false);
});

test('a late favorite refresh cannot overwrite a newer write to that key',async t => {
  const f = fixture(t);await f.select();f.panel.setFavorite({userId:9,keyId:1,favorite:true});
  let release, first = true;
  f.setHandler(async (endpoint,_options,next) => {
    if (endpoint === 'users/9/api-keys' && first) {first = false;const old = await next();return new Promise(resolve => {release = () => resolve(old);});}
    return next();
  });
  const reading = f.panel.refreshFavorite({userId:9,keyId:1});await new Promise(setImmediate);
  await f.change();release();const data = await reading;
  assert.equal(data.favorites[0].key.groupId,14);assert.equal(data.favorites[0].key.notice.kind,'success');assert.equal(f.writes().length,1);
});

test('explicit change updates exactly one key and only group_id, confirms by a later read, then synchronizes usage without leaking raw response',async t => {
  const f = fixture(t);await f.select();const data = await f.change();
  assert.equal(f.writes().length,1);assert.equal(f.writes()[0].endpoint,'api-keys/1');
  assert.deepEqual(JSON.parse(f.writes()[0].body),{group_id:14});assert.equal(f.writes()[0].headers['x-api-key'],'admin-fixture-secret');
  assert.equal(data.keys[0].groupId,14);assert.equal(data.keys[0].notice.kind,'success');assert.equal(data.keys[0].busy,false);
  assert.equal(data.keys[1].groupId,14);assert.deepEqual(f.changes,[{userId:9,keyId:1,groupId:14,groupName:'授权专属'}]);
  const writeIndex = f.calls.findIndex(call => call.method === 'PUT');assert.ok(f.calls.slice(writeIndex+1).some(call => call.endpoint === 'users/9/api-keys'));
  for (const secret of ['sk-fixture-secret','admin-fixture-secret','auto_granted_group_access']) assert.ok(!JSON.stringify(data).includes(secret));
  const saved = fs.readFileSync(path.join(f.dir,'quota-key-groups.json'),'utf8');
  assert.ok(!saved.includes('secret'));assert.ok(!saved.includes('Key 1'));assert.equal(fs.statSync(path.join(f.dir,'quota-key-groups.json')).mode&0o777,0o600);
  assert.equal((await f.panel.refresh()).keys[0].notice,null,'刷新后不保留可能已过时的换组结果提示');
});

test('rejects unknown users, foreign keys, arbitrary paths, unauthorized targets and no-op changes without any write',async t => {
  const f = fixture(t);await assert.rejects(f.panel.select(9));await f.select();const count = f.calls.length;
  for (const extra of [{userId:10},{keyId:101},{keyId:'../users'},{groupId:15},{groupId:17},{groupId:18},{groupId:13},{groupId:0},{groupId:null},{expectedGroupId:14}]) await assert.rejects(f.change(extra));
  assert.equal(f.calls.length,count);assert.equal(f.writes().length,0);
  await assert.rejects(f.panel.search('x'.repeat(101)));await assert.rejects(f.panel.search({}));
});

test('rechecks ownership, expected source group and permissions immediately before writing',async t => {
  const f = fixture(t);await f.select();
  f.user.allowed_groups = [];let data = await f.change();assert.match(data.keys[0].notice.text,/无权/);assert.equal(f.writes().length,0);
  f.user.allowed_groups = [14];f.records.get(9)[0].group_id = 16;
  data = await f.change();assert.match(data.keys[0].notice.text,/当前分组已变化/);assert.equal(f.writes().length,0);
  f.records.get(9)[0].group_id = 13;f.records.get(9)[0].user_id = 10;
  data = await f.change();assert.match(data.keys[0].notice.text,/归属/);assert.equal(f.writes().length,0);
});

test('missing permissions, duplicate keys and incomplete pagination fail closed',async t => {
  const f = fixture(t);await f.select();delete f.user.allowed_groups;
  await f.change();assert.equal(f.writes().length,0);
  assert.match((await f.panel.refresh()).error,/权限/);
  f.user.allowed_groups = [14];
  for (const body of [{items:[],total:2},{items:[f.records.get(9)[0],f.records.get(9)[0]],total:2},{items:[],total:1001}]) {
    f.setHandler((endpoint,_request,next) => endpoint.endsWith('/api-keys') ? body : next());
    assert.ok((await f.panel.refresh()).error);
  }
  assert.equal(f.writes().length,0);
});

test('write errors are reconciled by readback and never retried automatically',async t => {
  const f = fixture(t);await f.select();
  f.setHandler(async (endpoint,options,next) => {if (options.method === 'PUT') {await next();throw Error('admin-fixture-secret response lost');}return next();});
  let data = await f.change();assert.equal(data.keys[0].notice.kind,'success');assert.equal(f.writes().length,1);
  f.setHandler((_endpoint,options,next) => options.method === 'PUT' ? {__status:403} : next());
  data = await f.change({expectedGroupId:14,groupId:13});assert.equal(data.keys[0].groupId,14);assert.equal(data.keys[0].notice.kind,'error');
  assert.match(data.keys[0].notice.text,/权限/);assert.equal(f.writes().length,2);assert.ok(!JSON.stringify(data).includes('secret'));
});

test('unconfirmed outcomes block a second write until a successful explicit refresh',async t => {
  const f = fixture(t);await f.select();let written = false;
  f.setHandler(async (endpoint,options,next) => {
    if (options.method === 'PUT') {written = true;return next();}
    if (written && endpoint.endsWith('/api-keys')) throw Error('readback unavailable');
    return next();
  });
  const data = await f.change();assert.equal(data.keys[0].uncertain,true);assert.match(data.keys[0].notice.text,/未确认/);
  await assert.rejects(f.change());assert.equal(f.writes().length,1);
  f.setHandler(null);const fresh = await f.panel.refresh();assert.equal(fresh.keys[0].groupId,14);assert.equal(fresh.keys[0].uncertain,false);
  assert.equal(f.writes().length,1);
});

test('a timed-out write is reconciled once, and a lost response with an unchanged readback remains uncertain',async t => {
  const f = fixture(t);await f.select();
  f.setHandler(async (_endpoint,options,next) => {
    if (options.method !== 'PUT') return next();
    await next();return new Promise((_resolve,reject) => options.signal.addEventListener('abort',() => reject(Error('write timed out'))));
  });
  const pending = f.change();await new Promise(setImmediate);[...f.jobs.values()][0]();
  let data = await pending;assert.equal(data.keys[0].notice.kind,'success');assert.equal(f.writes().length,1);assert.equal(f.jobs.size,0);
  f.setHandler((_endpoint,options,next) => {if (options.method === 'PUT') throw Error('connection lost before result');return next();});
  data = await f.change({expectedGroupId:14,groupId:13});assert.equal(data.keys[0].uncertain,true);assert.equal(data.keys[0].groupId,14);
  await assert.rejects(f.change({expectedGroupId:14,groupId:13}));assert.equal(f.writes().length,2);
});

test('duplicate submissions are blocked and changing users during a write keeps the new user visible',async t => {
  const f = fixture(t);await f.select();let finish;
  f.setHandler(async (_endpoint,options,next) => options.method === 'PUT' ? new Promise(resolve => {finish = async () => resolve(await next());}) : next());
  const changing = f.change();await new Promise(setImmediate);assert.equal(f.panel.snapshot().keys[0].busy,true);
  await assert.rejects(f.change());assert.equal(f.writes().length,1);
  await f.panel.select(10);finish();await changing;
  assert.equal(f.panel.snapshot().user.id,10);assert.deepEqual(f.panel.snapshot().keys.map(key => key.id),[101]);assert.equal(f.records.get(9)[0].group_id,14);
});

test('preferences restore without cached keys; close aborts requests and credentials invalidate saved selection',async t => {
  const f = fixture(t);await f.select();f.panel.setExpanded(false);
  const restarted = f.create();assert.equal(restarted.snapshot().user.id,9);assert.equal(restarted.snapshot().expanded,false);assert.deepEqual(restarted.snapshot().keys,[]);
  const count = f.calls.length;await restarted.open();assert.equal(f.calls.length,count);
  const before = fs.readFileSync(path.join(f.dir,'quota-key-groups.json'),'utf8');
  fs.writeFileSync(f.tokenFile,'changed-secret');assert.equal(f.create().snapshot().user,null);
  assert.match((await f.panel.refresh()).error,/凭据已变化/);f.panel.setExpanded(true);
  assert.equal(fs.readFileSync(path.join(f.dir,'quota-key-groups.json'),'utf8'),before,'凭据变化不能把原来源的快照改绑到新来源');
  fs.writeFileSync(f.tokenFile,'admin-fixture-secret');
  let signal;
  f.setHandler((_endpoint,options) => {signal = options.signal;return new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(Error('private-server-detail'))));});
  const pending = f.panel.refresh();await new Promise(setImmediate);f.panel.close();await pending;assert.equal(signal.aborted,true);assert.equal(f.jobs.size,0);
  await assert.rejects(f.change());
});

test('verified group changes update usage grouping without changing billed cost',async t => {
  const f = fixture(t);
  const usage = createKeyUsage({...f.options,fetchImpl:async (url,options) => ({ok:true,json:async () => ({data:new URL(url).pathname.endsWith('/users') ?
    {items:[{id:9,email:'one@example.com'}]} : new URL(url).pathname.endsWith('/api-keys') ? {items:f.records.get(9),total:2} :
      {stats:Object.fromEntries(JSON.parse(options.body).api_key_ids.map(id => [id,{today_actual_cost:id/10}]))}})})});
  t.after(() => usage.close());await usage.search();const before = await usage.select(9);
  const panel = f.create({onChanged:value => usage.updateKeyGroup(value)});await panel.search();await panel.select(9);
  await panel.switchGroup({userId:9,keyId:1,expectedGroupId:13,groupId:14});
  assert.equal(usage.snapshot().keys[0].groupId,14);assert.equal(usage.snapshot().totalCost,before.totalCost);assert.equal(usage.snapshot().keys[1].todayCost,before.keys[1].todayCost);
});
