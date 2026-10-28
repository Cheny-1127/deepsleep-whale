'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {workSummary}=require('../src/reports/work-summary.cjs');
const {dailyContent,weekContent}=require('../src/reports/model.cjs');
const repo='https://gitlab.example.test/business/pay',time=(date,hour=18)=>Date.parse(date+'T'+hour+':00:00+08:00');
const mr={iid:1,title:'新增支付方式',url:repo+'/-/merge_requests/1',state:'merged',sourceBranch:'feat-cy-pay',targetBranch:'main',mergedAt:time('2026-10-27')};
function entry(id,date,meta={},extra={}){return {id,sourceKey:id,date,title:'开发支付方式',details:'',project:'business/pay',source:'gitlab',status:'done',included:true,sourceActive:true,sourceMeta:{repositoryUrl:repo,committedAt:time(date,10),...meta},...extra};}
function release(date='2026-10-28',meta={}){return entry('release',date,{release:true,environment:'prod',rangeVerified:true,direction:'forward',releasedAt:time(date),mergeRequests:[mr],...meta},{source:'jenkins'});}
function timeline(){return [entry('branch','2026-10-26',{featureBranch:mr.sourceBranch}),entry('merge','2026-10-27',{mergeRequests:[mr],event:'merged'}),release()];}

test('daily history keeps developing, pending release and completed states at the dates they happened',()=>{
  const entries=timeline();
  for(const [date,badge] of [['2026-10-26','开发中'],['2026-10-27','待发布'],['2026-10-28','已完成']]){
    const item=workSummary(entries.filter(entry=>entry.date===date),[],{context:entries}).items[0];assert.equal(item.title,mr.title);assert.equal(item.badge,badge);assert.match(dailyContent(entries,date),new RegExp(badge));
  }
  assert.equal(workSummary([entries[2]],[],{context:entries}).items[0].completedAt,time('2026-10-28'));
  assert.doesNotMatch(dailyContent(entries,'2026-10-26'),/已完成|待发布/);
});

test('weekly summary counts one cross-day feature while retaining each day in details',()=>{
  const result=weekContent(timeline(),'2026-10-28','count={{count}}\n{{summary}}\nDETAILS\n{{details}}').content,[summary,details]=result.split('DETAILS');
  assert.match(summary,/count=1/);assert.equal((summary.match(/新增支付方式/g)||[]).length,1);assert.match(summary,/已完成/);
  for(const date of ['2026-10-26','2026-10-27','2026-10-28'])assert.match(details,new RegExp(date));
  assert.match(details,/开发中/);assert.match(details,/待发布/);assert.match(details,/已完成/);
});

test('a release next week never completes the previous week or changes the prior daily report',()=>{
  const entries=[entry('previous','2026-10-23',{featureBranch:mr.sourceBranch}),entry('current','2026-10-26',{mergeRequests:[mr]}),release()];
  const previous=weekContent(entries,'2026-10-23').content,current=weekContent(entries,'2026-10-28').content;
  assert.match(previous,/开发中/);assert.doesNotMatch(previous,/已完成|待发布/);assert.match(current,/已完成/);assert.equal((current.match(/新增支付方式/g)||[]).length,1);
});

test('open MRs and unique feature branches group daily commits before a production release',()=>{
  const opened={...mr,state:'opened'};delete opened.mergedAt;
  for(const meta of [{mergeRequests:[opened]},{featureBranch:'feat-cy-pay'}]){
    const entries=[entry('one','2026-10-26',meta),entry('two','2026-10-26',meta)],summary=workSummary(entries);
    assert.equal(summary.items.length,1);assert.equal(summary.items[0].badge,'开发中');assert.equal(summary.items[0].entryIds.length,2);
  }
});

test('completion requires a verified forward production release containing the feature',()=>{
  for(const change of [{environment:'test'},{rangeVerified:false},{direction:'rollback'},{direction:'same'},{mergeRequests:[{...mr,iid:2,url:repo+'/-/merge_requests/2'}]}]){
    const entries=[entry('code','2026-10-28',{mergeRequests:[mr]}),release('2026-10-28',change)];
    const work=workSummary(entries).items.find(item=>item.mr?.url===mr.url);assert.ok(work);assert.notEqual(work.phase,'completed');assert.notEqual(work.badge,'已完成');
  }
});

test('a completed planner note cannot complete its linked feature before deployment',()=>{
  const entries=[entry('code','2026-10-26',{mergeRequests:[mr]}),entry('planner','2026-10-26',{}, {source:'planner',title:'支付方式开发完成'})],members=['mr:'+mr.url,'source:code','source:planner'];
  const item=workSummary(entries,[{id:'group',date:'2026-10-26',title:'新增支付方式',description:'保留工作说明',members}]).items[0];assert.equal(item.badge,'开发中');assert.equal(item.description,'保留工作说明');
});

test('excluded, removed or inactive production evidence cannot complete a feature',()=>{
  for(const fields of [{included:false},{removed:true},{sourceActive:false}]){
    const entries=[entry('code','2026-10-28',{mergeRequests:[mr]}),{...release(),...fields}],item=workSummary(entries).items[0];
    assert.equal(item.badge,'待发布');assert.equal(item.completedAt,undefined);assert.equal(item.releases.length,0);
  }
});

test('ambiguous branch reuse never joins separate MRs into one weekly feature',()=>{
  const second={...mr,iid:2,url:repo+'/-/merge_requests/2',title:'新增退款方式'};
  const entries=[entry('branch','2026-10-26',{featureBranch:mr.sourceBranch}),entry('one','2026-10-27',{mergeRequests:[mr]}),entry('two','2026-10-27',{mergeRequests:[second]})];
  const items=workSummary(entries,[],{context:entries,periodEnd:'2026-11-01'}).items;
  assert.equal(items.length,3);assert.equal(items.find(item=>item.kind==='branch').badge,'开发中');
});

test('a saved multi-MR work stays one weekly item across later progress without merging independent manual work',()=>{
  const second={...mr,iid:2,url:repo+'/-/merge_requests/2',title:'新增退款方式'};
  const entries=[entry('one','2026-10-26',{mergeRequests:[mr]}),entry('two','2026-10-26',{mergeRequests:[second]}),entry('later-one','2026-10-27',{mergeRequests:[mr]}),entry('later-two','2026-10-28',{mergeRequests:[second]}),entry('manual','2026-10-28',{}, {source:'manual',title:'独立日常工作',details:'保留人工说明'})];
  const groups=[{id:'combined',date:'2026-10-26',title:'支付方式调整',description:'保留合并说明',members:['mr:'+mr.url,'mr:'+second.url]}];
  const report=weekContent(entries,'2026-10-28','count={{count}}\n{{summary}}',groups).content;
  assert.match(report,/count=2/);assert.equal((report.match(/支付方式调整/g)||[]).length,1);assert.match(report,/待发布/);assert.match(report,/保留合并说明/);assert.match(report,/独立日常工作/);assert.match(report,/保留人工说明/);
});

test('d-minitv-admin accepts its actual target branch while other repositories still require main',()=>{
  for(const path of ['ossv/d-minitv-admin','ossv/d-ossv-operate','other/d-minitv-admin']){
    const reference={...mr,url:'https://gitlab.example.test/'+path+'/-/merge_requests/1',targetBranch:'v3.10.0'},code=entry('code','2026-10-27',{mergeRequests:[reference]},{project:path});
    assert.equal(workSummary([code]).items[0].badge,path==='ossv/d-minitv-admin'?'待发布':'开发中');
    const deployed={...release('2026-10-28',{mergeRequests:[reference]}),project:path};
    assert.equal(workSummary([code,deployed]).items.at(-1).badge,'已完成');
  }
});

test('a production release completes the explicitly merged business feature without requiring every project to deploy',()=>{
  const front={...mr,url:'https://gitlab.example.test/ossv/d-minitv-admin/-/merge_requests/1',targetBranch:'v3.10.0'},date='2026-10-28';
  const code=entry('front',date,{mergeRequests:[front]}),back=entry('back',date,{mergeRequests:[mr]}),deployed=release(),group={id:'both',date,title:'APP应用类型新增',description:'',members:['mr:'+front.url,'mr:'+mr.url]};
  const item=workSummary([code,back,deployed],[group]).items[0];assert.equal(item.badge,'已完成');assert.equal(item.completedAt,time(date));
  assert.equal(workSummary([code,back,deployed]).items.find(item=>item.mr?.url===front.url).badge,'待发布');
  const frontRelease={...release(date,{mergeRequests:[front]}),id:'front-release',sourceKey:'front-release'};
  assert.equal(workSummary([code,back,deployed,frontRelease],[group]).items[0].badge,'已完成');
});

test('production inclusion completes legacy MRs even when merge metadata is missing',()=>{
  const legacy={iid:mr.iid,title:mr.title,url:mr.url},entries=[entry('old','2026-10-28',{mrChecked:true,mergeRequests:[legacy]}),release('2026-10-28',{mergeRequests:[legacy]})];
  const item=workSummary(entries).items[0];assert.equal(item.badge,'已完成');assert.equal(item.releases.length,1);
  assert.equal(workSummary([entries[0]]).items[0].badge,'待核对');
});

test('a deployed feature is complete regardless of MR target branch or merge state',()=>{
  for(const reference of [{...mr,targetBranch:'test'},{...mr,state:'opened',mergedAt:undefined},{...mr,mergedAt:time('2026-10-29')}]){
    const entries=[entry('code','2026-10-28',{mergeRequests:[reference]}),release('2026-10-28',{mergeRequests:[reference]})];assert.equal(workSummary(entries).items[0].badge,'已完成');
  }
});

test('production commit evidence completes a branch without an MR and stays inside its repository and date',()=>{
  const code=entry('branch','2026-10-26',{featureBranch:'feat-cy-pay',sha:'a'.repeat(40)}),deployed=release('2026-10-28',{repositoryUrl:repo,mergeRequests:[],commitShas:['a'.repeat(40)]}),entries=[code,deployed];
  const day=workSummary([deployed],[],{context:entries}).items;assert.equal(day.length,1);assert.equal(day[0].badge,'已完成');assert.equal(day[0].title,'开发支付方式');assert.deepEqual(day[0].featureKeys,['branch:'+repo+'|feat-cy-pay']);
  assert.equal(workSummary([code],[],{context:entries}).items[0].badge,'开发中');assert.match(weekContent(entries,'2026-10-28','count={{count}}\n{{summary}}').content,/count=1/);
  const other={...deployed,sourceMeta:{...deployed.sourceMeta,repositoryUrl:'https://gitlab.example.test/other/pay'}};assert.equal(workSummary([code],[],{context:[code,other],periodEnd:'2026-11-01'}).items[0].badge,'开发中');
});
