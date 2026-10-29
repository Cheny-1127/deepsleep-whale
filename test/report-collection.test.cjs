'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkReports}=require('../src/app/work-reports.cjs');
const NOW=Date.parse('2026-10-28T20:00:00+08:00'),at=date=>Date.parse(date+'T12:00:00+08:00');
function fixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-report-collection-'));
  const reports=createWorkReports({dataDir:dir,now:()=>NOW,readEnvironment:()=>({}),...options});
  t.after(()=>{reports.close();fs.rmSync(dir,{recursive:true,force:true});});return {reports,dir};
}
const entry=(date,title=date)=>({source:'git',sourceKey:'git:fixture:'+date,title,date,project:'测试项目',status:'done',sourceMeta:{committedAt:at(date)}});

test('manual collection passes only the selected Shanghai day to every source and records that scope',async t=>{
  const calls=[],collector=kind=>async(source,options)=>{calls.push({kind,options});return [];};
  const {reports,dir}=fixture(t,{gitCollector:collector('git'),gitlabCollector:collector('gitlab'),jenkinsCollector:collector('jenkins')});
  await reports.action('settings',{repositories:[{path:dir,project:'测试项目',authors:'cy@example.test'}],gitlabProjects:[{host:'https://gitlab.example.test',projectId:7,project:'business/pay'}],gitlabAuthors:'cy@example.test',jenkinsJobs:[{job:'prod/pay',project:'business/pay',userIds:'cy',environment:'prod'}]});
  await reports.action('collect',{date:'2026-10-27'});
  assert.deepEqual(calls.map(call=>call.kind),['git','gitlab','jenkins']);
  for(const {options} of calls){assert.equal(options.since,Date.parse('2026-10-27T00:00:00+08:00'));assert.equal(options.until,Date.parse('2026-10-27T23:59:59.999+08:00'));}
  for(const source of reports.snapshot().sources){assert.equal(source.date,'2026-10-27');assert.equal(source.since,calls[0].options.since);assert.equal(source.until,calls[0].options.until);}
});

test('updating one day preserves other days and manual edits even when a collector returns tracked historical entries',async t=>{
  let items=[entry('2026-10-26','原有工作')];const {reports,dir}=fixture(t,{gitCollector:async()=>items});
  await reports.action('settings',{repositories:[{path:dir,project:'测试项目',authors:'cy@example.test'}]});
  await reports.action('collect',{date:'2026-10-26'});const before=reports.snapshot({date:'2026-10-26'}).entries;
  items=[entry('2026-10-26','不应改写其他日'),entry('2026-10-27','当天新工作'),entry('2026-10-28','不应新增其他日')];
  await reports.action('collect',{date:'2026-10-27'});
  assert.deepEqual(reports.snapshot({date:'2026-10-26'}).entries,before);assert.equal(reports.snapshot({date:'2026-10-28'}).entries.length,0);
  const imported=reports.snapshot({date:'2026-10-27'}).entries[0];await reports.action('save-entry',{...imported,title:'保留人工说明',included:false});
  items=[entry('2026-10-27','新来源标题')];await reports.action('collect',{date:'2026-10-27'});
  const updated=reports.snapshot({date:'2026-10-27'}).entries;assert.equal(updated.length,1);assert.equal(updated[0].title,'保留人工说明');assert.equal(updated[0].included,false);
});

test('today collection stops at now and invalid or future dates never call collectors',async t=>{
  const calls=[];const {reports,dir}=fixture(t,{gitCollector:async(source,options)=>{calls.push(options);return [];}});
  await reports.action('settings',{repositories:[{path:dir,project:'测试项目',authors:'cy@example.test'}]});await reports.action('collect');
  assert.equal(calls[0].since,Date.parse('2026-10-28T00:00:00+08:00'));assert.equal(calls[0].until,NOW);
  await assert.rejects(reports.action('collect',{date:'2026-10-29'}),/未来/);await assert.rejects(reports.action('collect',{date:'2026-02-30'}),/有效日期/);assert.equal(calls.length,1);
});

test('manual collection syncs planner changes only for the selected completion day',async t=>{
  let tasks=['2026-10-26','2026-10-27'].map(date=>({id:date,title:'原有工作 '+date,category:'work',completedAt:at(date)}));
  const {reports}=fixture(t,{getTasks:()=>tasks});await reports.action('sync-planner');
  const before=reports.snapshot({date:'2026-10-26'}).entries;
  tasks=tasks.map(task=>({...task,title:'更新后的工作 '+task.id}));await reports.action('collect',{date:'2026-10-27'});
  assert.deepEqual(reports.snapshot({date:'2026-10-26'}).entries,before);assert.equal(reports.snapshot({date:'2026-10-27'}).entries[0].title,'更新后的工作 2026-10-27');
  delete tasks[1].completedAt;await reports.action('collect',{date:'2026-10-27'});
  assert.equal(reports.snapshot({date:'2026-10-27'}).entries[0].sourceActive,false);assert.deepEqual(reports.snapshot({date:'2026-10-26'}).entries,before);
});

test('automatic collection retains the configured lookback independently of the manual selected day',async t=>{
  const calls=[];const {reports,dir}=fixture(t,{gitCollector:async(source,options)=>{calls.push(options);return [];}});
  await reports.action('settings',{autoCollect:true,lookbackDays:7,repositories:[{path:dir,project:'测试项目',authors:'cy@example.test'}]});await reports.runScheduled();
  assert.equal(calls[0].since,NOW-7*86400000);assert.equal(calls[0].until,NOW);
  await reports.action('collect',{date:'2026-10-27'});assert.equal(calls[1].since,Date.parse('2026-10-27T00:00:00+08:00'));
});

test('a day refresh retires only that day releases and keeps failed-source data',async t=>{
  const host='https://jenkins.example.test',job='prod/pay',project='business/pay';let items=[],failure=false;
  const {reports}=fixture(t,{readEnvironment:()=>({jenkinsUrl:host}),jenkinsCollector:async()=>{if(failure)throw Object.assign(Error('来源读取失败'),{reportSafe:true});return items;}});
  await reports.action('settings',{jenkinsJobs:[{job,project,userIds:'cy',environment:'prod'}]});
  const release=date=>({source:'jenkins',sourceKey:'jenkins:'+host+'/job/prod/job/pay/:'+Number(date.slice(-2)),title:date,date,project,status:'done',sourceMeta:{buildNumber:Number(date.slice(-2)),completedAt:at(date)}});
  for(const date of ['2026-10-26','2026-10-27']){items=[release(date)];await reports.action('collect',{date});}
  const previous=reports.snapshot({date:'2026-10-26'}).entries;assert.equal(previous[0].sourceActive,true);
  items=[];failure=true;await reports.action('collect',{date:'2026-10-27'});assert.notEqual(reports.snapshot({date:'2026-10-27'}).entries[0].sourceActive,false);
  failure=false;await reports.action('collect',{date:'2026-10-27'});assert.equal(reports.snapshot({date:'2026-10-27'}).entries[0].sourceActive,false);assert.deepEqual(reports.snapshot({date:'2026-10-26'}).entries,previous);
});

test('concurrent requests for different dates never reuse the other day collection result',async t=>{
  let finish,calls=0;const {reports,dir}=fixture(t,{gitCollector:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  await reports.action('settings',{repositories:[{path:dir,project:'测试项目',authors:'cy@example.test'}]});
  const first=reports.action('collect',{date:'2026-10-27'});await new Promise(setImmediate);
  const same=reports.action('collect',{date:'2026-10-27'}),different=assert.rejects(reports.action('collect',{date:'2026-10-26'}),/正在采集其他/);
  finish([]);await Promise.all([first,same,different]);assert.equal(calls,1);
});
