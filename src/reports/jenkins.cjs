'use strict';
const {dateKey}=require('./model.cjs');
const {releaseChanges}=require('./release-changes.cjs');
const safe=message=>Object.assign(Error(message),{reportSafe:true});
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40,64}$/.test(value);
function remotePath(value){
  if(typeof value!=='string')return '';
  try{return decodeURIComponent(new URL(value.replace(/^git@([^:]+):/,'https://$1/')).pathname).replace(/^\/+|\/+$/g,'').replace(/\.git$/,'');}catch{return '';}
}
async function collectJenkins(source,{since,until,signal,environment,fetchImpl=fetch,connection,gitlabProjects=[],gitlabFetchImpl=fetch,authors,authorMode,authorNames}={}){
  // 工作报告只扫描生产发布；保留旧配置字段以兼容已有账本，不再以手工勾选认定发布。
  if(source.environment!=='prod')return [];
  let base;
  try{base=new URL(environment.jenkinsUrl);if(!['https:','http:'].includes(base.protocol)||base.username||base.password||/[?#]/.test(environment.jenkinsUrl)||!environment.jenkinsUser||!environment.jenkinsToken)throw Error();}
  catch{throw safe('请在 .env 配置 Jenkins 地址、用户名和 API Token');}
  const users=new Set(source.userIds.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean));if(!users.size)throw safe('请配置要采集的 Jenkins 发布人账号');
  const projects=gitlabProjects.filter(p=>p.project===source.project||p.path===source.project);
  if(projects.length!==1)throw safe('请在 GitLab 中勾选与 Jenkins 项目名完全对应的业务仓库');
  const project={...projects[0],path:projects[0].path||projects[0].project};
  const jobUrl=base.href.replace(/\/+$/,'')+'/'+source.job.split('/').map(name=>'job/'+encodeURIComponent(name)).join('/')+'/';
  const headers={Authorization:'Basic '+Buffer.from(environment.jenkinsUser+':'+environment.jenkinsToken).toString('base64'),Accept:'application/json'};
  let requests=0;
  async function read(endpoint,tree){
    if(++requests>202)throw safe('Jenkins 发布核对超过请求上限，请缩小回溯范围');
    const url=new URL(endpoint,jobUrl);if(tree)url.searchParams.set('tree',tree);
    const response=await fetchImpl(url.href,{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers});
    if(!response.ok)throw safe(response.status===401||response.status===403?'Jenkins 认证或读取权限不足':'Jenkins 发布历史或部署阶段读取失败，请检查任务与 Pipeline API');
    if(Number(response.headers?.get('content-length'))>2*1024*1024)throw safe('Jenkins 历史响应过大，请缩短回溯范围');
    let bytes=0,raw='';const decoder=new TextDecoder();
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw safe('Jenkins 历史响应过大，请缩短回溯范围');raw+=decoder.decode(chunk,{stream:true});}raw+=decoder.decode();
    return JSON.parse(raw);
  }
  const stageCache=new Map();
  let gitlabRequests=0;
  const readGitlab=(url,options)=>{if(++gitlabRequests>400)throw safe('Jenkins 来源关联 GitLab 查询超过 400 次，请缩小时间范围');return gitlabFetchImpl(url,options);};
  async function deployment(build){
    if(stageCache.has(build.number))return stageCache.get(build.number);
    const params=Object.fromEntries((build.actions||[]).flatMap(a=>Array.isArray(a.parameters)?a.parameters:[]).filter(p=>typeof p?.name==='string').map(p=>[p.name,p.value]));
    if(params.ACTION!==undefined&&!['build_deploy','deploy','all'].includes(params.ACTION)){stageCache.set(build.number,null);return null;}
    const pipeline=await read(build.number+'/wfapi/describe');
    if(!Array.isArray(pipeline.stages))throw safe('Jenkins 未返回可核实的部署阶段');
    const stages=pipeline.stages.filter(s=>s.name==='Deploy to EKS'||s.name==='发布/回滚/启动/停止');
    if(!stages.length)throw safe('未识别到实际部署阶段，不能把构建成功视为发布');
    const executed=stages.filter(s=>s.status==='SUCCESS');
    if(!executed.length){stageCache.set(build.number,null);return null;}
    if(executed.length!==1)throw safe('存在多个部署阶段，无法确认发布完成时间');
    const stage=executed[0];
    if(stage.name==='发布/回滚/启动/停止'&&params.ACTION===undefined)throw safe('旧流水线缺少 ACTION，无法确认执行了发布');
    if(!Number.isSafeInteger(stage.startTimeMillis)||!Number.isFinite(stage.durationMillis)||stage.durationMillis<=0)throw safe('部署阶段缺少有效完成时间');
    if(params.IMAGE_TAG&&!['无需选择','none'].includes(params.IMAGE_TAG))throw safe('本次使用已有制品，无法从 checkout 版本确认实际发布 SHA，请先核对制品版本');
    const revisions=(build.actions||[]).filter(a=>(a.remoteUrls||[]).some(remote=>remotePath(remote)===project.path)).map(a=>a.lastBuiltRevision?.SHA1);
    const unique=[...new Set(revisions)];if(unique.length!==1||!sha(unique[0]))throw safe('无法唯一确认业务仓库发布 SHA，已排除流水线脚本仓库');
    const targets=params.RELEASE_SERVERS;
    const targetKey=stage.name==='Deploy to EKS'?'EKS':JSON.stringify((Array.isArray(targets)?targets:String(targets||'').split(',')).map(String).map(s=>s.trim()).filter(Boolean).sort());
    const result={build,sha:unique[0],releasedAt:stage.startTimeMillis+stage.durationMillis,targetKey,stage:stage.name,
      publishers:[...new Set((build.actions||[]).flatMap(a=>Array.isArray(a.causes)?a.causes:[]).map(c=>c.userId).filter(v=>typeof v==='string'))]};
    stageCache.set(build.number,result);return result;
  }
  try{
    const data=await read('api/json','allBuilds[number,building,result,timestamp,duration,actions[causes[userId],parameters[name,value],remoteUrls,lastBuiltRevision[SHA1]]]{0,201}');
    if(!Array.isArray(data.allBuilds)||data.allBuilds.length>201)throw safe('Jenkins 发布历史格式无效');
    for(const b of data.allBuilds)if(!Number.isSafeInteger(b.number)||b.number<1||typeof b.building!=='boolean'||!Number.isSafeInteger(b.timestamp)||!Number.isFinite(b.duration)||b.duration<0)throw safe('Jenkins 发布历史格式无效');
    if(new Set(data.allBuilds.map(b=>b.number)).size!==data.allBuilds.length)throw safe('Jenkins 发布历史包含重复构建编号');
    if(data.allBuilds.length===201&&data.allBuilds.at(-1).timestamp+data.allBuilds.at(-1).duration>=since)throw safe('Jenkins 发布回溯超过 200 次构建，请缩小时间范围');
    const builds=data.allBuilds.filter(b=>!b.building&&b.result==='SUCCESS').sort((a,b)=>b.timestamp-a.timestamp),releases=[];
    // 从时间窗口回溯，并保留窗口外前次成功部署作为基线；不把前次构建或自己的前次发布当基线。
    for(const build of builds){
      if(build.timestamp>until||build.timestamp+build.duration<since)continue;
      const release=await deployment(build);if(release&&release.releasedAt>=since&&release.releasedAt<=until)releases.push(release);
    }
    const result=[];
    for(const release of releases.filter(r=>r.publishers.some(user=>users.has(user)))){
      let previous;
      // 核对所有可能更早完成的成功部署，兼容等待审批导致构建完成顺序与编号不同。
      for(const build of builds){
        if(build.number===release.build.number||build.timestamp>=release.releasedAt)continue;
        if(previous&&build.timestamp+build.duration<previous.releasedAt)continue;
        const candidate=await deployment(build);
        if(candidate&&candidate.targetKey===release.targetKey&&candidate.releasedAt<release.releasedAt&&(!previous||candidate.releasedAt>previous.releasedAt))previous=candidate;
      }
      if(data.allBuilds.length===201&&!previous)throw safe('Jenkins 历史已截断且缺少前次发布基线，请核对更早发布');
      const changes=await releaseChanges(project,{from:previous?.sha,to:release.sha,connection,fetchImpl:readGitlab,signal,authors,authorMode,authorNames,releasedAt:release.releasedAt});
      if(!changes.ownCommitCount)continue;
      const {details:changeDetails,...changeMeta}=changes;
      const context=[source.environment,source.target].filter(Boolean).join(' / '),time=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(release.releasedAt);
      const details=`发布时间：${time}\n发布人：${release.publishers.join('、')}\n版本：${previous?previous.sha.slice(0,8):'起点待核对'} → ${release.sha.slice(0,8)}\n${changeDetails}`;
      if(details.length>4000)throw safe('发布内容超过工作记录长度上限，未截断保存');
      result.push({source:'jenkins',sourceKey:`jenkins:${jobUrl}:${release.build.number}`,title:`${source.project}${context?'（'+context+'）':''}发布完成 #${release.build.number}`,project:source.project,details,date:dateKey(release.releasedAt),status:'done',evidence:jobUrl+release.build.number+'/',
        sourceMeta:{buildNumber:release.build.number,url:jobUrl+release.build.number+'/',completedAt:release.releasedAt,releasedAt:release.releasedAt,environment:source.environment,target:source.target,targetScope:release.targetKey,release:true,stage:release.stage,publishers:release.publishers,sha:release.sha,previousSha:previous?.sha||'',previousBuild:previous?.build.number||null,...changeMeta}});
    }
    return result;
  }catch(error){if(error.reportSafe)throw error;if(signal?.aborted)throw error;throw safe('Jenkins 发布读取失败，未修改已有工作记录，请检查网络和任务权限');}
}
module.exports={collectJenkins};
