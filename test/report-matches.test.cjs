'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {workMatches}=require('../src/reports/work-matches.cjs');
const date='2026-10-26';
const item=(key,title,description='',extra={})=>({key,date,title,description,status:'done',project:'日程工作',memberKeys:['source:'+key],entryIds:[key],...extra});
test('different business titles are suggested using specific shared content, not auto merged',()=>{
  const items=[item('planner','调整VIP播放缓存问题','解决 epilora 到期前最后不足 1 秒的边界漏洞：时间取整为 0 → 工具写成永久缓存 → 读取不验证有效期 → 持续按 VIP 放行。'),item('code','修复会员临近过期时缓存被写成永久有效的问题','', {project:'business/play'})];
  const matches=workMatches(items,[{id:'planner',source:'planner'}]);
  assert.equal(matches.items.length,1);assert.match(matches.items[0].reason,/缓存/);assert.equal(matches.items[0].title,items[0].title);assert.deepEqual(matches.items[0].keys,['planner','code']);assert.equal(items.length,2);
  assert.equal(workMatches(items,[],[{date,id:matches.items[0].id}]).items.length,0);
  assert.equal(workMatches([...items].reverse()).items[0].id,matches.items[0].id);
});
test('generic overlap, other projects, dates, uncompleted and conflicting works do not produce reminders',()=>{
  const base=item('a','修复会员缓存过期判断');
  for(const other of [item('b','调整登录缓存'),item('b','修复问题优化功能'),item('b',base.title,'',{status:'planned'}),item('b',base.title,'',{status:'blocked'}),item('b',base.title,'',{date:'2026-10-27'}),item('b',base.title,'',{conflictingGroups:[{id:'conflict'}]})])assert.equal(workMatches([base,other]).items.length,0);
  assert.equal(workMatches([{...base,project:'business/a'},item('b',base.title,'',{project:'business/b'})]).items.length,0);
  assert.equal(workMatches([item('a','修复问题'),item('b','修复问题')]).items.length,0);
});
test('stable MR identity keeps a dismissal across new commits and title edits',()=>{
  const a=item('a','修复会员缓存过期判断'),b=item('b','调整会员缓存过期判断','',{mr:{url:'https://gitlab.example.test/p/-/merge_requests/1'}});
  const id=workMatches([a,b]).items[0].id;
  b.title='会员缓存有效期修复';b.memberKeys.push('source:new-commit');
  assert.equal(workMatches([a,b],[],[{date,id}]).items.length,0);
});
test('large candidate sets are bounded and explicitly indicate incomplete checks',()=>{
  const result=workMatches(Array.from({length:700},(_,i)=>item('task-'+i,'会员缓存有效期修复')));
  assert.ok(result.items.length<=20);assert.equal(result.limited,true);
});
