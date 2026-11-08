'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkReports}=require('../src/app/work-reports.cjs');
const at=value=>Date.parse(value+'+08:00');
function fixture(t,{time='2026-11-09T11:59:59.999',collector=async()=>[]}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-daily-catchup-')),calls=[],instances=[],timers=new Map();let current=at(time),serial=0;
  const clock={setTimeout(callback,delay){const handle={id:++serial,unref(){}};timers.set(handle,{callback,at:current+delay});return handle;},clearTimeout(handle){timers.delete(handle);}};
  const create=()=>{const reports=createWorkReports({dataDir:dir,now:()=>current,clock,readEnvironment:()=>({}),gitCollector:async(source,options)=>{calls.push(options);return collector(source,options);}});instances.push(reports);return reports;};
  t.after(()=>{for(const reports of instances)reports.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,calls,create,setTime(value){current=at(value);},async advance(value){const end=at(value);for(;;){const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);current=next[1].at;next[1].callback();await new Promise(setImmediate);}current=end;}};
}
async function configure(f,reports,extra={}){await reports.action('settings',{repositories:[{path:f.dir,project:'测试项目',authors:'cy@example.test'}],...extra});}

test('missing yesterday is collected from Beijing noon even when periodic collection is off, once across restart',async t=>{
  const f=fixture(t),reports=f.create();await configure(f,reports);
  await reports.runScheduled();assert.equal(f.calls.length,0,'北京时间中午前不补采');
  f.setTime('2026-11-09T12:00:00');await Promise.all([reports.runScheduled(),reports.runScheduled()]);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].since,at('2026-11-08T00:00:00'));assert.equal(f.calls[0].until,at('2026-11-08T23:59:59.999'));
  assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true,'零条记录也算成功采集');
  await reports.runScheduled();assert.equal(f.calls.length,1);
  reports.close();await f.create().runScheduled();assert.equal(f.calls.length,1,'重启后跳过已采集的昨天');
});

test('manual day successes remain known after collecting another day; partial current days do not count as complete',async t=>{
  const f=fixture(t,{time:'2026-11-08T18:00:00'}),reports=f.create();await configure(f,reports);
  await reports.action('collect',{date:'2026-11-08'});assert.equal(reports.snapshot({date:'2026-11-08'}).collected,false);
  f.setTime('2026-11-09T12:00:00');await reports.runScheduled();assert.equal(f.calls.length,2,'当天的未完整采集仍需补齐');
  await reports.action('collect',{date:'2026-11-07'});await reports.runScheduled();assert.equal(f.calls.length,3,'切换日期不会丢失昨天的成功记录');
  assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
});

test('a successful periodic lookback already covers yesterday without a second request',async t=>{
  const f=fixture(t,{time:'2026-11-09T12:00:00'}),reports=f.create();await configure(f,reports,{autoCollect:true,lookbackDays:7});
  await reports.runScheduled();assert.equal(f.calls.length,1);assert.equal(f.calls[0].since,at('2026-11-09T12:00:00')-7*86400000);
  assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
  await reports.action('settings',{autoCollect:false});reports.close();await f.create().runScheduled();assert.equal(f.calls.length,1);
});

test('failed sources retry later and disabling the module prevents collection',async t=>{
  let fail=true;const f=fixture(t,{time:'2026-11-09T12:00:00',collector:async()=>{if(fail)throw Error('fixture unavailable');return [];}}),reports=f.create();await configure(f,reports);
  reports.setModuleEnabled(false);await reports.runScheduled();assert.equal(f.calls.length,0);
  reports.setModuleEnabled(true);await reports.runScheduled();assert.equal(f.calls.length,1);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,false);
  fail=false;await reports.runScheduled();await reports.runScheduled();assert.equal(f.calls.length,2);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
});

test('the noon timer does not wait for a long periodic interval or advance that periodic collection',async t=>{
  const f=fixture(t,{time:'2026-11-09T11:59:00'}),reports=f.create();await configure(f,reports,{autoCollect:true,intervalMinutes:1440});
  reports.start();await reports.runScheduled();assert.equal(f.calls.length,1);
  // 此次启动的回溯采集已经覆盖昨天；明天中午仍需补采今天，不能等 24 小时间隔之后再补。
  await f.advance('2026-11-09T12:00:00');assert.equal(f.calls.length,1,'中午不重复执行周期采集');
  await f.advance('2026-11-10T11:59:00');assert.equal(f.calls.length,2,'周期采集仍按原来的 24 小时间隔');
  await f.advance('2026-11-10T12:00:00');assert.equal(f.calls.length,2,'周期采集已覆盖昨天时不额外请求');
  await reports.action('settings',{autoCollect:false});
  await f.advance('2026-11-11T12:00:00');assert.equal(f.calls.length,3,'关闭周期采集后仍在北京时间中午补采');
  assert.equal(f.calls.at(-1).since,at('2026-11-10T00:00:00'));
});

test('all configured sources must succeed and changing the source scope requires a new collection',async t=>{
  let fail=true;const f=fixture(t,{time:'2026-11-09T12:00:00',collector:async source=>{if(source.project==='第二个项目'&&fail)throw Error('fixture unavailable');return [];}}),reports=f.create();
  await configure(f,reports,{repositories:[{path:f.dir,project:'第一个项目',authors:'cy@example.test'},{path:path.join(f.dir,'second'),project:'第二个项目',authors:'cy@example.test'}]});
  await reports.runScheduled();assert.equal(f.calls.length,2);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,false);
  fail=false;await reports.runScheduled();await reports.runScheduled();assert.equal(f.calls.length,4);
  await configure(f,reports);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,false);await reports.runScheduled();assert.equal(f.calls.length,5);
  await reports.action('settings',{weeklyTemplate:'# 新的排版\n{{summary}}'});await reports.runScheduled();assert.equal(f.calls.length,5,'修改周报排版不会重复采集');
});

test('legacy successful source scopes are recognized without rewriting the file on read',async t=>{
  const f=fixture(t,{time:'2026-11-09T12:00:00'}),reports=f.create();await configure(f,reports);await reports.action('collect',{date:'2026-11-08'});reports.close();
  const file=path.join(f.dir,'work-reports.json'),saved=JSON.parse(fs.readFileSync(file));delete saved.collectedDays;fs.writeFileSync(file,JSON.stringify(saved));const before=fs.readFileSync(file);
  const reopened=f.create();assert.equal(reopened.snapshot({date:'2026-11-08'}).collected,true);assert.deepEqual(fs.readFileSync(file),before);
  await reopened.runScheduled();assert.equal(f.calls.length,1,'升级后不重采已有完整成功结果');
});

test('failed disk writes do not mark yesterday complete and a later scheduled check can recover',async t=>{
  const f=fixture(t,{time:'2026-11-09T12:00:00'}),reports=f.create();await configure(f,reports);const temporary=path.join(f.dir,'work-reports.json.tmp');fs.mkdirSync(temporary);
  await reports.runScheduled();assert.equal(reports.snapshot({date:'2026-11-08'}).collected,false);assert.match(reports.snapshot().error,/保存失败/);
  fs.rmdirSync(temporary);await reports.runScheduled();assert.equal(f.calls.length,2);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
  reports.close();await f.create().runScheduled();assert.equal(f.calls.length,2);
});

for(const date of ['2026-11-07','2026-11-08'])test('noon catchup waits for an in-flight manual collection of '+date,async t=>{
  let finish,first=true;const f=fixture(t,{time:'2026-11-09T12:00:00',collector:async()=>{if(!first)return [];first=false;return new Promise(resolve=>{finish=resolve;});}}),reports=f.create();await configure(f,reports);
  const manual=reports.action('collect',{date});await new Promise(setImmediate);const scheduled=reports.runScheduled();await new Promise(setImmediate);assert.equal(f.calls.length,1);
  finish([]);await Promise.all([manual,scheduled]);assert.equal(f.calls.length,date==='2026-11-08'?1:2);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
});

test('disabling during automatic catchup discards late results and permits a later attempt',async t=>{
  let finish,first=true;const f=fixture(t,{time:'2026-11-09T12:00:00',collector:async()=>{if(!first)return [];first=false;return new Promise(resolve=>{finish=resolve;});}}),reports=f.create();await configure(f,reports);
  const pending=reports.runScheduled();await new Promise(setImmediate);reports.setModuleEnabled(false);finish([]);await pending;
  assert.equal(reports.snapshot({date:'2026-11-08'}).collected,false);reports.setModuleEnabled(true);await reports.runScheduled();assert.equal(f.calls.length,2);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
});

test('the daily timer retries failed catchup within fifteen minutes without waiting a day',async t=>{
  let fail=true;const f=fixture(t,{time:'2026-11-09T12:00:00',collector:async()=>{if(fail)throw Error('fixture unavailable');return [];}}),reports=f.create();await configure(f,reports,{intervalMinutes:1440});
  reports.start();await reports.runScheduled();assert.equal(f.calls.length,1);fail=false;
  await f.advance('2026-11-09T12:14:59.999');assert.equal(f.calls.length,1);
  await f.advance('2026-11-09T12:15:00');assert.equal(f.calls.length,2);assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
  await f.advance('2026-11-09T23:59:00');assert.equal(f.calls.length,2,'成功后当天不再补采');
});

test('an earlier periodic save failure does not prevent the independent noon timer from running',async t=>{
  const f=fixture(t,{time:'2026-11-09T11:59:00'}),reports=f.create();await configure(f,reports,{autoCollect:true,intervalMinutes:1440});const temporary=path.join(f.dir,'work-reports.json.tmp');fs.mkdirSync(temporary);
  reports.start();await reports.runScheduled();assert.equal(f.calls.length,1);fs.rmdirSync(temporary);
  await f.advance('2026-11-09T12:00:00');assert.equal(f.calls.length,2);assert.equal(f.calls.at(-1).since,at('2026-11-08T00:00:00'));assert.equal(reports.snapshot({date:'2026-11-08'}).collected,true);
});
