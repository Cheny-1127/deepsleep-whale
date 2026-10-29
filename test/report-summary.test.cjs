'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {workSummary}=require('../src/reports/work-summary.cjs');
const {dailyContent,weekContent,settingsInput}=require('../src/reports/model.cjs');
const mr=(iid,project='business/service')=>({iid,title:'事项 '+iid,url:`https://gitlab.example.test/${project}/-/merge_requests/${iid}`,state:'merged',sourceBranch:'feat-cy-task-'+iid,targetBranch:'main',mergedAt:Date.parse('2026-10-26T08:00:00+08:00')});
const at=hour=>Date.parse(`2026-10-26T${hour}:00:00+08:00`);
function entry(id,changes={}){return {id,sourceKey:id,date:'2026-10-26',title:id,details:'',project:'business/service',status:'done',source:'gitlab',included:true,sourceActive:true,sourceMeta:{},...changes};}
function commits(iid){return [0,1,2].map(n=>entry('commit-'+iid+'-'+n,{title:n===1?"Merge branch feature into main":'原始提交 '+iid,sourceMeta:{committedAt:at('10')+n,sha:String(n).repeat(40),mrChecked:true,mergeRequests:[mr(iid)]}}));}
function release(id,iid,hour,target='原有服务器',meta={}){return entry(id,{source:'jenkins',title:'原始发布 '+id,evidence:'https://jenkins.example.test/job/service/42/',sourceMeta:{release:true,direction:'forward',rangeVerified:true,releasedAt:at(hour),target,buildNumber:42,mergeRequests:[mr(iid)],...meta}});}
function day(){return [...commits(1),...commits(2),...commits(3),release('release-1',1,'11'),release('release-2',2,'16'),release('release-3',2,'17','EKS'),release('release-4',3,'19'),entry('planner',{source:'planner',title:'会员缓存处理',details:'已验证边界条件',sourceMeta:{completedAt:at('20')}})];}
test('14 raw facts become three MR works and one independent planner record with four chronological releases',()=>{
  const input=day().reverse(),before=JSON.stringify(input),summary=workSummary(input);
  assert.equal(summary.items.length,4);assert.equal(summary.releaseCount,4);assert.equal(summary.rawCount,14);
  assert.deepEqual(summary.items.filter(i=>i.mr).map(i=>i.mr.iid),[1,2,3]);
  assert.deepEqual(summary.items.find(i=>i.mr?.iid===2).releases.map(r=>r.target),['原有服务器','EKS']);
  assert.equal(summary.items.find(i=>i.mr?.iid===2).entryIds.length,5);assert.equal(JSON.stringify(input),before);
  const text=dailyContent(input,'2026-10-26');assert.match(text,/今日工作 4 项/);
  assert.equal((text.match(/\*\*事项 2\*\*/g)||[]).length,1);
  assert.doesNotMatch(text,/Merge branch|原始提交|发布时间：|[a-f0-9]{40}|MR !|16:00|17:00|原有服务器|EKS|#42/);
  assert.match(text,/事项 2\*\*（已完成）/);
});
test('work copy describes the change and outcome while release evidence remains traceable',()=>{
  const records=[...commits(1),release('published',1,'11'),release('repeat',1,'12','EKS',{direction:'same'})];
  for(const e of records)if(e.sourceMeta.mergeRequests)e.sourceMeta.mergeRequests[0].title='fix(tracking): 调整注册事件回传';
  records[0].details='统一由 AF 回传，避免重复上报。\n分支：feat-cy-tracking\n构建编号：42\n\nSee merge request business/service!1';
  const result=workSummary(records),work=result.items.find(i=>i.kind==='mr');
  assert.equal(work.title,'调整注册事件回传');assert.equal(work.badge,'已完成');assert.equal(work.description,'统一由 AF 回传，避免重复上报。');
  assert.equal(work.releases[0].buildNumber,42);assert.equal(work.mr.iid,1);assert.equal(work.entryIds.length,4);
  const report=dailyContent(records,'2026-10-26');assert.match(report,/避免重复上报/);assert.doesNotMatch(report,/MR !|fix\(tracking\)|#42|构建|原有服务器|EKS/);
  assert.equal(workSummary([...records,entry('new-issue',{source:'manual',status:'blocked',title:'上线后发现的新问题'})]).items.find(i=>i.kind==='mr').badge,'已完成');
});
test('generated merge notices stay in source evidence and never enter daily or weekly business copy',()=>{
  for(const branch of ['main','v3.10.0','release/2026.10']){
    const reference={...mr(1),title:'兼容TT广告系列四位日期格式',targetBranch:branch};
    const records=[entry('merged-event',{title:reference.title,details:'代码已合并 '+branch+'。',sourceMeta:{event:'merged',mrChecked:true,mergeRequests:[reference]}}),entry('business-commit',{details:'兼容TT广告系列四位日期格式并补充关键注释及回归测试',sourceMeta:{mrChecked:true,mergeRequests:[reference]}}),release('published',1,'11','EKS',{mergeRequests:[reference]})];
    const before=structuredClone(records),summary=workSummary(records);
    assert.equal(summary.items.length,1);assert.equal(summary.items[0].badge,'已完成');assert.equal(summary.items[0].description,records[1].details);
    for(const content of [dailyContent(records,'2026-10-26'),weekContent(records,'2026-10-26','{{summary}}\n{{releases}}\n{{details}}').content]){
      assert.doesNotMatch(content,/代码已合并|main|v3\.10\.0|release\/2026\.10/);assert.match(content,/兼容TT广告系列四位日期格式并补充关键注释及回归测试/);
    }
    assert.deepEqual(records,before);
  }
});
test('saved work descriptions also omit merge notices from reports without losing manual results or stored copy',()=>{
  const records=commits(1),description='代码已合并 main。\n完成日期格式兼容\n保留现有投放规则\n补齐渠道边界校验\n回归验证通过';
  const group={id:'legacy-copy',date:'2026-10-26',title:'兼容广告日期格式',description,members:workSummary(records).items[0].memberKeys};
  const before=structuredClone({records,group});
  for(const content of [dailyContent(records,group.date,[group]),weekContent(records,group.date,'{{summary}}\n{{details}}',[group]).content]){
    assert.doesNotMatch(content,/代码已合并|main/);
    for(const line of description.split('\n').slice(1))assert.ok(content.includes(line));
  }
  assert.equal(workSummary(records,[group]).items[0].description,description);assert.deepEqual({records,group},before);
});
test('merge-related business problems and manual technical explanations remain intact',()=>{
  const details='代码已合并 main，但支付回调仍需渠道联调确认。\n修复合并订单时金额重复计算的问题。\n补齐 main 字段的日期解析与回归测试。';
  const records=[entry('manual-copy',{source:'manual',title:'验证支付回调',details,status:'blocked'})];
  assert.ok(dailyContent(records,'2026-10-26').includes(details.split('\n')[0]));
  for(const line of details.split('\n'))assert.ok(weekContent(records,'2026-10-26','{{blockers}}').content.includes(line));
});
test('a deployment-only work extracts business content, including missing-range releases, without treating release evidence as unresolved business',()=>{
  const e=release('legacy',1,'11','EKS',{rangeVerified:false,mergeRequests:[]});
  e.details='发布时间：2026/10/26 11:00:00\n发布人：cy\n版本：起点待核对 → aaaaaaaa\nMR !1：修复订单超时\nhttps://gitlab.example.test/business/service/-/merge_requests/1\n  aaaaaaaa 修复订单超时（cy）';
  const item=workSummary([e]).items[0];assert.equal(item.title,'修复订单超时');assert.equal(item.badge,'已完成');assert.ok(item.warnings.length);
  assert.match(dailyContent([e],e.date),/修复订单超时\*\*（已完成）/);assert.doesNotMatch(dailyContent([e],e.date),/范围待核对|MR !|aaaaaaa|EKS/);
});
test('only explicit planner linking joins an MR, preserves notes and falls back when its target is absent',()=>{
  const records=day();records.at(-1).relatedMr=mr(3).url;
  const summary=workSummary(records);assert.equal(summary.items.length,3);assert.match(summary.items.at(-1).description,/已验证边界条件/);
  assert.equal(summary.items.at(-1).entryIds.length,5);
  records.filter(e=>e.sourceMeta.mergeRequests?.[0].iid===3).forEach(e=>e.included=false);
  const fallback=workSummary(records).items.find(i=>i.kind==='planner');assert.ok(fallback);assert.match(fallback.warnings[0],/不在当天/);
});
test('same MR numbers across dates and repositories stay distinct; multiple commit associations are not guessed',()=>{
  const records=[...commits(1),entry('other-repo',{sourceMeta:{mergeRequests:[mr(1,'other/service')]}}),entry('tomorrow',{date:'2026-10-27',sourceMeta:{mergeRequests:[mr(1)]}}),entry('ambiguous',{sourceMeta:{mergeRequests:[mr(1),mr(2)],mrChecked:true}})];
  const summary=workSummary(records);assert.equal(summary.items.length,4);assert.match(summary.items.find(i=>i.key==='ambiguous').warnings[0],/多个 MR/);
});
test('rollback, repeated and unverified releases are separate from new work; one release with two MRs is counted once',()=>{
  const records=[release('normal',1,'11',{},{mergeRequests:[mr(1),mr(2)]}),release('rollback',1,'12','EKS',{direction:'rollback'}),release('same',1,'13','EKS',{direction:'same'}),release('unknown',1,'14','EKS',{rangeVerified:false})];
  const summary=workSummary(records);assert.equal(summary.releaseCount,4);assert.equal(summary.items.filter(i=>i.kind==='mr').length,2);assert.equal(summary.items.filter(i=>i.kind==='release').length,3);
  assert.ok(summary.items.filter(i=>i.kind==='release').every(i=>i.badge==='已完成'));
  assert.deepEqual(summary.items.filter(i=>i.kind==='release').map(i=>i.releases[0].kind),['回退','重复发布','发布']);
  assert.ok(summary.items.find(i=>i.key==='unknown').warnings.some(w=>w.includes('范围待核对')));
});
test('removed, excluded and withdrawn sources do not leak into summaries; edited source copy stays visible',()=>{
  const records=[...commits(1),entry('deleted',{removed:true}),entry('excluded',{included:false}),entry('withdrawn',{sourceActive:false})];records[0].edited=true;records[0].title='人工整理的标题';
  const summary=workSummary(records);assert.equal(summary.rawCount,3);assert.equal(summary.items.length,2);assert.ok(summary.items.some(i=>i.title==='人工整理的标题'));
  assert.doesNotMatch(dailyContent(records,'2026-10-26'),/deleted|excluded|withdrawn/);
});
test('weekly summary counts MR works, keeps event chronology and includes manual plans and blockers',()=>{
  const records=[...day(),entry('blocker',{source:'manual',status:'blocked'}),entry('plan',{source:'manual',status:'planned',date:'2026-11-02'})];
  const text=weekContent(records,'2026-10-26','{{count}}\n{{summary}}\n{{releases}}\n{{blockers}}\n{{next_week}}').content;
  assert.ok(text.startsWith('4\n'));assert.match(text,/blocker/);assert.match(text,/plan/);assert.doesNotMatch(text,/Merge branch/);
});
test('release commit notes enrich only their own business work, without raw merge or release metadata',()=>{
  const e=release('one-release',1,'11','EKS',{mergeRequests:[mr(1),mr(2)]});
  e.details='发布时间：11:00\nMR !1：事项 1\nhttps://gitlab.example.test/business/service/-/merge_requests/1\n  aaaaaaaa fix: 事项 1\n    避免订单重复扣款。（cy）\nMR !2：事项 2\n  bbbbbbbb 事项 2\n    缩短首页加载时间。（other）';
  const result=workSummary([e]);assert.equal(result.items[0].description,'避免订单重复扣款。');assert.equal(result.items[1].description,'缩短首页加载时间。');
  const text=weekContent([e],e.date).content;assert.match(text,/避免订单重复扣款/);assert.doesNotMatch(text,/aaaaaaa|bbbbbbb|MR !|11:00|EKS|#42|cy|other|发布记录|工作明细/);
});
test('only the untouched legacy default template upgrades; custom templates and saved report text remain editable',()=>{
  const legacy='# 工作周报（{{week_start}} ～ {{week_end}}）\n\n## 本周工作\n{{summary}}\n\n## 发布记录\n{{releases}}\n\n## 问题与风险\n{{blockers}}\n\n## 下周计划\n{{next_week}}\n\n## 工作明细\n{{details}}\n';
  assert.doesNotMatch(settingsInput({weeklyTemplate:legacy.trim()}).weeklyTemplate,/发布记录|工作明细/);
  const custom='# 我的格式\n{{summary}}\n{{releases}}\n{{details}}';assert.equal(settingsInput({weeklyTemplate:custom}).weeklyTemplate,custom);
});
test('merging one work from a shared deployment never captures another MR; explicit grouping deduplicates shared facts',()=>{
  const records=[release('shared',1,'11','EKS',{mergeRequests:[mr(1),mr(2)]}),entry('notes',{source:'manual',title:'缓存处理说明'})],before=workSummary(records);
  const one=before.items.find(i=>i.mr?.iid===1),two=before.items.find(i=>i.mr?.iid===2),notes=before.items.find(i=>i.kind==='manual');
  const group={id:'joined',date:'2026-10-26',title:'处理会员缓存',description:'保留结果',members:[...one.memberKeys,...notes.memberKeys]};
  const summary=workSummary(records,[group]);assert.equal(summary.items.length,2);assert.ok(summary.items.some(i=>i.key===two.key));assert.equal(summary.items.find(i=>i.groupId).entryIds.length,2);assert.equal(summary.releaseCount,1);
  group.members=[...new Set([...group.members,...two.memberKeys])];const all=workSummary(records,[group]);assert.equal(all.items.length,1);assert.equal(all.items[0].releases.length,1);assert.equal(all.items[0].entryIds.length,2);assert.equal(all.rawCount,2);
  const tomorrow={...records[0],id:'tomorrow-shared',sourceKey:'tomorrow-shared',date:'2026-10-27'};assert.equal(workSummary([...records,tomorrow],[group]).items.filter(i=>i.date==='2026-10-27').length,2);
});
