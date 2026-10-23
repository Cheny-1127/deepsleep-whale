'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createKeyUsage} = require('../src/channels/quota-key-usage.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-keys-')), tokenFile = path.join(dir,'token'), jobs = new Map(), calls = [], panels = [];
  fs.writeFileSync(tokenFile,'admin-fixture-secret');
  let now = Date.parse('2026-10-24T12:00:00+08:00'), job = 0;
  let request = async (url,options) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.endsWith('/users')) return {items:[{id:9,email:'one@example.com',password:'do-not-expose'},{id:10,email:'two@example.com'}],total:2};
    if (endpoint.pathname.endsWith('/api-keys')) {
      const owner = Number(endpoint.pathname.split('/').at(-2));
      return {items:[1,2,3].map(id => ({id,user_id:owner,name:`key-${id}`,group_id:id===3?14:13,group:{name:id===3?'B':'A'},status:'active',key:'sk-do-not-expose'})),total:3};
    }
    return {stats:Object.fromEntries(JSON.parse(options.body).api_key_ids.map(id => [id,{api_key_id:id,today_actual_cost:id/10,total_actual_cost:999}]))};
  };
  const clock = {now:() => now,setTimeout(fn,ms) {const id = ++job;jobs.set(id,{fn,ms});return id;},clearTimeout:id => jobs.delete(id)};
  const create = () => {
    const panel = createKeyUsage({tokenFile,dataDir:dir,clock,fetchImpl:async (url,options) => {
      calls.push({url,options});return {ok:true,json:async () => ({code:0,data:await request(url,options)})};
    }});panels.push(panel);return panel;
  };
  const panel = create();
  t.after(() => {panels.forEach(item => item.close());fs.rmSync(dir,{recursive:true,force:true});});
  return {panel,create,calls,dir,tokenFile,jobs,setNow:value => {now = value;},setRequest:fn => {request = fn;},
    batches:() => calls.filter(item => new URL(item.url).pathname.endsWith('/api-keys-usage'))};
}

test('one selected user batches every key once and exposes only projected fields',async t => {
  const f = fixture(t);await f.panel.open();assert.equal(f.calls.length,0);
  assert.deepEqual(await f.panel.search(),[{id:9,email:'one@example.com'},{id:10,email:'two@example.com'}]);
  const data = await f.panel.select(9);
  assert.equal(f.batches().length,1);assert.deepEqual(JSON.parse(f.batches()[0].options.body),{api_key_ids:[1,2,3]});
  assert.equal(f.batches()[0].options.headers['x-api-key'],'admin-fixture-secret');
  assert.deepEqual(data.keys.map(key => key.groupId),[13,13,14]);assert.deepEqual(data.keys.map(key => key.todayCost),[0.1,0.2,0.3]);
  assert.ok(Math.abs(data.totalCost-0.6)<1e-12);assert.equal(data.busy,false);assert.equal(data.date,'2026-10-24');
  const cache = fs.readFileSync(path.join(f.dir,'quota-key-usage.json'),'utf8');
  for (const secret of ['admin-fixture-secret','sk-do-not-expose','do-not-expose','total_actual_cost']) {
    assert.ok(!JSON.stringify(data).includes(secret));assert.ok(!cache.includes(secret));
  }
  assert.equal(fs.statSync(path.join(f.dir,'quota-key-usage.json')).mode&0o777,0o600);
});

test('open, select and restart reuse a user/day cache for thirty minutes; manual refresh bypasses it',async t => {
  const f = fixture(t);await f.panel.search();await f.panel.select(9);const count = f.calls.length;
  await f.panel.open();await f.panel.select(9);await f.panel.search();assert.equal(f.calls.length,count);
  const restarted = f.create();await restarted.open();assert.equal(f.calls.length,count);assert.equal(restarted.snapshot().user.id,9);
  f.setNow(Date.parse('2026-10-24T12:30:00+08:00'));await restarted.open();assert.equal(f.batches().length,2);
  await restarted.refresh();assert.equal(f.batches().length,3);
});

test('pagination collects all keys before one batch, and empty accounts do not need a batch',async t => {
  const f = fixture(t);await f.panel.search();
  const keys = Array.from({length:105},(_,i) => ({id:i+1,user_id:9,name:`k${i}`,group_id:null}));
  f.setRequest(async (url,options) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.endsWith('/api-keys')) {const page = Number(endpoint.searchParams.get('page'));return {items:keys.slice((page-1)*100,page*100),total:105};}
    return {stats:Object.fromEntries(JSON.parse(options.body).api_key_ids.map(id => [id,{today_actual_cost:0}]))};
  });
  const data = await f.panel.select(9);assert.equal(data.keys.length,105);assert.equal(f.batches().length,1);
  assert.equal(JSON.parse(f.batches()[0].options.body).api_key_ids.length,105);
  f.setRequest(async () => ({items:[],total:0}));const empty = await f.panel.refresh();
  assert.deepEqual(empty.keys,[]);assert.equal(empty.totalCost,0);assert.equal(f.batches().length,1);
});

test('missing stats, foreign ownership and incomplete lists preserve only the same user/day result',async t => {
  const f = fixture(t);await f.panel.search();const first = await f.panel.select(9);
  f.setRequest(async url => new URL(url).pathname.endsWith('/api-keys') ? {items:[{id:1,user_id:9,group_id:13}],total:1} : {stats:{}});
  const failed = await f.panel.refresh();assert.ok(failed.error);assert.deepEqual(failed.keys,first.keys);assert.equal(failed.checkedAt,first.checkedAt);
  const count = f.calls.length;await f.panel.open();assert.equal(f.calls.length,count,'失败后不密集轮询');
  for (const data of [{items:[{id:1,user_id:10}],total:1},{items:[],total:5},{items:[],total:1001}]) {
    f.setRequest(async () => data);await f.panel.refresh();assert.deepEqual(f.panel.snapshot().keys,first.keys);
  }
  const other = await f.panel.select(10);assert.equal(other.user.id,10);assert.deepEqual(other.keys,[]);assert.equal(other.checkedAt,null);
});

test('unknown IDs and malformed search inputs cannot create arbitrary admin requests',async t => {
  const f = fixture(t);
  for (const id of [9,0,-1,1.5,'9','../users',Number.MAX_SAFE_INTEGER+1]) await assert.rejects(f.panel.select(id));
  await assert.rejects(f.panel.search({}));await assert.rejects(f.panel.search('x'.repeat(101)));assert.equal(f.calls.length,0);
  await f.panel.search('  name@example.com  ');
  const params = new URL(f.calls[0].url).searchParams;assert.equal(params.get('search'),'name@example.com');assert.equal(params.get('include_subscriptions'),'false');
});

test('overlaps merge, late responses cannot change the user and Shanghai midnight invalidates old data',async t => {
  const f = fixture(t);await f.panel.search();let finish;
  f.setRequest(async (url,options) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.includes('/users/9/')) return new Promise(resolve => {finish = () => resolve({items:[{id:91,user_id:9}],total:1});});
    if (endpoint.pathname.includes('/users/10/')) return {items:[{id:101,user_id:10}],total:1};
    return {stats:Object.fromEntries(JSON.parse(options.body).api_key_ids.map(id => [id,{today_actual_cost:id}]))};
  });
  const first = f.panel.select(9), duplicate = f.panel.open();await new Promise(setImmediate);
  assert.equal(f.calls.filter(item => item.url.includes('/users/9/')).length,1);
  await f.panel.select(10);finish();await Promise.all([first,duplicate]);
  assert.equal(f.panel.snapshot().user.id,10);assert.deepEqual(f.panel.snapshot().keys.map(key => key.id),[101]);
  f.setNow(Date.parse('2026-10-25T00:00:00+08:00'));assert.deepEqual(f.panel.snapshot().keys,[]);assert.equal(f.panel.snapshot().checkedAt,null);
  await f.panel.open();assert.equal(f.panel.snapshot().date,'2026-10-25');assert.equal(f.panel.snapshot().keys.length,1);
});

test('credential changes invalidate caches; timeout and close abort without leaking error details',async t => {
  const f = fixture(t);await f.panel.search();await f.panel.select(9);
  fs.writeFileSync(f.tokenFile,'different-secret');assert.equal(f.create().snapshot().user,null);
  let signal;
  f.setRequest((_url,options) => {signal = options.signal;return new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(Error('admin-fixture-secret'))));});
  const flight = f.panel.refresh();await new Promise(setImmediate);[...f.jobs.values()][0].fn();await flight;
  assert.match(f.panel.snapshot().error,/超时/);assert.ok(!f.panel.snapshot().error.includes('secret'));assert.equal(f.jobs.size,0);
  const closing = f.panel.refresh();await new Promise(setImmediate);f.panel.close();await closing;assert.equal(signal.aborted,true);assert.equal(f.jobs.size,0);
});
