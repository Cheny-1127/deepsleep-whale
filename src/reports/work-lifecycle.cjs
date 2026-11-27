'use strict';
const {isMergeCommit}=require('./commit-authorship.cjs');
const active=entry=>!entry.removed&&entry.sourceActive!==false&&entry.included!==false;
const featureBranch=value=>typeof value==='string'&&value.length<=500&&/^(?:feat(?:ure)?|hotfix)[/-]/i.test(value)&&!/[\0\r\n]/.test(value);
function mrReference(value){
  if(!value||!Number.isSafeInteger(value.iid)||value.iid<1||typeof value.title!=='string')return null;
  try{
    const url=new URL(value.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/-/merge_requests/'+value.iid))return null;
    const result={iid:value.iid,title:value.title,url:url.href};
    if(['opened','merged','closed'].includes(value.state))result.state=value.state;
    for(const [key,raw] of [['sourceBranch',value.sourceBranch??value.source_branch],['targetBranch',value.targetBranch??value.target_branch]])if(typeof raw==='string'&&raw.length<=500&&!/[\0\r\n]/.test(raw))result[key]=raw;
    const mergedAt=Number.isFinite(value.mergedAt)?value.mergedAt:Date.parse(value.merged_at);if(Number.isFinite(mergedAt))result.mergedAt=mergedAt;
    return result;
  }catch{return null;}
}
const repository=entry=>{
  try{const url=new URL(entry.sourceMeta?.repositoryUrl||entry.evidence);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return '';return url.href.replace(/\/-\/(?:commit|merge_requests)\/[^/]+\/?$/,'').replace(/\/$/,'');}catch{return '';}
};
const incompleteMerge=mr=>!mr?.state||mr.state==='merged'&&(!mr.targetBranch||!Number.isFinite(mr.mergedAt));
const testingBranches=new Set(['test','uat']);
const automaticReleaseProject=mr=>typeof mr?.url==='string'&&/^https:\/\/[^/]+\/ossv\/(?:[^/]+\/)+-\/merge_requests\/\d+$/.test(mr.url);
const testingMerge=mr=>automaticReleaseProject(mr)&&mr.state==='merged'&&Number.isFinite(mr.mergedAt)&&testingBranches.has(mr.targetBranch);
function needsMrRefresh(entry){
  if(entry.source!=='gitlab'||entry.removed||entry.sourceActive===false||isMergeCommit(entry))return false;
  const meta=entry.sourceMeta||{};
  return !meta.mrChecked||meta.mrLifecycleChecked!==true&&(meta.mergeRequests||[]).some(value=>incompleteMerge(mrReference(value)));
}
function releaseMerge(mr){
  if(mr?.state!=='merged'||!Number.isFinite(mr.mergedAt)||!mr.targetBranch?.trim())return false;
  if(testingBranches.has(mr.targetBranch))return false;
  if(mr.targetBranch==='main')return true;
  try{return new URL(mr.url).pathname.endsWith('/ossv/d-minitv-admin/-/merge_requests/'+mr.iid);}catch{return false;}
}
const mergeProgress=mr=>releaseMerge(mr)||testingMerge(mr);
function createLifecycle(entries){
  const records=entries.filter(active),references=new Map(),branches=new Map(),stagesByMr=new Map(),releases=new Map(),releaseFeatures=new Map();
  for(const entry of records)for(const mr of (entry.sourceMeta?.mergeRequests||[]).map(mrReference).filter(Boolean)){
    const previous=references.get(mr.url);
    if(!previous||Number.isFinite(mr.mergedAt)||!Number.isFinite(previous.mergedAt))references.set(mr.url,{...previous,...mr});
  }
  for(const mr of references.values())if(mr.sourceBranch){const key=mr.url.replace(/\/-\/merge_requests\/\d+$/,'')+'|'+mr.sourceBranch;if(!branches.has(key))branches.set(key,[]);branches.get(key).push(mr);}
  for(const candidates of branches.values()){
    const stages=new Map();
    if(!candidates.every(mr=>automaticReleaseProject(mr)&&featureBranch(mr.sourceBranch)))continue;
    for(const mr of candidates)if(mr.state!=='closed'&&(mr.targetBranch==='main'||testingBranches.has(mr.targetBranch))){
      if(stages.has(mr.targetBranch)){stages.clear();break;}
      stages.set(mr.targetBranch,mr);
    }
    if(stages.size<2)continue;
    const primary=stages.get('main')||stages.get('uat')||stages.get('test');
    const group={primary,stages:[...stages.values()]};
    for(const mr of group.stages)stagesByMr.set(mr.url,group);
  }
  // 同仓库的显式环境分支可在对应 main 合并后归入正式事项，保留独立的测试 MR 作为来源。
  for(const [branchKey,candidates] of branches){
    if(candidates.some(mr=>mr.targetBranch==='main'&&mr.state!=='closed'))continue;
    for(const test of candidates){
      if(!testingMerge(test)||!featureBranch(test.sourceBranch)||stagesByMr.has(test.url))continue;
      const suffix='-'+test.targetBranch;
      if(!test.sourceBranch.endsWith(suffix))continue;
      const mains=(branches.get(branchKey.slice(0,-suffix.length))||[]).filter(mr=>mr.targetBranch==='main'&&mr.state!=='closed');
      if(mains.length!==1||!releaseMerge(mains[0])||test.mergedAt>mains[0].mergedAt)continue;
      const [main]=mains,group=stagesByMr.get(main.url)||{primary:main,stages:[main]};
      group.stages.push(test);
      stagesByMr.set(main.url,group);
      stagesByMr.set(test.url,group);
    }
  }
  function resolvedMr(mr){return stagesByMr.get(mr.url)?.primary||references.get(mr.url)||mr;}
  function mrKeys(mr){
    const stages=stagesByMr.get(mr.url)?.stages;
    return (stages||[mr]).map(value=>'mr:'+value.url);
  }
  const commits=new Map();
  for(const entry of records){
    if(entry.source!=='gitlab'||!entry.sourceMeta?.sha)continue;
    const repo=repository(entry),value=feature(entry);if(repo&&value)commits.set(repo+'|'+entry.sourceMeta.sha,value);
  }
  for(const entry of records){
    const meta=entry.sourceMeta||{};
    if(entry.source!=='jenkins'||meta.release!==true||meta.rangeVerified!==true||meta.direction!=='forward'||meta.environment&&meta.environment!=='prod'||!Number.isFinite(meta.releasedAt))continue;
    const targets=new Map();
    for(const value of (meta.mergeRequests||[]).map(mrReference).filter(Boolean)){const mr=resolvedMr(value);targets.set('mr:'+mr.url,{key:'mr:'+mr.url,mr});}
    const repo=repository(entry);if(repo)for(const sha of meta.ownCommitShas||meta.commitShas||[]){const value=commits.get(repo+'|'+sha);if(value)targets.set(value.key,value);}
    releaseFeatures.set(entry.id||entry.sourceKey,[...targets.values()]);
    for(const key of targets.keys()){if(!releases.has(key))releases.set(key,[]);releases.get(key).push(meta.releasedAt);}
  }
  function state(mr,date){
    const end=Date.parse(date+'T23:59:59.999+08:00'),reference=resolvedMr(mr),key=reference.url?'mr:'+reference.url:mr.key;
    const completedAt=(releases.get(key)||[]).filter(time=>time<=end).sort((a,b)=>a-b)[0];
    const mainPublishedAt=automaticReleaseProject(reference)&&reference.targetBranch==='main'&&releaseMerge(reference)&&reference.mergedAt<=end?reference.mergedAt:undefined;
    if(Number.isFinite(completedAt))return {phase:'completed',badge:'已完成',completedAt,mainPublishedAt};
    if(mainPublishedAt!==undefined)return {phase:'completed',badge:'已发布',completedAt:mainPublishedAt,mainPublishedAt};
    if(!mr.url)return {phase:'developing',badge:'开发中'};
    const stages=stagesByMr.get(reference.url)?.stages;
    const progress=stages||[reference];
    if(progress.some(mr=>testingMerge(mr)&&mr.mergedAt<=end))return {phase:'testing',badge:'测试中'};
    if(incompleteMerge(reference))return {phase:'unverified',badge:'待核对'};
    return releaseMerge(reference)&&reference.mergedAt<=end?{phase:'pending-release',badge:'待发布'}:{phase:'developing',badge:'开发中'};
  }
  function feature(entry){
    const meta=entry.sourceMeta||{},mrs=(meta.mergeRequests||[]).map(mrReference).filter(Boolean);
    const mapped=new Map(mrs.map(resolvedMr).map(mr=>[mr.url,mr]));
    if(mapped.size===1){const [mr]=mapped.values();return {key:'mr:'+mr.url,mr};}
    if(mrs.length||!featureBranch(meta.featureBranch))return null;
    const repo=repository(entry);if(!repo)return null;
    const eligible=(branches.get(repo+'|'+meta.featureBranch)||[]).filter(mr=>!Number.isFinite(mr.mergedAt)||!Number.isFinite(meta.committedAt)||meta.committedAt<=mr.mergedAt);
    const known=[...new Map(eligible.map(resolvedMr).map(mr=>[mr.url,mr])).values()];
    return known.length===1?{key:'mr:'+known[0].url,mr:known[0]}:{key:'branch:'+repo+'|'+meta.featureBranch,branch:meta.featureBranch,title:entry.title,details:entry.details};
  }
  return {feature,state,mrKeys,releaseFeatures:entry=>releaseFeatures.get(entry.id||entry.sourceKey)||[]};
}
function applyPhases(item,phases){
  if(!phases.length)return;
  const completed=phases.filter(value=>value.phase==='completed');
  const mainPublishes=completed.map(value=>value.mainPublishedAt).filter(Number.isFinite);
  const phase=completed.find(value=>value.badge==='已完成')||completed[0]||phases.find(value=>value.phase==='unverified')||phases.find(value=>value.phase==='developing')||phases.find(value=>value.phase==='pending-release')||phases[0];
  item.phase=phase.phase;item.badge=phase.badge;
  if(completed.length)item.completedAt=Math.min(...completed.map(value=>value.completedAt));else delete item.completedAt;
  if(mainPublishes.length)item.mainPublishedAt=Math.max(...mainPublishes);else delete item.mainPublishedAt;
}
module.exports={mrReference,featureBranch,needsMrRefresh,mergeProgress,createLifecycle,applyPhases};
