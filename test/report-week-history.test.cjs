'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkReports}=require('../src/app/work-reports.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-week-history-')),vault=path.join(dir,'vault');fs.mkdirSync(vault);
  const reports=createWorkReports({dataDir:dir,readEnvironment:()=>({archiveDir:vault}),now:()=>Date.parse('2026-11-08T12:00:00+08:00')});
  t.after(()=>{reports.close();fs.rmSync(dir,{recursive:true,force:true});});
  function note(relative,content){const file=path.join(vault,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file;}
  return {dir,vault,reports,note};
}
test('weekly history reads app drafts and existing Obsidian reports without generating or changing either',async t=>{
  const f=fixture(t),manual='---\ntype: weekly-report\nperiod_start: "2026-10-26"\nperiod_end: "2026-10-30"\n---\n\n# 手工完成的周报\n\n保留原文与 [[来源日志]]。\n';
  const file=f.note('03-报告/2026/周报/2026-10-26至2026-10-30-周报.md',manual);
  f.note('周报/2026-10-19.md','<!-- deepsleep:weekly:2026-10-19:start -->\n# 以前的归档\n旧成果\n<!-- deepsleep:weekly:2026-10-19:end -->\n');
  f.note('90-模板/周报模板.md','# 不是历史周报');f.note('日报/2026-11-07.md','# 日报');
  await f.reports.action('save-week',{date:'2026-11-04',content:'# 本周草稿\n保留手工总结'});
  const ledger=fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8');
  const history=await f.reports.action('list-weeks');
  assert.deepEqual(history.items.map(i=>[i.source,i.start,i.end]),[['draft','2026-11-02','2026-11-08'],['obsidian','2026-10-26','2026-10-30'],['obsidian','2026-10-19','2026-10-25']]);
  assert.ok(history.items.every(i=>i.content===undefined),'列表只返回摘要');
  assert.equal((await f.reports.action('read-week',{id:history.items[1].id})).content,manual);
  assert.match((await f.reports.action('read-week',{id:history.items[0].id})).content,/保留手工总结/);
  assert.equal(fs.readFileSync(file,'utf8'),manual);assert.equal(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),ledger);
  assert.equal((await f.reports.action('get-week',{date:'2026-10-28'})).content,'','查看旧稿不创建应用草稿');
});
test('history rejects outside paths, links, oversized and malformed files, and rechecks deleted files and changed roots',async t=>{
  const f=fixture(t),secret=path.join(f.dir,'outside.md');fs.writeFileSync(secret,'outside-secret');
  const file=f.note('周报/2026-10-26.md','# 原稿');
  fs.symlinkSync(secret,path.join(f.vault,'周报/2026-10-19.md'));
  fs.linkSync(secret,path.join(f.vault,'周报/2026-10-12.md'));
  const outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'2026-10-05.md'),'outside-secret');fs.symlinkSync(outside,path.join(f.vault,'周报/链接目录'));
  f.note('周报/2026-10-05.md','a'.repeat(200001));f.note('周报/2026-02-30.md','# 无效日期');
  f.note('周报/2026-10-01至2026-10-02-周报.md','---\nperiod_start: "2026-02-30"\nperiod_end: "2026-10-02"\n---\n# 日期不能被文件名掩盖');
  const history=await f.reports.action('list-weeks');assert.equal(history.items.length,1);
  for(const id of ['../outside.md','obsidian:../../outside.md','draft:2026-11-02',null])await assert.rejects(f.reports.action('read-week',{id}),/不存在|有效/);
  fs.writeFileSync(file,'# 新的人工修改');assert.equal((await f.reports.action('read-week',{id:history.items[0].id})).content,'# 新的人工修改');
  fs.unlinkSync(file);await assert.rejects(f.reports.action('read-week',{id:history.items[0].id}),/不存在/);
  f.note('周报/2026-10-26.md','# 原稿');const another=path.join(f.dir,'another');fs.mkdirSync(another);
  await assert.rejects(f.reports.action('settings',{weeklyDir:'../outside'}),/相对路径/);
  await f.reports.action('settings',{archiveDir:another});await assert.rejects(f.reports.action('read-week',{id:history.items[0].id}),/不存在/);
});
test('draft history remains available without an Obsidian directory and when the module is disabled',async t=>{
  const f=fixture(t);await f.reports.action('save-week',{date:'2026-11-02',content:'手工草稿'});
  await f.reports.action('settings',{archiveDir:''});f.reports.setModuleEnabled(false);
  const history=await f.reports.action('list-weeks');assert.equal(history.items.length,1);
  assert.equal((await f.reports.action('read-week',{id:history.items[0].id})).content,'手工草稿');
});
