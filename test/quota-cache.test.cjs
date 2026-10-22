'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createQuotaPanel}=require('../src/channels/quota-accounts.cjs');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-quota-cache-')),tokenFile=path.join(dir,'token'),cacheFile=path.join(dir,'quota-cache.json');
  fs.writeFileSync(tokenFile,'private-api-key');
  let now=1000,offline=false,used=20;
  const jobs=new Set(),calls=[],panels=[];
  const clock={now:()=>now,setTimeout:(fn,ms)=>{const job={fn,ms};jobs.add(job);return job;},clearTimeout:job=>jobs.delete(job)};
  const create=()=>{
    const panel=createQuotaPanel({dataDir:dir,tokenFile,clock,fetchImpl:async url=>{
      calls.push(url);if(offline)throw Error('private-request-diagnostics');
      const item={id:5,name:'cached-account',platform:'openai',type:'oauth',credentials:{plan_type:'prolite',access_token:'private-access-token'},extra:{codex_5h_used_percent:used,codex_5h_window_minutes:0,codex_7d_window_minutes:10080,codex_5h_reset_at:'2026-10-20T15:00:00Z',codex_7d_reset_at:'2026-10-27T15:00:00Z',codex_reset_credit_snapshot:{available_count:2}}};
      return {ok:true,json:async()=>({data:new URL(url).pathname.endsWith('/5')?item:{items:[item],pages:1}})};
    }});
    panels.push(panel);return panel;
  };
  t.after(()=>{panels.forEach(panel=>panel.close());fs.rmSync(dir,{recursive:true,force:true});});
  return {create,calls,jobs,cacheFile,tokenFile,dir,setNow:value=>{now=value;},offline:()=>{offline=true;},online:()=>{offline=false;},used:value=>{used=value;}};
}

test('successful quota data is saved without credentials and restored before any request',async t=>{
  const f=fixture(t),first=f.create();const success=await first.refresh();first.close();
  const serialized=fs.readFileSync(f.cacheFile,'utf8');
  assert.ok(!serialized.includes('private-api-key'));assert.ok(!serialized.includes('private-access-token'));assert.ok(!serialized.includes('credentials'));
  assert.equal(fs.statSync(f.cacheFile).mode&0o777,0o600);
  f.setNow(2000);const restarted=f.create(),cached=restarted.snapshot();
  assert.deepEqual(cached.accounts,success.accounts);assert.equal(cached.accounts[0].fiveHourWindowMinutes,0);assert.equal(cached.accounts[0].sevenDayWindowMinutes,10080);assert.equal(cached.accounts[0].sevenDayResetAt,'2026-10-27T15:00:00Z');assert.equal(cached.checkedAt,1000);assert.equal(cached.nextRefreshAt,301000);
  assert.equal(f.calls.length,1);assert.ok([...f.jobs].some(job=>job.ms===299000),'恢复剩余等待时间，不能重新等待完整五分钟');
  const timer=[...f.jobs].find(job=>job.ms===299000);f.jobs.delete(timer);f.setNow(301000);timer.fn();await new Promise(setImmediate);
  assert.equal(f.calls.length,2);assert.equal(restarted.snapshot().checkedAt,301000);
});

test('custom interval and account switches survive restart without overwriting each other',async t=>{
  const f=fixture(t),first=f.create();await first.refresh();
  first.setRefreshInterval({value:2,unit:'hours'});first.setRefreshEnabled({id:5,enabled:false});
  first.setRefreshInterval({value:30,unit:'seconds'});assert.equal(first.snapshot().nextRefreshAt,null);
  assert.equal(f.jobs.size,0);assert.equal(f.calls.length,1);first.close();
  const restored=f.create();assert.deepEqual(restored.snapshot().refreshInterval,{value:30,unit:'seconds'});
  assert.equal(restored.snapshot().accounts[0].refreshEnabled,false);assert.equal(restored.snapshot().nextRefreshAt,null);
  f.setNow(2000);restored.setRefreshEnabled({id:5,enabled:true});assert.equal(restored.snapshot().nextRefreshAt,32000);restored.close();
  f.setNow(3000);const again=f.create();assert.equal(again.snapshot().nextRefreshAt,32000);
  assert.ok([...f.jobs].some(job=>job.ms===29000));assert.equal(f.calls.length,1);
});

test('legacy and invalid intervals use the default; independent settings win when a cache write failed',async t=>{
  const f=fixture(t),first=f.create();await first.refresh();first.close();
  const settingsFile=path.join(f.dir,'quota-refresh.json');
  for(const interval of [undefined,{value:4,unit:'seconds'},{value:25,unit:'hours'}]) {
    fs.writeFileSync(settingsFile,JSON.stringify({disabledAccountIds:[5],refreshInterval:interval}));
    const restored=f.create();assert.equal(restored.snapshot().refreshIntervalMs,300000);assert.equal(restored.snapshot().accounts[0].refreshEnabled,false);restored.close();
  }
  fs.writeFileSync(settingsFile,JSON.stringify({disabledAccountIds:[]}));const panel=f.create();panel.snapshot();
  fs.mkdirSync(f.cacheFile+'.tmp');panel.setRefreshInterval({value:1,unit:'hours'});
  assert.match(panel.snapshot().cacheError,/保存失败/);panel.close();
  const restarted=f.create();assert.equal(restarted.snapshot().refreshIntervalMs,3600000);assert.equal(restarted.snapshot().nextRefreshAt,3601000);
});

test('a failed first request after restart retains cached data, success time and first failure across restarts',async t=>{
  const f=fixture(t),first=f.create();const success=await first.refresh();first.close();
  f.setNow(400000);f.offline();const restarted=f.create();
  assert.deepEqual(restarted.snapshot().accounts,success.accounts);
  await restarted.refresh();const failure=restarted.snapshot();
  assert.deepEqual(failure.accounts,success.accounts);assert.equal(failure.checkedAt,1000);assert.equal(failure.failedAt,400000);assert.ok(failure.error);
  restarted.close();f.setNow(401000);const again=f.create(),cached=again.snapshot();
  assert.deepEqual(cached.accounts,success.accounts);assert.equal(cached.failedAt,400000);assert.equal(cached.nextRefreshAt,700000);assert.ok(cached.error);
  await again.refresh();assert.equal(again.snapshot().failedAt,400000);
  f.online();f.used(40);await again.refresh();assert.equal(again.snapshot().error,'');assert.equal(again.snapshot().failedAt,null);
  assert.equal(again.snapshot().accounts[0].fiveHourRemaining,60);
});

test('failed cache writes keep the prior file and expose a save error until the next successful save',async t=>{
  const f=fixture(t),panel=f.create();await panel.refresh();const original=fs.readFileSync(f.cacheFile,'utf8');
  fs.mkdirSync(f.cacheFile+'.tmp');f.used(40);const latest=await panel.refresh();
  assert.equal(latest.accounts[0].fiveHourRemaining,60);assert.match(latest.cacheError,/缓存.*保存/);
  assert.equal(fs.readFileSync(f.cacheFile,'utf8'),original);
  fs.rmdirSync(f.cacheFile+'.tmp');await panel.refresh();assert.equal(panel.snapshot().cacheError,'');
});

test('invalid cache is ignored without overwriting it and a changed token cannot reuse another account cache',async t=>{
  const f=fixture(t),first=f.create();await first.refresh();first.close();
  fs.writeFileSync(f.tokenFile,'another-api-key');assert.deepEqual(f.create().snapshot().accounts,[]);
  fs.writeFileSync(f.cacheFile,'broken-json');const invalid=f.create();assert.deepEqual(invalid.snapshot().accounts,[]);
  assert.match(invalid.snapshot().cacheError,/缓存.*读取/);assert.equal(fs.readFileSync(f.cacheFile,'utf8'),'broken-json');
});

test('cached fields are allowlisted and paused accounts remain paused after restart',async t=>{
  const f=fixture(t),first=f.create();await first.refresh();first.setRefreshEnabled({id:5,enabled:false});first.close();
  const saved=JSON.parse(fs.readFileSync(f.cacheFile,'utf8'));saved.accounts[0].credentials={access_token:'injected'};
  fs.writeFileSync(f.cacheFile,JSON.stringify(saved));f.setNow(400000);
  const restarted=f.create(),cached=restarted.snapshot();
  assert.equal(cached.accounts[0].refreshEnabled,false);assert.ok(!JSON.stringify(cached).includes('injected'));assert.equal(cached.nextRefreshAt,null);
  await restarted.refresh();assert.equal(f.calls.length,1);
  restarted.setRefreshEnabled({id:5,enabled:true});
  assert.equal(restarted.snapshot().nextRefreshAt,700000,'从本地缓存恢复的账号重新开启后应恢复轮询');
});
