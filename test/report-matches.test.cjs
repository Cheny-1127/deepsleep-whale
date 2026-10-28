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
test('overlapping matches group both repositories with their shared planner exactly once',()=>{
  const items=[item('admin','应用管理支持客户端类型配置与筛选','',{project:'business/admin'}),item('backend','应用管理支持客户端类型并修复跨应用列表查询','',{project:'business/api'}),item('planner','APP应用类型新增','h5、app、tiktok')],entries=[{id:'planner',source:'planner'}];
  const result=workMatches(items,entries);
  assert.equal(result.items.length,1);assert.deepEqual(result.items[0].keys,['admin','backend','planner']);assert.equal(result.items[0].title,items[2].title);assert.equal(result.items[0].description,items[2].description);assert.match(result.items[0].reason,/应用、类型/);assert.equal(result.limited,false);
  assert.equal(workMatches([...items].reverse(),entries).items[0].id,result.items[0].id);
  assert.equal(workMatches(items,entries,[{date,id:result.items[0].id}]).items.length,0);
});
test('a shared planner cannot regroup a previously dismissed pair indirectly',()=>{
  const items=['a','b','planner'].map(key=>item(key,'会员缓存有效期修复')),entries=[{id:'planner',source:'planner'}];
  const pair=workMatches(items.slice(0,2)).items[0];
  for(const decision of [{date,id:pair.id},{date,id:pair.id,members:items.slice(0,2).map(item=>item.memberKeys)}]){
    const result=workMatches(items,entries,[decision]);
    assert.equal(result.items.length,2);assert.ok(result.items.every(match=>!(match.keys.includes('a')&&match.keys.includes('b'))));
    assert.ok(result.items.some(match=>match.keys.includes('a')&&match.keys.includes('planner')));assert.ok(result.items.some(match=>match.keys.includes('b')&&match.keys.includes('planner')));
  }
});
test('grouping respects the fifty-work merge limit and the twenty-group display limit',()=>{
  const large=workMatches(Array.from({length:51},(_,i)=>item('task-'+i,'会员缓存有效期修复')));
  assert.equal(large.items.length,1);assert.equal(large.items[0].keys.length,50);assert.equal(large.limited,true);
  const separate=workMatches(Array.from({length:21},(_,i)=>[item('a-'+i,'topic'+i+' feature'+i),item('b-'+i,'topic'+i+' feature'+i)]).flat());
  assert.equal(separate.items.length,20);assert.equal(separate.limited,true);
});
test('large candidate sets are bounded and explicitly indicate incomplete checks',()=>{
  const result=workMatches(Array.from({length:700},(_,i)=>item('task-'+i,'会员缓存有效期修复')));
  assert.ok(result.items.length<=20);assert.equal(result.limited,true);
});
