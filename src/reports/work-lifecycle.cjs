'use strict';
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
function needsMrRefresh(entry){
  if(entry.source!=='gitlab'||entry.removed||entry.sourceActive===false)return false;
  const meta=entry.sourceMeta||{};
  return !meta.mrChecked||meta.mrLifecycleChecked!==true&&(meta.mergeRequests||[]).some(value=>incompleteMerge(mrReference(value)));
}
function releaseMerge(mr){
  if(mr?.state!=='merged'||!Number.isFinite(mr.mergedAt)||!mr.targetBranch?.trim())return false;
  if(mr.targetBranch==='main')return true;
  try{return new URL(mr.url).pathname.endsWith('/ossv/d-minitv-admin/-/merge_requests/'+mr.iid);}catch{return false;}
}
function createLifecycle(entries){
  const records=entries.filter(active),references=new Map(),branches=new Map(),releases=new Map(),releaseFeatures=new Map();
  for(const entry of records)for(const mr of (entry.sourceMeta?.mergeRequests||[]).map(mrReference).filter(Boolean)){
    const previous=references.get(mr.url);
    if(!previous||Number.isFinite(mr.mergedAt)||!Number.isFinite(previous.mergedAt))references.set(mr.url,{...previous,...mr});
  }
  for(const mr of references.values())if(mr.sourceBranch){const key=mr.url.replace(/\/-\/merge_requests\/\d+$/,'')+'|'+mr.sourceBranch;if(!branches.has(key))branches.set(key,[]);branches.get(key).push(mr);}
  const commits=new Map();
  for(const entry of records){
    if(entry.source!=='gitlab'||!entry.sourceMeta?.sha)continue;
    const repo=repository(entry),value=feature(entry);if(repo&&value)commits.set(repo+'|'+entry.sourceMeta.sha,value);
  }
  for(const entry of records){
    const meta=entry.sourceMeta||{};
    if(entry.source!=='jenkins'||meta.release!==true||meta.rangeVerified!==true||meta.direction!=='forward'||meta.environment&&meta.environment!=='prod'||!Number.isFinite(meta.releasedAt))continue;
    const targets=new Map();
    for(const value of (meta.mergeRequests||[]).map(mrReference).filter(Boolean)){const mr=references.get(value.url)||value;targets.set('mr:'+mr.url,{key:'mr:'+mr.url,mr});}
    const repo=repository(entry);if(repo)for(const sha of meta.commitShas||[]){const value=commits.get(repo+'|'+sha);if(value)targets.set(value.key,value);}
    releaseFeatures.set(entry.id||entry.sourceKey,[...targets.values()]);
    for(const key of targets.keys()){if(!releases.has(key))releases.set(key,[]);releases.get(key).push(meta.releasedAt);}
  }
  function state(mr,date){
    const end=Date.parse(date+'T23:59:59.999+08:00'),reference=references.get(mr.url)||mr,key=mr.url?'mr:'+mr.url:mr.key;
    const completedAt=(releases.get(key)||[]).filter(time=>time<=end).sort((a,b)=>a-b)[0];
    if(Number.isFinite(completedAt))return {phase:'completed',badge:'已完成',completedAt};
    if(!mr.url)return {phase:'developing',badge:'开发中'};
    if(incompleteMerge(reference))return {phase:'unverified',badge:'待核对'};
    return releaseMerge(reference)&&reference.mergedAt<=end?{phase:'pending-release',badge:'待发布'}:{phase:'developing',badge:'开发中'};
  }
  function feature(entry){
    const meta=entry.sourceMeta||{},mrs=(meta.mergeRequests||[]).map(mrReference).filter(Boolean);
    if(mrs.length===1)return {key:'mr:'+mrs[0].url,mr:references.get(mrs[0].url)||mrs[0]};
    if(mrs.length||!featureBranch(meta.featureBranch))return null;
    const repo=repository(entry);if(!repo)return null;
    const known=(branches.get(repo+'|'+meta.featureBranch)||[]).filter(mr=>!Number.isFinite(mr.mergedAt)||!Number.isFinite(meta.committedAt)||meta.committedAt<=mr.mergedAt);
    return known.length===1?{key:'mr:'+known[0].url,mr:known[0]}:{key:'branch:'+repo+'|'+meta.featureBranch,branch:meta.featureBranch,title:entry.title,details:entry.details};
  }
  return {feature,state,releaseFeatures:entry=>releaseFeatures.get(entry.id||entry.sourceKey)||[]};
}
function applyPhases(item,phases){
  if(!phases.length)return;
  const completed=phases.filter(value=>value.phase==='completed');
  const phase=completed[0]||phases.find(value=>value.phase==='unverified')||phases.find(value=>value.phase==='developing')||phases.find(value=>value.phase==='pending-release')||phases[0];
  item.phase=phase.phase;item.badge=phase.badge;
  if(completed.length)item.completedAt=Math.min(...completed.map(value=>value.completedAt));else delete item.completedAt;
}
module.exports={mrReference,featureBranch,needsMrRefresh,releaseMerge,createLifecycle,applyPhases};
