'use strict';
const {createHash}=require('node:crypto');
const {featureBranch}=require('./work-lifecycle.cjs');
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const ignored=new Set('修复 调整 解决 问题 功能 完成 工作 优化 处理 更新 新增 实现 支持 修改 增加 删除 测试 验证 进行 相关 这个 那个 一个 今天 昨天 时间 工具 写成 需要 可以 已经 以及 通过 情况 内容 记录 提交 发布 合并 分支 原有 服务 系统 平台'.split(' '));
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/^代码已合并[^\S\r\n]+\S+[。.]?$/gm,' ').replace(/\bvip\b/g,'会员').replace(/\bfb\b/g,'facebook').replace(/https?:\/\/\S+|\b[a-f\d]{12,64}\b/g,' ');
function words(value){
  const result=new Set();let previous='';
  for(const part of segmenter.segment(normalize(value))){
    const word=part.segment;
    if(!part.isWordLike){previous='';continue;}
    if(/^[\p{Script=Han}]$/u.test(word)&&!/[时被的为不在已前后按把与及了有是将和到]/.test(word)){
      if(previous)result.add(previous+word);previous=word;
    }else previous='';
    if((/^[\p{Script=Han}]{2,}$/u.test(word)||/^[a-z][a-z\d_-]{2,}$/i.test(word))&&!ignored.has(word))result.add(word);
    if(result.size>=80)break;
  }
  return result;
}
// 分支新增提交不会改变事项身份，保留组标题及已确认的关联判断。
const identity=item=>item.groupId?'work:'+item.groupId:item.mr?'mr:'+item.mr.url:item.kind==='branch'&&item.featureKeys?.length===1?item.featureKeys[0]:[...item.memberKeys].sort()[0];
function matchId(...items){return createHash('sha256').update(JSON.stringify([items[0].date,...items.map(identity).sort()])).digest('hex');}
function taskSignals(item,sources){
  // 相同分支或描述只是待确认线索；即使跨仓库命中，也不在此写入合并关系。
  const branches=new Set(),descriptions=new Set(),mrUrls=new Set([item.mr?.url,...(item.featureKeys||[]).filter(key=>key.startsWith('mr:')).map(key=>key.slice(3))].filter(Boolean));
  const addBranch=value=>{if(featureBranch(value))branches.add(value);};
  addBranch(item.mr?.sourceBranch);
  for(const id of item.entryIds){
    const entry=sources.get(id);if(!entry||!['git','gitlab','jenkins'].includes(entry.source))continue;
    addBranch(entry.sourceMeta?.featureBranch);
    for(const mr of entry.sourceMeta?.mergeRequests||[])if(!mrUrls.size||mrUrls.has(mr.url))addBranch(mr.sourceBranch||mr.source_branch);
  }
  const addDescription=value=>{
    if(!value||value.length>=600||/^代码已合并\s+\S+[。.]?$/.test(value.trim()))return;
    const text=String(value).normalize('NFKC').toLowerCase().trim().replace(/^(?:feat|fix|perf|refactor|chore|docs|test|build|ci|style|revert)(?:\([^\n)]*\))?!?[:：]\s*/i,'').replace(/[_\s-]+/g,' ').replace(/[。.!！]+$/,'');
    if(words(text).size)descriptions.add(text);
  };
  for(const branch of branches){const match=branch.match(/^(?:feat(?:ure)?|hotfix)-cy-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})-(.+)$/i);if(match)addDescription(match[1]);}
  addDescription(item.title);addDescription(item.description);
  return {branches,descriptions};
}
function workMatches(items,entries=[],dismissed=[]){
  // 否认按来源身份分区保存；补全 MR 或加入其他事项后仍能识别原来的两侧。
  const denials=new Map();
  for(const decision of dismissed)for(const [part,members] of (decision.members||[]).entries())for(const member of members){
    const key=decision.date+'|'+member;if(!denials.has(key))denials.set(key,[]);denials.get(key).push([decision.id,part]);
  }
  const sources=new Map(entries.map(entry=>[entry.id,entry])),eligible=items.filter(item=>item.status==='done'&&!item.conflictingGroups?.length),profiles=eligible.slice(-500).map((item,index)=>{
    const decisions=new Map();for(const member of item.memberKeys)for(const [id,part] of denials.get(item.date+'|'+member)||[]){if(!decisions.has(id))decisions.set(id,new Set());decisions.get(id).add(part);}
    return {item,index,words:words(item.title+'\n'+item.description.slice(0,1600)),...taskSignals(item,sources),decisions};
  });
  let limited=eligible.length>profiles.length;const postings=new Map(),pairs=new Set(),candidates=[],hidden=new Set(dismissed.map(item=>item.id));
  const separated=(a,b)=>hidden.has(matchId(a.item,b.item))||[...a.decisions].some(([id,parts])=>b.decisions.has(id)&&[...parts].some(part=>[...b.decisions.get(id)].some(other=>part!==other)));
  for(let i=0;i<profiles.length;i++)for(const key of [...profiles[i].branches].map(value=>'branch:'+value).concat([...profiles[i].descriptions].map(value=>'description:'+value),[...profiles[i].words].map(value=>'word:'+value))){if(!postings.has(key))postings.set(key,[]);const list=postings.get(key);if(list.length<60)list.push(i);else limited=true;}
  for(const list of postings.values())for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    if(pairs.size>=20000){limited=true;break;}
    const key=list[i]+':'+list[j];if(pairs.has(key))continue;pairs.add(key);
    const a=profiles[list[i]],b=profiles[list[j]];
    if(a.item.date!==b.item.date)continue;
    if(dismissed.length&&separated(a,b))continue;
    const branch=[...a.branches].find(value=>b.branches.has(value)),description=[...a.descriptions].find(value=>b.descriptions.has(value)),strong=branch||description;
    const known=project=>project&&!['未分类','日程工作'].includes(project);
    if(!strong&&known(a.item.project)&&known(b.item.project)&&a.item.project!==b.item.project)continue;
    const shared=[...a.words].filter(word=>b.words.has(word));
    if(!strong&&(shared.length<2||shared.length/Math.min(a.words.size,b.words.size)<0.35))continue;
    const reason=branch?'相同功能分支：'+branch:description?'相同任务描述：'+description:'';
    candidates.push({id:matchId(a.item,b.item),profiles:[a,b],shared,reason,score:(branch?100:description?50:0)+shared.length/Math.max(1,Math.min(a.words.size,b.words.size))+shared.length/20});
  }
  candidates.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  // 共享事项的候选归入同一待确认组；已否认的关系不能通过第三项间接归组。
  const memberships=new Map(profiles.map(profile=>[profile,{profiles:[profile],shared:new Set(),score:0,reason:''}])),separate=[];
  for(const candidate of candidates){
    const [a,b]=candidate.profiles,left=memberships.get(a),right=memberships.get(b);
    if(left!==right){
      if(dismissed.length&&left.profiles.some(a=>right.profiles.some(b=>separated(a,b)))){separate.push(candidate);continue;}
      if(left.profiles.length+right.profiles.length>50){limited=true;continue;}
      left.profiles.push(...right.profiles);for(const profile of right.profiles)memberships.set(profile,left);
      for(const word of right.shared)left.shared.add(word);if(right.score>left.score){left.score=right.score;left.reason=right.reason;}
    }
    for(const word of candidate.shared)left.shared.add(word);if(candidate.score>left.score){left.score=candidate.score;left.reason=candidate.reason;}
  }
  const grouped=[...new Set(memberships.values())].filter(group=>group.profiles.length>1).concat(separate).map(group=>{
    const members=[...group.profiles].sort((a,b)=>a.index-b.index),works=members.map(profile=>profile.item),preferred=works.find(item=>item.entryIds.some(id=>sources.get(id)?.source==='planner'))||works[0];
    const common=[...members[0].words].filter(word=>members.every(profile=>profile.words.has(word))),shared=common.length>=2?common:[...group.shared];
    return {id:matchId(...works),keys:works.map(item=>item.key),titles:works.map(item=>item.title),title:preferred.title,description:preferred.description,reason:group.reason||(common.length>=2?'内容共同涉及：':'关联内容涉及：')+shared.slice(0,5).join('、'),score:group.score};
  }).filter(group=>!hidden.has(group.id));
  grouped.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));if(grouped.length>20)limited=true;
  return {items:grouped.slice(0,20).map(({score,...item})=>item),limited};
}
module.exports={workMatches};
