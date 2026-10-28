'use strict';
const {mrReference,createLifecycle,applyPhases}=require('./work-lifecycle.cjs');
const active=e=>!e.removed&&e.sourceActive!==false&&e.included!==false;
const eventTime=e=>[e.sourceMeta?.releasedAt,e.sourceMeta?.completedAt,e.sourceMeta?.committedAt].find(Number.isFinite)||Date.parse(e.date+'T00:00:00+08:00');
const order=(a,b)=>a.time-b.time||a.key.localeCompare(b.key);
const cleanTitle=value=>String(value||'').trim().replace(/^(?:feat|fix|perf|refactor|chore|docs|test|build|ci|style|revert)(?:\([^\n)]*\))?!?[:：]\s*/i,'');
function businessLines(value,title=''){
  let fenced=false;const lines=[];
  for(let line of String(value||'').split(/\r?\n/)){
    if(/^\s*```/.test(line)){fenced=!fenced;continue;}if(fenced)continue;
    line=line.trim().replace(/^[-*]\s+|^#{1,6}\s+/,'');
    if(!line||/^(?:https?:\/\/|See merge request\b|Merge branch\b|Merge remote-tracking branch\b|MR\s*!\d+|(?:发布时间|发布人|版本|分支|构建编号|提交编号|Branch|Commit|SHA)[：:]|(?:Co-authored-by|Signed-off-by)[：:])/i.test(line))continue;
    line=cleanTitle(line);if(line===cleanTitle(title)||lines.includes(line))continue;lines.push(line);
  }
  return lines.slice(0,3).join('\n').slice(0,600);
}
function businessTitle(title,details){
  const clean=cleanTitle(title);
  return /^(?:Merge branch|Merge remote-tracking branch)\b/i.test(clean)?businessLines(details).split('\n')[0]||'整理代码变更':clean;
}
function releaseTitle(entry){
  const meta=entry.sourceMeta||{};
  if(meta.direction==='rollback')return '完成生产版本回退';
  if(meta.direction==='same')return '完成生产服务维护';
  const titles=(meta.mergeRequests||[]).map(mr=>businessTitle(mr.title,''));
  if(!titles.length)for(const line of (entry.details||'').split(/\r?\n/)){
    const match=line.match(/^MR\s*!\d+[：:]\s*(.+)$/)||line.match(/^直接提交\s+[a-f0-9]+[：:]\s*(.+?)(?:（[^（）]*）)?$/i);if(match)titles.push(businessTitle(match[1],''));
  }
  return [...new Set(titles)].join('；')||'完成生产服务更新';
}
function releaseDescription(entry,mr){
  let selected=false;const lines=[];
  for(const line of (entry.details||'').split(/\r?\n/)){
    const header=line.match(/^MR\s*!(\d+)[：:]/);
    if(header){selected=Number(header[1])===mr.iid;continue;}
    if(/^直接提交\s/.test(line))selected=false;
    if(selected&&/^\s+/.test(line))lines.push(line.replace(/^\s+[a-f0-9]{8,64}\s+/i,'').trim().replace(/（[^（）]*）$/,''));
  }
  return businessLines(lines.join('\n'),mr.title);
}
function workSummary(entries,workGroups=[],{context=entries,periodEnd}={}){
  const records=entries.filter(active),groups=new Map(),linked=[],lifecycle=createLifecycle(context);
  function attach(item,entry){if(!item.entryIds.includes(entry.id))item.entryIds.push(entry.id);}
  function mrItem(entry,mr){
    const key=entry.date+'|'+mr.url;
    if(!groups.has(key))groups.set(key,{key,date:entry.date,title:businessTitle(mr.title,entry.details),project:entry.project,status:'done',kind:'mr',...lifecycle.state(mr,entry.date),mr,featureKeys:['mr:'+mr.url],time:eventTime(entry),description:'',entryIds:[],releases:[],warnings:[]});
    const item=groups.get(key);item.time=Math.min(item.time,eventTime(entry));attach(item,entry);
    if(item.phase==='unverified'&&!item.warnings.length)item.warnings.push('MR 合并信息不完整，请核对来源');
    const description=entry.source==='gitlab'?entry.details:entry.source==='jenkins'?releaseDescription(entry,mr):'';
    if(description)item.description=businessLines([item.description,description].filter(Boolean).join('\n'),item.title);
    return item;
  }
  function branchItem(entry,feature){
    const key=entry.date+'|'+feature.key;
    if(!groups.has(key))groups.set(key,{key,date:entry.date,title:businessTitle(feature.title||entry.title,feature.details||entry.details),project:entry.project,status:'done',kind:'branch',...lifecycle.state(feature,entry.date),featureKeys:[feature.key],time:eventTime(entry),description:'',entryIds:[],releases:[],warnings:[]});
    const item=groups.get(key);attach(item,entry);if(entry.source==='gitlab')item.description=businessLines([item.description,entry.details].filter(Boolean).join('\n'),item.title);item.time=Math.min(item.time,eventTime(entry));return item;
  }
  function standalone(entry,kind=entry.source){
    const meta=entry.sourceMeta||{},release=entry.source==='jenkins'&&meta.release===true;
    const badge=entry.status==='blocked'?'待解决':entry.status==='planned'?'计划':release?'已完成':['git','gitlab'].includes(entry.source)?'开发中':'已完成';
    const automatic=!entry.edited&&['git','gitlab','jenkins'].includes(entry.source);
    const title=automatic?(release?releaseTitle(entry):businessTitle(entry.title,entry.details)):entry.title;
    const item={key:entry.id||entry.sourceKey,date:entry.date,title,project:entry.project,status:entry.status,kind:release?'release':kind,badge,time:eventTime(entry),description:release&&!entry.edited?'':automatic?businessLines(entry.details,title):entry.details||'',entryIds:[entry.id],releases:[],warnings:[]};
    if(release)item.releases.push(releaseEvent(entry));
    if(meta.rangeVerified===false)item.warnings.push('缺少前次版本，MR 完整范围待核对');
    if((meta.mergeRequests||[]).length>1)item.warnings.push('此提交关联多个 MR，暂未自动归组');
    if(entry.relatedMr)item.warnings.push('关联 MR 不在当天纳入的记录中，暂独立展示');
    groups.set(item.key,item);
  }
  function releaseEvent(entry){const meta=entry.sourceMeta||{};return {id:entry.id,time:eventTime(entry),target:meta.target||meta.environment||'生产',buildNumber:meta.buildNumber,url:entry.evidence,kind:meta.direction==='rollback'?'回退':meta.direction==='same'?'重复发布':'发布'};}
  for(const entry of records){
    if(entry.relatedMr&&['manual','planner'].includes(entry.source)&&entry.status==='done'){linked.push(entry);continue;}
    const meta=entry.sourceMeta||{};
    if(!entry.edited&&entry.status==='done'&&entry.source==='jenkins'&&lifecycle.releaseFeatures(entry).length){
      for(const feature of lifecycle.releaseFeatures(entry)){const item=feature.mr?mrItem(entry,feature.mr):branchItem(entry,feature);item.releases.push(releaseEvent(entry));if(meta.directCommitCount)item.warnings.push('本次发布另含 '+meta.directCommitCount+' 条直接提交，见原始明细');}
    }else if(!entry.edited&&entry.status==='done'&&entry.source==='gitlab'&&lifecycle.feature(entry)){
      const feature=lifecycle.feature(entry);
      if(feature.mr)mrItem(entry,feature.mr);
      else branchItem(entry,feature);
    }
    else standalone(entry);
  }
  for(const entry of linked){
    const item=groups.get(entry.date+'|'+entry.relatedMr);
    if(item){attach(item,entry);(item.legacyLinkIds??=[]).push(entry.id);item.description=[item.description,entry.details||entry.title].filter(Boolean).join('\n');}
    else standalone(entry);
  }
  const sources=new Map(records.map(entry=>[entry.id,entry]));
  let items=[...groups.values()];
  for(const item of items){
    // 一条生产发布可能包含多个 MR；共享证据不能将未选中的业务事项带入合并。
    const owned=item.entryIds.map(id=>sources.get(id)).filter(entry=>!item.mr||['manual','planner'].includes(entry.source)||(entry.sourceMeta?.mergeRequests||[]).length===1);
    item.memberKeys=[...new Set([...(item.mr?['mr:'+item.mr.url]:[]),...owned.map(entry=>'source:'+entry.sourceKey)])];
  }
  // 合并关系独立于来源记录；MR 身份可接住后续采集新增的提交，原始正文不被改写。
  const memberships=new Map(),combined=new Map(),separate=[];
  for(const group of workGroups)for(const member of group.members)memberships.set(group.date+'|'+member,group);
  for(const item of items){
    const matches=new Map(item.memberKeys.map(key=>memberships.get(item.date+'|'+key)).filter(Boolean).map(group=>[group.id,group]));
    if(matches.size!==1||item.status!=='done'){
      if(matches.size>1){item.warnings.push('来源关联了多个合并事项，请核对合并关系');item.conflictingGroups=[...matches.values()].map(group=>({id:group.id,title:group.title}));}separate.push(item);continue;
    }
    const group=[...matches.values()][0];
    // 将保存时的修改意图带到界面，区分“还原修改”和“解除合并”。
    if(!combined.has(group.id))combined.set(group.id,{key:'work:'+group.id,groupId:group.id,editOnly:group.editOnly===true,date:item.date,title:group.title,description:group.description,project:item.project,status:'done',kind:'work',badge:'已完成',time:item.time,entryIds:[],releases:[],warnings:[],memberKeys:[...group.members],featureKeys:[],phases:[]});
    const target=combined.get(group.id);target.time=Math.min(target.time,item.time);
    target.entryIds=[...new Set([...target.entryIds,...item.entryIds])];
    target.releases=[...new Map([...target.releases,...item.releases].map(release=>[release.id,release])).values()];
    target.warnings.push(...item.warnings);target.featureKeys.push(...(item.featureKeys||[]));if(item.phase)target.phases.push(item);
  }
  for(const item of combined.values()){item.featureKeys=[...new Set(item.featureKeys)];applyPhases(item,item.phases);delete item.phases;}
  items=[...separate,...combined.values()];
  for(const item of items){item.releases.sort((a,b)=>a.time-b.time||String(a.id).localeCompare(String(b.id)));if(item.releases.length)item.time=item.releases[0].time;item.warnings=[...new Set(item.warnings)];}
  items.sort(order);
  if(periodEnd){
    const memberships=new Map(),period=[];
    for(const item of items){
      const keys=item.featureKeys||[],existing=[...new Set(keys.map(key=>memberships.get(key)).filter(Boolean))],target=existing[0]||{...item,entryIds:[],releases:[],warnings:[],featureKeys:[]};
      if(!existing.length)period.push(target);
      for(const source of [...existing.slice(1),item]){
        target.entryIds=[...new Set([...target.entryIds,...source.entryIds])];target.releases=[...new Map([...target.releases,...source.releases].map(release=>[release.id,release])).values()];target.warnings=[...new Set([...target.warnings,...source.warnings])];target.featureKeys=[...new Set([...target.featureKeys,...(source.featureKeys||[])])];
        if(source.groupId){target.title=source.title;target.description=source.description;target.groupId=source.groupId;}
        else if(!target.groupId&&source.description&&source.description!==target.description)target.description=businessLines([target.description,source.description].filter(Boolean).join('\n'),target.title);
        if(source!==item)period.splice(period.indexOf(source),1);
      }
      for(const key of target.featureKeys)memberships.set(key,target);
    }
    for(const item of period){
      const phases=item.featureKeys.map(key=>lifecycle.state(key.startsWith('mr:')?{url:key.slice(3)}:{key},periodEnd));applyPhases(item,phases);
    }
    items=period;
  }
  return {items,releaseCount:new Set(items.flatMap(i=>i.releases.map(r=>r.id))).size,rawCount:records.length};
}
module.exports={workSummary,eventTime,mrReference};
