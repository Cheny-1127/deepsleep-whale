'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkReports}=require('../src/app/work-reports.cjs');
const {createPlanner}=require('../src/app/planner.cjs');
const NOW=Date.parse('2026-10-26T18:00:00+08:00');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-reports-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const planner=createPlanner({dataDir:dir,now:()=>NOW});const instances=[];const create=(options={})=>{const reports=createWorkReports({dataDir:dir,now:()=>NOW,getTasks:()=>planner.snapshot().tasks,readEnvironment:()=>({}),...options});instances.push(reports);return reports;};t.after(()=>instances.forEach(item=>item.close()));return {dir,planner,create};}

test('editing an automatic MR work preserves its sources, accepts later commits and survives restart',async t=>{
  const f=fixture(t),date='2026-10-26',mr={iid:1,title:'原始 MR 标题',url:'https://gitlab.example.test/business/service/-/merge_requests/1'};let count=2;
  const reports=f.create({gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>Array.from({length:count},(_,i)=>({source:'gitlab',sourceKey:'gitlab:edit:'+i,title:'原始提交 '+i,project:'business/service',date,status:'done',sourceMeta:{mrChecked:true,mergeRequests:[mr]}}))});
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/service'}],gitlabAuthors:'cy@example.test'});await reports.action('collect');
  const before=reports.snapshot({date}),item=before.work.items[0];
  await assert.rejects(reports.action('save-work',{date,key:'missing',title:'新标题',description:''}),/不存在|事项已变化/);
  const saved=await reports.action('save-work',{date,key:item.key,title:'整理后的工作标题',description:'补充处理结果与回归结论'});
  assert.equal(saved.work.items.length,1);assert.equal(saved.work.items[0].title,'整理后的工作标题');assert.equal(saved.work.items[0].description,'补充处理结果与回归结论');assert.equal(saved.work.items[0].editOnly,true);assert.deepEqual(saved.entries,before.entries);
  await assert.rejects(reports.action('save-work',{date,id:saved.work.items[0].groupId,title:'',description:''}),/标题/);assert.deepEqual(reports.snapshot({date}),saved);
  count=3;await reports.action('collect');const after=reports.snapshot({date});assert.equal(after.work.items.length,1);assert.equal(after.work.items[0].entryIds.length,3);assert.equal(after.work.items[0].title,'整理后的工作标题');
  const restarted=f.create();assert.equal(restarted.snapshot({date}).work.items[0].title,'整理后的工作标题');assert.equal(restarted.snapshot({date}).work.items[0].editOnly,true);assert.match((await restarted.action('preview-day',{date})).content,/补充处理结果与回归结论/);
  const restored=await restarted.action('unmerge-work',{date,id:after.work.items[0].groupId});assert.equal(restored.work.items.length,1);assert.equal(restored.work.items[0].title,mr.title);assert.deepEqual(restored.entries,after.entries);
});

test('editing one MR in a shared deployment never changes the other work or its evidence',async t=>{
  const f=fixture(t),date='2026-10-26',reports=f.create();await reports.action('save-entry',{date,title:'共享发布',project:'business/service',status:'done'});reports.close();
  const file=path.join(f.dir,'work-reports.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  Object.assign(saved.entries[0],{source:'jenkins',edited:false,sourceMeta:{release:true,rangeVerified:true,direction:'forward',target:'EKS',buildNumber:42,releasedAt:NOW,mergeRequests:[1,2].map(iid=>({iid,title:'事项 '+iid,url:'https://gitlab.example.test/business/service/-/merge_requests/'+iid}))}});fs.writeFileSync(file,JSON.stringify(saved));
  const current=f.create(),before=current.snapshot({date});assert.equal(before.work.items.length,2);assert.equal(before.work.items[0].memberKeys.length,1);
  const result=await current.action('save-work',{date,key:before.work.items[0].key,title:'补充处理结论',description:'只调整第一项工作'});
  assert.equal(result.work.items.length,2);assert.equal(result.work.items.find(item=>item.groupId).title,'补充处理结论');assert.equal(result.work.items.find(item=>item.mr?.iid===2).title,'事项 2');assert.equal(result.work.releaseCount,1);assert.deepEqual(result.entries,before.entries);
  const restarted=f.create().snapshot({date});assert.equal(restarted.error,'');assert.equal(restarted.work.items.length,2);assert.equal(restarted.work.items.find(item=>item.groupId).description,'只调整第一项工作');
});

test('removing an MR work removes its current commits together and survives restart and recollection',async t=>{
  const f=fixture(t),date='2026-10-26',mr={iid:119,title:'别人的支付功能',url:'https://gitlab.example.test/business/pay/-/merge_requests/119'};
  const reports=f.create({gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>Array.from({length:2},(_,i)=>({source:'gitlab',sourceKey:'gitlab:remove:'+i,title:'提交 '+i,date,project:'business/pay',status:'done',sourceMeta:{mrChecked:true,mergeRequests:[mr]}}))});
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/pay'}],gitlabAuthors:'cy@example.test'});await reports.action('collect');await reports.action('save-entry',{date,title:'我自己的工作',status:'done'});
  const before=reports.snapshot({date}),work=before.work.items.find(item=>item.mr),remaining=before.entries.filter(entry=>!work.entryIds.includes(entry.id));
  const removed=await reports.action('remove-work',{date,key:work.key});assert.equal(removed.work.items.length,1);assert.deepEqual(removed.entries,remaining);assert.equal(f.create().snapshot({date}).work.items.length,1);
  await reports.action('collect');assert.deepEqual(reports.snapshot({date}).entries,remaining);assert.doesNotMatch((await reports.action('preview-day',{date})).content,/别人的支付功能|提交/);
});

test('removing a merged work is atomic and preserves other dates and saved drafts',async t=>{
  const f=fixture(t),reports=f.create(),date='2026-10-26';
  for(const title of ['需求讨论','方案整理'])await reports.action('save-entry',{date,title,status:'done'});
  const merged=await reports.action('merge-work',{date,keys:reports.snapshot({date}).work.items.map(item=>item.key),title:'需求与方案',description:''}),work=merged.work.items[0];
  await reports.action('save-entry',{date:'2026-10-27',title:'下一天的工作',status:'done'});await reports.action('save-week',{date,content:'已保存的手工周报'});
  const before=reports.snapshot({date});await assert.rejects(reports.action('remove-work',{date:'2026-10-27',key:work.key}),/事项已变化/);
  fs.mkdirSync(path.join(f.dir,'work-reports.json.tmp'));await assert.rejects(reports.action('remove-work',{date,key:work.key}),/保存失败/);fs.rmdirSync(path.join(f.dir,'work-reports.json.tmp'));assert.deepEqual(reports.snapshot({date}).entries,before.entries);assert.equal(reports.snapshot({date}).work.items.length,1);
  const removed=await reports.action('remove-work',{date,key:work.key});assert.equal(removed.entries.length,0);assert.equal(removed.work.items.length,0);assert.equal(reports.snapshot({date:'2026-10-27'}).work.items.length,1);assert.equal((await reports.action('get-week',{date})).content,'已保存的手工周报');
  await assert.rejects(reports.action('remove-work',{date,key:work.key}),/事项已变化/);
});

test('removing a work cannot delete a deployment source shared with another MR',async t=>{
  const f=fixture(t),date='2026-10-26',reports=f.create();await reports.action('save-entry',{date,title:'共享发布',status:'done'});reports.close();
  const file=path.join(f.dir,'work-reports.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  Object.assign(saved.entries[0],{source:'jenkins',edited:false,sourceMeta:{release:true,rangeVerified:true,direction:'forward',releasedAt:NOW,mergeRequests:[1,2].map(iid=>({iid,title:'事项 '+iid,url:'https://gitlab.example.test/business/service/-/merge_requests/'+iid}))}});fs.writeFileSync(file,JSON.stringify(saved));
  const current=f.create(),before=current.snapshot({date});await assert.rejects(current.action('remove-work',{date,key:before.work.items[0].key}),/共用来源/);assert.deepEqual(current.snapshot({date}),before);
});

test('a merged work stays a merge when one source is excluded',async t=>{
  const f=fixture(t),reports=f.create(),date='2026-10-26';
  for(const title of ['需求访谈','方案整理'])await reports.action('save-entry',{date,title,status:'done'});
  const before=reports.snapshot({date}),merged=await reports.action('merge-work',{date,keys:before.work.items.map(item=>item.key),title:'需求与方案',description:'整理处理结果'});
  await reports.action('set-entry-included',{id:before.entries[0].id,included:false});
  const current=reports.snapshot({date});assert.equal(current.work.items.length,1);assert.equal(current.work.items[0].groupId,merged.work.items[0].groupId);assert.equal(current.work.items[0].editOnly,false);assert.equal(f.create().snapshot({date}).work.items[0].editOnly,false);
});

test('collection carries a feature from branch development through main merge to production without rewriting past days',async t=>{
  const f=fixture(t),host='https://gitlab.example.test',project='business/pay',branch='feat-cy-pay',mergedAt=Date.parse('2026-10-27T17:00:00+08:00'),releasedAt=Date.parse('2026-10-28T16:00:00+08:00');let stage=0,currentTime=NOW;
  const raw={iid:1,project_id:1,title:'新增支付方式',state:'merged',source_branch:branch,target_branch:'main',merged_at:new Date(mergedAt).toISOString()},mr={iid:1,title:raw.title,url:host+'/'+project+'/-/merge_requests/1',state:'merged',sourceBranch:branch,targetBranch:'main',mergedAt};
  const reports=f.create({now:()=>currentTime,gitlabStore:{load:()=>({url:host,token:'fixture'})},gitlabFetchImpl:async url=>{
    const path=new URL(url).pathname;
    return Response.json(path.endsWith('/repository/commits')?[{id:'a'.repeat(40),title:'开发支付方式',message:'开发支付方式\n补充支付处理',author_name:'cy',author_email:'cy@example.test',committed_date:'2026-10-26T10:00:00+08:00'}]:path.endsWith('/refs')?[{type:'branch',name:branch}]:path.endsWith('/merge_requests/1')?raw:stage?[raw]:[],{headers:{'x-next-page':''}});
  },jenkinsCollector:async()=>stage<2?[]:[{source:'jenkins',sourceKey:'jenkins:feature:42',date:'2026-10-28',title:'发布完成',project,status:'done',sourceMeta:{release:true,environment:'prod',direction:'forward',rangeVerified:true,releasedAt,completedAt:releasedAt,mergeRequests:[mr]}}]});
  await reports.action('settings',{gitlabProjects:[{host,projectId:1,project}],gitlabAuthors:'cy@example.test',jenkinsJobs:[{job:'prod/pay',project,environment:'prod',target:'EKS',userIds:'cy'}]});await reports.action('collect');assert.equal(reports.snapshot({date:'2026-10-26'}).work.items[0].badge,'开发中');
  const initial=reports.snapshot({date:'2026-10-26'});await reports.action('save-work',{date:initial.date,key:initial.work.items[0].key,title:raw.title,description:'保留开发说明'});assert.deepEqual(reports.snapshot({date:initial.date}).entries,initial.entries);
  stage=1;currentTime=Date.parse('2026-10-27T18:00:00+08:00');await reports.action('collect');assert.equal(reports.snapshot({date:'2026-10-27'}).work.items[0].badge,'待发布');assert.equal(reports.snapshot({date:'2026-10-26'}).work.items[0].badge,'开发中');await reports.action('save-week',{date:'2026-10-26',content:'保留人工周报'});
  stage=2;currentTime=Date.parse('2026-10-28T18:00:00+08:00');await reports.action('collect');
  assert.equal(reports.snapshot({date:'2026-10-28'}).work.items[0].badge,'已完成');assert.equal(reports.snapshot({date:'2026-10-28'}).work.items[0].completedAt,releasedAt);assert.equal(reports.snapshot({date:'2026-10-27'}).work.items[0].badge,'待发布');assert.equal(reports.snapshot({date:'2026-10-26'}).work.items[0].badge,'开发中');assert.equal((await reports.action('get-week',{date:'2026-10-28'})).content,'保留人工周报');
  const week=await reports.action('generate-week',{date:'2026-10-28',force:true});assert.equal((week.content.match(/\*\*新增支付方式\*\*/g)||[]).length,1);assert.match(week.content,/已完成/);assert.match(week.content,/保留开发说明/);assert.equal(f.create().snapshot({date:'2026-10-27'}).work.items[0].badge,'待发布');
});

test('work merging keeps planner and MR evidence intact through restart, recollection, editing and unmerge',async t=>{
  const f=fixture(t),mr={iid:1,title:'修复会员缓存永久有效',url:'https://gitlab.example.test/business/service/-/merge_requests/1'};
  let count=1;
  const reports=f.create({gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>Array.from({length:count},(_,i)=>({source:'gitlab',sourceKey:'gitlab:fixture:'+i,title:'原始提交 '+i,project:'business/service',date:'2026-10-26',status:'done',sourceMeta:{mrChecked:true,mergeRequests:[mr]}}))});
  const task=f.planner.action('save-task',{title:'调整 VIP 缓存',notes:'修复临近过期时的判断',deadline:'none',category:'work'}).tasks[0];f.planner.action('set-task-status',{id:task.id,status:'done'});
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/service'}],gitlabAuthors:'cy@example.test'});await reports.action('collect');
  const before=reports.snapshot({date:'2026-10-26'});assert.equal(before.work.items.length,2);
  const merged=await reports.action('merge-work',{date:before.date,keys:before.work.items.map(i=>i.key),title:task.title,description:task.notes});
  assert.equal(merged.work.items.length,1);assert.equal(merged.work.items[0].title,task.title);assert.deepEqual(merged.entries,before.entries);assert.ok(merged.work.items[0].groupId);
  count=2;await reports.action('collect');const after=reports.snapshot({date:before.date});assert.equal(after.work.items.length,1);assert.equal(after.work.items[0].entryIds.length,3);assert.equal(after.work.items[0].description,task.notes);
  assert.equal(f.create().snapshot({date:before.date}).work.items.length,1);
  assert.match((await reports.action('preview-day',{date:before.date})).content,/今日工作 1 项/);assert.match((await reports.action('generate-week',{date:before.date})).content,/调整 VIP 缓存/);
  const groupId=after.work.items[0].groupId;await reports.action('save-work',{date:before.date,id:groupId,title:'修复 VIP 缓存过期判断',description:'保留完成结果'});
  assert.equal(reports.snapshot({date:before.date}).work.items[0].title,'修复 VIP 缓存过期判断');
  const vault=path.join(f.dir,'vault');fs.mkdirSync(vault);await reports.action('settings',{archiveDir:vault});await reports.action('archive-day',{date:before.date});
  const archived=fs.readFileSync(path.join(vault,'日报',before.date+'.md'),'utf8');assert.match(archived,/今日工作 1 项/);assert.match(archived,/保留完成结果/);assert.doesNotMatch(archived,/原始提交/);
  const restored=await reports.action('unmerge-work',{date:before.date,id:groupId});assert.equal(restored.work.items.length,2);assert.deepEqual(restored.entries,after.entries);
  assert.equal(f.create().snapshot({date:before.date}).work.items.length,2);
});

test('work merging needs no MR, stays within the day and preserves exclusions, drafts and write-failure state',async t=>{
  const f=fixture(t),reports=f.create();
  for(const [title,date,status] of [['访谈记录','2026-10-26','done'],['整理访谈结论','2026-10-26','done'],['后续计划','2026-10-26','planned'],['其他日期','2026-10-27','done']])await reports.action('save-entry',{title,date,status});
  const first=reports.snapshot({date:'2026-10-26'}),keys=first.work.items.filter(i=>i.status==='done').map(i=>i.key),input={date:first.date,keys,title:'完成需求访谈',description:'整理需求和结论'};
  await assert.rejects(reports.action('merge-work',{...input,keys:[keys[0]]}),/至少选择/);
  await assert.rejects(reports.action('merge-work',{...input,keys:[keys[0],'missing']}),/事项已变化/);
  await assert.rejects(reports.action('merge-work',{...input,keys:[keys[0],first.work.items.find(i=>i.status==='planned').key]}),/工作计划|待解决/);
  fs.mkdirSync(path.join(f.dir,'work-reports.json.tmp'));await assert.rejects(reports.action('merge-work',input),/保存失败/);assert.equal(reports.snapshot({date:first.date}).work.items.length,3);fs.rmdirSync(path.join(f.dir,'work-reports.json.tmp'));
  await reports.action('save-week',{date:first.date,content:'保留人工周报'});const merged=await reports.action('merge-work',input),group=merged.work.items.find(i=>i.groupId);
  assert.equal(group.entryIds.length,2);assert.equal(merged.work.items.length,2);assert.equal(reports.snapshot({date:'2026-10-27'}).work.items.length,1);assert.equal((await reports.action('get-week',{date:first.date})).content,'保留人工周报');
  await reports.action('set-entry-included',{id:group.entryIds[0],included:false});assert.equal(reports.snapshot({date:first.date}).work.items.find(i=>i.groupId).entryIds.length,1);
  await reports.action('remove-entry',{id:group.entryIds[1]});assert.equal(reports.snapshot({date:first.date}).work.items.some(i=>i.groupId),false);
  await reports.action('unmerge-work',{date:first.date,id:group.groupId});assert.equal(reports.snapshot({date:first.date}).work.items.filter(i=>i.status==='done').length,0);
});

test('merging existing work groups flattens their sources and unmerge restores every original work',async t=>{
  const f=fixture(t),reports=f.create(),date='2026-10-26';
  for(const title of ['需求讨论','访谈结论','交互方案','方案确认'])await reports.action('save-entry',{date,title,status:'done'});
  const before=reports.snapshot({date}),keys=before.work.items.map(item=>item.key);
  const left=await reports.action('merge-work',{date,keys:keys.slice(0,2),title:'需求整理',description:'确认需求'}),leftKey=left.work.items.find(item=>item.groupId).key;
  const right=await reports.action('merge-work',{date,keys:keys.slice(2),title:'方案设计',description:'确认方案'}),rightKey=right.work.items.find(item=>item.groupId&&item.key!==leftKey).key;
  const merged=await reports.action('merge-work',{date,keys:[leftKey,rightKey],title:'完成需求与方案确认',description:'形成一致结论'});
  assert.equal(merged.work.items.length,1);assert.equal(merged.work.items[0].entryIds.length,4);assert.deepEqual(merged.entries,before.entries);
  const restarted=f.create();assert.equal(restarted.snapshot({date}).work.items.length,1);
  const restored=await restarted.action('unmerge-work',{date,id:merged.work.items[0].groupId});assert.equal(restored.work.items.length,4);assert.deepEqual(restored.entries,before.entries);
});

test('automatic work reminders preserve decisions through collection and restart, accept once and allow recovery',async t=>{
  const f=fixture(t),reports=f.create(),date='2026-10-26';
  await reports.action('save-entry',{date,title:'修复会员缓存过期判断',details:'处理临近过期时缓存永久有效的问题',status:'done'});
  await reports.action('save-entry',{date,title:'调整VIP播放缓存问题',details:'修复会员缓存永久有效的边界情况',status:'done'});
  const before=reports.snapshot({date});assert.equal(before.work.items.length,2);assert.equal(before.workMatches.items.length,1);
  const id=before.workMatches.items[0].id;
  fs.mkdirSync(path.join(f.dir,'work-reports.json.tmp'));await assert.rejects(reports.action('dismiss-work-match',{date,id}),/保存失败/);assert.equal(reports.snapshot({date}).workMatches.items.length,1);fs.rmdirSync(path.join(f.dir,'work-reports.json.tmp'));
  await reports.action('dismiss-work-match',{date,id});await reports.action('collect');assert.equal(reports.snapshot({date}).workMatches.items.length,0);assert.deepEqual(reports.snapshot({date}).entries,before.entries);
  const restarted=f.create();assert.equal(restarted.snapshot({date}).workMatches.items.length,0);assert.equal(restarted.snapshot({date}).workMatches.dismissedCount,1);
  await restarted.action('restore-work-matches',{date});assert.equal(restarted.snapshot({date}).workMatches.items[0].id,id);
  fs.mkdirSync(path.join(f.dir,'work-reports.json.tmp'));await assert.rejects(restarted.action('accept-work-match',{date,id}),/保存失败/);assert.equal(restarted.snapshot({date}).work.items.length,2);fs.rmdirSync(path.join(f.dir,'work-reports.json.tmp'));
  const merged=await restarted.action('accept-work-match',{date,id});assert.equal(merged.work.items.length,1);assert.equal(merged.workMatches.items.length,0);assert.deepEqual(merged.entries,before.entries);
  await assert.rejects(restarted.action('accept-work-match',{date,id}),/提醒已变化/);
  await restarted.action('unmerge-work',{date,id:merged.work.items[0].groupId});assert.equal(restarted.snapshot({date}).work.items.length,2);assert.equal(restarted.snapshot({date}).workMatches.items.length,0);
  assert.equal(f.create().snapshot({date}).workMatches.items.length,0);
});

test('reminders use completed planner notes and collected MR content without completing pending tasks',async t=>{
  const f=fixture(t),date='2026-10-26',mr={iid:1,title:'修复会员临近过期时缓存被写成永久有效的问题',url:'https://gitlab.example.test/business/play/-/merge_requests/1'};
  let count=1;
  const reports=f.create({gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>Array.from({length:count},(_,i)=>({source:'gitlab',sourceKey:'gitlab:match:'+i,title:'代码提交',date,project:'business/play',status:'done',sourceMeta:{mrChecked:true,mergeRequests:[mr]}}))});
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/play'}],gitlabAuthors:'cy@example.test'});
  const task=f.planner.action('save-task',{title:'调整VIP播放缓存问题',notes:'临近过期时缓存会被写成永久有效',deadline:'none',category:'work'}).tasks[0];
  await reports.action('collect');assert.equal(reports.snapshot({date}).workMatches.items.length,0);assert.equal(f.planner.snapshot().tasks[0].status,'pending');
  f.planner.action('set-task-status',{id:task.id,status:'done'});reports.syncPlanner();let snapshot=reports.snapshot({date});assert.equal(snapshot.workMatches.items.length,1);assert.equal(snapshot.workMatches.items[0].title,task.title);
  const id=snapshot.workMatches.items[0].id;await reports.action('dismiss-work-match',{date,id});count=2;await reports.action('collect');assert.equal(reports.snapshot({date}).workMatches.items.length,0);
  await reports.action('restore-work-matches',{date});snapshot=await reports.action('accept-work-match',{date,id});assert.equal(snapshot.work.items.length,1);assert.equal(snapshot.work.items[0].entryIds.length,3);
  count=3;await reports.action('collect');assert.equal(reports.snapshot({date}).work.items.length,1);assert.equal(reports.snapshot({date}).work.items[0].entryIds.length,4);
});

test('dismissed source pairs remain separate after MR enrichment and joining another work',async t=>{
  const f=fixture(t),date='2026-10-26',mr={iid:1,title:'会员缓存永久有效修复',url:'https://gitlab.example.test/business/play/-/merge_requests/1'};let enriched=false;
  const reports=f.create({gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>[{source:'gitlab',sourceKey:'gitlab:upgraded',title:mr.title,date,project:'business/play',status:'done',sourceMeta:{mrChecked:true,mergeRequests:enriched?[mr]:[]}}]});
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/play'}],gitlabAuthors:'cy@example.test'});
  await reports.action('save-entry',{date,title:'调整会员缓存永久有效问题',status:'done'});await reports.action('collect');
  const before=reports.snapshot({date}),id=before.workMatches.items[0].id;await reports.action('dismiss-work-match',{date,id});enriched=true;await reports.action('collect');
  assert.equal(reports.snapshot({date}).entries.length,2);assert.equal(reports.snapshot({date}).workMatches.items.length,0);assert.equal(f.create().snapshot({date}).workMatches.items.length,0);
  await reports.action('save-entry',{date,title:'补充会员缓存边界验证',status:'done'});const snapshot=reports.snapshot({date}),original=snapshot.work.items.find(item=>item.kind==='manual'&&item.title.startsWith('调整')),added=snapshot.work.items.find(item=>item.title.startsWith('补充'));
  const merged=await reports.action('merge-work',{date,keys:[original.key,added.key],title:'会员缓存永久有效问题处理',description:''});
  assert.equal(merged.work.items.length,2);assert.equal(merged.workMatches.items.length,0);
});

test('grouped planner and cross-repository MRs accept, dismiss and unmerge together without changing sources',async t=>{
  const f=fixture(t),date='2026-10-26',mrs=[{project:'business/admin',title:'应用管理支持客户端类型配置与筛选'},{project:'business/api',title:'应用管理支持客户端类型并修复跨应用列表查询'}];let count=1;
  const reports=f.create({gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>mrs.flatMap(({project,title},index)=>Array.from({length:count},(_,i)=>({source:'gitlab',sourceKey:'gitlab:grouped:'+index+':'+i,title:'代码提交',date,project,status:'done',sourceMeta:{mrChecked:true,mergeRequests:[{iid:index+1,title,url:'https://gitlab.example.test/'+project+'/-/merge_requests/'+(index+1)}]}})))});
  await reports.action('settings',{gitlabProjects:mrs.map(({project},index)=>({host:'https://gitlab.example.test',projectId:index+1,project})),gitlabAuthors:'cy@example.test'});
  const task=f.planner.action('save-task',{title:'APP应用类型新增',notes:'h5、app、tiktok',deadline:'none',category:'work'}).tasks[0];f.planner.action('set-task-status',{id:task.id,status:'done'});await reports.action('collect');
  const before=reports.snapshot({date}),match=before.workMatches.items[0];assert.equal(before.workMatches.items.length,1);assert.equal(match.keys.length,3);
  await reports.action('dismiss-work-match',{date,id:match.id});assert.equal(reports.snapshot({date}).workMatches.items.length,0);assert.equal(f.create().snapshot({date}).workMatches.items.length,0);
  count=2;await reports.action('collect');assert.equal(reports.snapshot({date}).workMatches.items.length,0);
  const restored=await reports.action('restore-work-matches',{date});assert.equal(restored.workMatches.items.length,1);assert.equal(restored.workMatches.items[0].id,match.id);
  const merged=await reports.action('accept-work-match',{date,id:match.id});assert.equal(merged.work.items.length,1);assert.equal(merged.work.items[0].entryIds.length,5);assert.equal(merged.work.items[0].title,task.title);assert.equal(merged.work.items[0].description,task.notes);assert.deepEqual(merged.entries,restored.entries);assert.equal(f.create().snapshot({date}).work.items.length,1);
  const separated=await reports.action('unmerge-work',{date,id:merged.work.items[0].groupId});assert.equal(separated.work.items.length,3);assert.equal(separated.workMatches.items.length,0);assert.deepEqual(separated.entries,restored.entries);assert.equal(f.create().snapshot({date}).workMatches.items.length,0);
});

test('unmerge remembers every partition in a grouped suggestion and supports legacy MR links',async t=>{
  const f=fixture(t),date='2026-10-26',reports=f.create();
  for(let i=0;i<8;i++)await reports.action('save-entry',{date,title:'会员缓存永久有效修复 '+i,status:'done'});
  const before=reports.snapshot({date});assert.equal(before.workMatches.items.length,1);assert.equal(before.workMatches.items[0].keys.length,8);assert.equal(before.workMatches.limited,false);
  const merged=await reports.action('merge-work',{date,keys:before.work.items.map(item=>item.key),title:'会员缓存修复',description:''});
  const restored=await reports.action('unmerge-work',{date,id:merged.work.items[0].groupId});assert.equal(restored.work.items.length,8);assert.equal(restored.workMatches.items.length,0);assert.deepEqual(restored.entries,before.entries);assert.equal(f.create().snapshot({date}).workMatches.items.length,0);
  await reports.action('restore-work-matches',{date});assert.equal(reports.snapshot({date}).workMatches.items.length,1);assert.equal(reports.snapshot({date}).workMatches.items[0].keys.length,8);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-legacy-match-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const mr={iid:1,title:'会员缓存永久有效修复',url:'https://gitlab.example.test/business/play/-/merge_requests/1'},legacy=createWorkReports({dataDir:dir,now:()=>NOW,readEnvironment:()=>({}),gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>[{source:'gitlab',sourceKey:'gitlab:legacy',date,title:mr.title,project:'business/play',status:'done',sourceMeta:{mrChecked:true,mergeRequests:[mr]}}]});t.after(()=>legacy.close());
  await legacy.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/play'}],gitlabAuthors:'cy@example.test'});await legacy.action('collect');
  await legacy.action('save-entry',{date,title:'调整会员缓存永久有效问题',status:'done',relatedMr:mr.url});const linked=legacy.snapshot({date});assert.equal(linked.work.items.length,1);
  const separated=await legacy.action('unmerge-work',{date,key:linked.work.items[0].key});assert.equal(separated.work.items.length,2);assert.equal(separated.workMatches.items.length,0);
});

test('manual work survives restart and report templates group only included work in the Shanghai week',async t=>{
  const f=fixture(t),reports=f.create();
  await reports.action('save-entry',{date:'2026-10-26',title:'修复登录超时',project:'用户中心',details:'补齐超时重试，回归通过',status:'done'});
  await reports.action('save-entry',{date:'2026-11-02',title:'下周工作',project:'用户中心',status:'planned'});
  const week=await reports.action('generate-week',{date:'2026-10-28'});
  assert.match(week.content,/2026-10-26/);assert.match(week.content,/修复登录超时/);assert.match(week.content,/下周工作/);
  assert.equal(f.create().snapshot({date:'2026-10-26'}).entries.length,1);
  await reports.action('save-week',{date:'2026-10-28',content:'手工整理的周报'});
  await reports.runScheduled();assert.equal((await reports.action('get-week',{date:'2026-10-28'})).content,'手工整理的周报');
});

test('completed work tasks are deduplicated, personal tasks omitted, undo removes them from reports',async t=>{
  const f=fixture(t),reports=f.create();
  for(const category of ['work','personal']){const result=f.planner.action('save-task',{title:category,notes:'已验证',deadline:'none',category});const task=result.tasks.at(-1);f.planner.action('toggle-task',{id:task.id,completed:true});}
  reports.syncPlanner();reports.syncPlanner();assert.equal(reports.snapshot({date:'2026-10-26'}).entries.length,1);
  const work=f.planner.snapshot().tasks.find(item=>item.category==='work');f.planner.action('toggle-task',{id:work.id,completed:false});reports.syncPlanner();
  assert.doesNotMatch((await reports.action('generate-week',{date:'2026-10-26'})).content,/已验证/);
  f.planner.action('toggle-task',{id:work.id,completed:true});reports.syncPlanner();
  const entry=reports.snapshot({date:'2026-10-26'}).entries[0];await reports.action('remove-entry',{id:entry.id});reports.syncPlanner();
  assert.equal(reports.snapshot({date:'2026-10-26'}).entries.length,0);
});

test('failed writes keep prior records and corrupt stores are never overwritten',async t=>{
  const f=fixture(t),reports=f.create();await reports.action('save-entry',{date:'2026-10-26',title:'原记录',status:'done'});
  fs.mkdirSync(path.join(f.dir,'work-reports.json.tmp'));
  await assert.rejects(reports.action('save-entry',{date:'2026-10-26',title:'未保存',status:'done'}),/保存失败/);
  assert.equal(reports.snapshot({date:'2026-10-26'}).entries.length,1);
  fs.rmdirSync(path.join(f.dir,'work-reports.json.tmp'));fs.writeFileSync(path.join(f.dir,'work-reports.json'),'broken');const broken=f.create();
  await assert.rejects(broken.action('save-entry',{date:'2026-10-26',title:'不可覆盖',status:'done'}),/无法读取/);
  assert.equal(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),'broken');
});
test('completed planner work belongs to its completion day and survives deleting the task and restart',async t=>{
  const f=fixture(t),reports=f.create();
  const task=f.planner.action('save-task',{title:'今天实际完成',notes:'结果已验证',deadline:'date',dueDate:'2026-11-02'}).tasks[0];
  f.planner.action('set-task-status',{id:task.id,status:'done'});reports.syncPlanner();reports.syncPlanner();
  assert.equal(reports.snapshot({date:'2026-10-26'}).entries.length,1);assert.equal(reports.snapshot({date:'2026-11-02'}).entries.length,0);
  f.planner.action('remove-task',{id:task.id});reports.syncPlanner();
  const restarted=f.create();assert.match((await restarted.action('preview-day',{date:'2026-10-26'})).content,/今天实际完成/);
  assert.equal(f.planner.action('history',{date:'2026-10-26'}).items[0].taskId,task.id);
});

test('collection merges concurrent manual edits, reports failed sources, and deduplicates repeated scans',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-report-collect-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let finish,fail=false;
  const entry={title:'提交结果',project:'项目',details:'代码已提交',date:'2026-10-26',status:'done',source:'git',sourceKey:'git:repo:sha',sourceMeta:{sha:'a'.repeat(40)}};
  const reports=createWorkReports({dataDir:dir,now:()=>NOW,readEnvironment:()=>({}),gitCollector:async()=>{if(fail)throw Object.assign(Error('来源不可达'),{reportSafe:true});return new Promise(resolve=>{finish=()=>resolve([entry]);});}});t.after(()=>reports.close());
  await reports.action('settings',{repositories:[{path:dir,project:'项目',authors:'me@example.test'}]});
  let pending=reports.action('collect');await new Promise(setImmediate);
  await reports.action('save-entry',{title:'并发手工工作',date:'2026-10-26',status:'done'});finish();await pending;
  const imported=reports.snapshot({date:'2026-10-26'}).entries.find(item=>item.source==='git');
  await reports.action('save-entry',{...imported,title:'人工整理标题'});
  pending=reports.action('collect');await new Promise(setImmediate);finish();await pending;
  assert.equal(reports.snapshot({date:'2026-10-26'}).entries.length,2);assert.equal(reports.snapshot({date:'2026-10-26'}).entries.find(item=>item.id===imported.id).title,'人工整理标题');
  fail=true;await reports.action('collect');assert.match(reports.snapshot().sources[0].error,/来源不可达/);assert.equal(reports.snapshot({date:'2026-10-26'}).entries.length,2);
});

test('automatic previous-week reports and day archives preserve handwritten drafts and stop with the module',async t=>{
  const f=fixture(t),vault=path.join(f.dir,'vault');fs.mkdirSync(vault);const reports=f.create();
  await reports.action('save-entry',{date:'2026-10-23',title:'上周交付',status:'done'});
  await reports.action('settings',{archiveDir:vault,autoWeekly:true,autoArchive:true});await reports.runScheduled();
  assert.match(fs.readFileSync(path.join(vault,'日报/2026-10-23.md'),'utf8'),/上周交付/);
  assert.match(fs.readFileSync(path.join(vault,'周报/2026-10-19.md'),'utf8'),/上周交付/);
  await reports.action('save-week',{date:'2026-10-23',content:'人工周报'});await reports.runScheduled();
  assert.match(fs.readFileSync(path.join(vault,'周报/2026-10-19.md'),'utf8'),/人工周报/);
  reports.setModuleEnabled(false);await assert.rejects(reports.action('save-entry',{date:'2026-10-26',title:'关闭后不能写',status:'done'}),/已关闭/);await reports.runScheduled();
});

test('templates reject unknown placeholders and Shanghai week boundaries cross months correctly',async t=>{
  const f=fixture(t),reports=f.create();await assert.rejects(reports.action('settings',{weeklyTemplate:'{{unknown}}'}),/占位符/);
  await reports.action('settings',{weeklyTemplate:'{{week_start}}|{{week_end}}|{{count}}\n{{summary}}'});
  await reports.action('save-entry',{date:'2026-11-01',title:'周日工作',project:'项目',status:'done'});
  const week=await reports.action('generate-week',{date:'2026-11-01'});assert.match(week.content,/2026-10-26\|2026-11-01\|1/);
  assert.doesNotMatch((await reports.action('generate-week',{date:'2026-11-02'})).content,/周日工作/);
});

test('automatic reports remove the last withdrawn fact without overwriting manual drafts',async t=>{
  const reports=fixture(t).create();
  const added=await reports.action('save-entry',{date:'2026-10-23',title:'已撤销成果',status:'done'});
  await reports.action('settings',{autoWeekly:true});await reports.runScheduled();
  assert.match((await reports.action('get-week',{date:'2026-10-23'})).content,/已撤销成果/);
  await reports.action('remove-entry',{id:added.entries[0].id});await reports.runScheduled();
  assert.doesNotMatch((await reports.action('get-week',{date:'2026-10-23'})).content,/已撤销成果/);
});

test('disabled modules discard delayed collection results even after re-enabling',async t=>{
  const f=fixture(t);let finish;
  const reports=createWorkReports({dataDir:f.dir,now:()=>NOW,readEnvironment:()=>({}),gitCollector:()=>new Promise(resolve=>{finish=resolve;})});t.after(()=>reports.close());
  await reports.action('settings',{repositories:[{path:f.dir,project:'项目',authors:'me@example.test'}]});
  const pending=reports.action('collect');await new Promise(setImmediate);
  reports.setModuleEnabled(false);reports.setModuleEnabled(true);
  finish([{title:'过期结果',date:'2026-10-26',status:'done',source:'git',sourceKey:'git:stale'}]);await pending;
  assert.equal(reports.snapshot().total,0);assert.deepEqual(reports.snapshot().sources,[]);
});

test('oversized generated reports leave the previous draft readable',async t=>{
  const f=fixture(t),reports=f.create();
  await reports.action('save-week',{date:'2026-10-26',content:'保留原草稿'});
  await reports.action('save-entry',{date:'2026-10-26',title:'详细工作',details:'字'.repeat(4000),status:'done'});
  await reports.action('settings',{weeklyTemplate:'{{summary}}\n'.repeat(60)});
  await assert.rejects(reports.action('generate-week',{date:'2026-10-26',force:true}),/超过 200000/);
  assert.equal((await f.create().action('get-week',{date:'2026-10-26'})).content,'保留原草稿');
});

test('verified Jenkins scans retire legacy build facts only for the checked source and window, preserve edits and restore releases',async t=>{
  const f=fixture(t);let items=[],failure=false,optionsSeen;
  const source={job:'prod/pay',project:'ossv/pay',environment:'prod',target:'EKS',userIds:'cy'};
  const old={source:'jenkins',sourceKey:'jenkins:https://jenkins.example.test/job/prod/job/pay/:42',title:'旧构建成功',project:'ossv/pay',date:'2026-10-26',status:'done',evidence:'https://jenkins.example.test/job/prod/job/pay/42/',sourceMeta:{buildNumber:42,completedAt:NOW-60000,release:false}};
  const reports=createWorkReports({dataDir:f.dir,now:()=>NOW,readEnvironment:()=>({jenkinsUrl:'https://jenkins.example.test'}),gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>[],jenkinsCollector:async(_source,options)=>{optionsSeen=options;if(failure)throw Object.assign(Error('阶段读取失败'),{reportSafe:true});return items;}});t.after(()=>reports.close());
  const project={host:'https://gitlab.example.test',projectId:7,project:'ossv/pay',path:'ossv/pay'};
  await reports.action('settings',{jenkinsJobs:[source],gitlabProjects:[project],gitlabAuthors:'cy@example.test'});
  items=[old];await reports.action('collect');let entry=reports.snapshot({date:old.date}).entries[0];await reports.action('save-entry',{...entry,title:'人工说明',included:false});
  assert.equal(optionsSeen.connection.token,'fixture');assert.deepEqual(optionsSeen.gitlabProjects,[project]);assert.equal(typeof optionsSeen.gitlabFetchImpl,'function');
  items=[];failure=true;await reports.action('collect');assert.notEqual(reports.snapshot({date:old.date}).entries[0].sourceActive,false);
  failure=false;await reports.action('collect');entry=reports.snapshot({date:old.date}).entries[0];assert.equal(entry.sourceActive,false);assert.equal(entry.title,'人工说明');
  items=[{...old,title:'核实后的发布完成',sourceMeta:{...old.sourceMeta,release:true,rangeVerified:false}}];await reports.action('collect');entry=reports.snapshot({date:old.date}).entries[0];assert.equal(entry.sourceActive,true);assert.equal(entry.title,'人工说明');assert.equal(entry.included,false);assert.match(reports.snapshot().sources.find(s=>s.key.startsWith('jenkins:')).warning,/完整范围待核对/);
  await reports.action('remove-entry',{id:entry.id});await reports.action('collect');assert.equal(reports.snapshot({date:old.date}).entries.length,0);
});

test('explicit planner association survives restart and inclusion changes do not detach MR work',async t=>{
  const f=fixture(t),mr={iid:9,title:'缓存修复',url:'https://gitlab.example.test/business/service/-/merge_requests/9'};
  const reports=createWorkReports({dataDir:f.dir,now:()=>NOW,readEnvironment:()=>({}),gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>[{source:'gitlab',sourceKey:'gitlab:fixture:1',title:'原始提交',project:'business/service',date:'2026-10-26',status:'done',sourceMeta:{mrChecked:true,mergeRequests:[mr]}}]});t.after(()=>reports.close());
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/service'}],gitlabAuthors:'cy@example.test'});await reports.action('collect');
  await reports.action('save-entry',{date:'2026-10-26',title:'缓存回归',details:'补齐边界验证',status:'done',relatedMr:mr.url});
  let snapshot=reports.snapshot({date:'2026-10-26'});assert.equal(snapshot.work.items.length,1);assert.match(snapshot.work.items[0].description,/补齐边界验证/);
  const source=snapshot.entries.find(e=>e.source==='gitlab');await reports.action('set-entry-included',{id:source.id,included:false});assert.equal(reports.snapshot({date:source.date}).work.items[0].kind,'manual');
  await reports.action('collect');snapshot=reports.snapshot({date:source.date});assert.equal(snapshot.entries.find(e=>e.id===source.id).included,false);assert.equal(snapshot.entries.find(e=>e.id===source.id).edited,false);assert.equal(snapshot.work.items[0].kind,'manual');
  await reports.action('set-entry-included',{id:source.id,included:true});snapshot=reports.snapshot({date:source.date});assert.equal(snapshot.work.items.length,1);assert.equal(snapshot.entries.find(e=>e.id===source.id).edited,false);
  const restarted=f.create();assert.equal(restarted.snapshot({date:source.date}).work.items.length,1);
  await assert.rejects(reports.action('save-entry',{date:source.date,title:'错误关联',status:'done',relatedMr:'javascript:alert(1)'}),/关联 MR/);
  const legacy=reports.snapshot({date:source.date}).work.items[0],unlinked=await reports.action('unmerge-work',{date:source.date,key:legacy.key});assert.equal(unlinked.work.items.length,2);assert.equal(unlinked.entries.find(e=>e.source==='manual').relatedMr,'');
});

test('preparing a legacy day backfills only existing metadata, deduplicates requests and preserves concurrent edits',async t=>{
  const f=fixture(t),mr={iid:9,title:'订单超时修复',url:'https://gitlab.example.test/business/service/-/merge_requests/9'};let mode='seed',finish,calls=0;
  const old={source:'gitlab',sourceKey:'gitlab:fixture:old',title:'原始工作',details:'原说明',project:'business/service',date:'2026-10-26',status:'done',sourceMeta:{projectId:1,sha:'a'.repeat(40),committedAt:NOW-10000}};
  const reports=createWorkReports({dataDir:f.dir,now:()=>NOW,readEnvironment:()=>({}),gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async(_source,options)=>{calls++;if(mode==='seed')return [old];assert.equal(options.since,Date.parse('2026-10-26T00:00:00+08:00'));return new Promise(resolve=>{finish=()=>resolve([{...old,title:'不能覆盖手工标题',sourceMeta:{...old.sourceMeta,mrChecked:true,mergeRequests:[mr]}},{...old,sourceKey:'gitlab:fixture:new',title:'不应导入的新工作'}]);});}});t.after(()=>reports.close());
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:1,project:'business/service'}],gitlabAuthors:'cy@example.test'});await reports.action('collect');mode='repair';
  const pending=reports.action('prepare-day',{date:old.date});await new Promise(setImmediate);assert.ok(finish);
  const second=reports.action('prepare-day',{date:old.date}),entry=reports.snapshot({date:old.date}).entries[0];await reports.action('save-entry',{...entry,title:'人工整理标题',included:false});finish();await Promise.all([pending,second]);
  let snapshot=reports.snapshot({date:old.date});assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].title,'人工整理标题');assert.equal(snapshot.entries[0].included,false);assert.equal(snapshot.entries[0].sourceMeta.mrChecked,true);assert.deepEqual(snapshot.entries[0].sourceMeta.mergeRequests,[mr]);assert.equal(snapshot.settings.autoCollect,false);assert.equal(calls,2);
  await reports.action('prepare-day',{date:old.date});assert.equal(calls,2);
});

test('already-associated legacy MRs refresh lifecycle metadata without changing sources or saved work',async t=>{
  const f=fixture(t),date='2026-10-26',project='ossv/d-minitv-admin',url='https://gitlab.example.test/'+project+'/-/merge_requests/20',legacy={iid:20,title:'应用类型新增',url};let repair=false,calls=0;
  const complete={...legacy,state:'merged',sourceBranch:'feat-cy-client-type',targetBranch:'v3.10.0',mergedAt:NOW-1000};
  const old={source:'gitlab',sourceKey:'gitlab:legacy:20',date,project,title:'提交说明',details:'原始正文',status:'done',sourceMeta:{projectId:77,sha:'a'.repeat(40),mrChecked:true,mergeRequests:[legacy],committedAt:NOW-2000}};
  const reports=f.create({gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async()=>{calls++;return [{...old,sourceMeta:{...old.sourceMeta,...(repair?{mrLifecycleChecked:true,mergeRequests:[complete]}:{})}}];}});
  await reports.action('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:77,project}],gitlabAuthors:'cy@example.test'});await reports.action('collect');
  const before=reports.snapshot({date});assert.equal(before.needsMrRefresh,true);assert.equal(before.work.items[0].badge,'待核对');
  await reports.action('save-work',{date,key:before.work.items[0].key,title:'人工整理的应用类型',description:'保留说明'});await reports.action('save-week',{date,content:'人工周报'});repair=true;
  const after=await reports.action('prepare-day',{date});assert.equal(after.needsMrRefresh,false);assert.equal(after.entries.length,1);assert.equal(after.entries[0].title,'提交说明');assert.equal(after.entries[0].details,'原始正文');assert.equal(after.work.items[0].title,'人工整理的应用类型');assert.equal(after.work.items[0].badge,'待发布');assert.equal((await reports.action('get-week',{date})).content,'人工周报');
  await reports.action('prepare-day',{date});assert.equal(calls,2);assert.equal(f.create().snapshot({date}).needsMrRefresh,false);
});

test('legacy association is atomic across sources and discards results after module disable',async t=>{
  const f=fixture(t);let mode='seed',finish;
  const make=id=>({source:'gitlab',sourceKey:'legacy:'+id,title:'旧记录 '+id,project:'business/repo-'+id,date:'2026-10-26',status:'done',sourceMeta:{projectId:id,sha:String(id).repeat(40),committedAt:NOW-1000}});
  const reports=createWorkReports({dataDir:f.dir,now:()=>NOW,readEnvironment:()=>({}),gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture'})},gitlabCollector:async source=>{
    if(mode==='seed')return [make(source.projectId)];
    if(mode==='fail'&&source.projectId===2)throw Object.assign(Error('MR 读取失败'),{reportSafe:true});
    if(mode==='defer')await new Promise(resolve=>{finish=resolve;});
    return [{...make(source.projectId),sourceMeta:{...make(source.projectId).sourceMeta,mrChecked:true,mergeRequests:[]}}];
  }});t.after(()=>reports.close());
  await reports.action('settings',{gitlabProjects:[1,2].map(id=>({host:'https://gitlab.example.test',projectId:id,project:'business/repo-'+id})),gitlabAuthors:'cy@example.test'});await reports.action('collect');
  const file=path.join(f.dir,'work-reports.json'),before=fs.readFileSync(file,'utf8');mode='fail';await assert.rejects(reports.action('prepare-day',{date:'2026-10-26'}),/MR 读取失败/);assert.equal(fs.readFileSync(file,'utf8'),before);
  mode='defer';const pending=reports.action('prepare-day',{date:'2026-10-26'});await new Promise(setImmediate);assert.ok(finish);reports.setModuleEnabled(false);reports.setModuleEnabled(true);finish();
  // 关闭模块后不继续读取第二个来源，也不能落盘第一个来源的结果。
  await assert.rejects(pending,/取消/);assert.equal(fs.readFileSync(file,'utf8'),before);
});
