'use strict';
const {createHash}=require('node:crypto');
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const ignored=new Set('修复 调整 解决 问题 功能 完成 工作 优化 处理 更新 新增 实现 支持 修改 增加 删除 测试 验证 进行 相关 这个 那个 一个 今天 昨天 时间 工具 写成 需要 可以 已经 以及 通过 情况 内容 记录 提交 发布 合并 分支 原有 服务 系统 平台'.split(' '));
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\bvip\b/g,'会员').replace(/\bfb\b/g,'facebook').replace(/https?:\/\/\S+|\b[a-f\d]{12,64}\b/g,' ');
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
const identity=item=>item.groupId?'work:'+item.groupId:item.mr?'mr:'+item.mr.url:[...item.memberKeys].sort()[0];
function matchId(a,b){return createHash('sha256').update(JSON.stringify([a.date,...[identity(a),identity(b)].sort()])).digest('hex');}
function workMatches(items,entries=[],dismissed=[]){
  // 否认按来源身份分区保存；补全 MR 或加入其他事项后仍能识别原来的两侧。
  const denials=new Map();
  for(const decision of dismissed)for(const [part,members] of (decision.members||[]).entries())for(const member of members){
    const key=decision.date+'|'+member;if(!denials.has(key))denials.set(key,[]);denials.get(key).push([decision.id,part]);
  }
  const eligible=items.filter(item=>item.status==='done'&&!item.conflictingGroups?.length),profiles=eligible.slice(-500).map(item=>{
    const decisions=new Map();for(const member of item.memberKeys)for(const [id,part] of denials.get(item.date+'|'+member)||[]){if(!decisions.has(id))decisions.set(id,new Set());decisions.get(id).add(part);}
    return {item,words:words(item.title+'\n'+item.description.slice(0,1600)),decisions};
  });
  let limited=eligible.length>profiles.length;const postings=new Map(),pairs=new Set(),candidates=[],hidden=new Set(dismissed.map(item=>item.id)),sources=new Map(entries.map(entry=>[entry.id,entry]));
  for(let i=0;i<profiles.length;i++)for(const word of profiles[i].words){if(!postings.has(word))postings.set(word,[]);const list=postings.get(word);if(list.length<60)list.push(i);else limited=true;}
  for(const list of postings.values())for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    if(pairs.size>=20000){limited=true;break;}
    const key=list[i]+':'+list[j];if(pairs.has(key))continue;pairs.add(key);
    const a=profiles[list[i]],b=profiles[list[j]];
    if(a.item.date!==b.item.date)continue;
    if([...a.decisions].some(([id,parts])=>b.decisions.has(id)&&[...parts].some(part=>[...b.decisions.get(id)].some(other=>part!==other))))continue;
    const known=project=>project&&!['未分类','日程工作'].includes(project);
    if(known(a.item.project)&&known(b.item.project)&&a.item.project!==b.item.project)continue;
    const shared=[...a.words].filter(word=>b.words.has(word));
    if(shared.length<2||shared.length/Math.min(a.words.size,b.words.size)<0.35)continue;
    const id=matchId(a.item,b.item);if(hidden.has(id))continue;
    const planner=[a.item,b.item].find(item=>item.entryIds.some(id=>sources.get(id)?.source==='planner')),preferred=planner||a.item;
    candidates.push({id,keys:[a.item.key,b.item.key],titles:[a.item.title,b.item.title],title:preferred.title,description:preferred.description,reason:'内容共同涉及：'+shared.slice(0,5).join('、'),score:shared.length/Math.min(a.words.size,b.words.size)+shared.length/20});
  }
  candidates.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));if(candidates.length>20)limited=true;
  return {items:candidates.slice(0,20).map(({score,...item})=>item),limited};
}
module.exports={workMatches};
