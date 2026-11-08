'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkReports}=require('../src/app/work-reports.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-continuous-week-')),vault=path.join(dir,'vault');fs.mkdirSync(vault);
  let time=Date.parse('2026-11-08T12:00:00+08:00');const instances=[];
  const create=()=>{const reports=createWorkReports({dataDir:dir,readEnvironment:()=>({archiveDir:vault}),now:()=>time});instances.push(reports);return reports;};
  t.after(()=>{instances.forEach(r=>r.close());fs.rmSync(dir,{recursive:true,force:true});});
  const note=(start,end)=>{const folder=path.join(vault,'03-报告/2026/周报');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,`${start}至${end}-周报.md`);fs.writeFileSync(file,`---\nperiod_start: "${start}"\nperiod_end: "${end}"\n---\n# 手工周报\n保留原文。`);return file;};
  return {dir,vault,create,note,setDate:date=>{time=Date.parse(date+'T12:00:00+08:00');}};
}
test('manual reports continue after the last covered date through the writing date, across weekends and restart',async t=>{
  const f=fixture(t),file=f.note('2026-10-26','2026-10-30'),original=fs.readFileSync(file,'utf8'),reports=f.create();
  f.note('2026-11-09','2026-11-13'); // 未来报告不能移动这次的采集起点。
  for(const [date,title] of [['2026-10-30','已写过的成果'],['2026-10-31','周六工作'],['2026-11-01','周日工作'],['2026-11-02','周一工作'],['2026-11-08','写报告当天工作'],['2026-11-09','之后的工作']])await reports.action('save-entry',{date,title,status:'done'});
  const ledger=fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),draft=await reports.action('get-week',{date:'2026-11-08',continuous:true});
  assert.deepEqual([draft.start,draft.end,draft.content],['2026-10-31','2026-11-08','']);
  assert.equal(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),ledger,'查看范围不推进记录');
  const period={start:draft.start,end:draft.end},generated=await reports.action('generate-week',period);
  for(const title of ['周六工作','周日工作','周一工作','写报告当天工作'])assert.ok(generated.content.includes(title));
  assert.doesNotMatch(generated.content,/已写过的成果|之后的工作/);assert.match(generated.content,/2026-10-31 ～ 2026-11-08/);
  await reports.action('save-week',{...period,content:generated.content+'\n人工补充。'});
  await assert.rejects(reports.action('generate-week',period),/手动编辑/);
  const archived=await reports.action('archive-week',period);
  assert.equal(path.basename(archived.path),'2026-10-31至2026-11-08-周报.md');assert.match(fs.readFileSync(archived.path,'utf8'),/人工补充/);
  const history=await reports.action('list-weeks');assert.ok(history.items.some(i=>i.source==='obsidian'&&i.start===period.start&&i.end===period.end));
  reports.close();const restarted=f.create();assert.match((await restarted.action('get-week',{date:period.end,continuous:true})).content,/人工补充/);
  f.setDate('2026-11-09');const next=await restarted.action('get-week',{date:'2026-11-09',continuous:true});assert.deepEqual([next.start,next.end],['2026-11-09','2026-11-09']);
  assert.equal(fs.readFileSync(file,'utf8'),original,'不修改上一份手工周报');
  fs.appendFileSync(archived.path,'\n外部注释保留\n');await restarted.action('archive-week',period);assert.match(fs.readFileSync(archived.path,'utf8'),/外部注释保留/);
  fs.writeFileSync(archived.path,fs.readFileSync(archived.path,'utf8').replace('人工补充','Obsidian 人工改稿'));
  await assert.rejects(restarted.action('archive-week',period),/手动修改/);
});
test('first continuous report starts at the earliest included work, and reading without work does not invent a week',async t=>{
  const f=fixture(t),reports=f.create();
  assert.deepEqual(((r)=>[r.start,r.end])(await reports.action('get-week',{date:'2026-11-08',continuous:true})),['2026-11-08','2026-11-08']);
  await reports.action('save-entry',{date:'2026-10-01',title:'不纳入',status:'done',included:false});
  await reports.action('save-entry',{date:'2026-10-31',title:'最早工作',status:'done'});
  const draft=await reports.action('get-week',{date:'2026-11-08',continuous:true});assert.deepEqual([draft.start,draft.end],['2026-10-31','2026-11-08']);
  await reports.action('save-week',{start:draft.start,end:'2026-11-07',content:'上一份已保存'});
  const next=await reports.action('get-week',{date:'2026-11-08',continuous:true});assert.deepEqual([next.start,next.end],['2026-11-08','2026-11-08']);
  await reports.action('settings',{archiveDir:path.join(f.dir,'missing')});
  await assert.rejects(reports.action('get-week',{date:'2026-11-08',continuous:true}),/无法完整读取历史周报/);
});
test('explicit periods remain distinct from natural weeks and validate before changing saved data',async t=>{
  const f=fixture(t),reports=f.create();
  await reports.action('save-week',{date:'2026-11-08',content:'原自然周草稿'});
  for(const end of ['2026-11-07','2026-11-08'])await reports.action('save-week',{start:'2026-10-31',end,content:'连续草稿 '+end});
  const ledger=fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8');
  for(const value of [{start:'2026-11-08',end:'2026-10-31'},{start:'2026-02-30',end:'2026-11-08'},{start:'../../outside',end:'2026-11-08'},{start:'2026-10-31'}])for(const action of ['get-week','generate-week','save-week','archive-week'])await assert.rejects(reports.action(action,{...value,content:'不可保存'}),/日期|范围/);
  await assert.rejects(reports.action('get-week',{date:'2026-11-09',continuous:true}),/未来/);
  assert.equal(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),ledger);
  reports.close();const restarted=f.create();assert.equal((await restarted.action('get-week',{date:'2026-11-08'})).content,'原自然周草稿');
  for(const end of ['2026-11-07','2026-11-08'])assert.equal((await restarted.action('get-week',{start:'2026-10-31',end})).content,'连续草稿 '+end);
  assert.equal((await restarted.action('get-week',{date:'2026-11-08',continuous:true})).start,'2026-10-31');
  await restarted.action('settings',{autoWeekly:true});await restarted.runScheduled();assert.equal((await restarted.action('get-week',{start:'2026-10-31',end:'2026-11-08'})).content,'连续草稿 2026-11-08');
});
