'use strict';
const {dateKey,gitlabUrl}=require('./model.cjs');
const {mrReference,featureBranch,releaseMerge,createLifecycle}=require('./work-lifecycle.cjs');
const {authorFilter,isMergeCommit}=require('./commit-authorship.cjs');
const safe=message=>Object.assign(Error(message),{reportSafe:true});
function positive(value,label){if(!Number.isSafeInteger(value)||value<1)throw safe('无效的 GitLab '+label);return value;}
function createGitlabClient({url,token,fetchImpl=fetch,signal}={}){
  const base=gitlabUrl(url);if(typeof token!=='string'||!token.trim()||token.length>8192||/[\r\n]/.test(token))throw safe('请填写有效的 GitLab Token');
  async function request(endpoint,query={}){
    const target=new URL(base+'/api/v4/'+endpoint);for(const [key,value] of Object.entries(query))target.searchParams.set(key,String(value));
    try{
      const response=await fetchImpl(target.href,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:{'PRIVATE-TOKEN':token,Accept:'application/json'}});
      if(!response.ok)throw safe(response.status===401||response.status===403?'GitLab 认证或读取权限不足，请检查 Token 的 read_api 权限':response.status===429?'GitLab 请求过于频繁，请稍后重试':'GitLab 读取失败，请检查地址、项目权限和网络');
      if(Number(response.headers.get('content-length'))>2*1024*1024)throw safe('GitLab 响应过大，请缩小查询范围');
      let bytes=0,raw='';const decoder=new TextDecoder();
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw safe('GitLab 响应过大，请缩小查询范围');raw+=decoder.decode(chunk,{stream:true});}raw+=decoder.decode();
      return {data:JSON.parse(raw),headers:response.headers};
    }catch(error){if(error.reportSafe)throw error;if(signal?.aborted)throw safe('GitLab 操作已取消');throw safe('GitLab 读取失败，未修改已有记录，请检查网络、HTTPS 证书和站点地址');}
  }
  async function list(endpoint,query,limit=50){
    const page=positive(query.page??1,'页码');if(page>1000)throw safe('GitLab 查询页数过多，请使用搜索缩小范围');
    const {data,headers}=await request(endpoint,{...query,page,per_page:limit});
    if(!Array.isArray(data)||data.length>limit)throw safe('GitLab 返回的列表格式无效');
    const next=headers.get('x-next-page');if(next!==null&&next!==''&&(!/^\d+$/.test(next)||Number(next)!==page+1))throw safe('GitLab 返回的分页信息无效');
    return {items:data,page,hasMore:next===null?data.length===limit:next!==''};
  }
  return {
    async currentUser(){const {data}=await request('user');if(!data||!Number.isSafeInteger(data.id)||typeof data.username!=='string'||!data.username)throw safe('GitLab 返回的账号格式无效');
      const authors=[...new Set([data.email,data.public_email].filter(v=>typeof v==='string'&&/^[^\s,@]+@[^\s,@]+$/.test(v)))].join(',');return {username:data.username.slice(0,200),authors};},
    async groups({page=1,search=''}={}){const result=await list('groups',{page,search:String(search).slice(0,200),all_available:false,order_by:'name',sort:'asc'});
      result.items=result.items.map(group=>{if(!group||!Number.isSafeInteger(group.id)||group.id<1||typeof group.full_path!=='string'||!group.full_path)throw safe('GitLab 返回的分组格式无效');return {id:group.id,fullPath:group.full_path.slice(0,1000)};});return result;},
    async projects({groupId,page=1,search=''}={}){positive(groupId,'分组');const result=await list(`groups/${groupId}/projects`,{page,search:String(search).slice(0,200),include_subgroups:true,with_shared:false,simple:true,order_by:'name',sort:'asc'});
      result.items=result.items.map(project=>{if(!project||!Number.isSafeInteger(project.id)||project.id<1||typeof project.path_with_namespace!=='string'||!project.path_with_namespace)throw safe('GitLab 返回的项目格式无效');return {host:base,projectId:project.id,project:project.path_with_namespace.slice(0,100),path:project.path_with_namespace.slice(0,2000)};});return result;},
    commits(projectId,query){positive(projectId,'项目');return list(`projects/${projectId}/repository/commits`,query,100);},
    async commit(projectId,sha){positive(projectId,'项目');if(!/^[0-9a-f]{40,64}$/.test(sha))throw safe('无效的 GitLab 提交');return (await request(`projects/${projectId}/repository/commits/${sha}`)).data;},
    async compare(projectId,from,to){positive(projectId,'项目');for(const sha of [from,to])if(!/^[0-9a-f]{40,64}$/.test(sha))throw safe('无效的 GitLab 发布版本');return (await request(`projects/${projectId}/repository/compare`,{from,to,straight:true})).data;},
    commitMergeRequests(projectId,sha,page=1){positive(projectId,'项目');if(!/^[0-9a-f]{40,64}$/.test(sha))throw safe('无效的 GitLab 发布版本');return list(`projects/${projectId}/repository/commits/${sha}/merge_requests`,{page},100);},
    mergeRequestCommits(projectId,iid,page=1){positive(projectId,'项目');positive(iid,'MR');return list(`projects/${projectId}/merge_requests/${iid}/commits`,{page},100);},
    async mergeRequest(projectId,iid){positive(projectId,'项目');positive(iid,'MR');return (await request(`projects/${projectId}/merge_requests/${iid}`)).data;},
    commitBranches(projectId,sha,page=1){positive(projectId,'项目');if(!/^[0-9a-f]{40,64}$/.test(sha))throw safe('无效的 GitLab 提交');return list(`projects/${projectId}/repository/commits/${sha}/refs`,{page,type:'branch'},100);}
  };
}
async function collectGitlab(source,{since,until,signal,connection,authors,authorMode='email',authorNames,trackedEntries=[],fetchImpl=fetch}={}){
  if(!connection||gitlabUrl(connection.url)!==gitlabUrl(source.host))throw safe('GitLab 来源与当前连接的实例地址不一致，请重新选择项目');
  const {matches:matchesAuthor}=authorFilter({authors,authorMode,authorNames});
  let requests=0;
  const boundedFetch=(url,options)=>{if(++requests>400)throw safe('GitLab 提交与 MR 关联查询超过 400 次，请缩短回溯范围');return (fetchImpl||fetch)(url,options);};
  const client=createGitlabClient({...connection,fetchImpl:boundedFetch,signal}),result=[],seen=new Set();let scanned=0;
  const repositoryUrl=gitlabUrl(source.host)+'/'+(source.path||source.project).split('/').map(encodeURIComponent).join('/');
  async function associate(){
    // 超出提交回溯窗口的未完成功能仍跟踪一个已有提交；不扩大作者或仓库范围。
    const lifecycle=createLifecycle(trackedEntries),tracked=new Map(),prefix=`gitlab:${gitlabUrl(source.host)}:${source.projectId}:`;
    for(const old of [...trackedEntries].sort((a,b)=>(b.sourceMeta?.committedAt||0)-(a.sourceMeta?.committedAt||0))){
      const meta=old.sourceMeta||{};
      if(old.source!=='gitlab'||old.removed||old.included===false||old.sourceActive===false||isMergeCommit(old)||!old.sourceKey?.startsWith(prefix)||meta.projectId!==source.projectId||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(meta.sha)||!matchesAuthor({author_name:meta.author,author_email:meta.email}))continue;
      const feature=lifecycle.feature(old);if(!feature||feature.mr&&lifecycle.state(feature.mr,dateKey(until)).phase==='completed'||tracked.has(feature.key))continue;
      tracked.set(feature.key,old);
    }
    if(tracked.size>200)throw safe('待跟踪的未完成功能超过 200 项，请先整理历史工作');
    for(const old of tracked.values())if(!seen.has(old.sourceMeta.sha)){seen.add(old.sourceMeta.sha);result.push({...old,sourceMeta:{...old.sourceMeta}});}
    const known=new Map(),bySha=new Map(),details=new Map();
    for(const entry of result){
      if(signal?.aborted)throw safe('GitLab 操作已取消');
      const mrs=new Map();let count=0;
      for(let page=1;page<=3;page++){
        const response=await client.commitMergeRequests(source.projectId,entry.sourceMeta.sha,page);count+=response.items.length;
        if(count>200)throw safe('GitLab 提交关联 MR 超过 200 项，未保存不完整结果');
        for(let mr of response.items){
          if(!['opened','merged'].includes(mr?.state))continue;
          if(mr.project_id!==source.projectId)continue;
          if(!Number.isSafeInteger(mr.iid)||mr.iid<1||typeof mr.title!=='string')throw safe('GitLab 返回的 MR 关联格式无效');
          if(mr.state==='merged'&&mr.source_branch&&mr.target_branch&&!Number.isFinite(Date.parse(mr.merged_at))){
            if(!details.has(mr.iid))details.set(mr.iid,await client.mergeRequest(source.projectId,mr.iid));
            const full=details.get(mr.iid);if(full?.iid!==mr.iid||full.project_id!==source.projectId||full.state!=='merged')throw safe('GitLab 返回的 MR 合并信息不完整');mr={...mr,...full};
          }
          const reference=mrReference({...mr,url:repositoryUrl+'/-/merge_requests/'+mr.iid});
          mrs.set(mr.iid,reference);known.set(mr.iid,reference);
          for(const id of [mr.merge_commit_sha,mr.squash_commit_sha])if(typeof id==='string'&&/^[0-9a-f]{40,64}$/.test(id)){if(!bySha.has(id))bySha.set(id,new Map());bySha.get(id).set(mr.iid,reference);}
        }
        if(!response.hasMore)break;
        if(page===3)throw safe('GitLab 提交关联 MR 分页不完整');
      }
      entry.sourceMeta.mergeRequests=[...mrs.values()];entry.sourceMeta.mrChecked=true;entry.sourceMeta.mrLifecycleChecked=true;entry.sourceMeta.repositoryUrl=repositoryUrl;
      if(mrs.size===1&&featureBranch([...mrs.values()][0].sourceBranch))entry.sourceMeta.featureBranch=[...mrs.values()][0].sourceBranch;
      if(!mrs.size){
        const refs=[];for(let page=1;page<=3;page++){const response=await client.commitBranches(source.projectId,entry.sourceMeta.sha,page);refs.push(...response.items);if(refs.length>200)throw safe('提交分支关联超过 200 项，未保存不完整结果');if(!response.hasMore)break;if(page===3)throw safe('提交分支关联分页不完整');}
        if(refs.some(ref=>ref?.type!=='branch'||typeof ref.name!=='string'))throw safe('GitLab 返回的提交分支格式无效');
        const names=[...new Set(refs.map(ref=>ref.name).filter(featureBranch))];if(names.length===1&&!refs.some(ref=>['main','master'].includes(ref.name)))entry.sourceMeta.featureBranch=names[0];
      }
    }
    for(const entry of result){
      if(entry.sourceMeta.mergeRequests.length)continue;
      const exact=bySha.get(entry.sourceMeta.sha);
      if(exact?.size){entry.sourceMeta.mergeRequests=[...exact.values()];continue;}
    }
    for(const mr of known.values())if(releaseMerge(mr)&&mr.mergedAt>=since&&mr.mergedAt<=until)result.push({source:'gitlab',sourceKey:`gitlab:${gitlabUrl(source.host)}:${source.projectId}:mr:${mr.iid}:merged`,project:source.project,title:mr.title,details:'代码已合并 '+mr.targetBranch+'。',date:dateKey(mr.mergedAt),status:'done',evidence:mr.url,sourceMeta:{projectId:source.projectId,repositoryUrl,mrChecked:true,mrLifecycleChecked:true,mergeRequests:[mr],event:'merged',committedAt:mr.mergedAt}});
    if(result.length>2000)throw safe('提交与功能进展超过 2000 条，请缩短回溯范围');
    return result;
  }
  for(let page=1;page<=21;page++){
    const response=await client.commits(source.projectId,{page,all:true,since:new Date(since).toISOString(),until:new Date(until).toISOString()});
    scanned+=response.items.length;if(scanned>2000)throw safe('GitLab 单项目回溯超过 2000 条提交，请缩短回溯天数');
    for(const commit of response.items){if(!commit)throw safe('GitLab 返回的提交格式无效');const at=Date.parse(commit.committed_date);
      if(!/^[0-9a-f]{40,64}$/.test(commit.id)||!Number.isFinite(at)||typeof commit.author_email!=='string'||typeof commit.title!=='string'||typeof commit.message!=='string')throw safe('GitLab 返回的提交格式无效');
      if(at<since||at>until||!matchesAuthor(commit)||isMergeCommit(commit)||seen.has(commit.id))continue;seen.add(commit.id);
      const evidence=`${gitlabUrl(source.host)}/${(source.path||source.project).split('/').map(encodeURIComponent).join('/')}/-/commit/${commit.id}`;
      result.push({source:'gitlab',sourceKey:`gitlab:${gitlabUrl(source.host)}:${source.projectId}:${commit.id}`,project:source.project,title:commit.title.slice(0,200)||'GitLab 提交',details:commit.message.replace(/^.*(?:\r?\n|$)/,'').trim().slice(0,4000),date:dateKey(at),status:'done',evidence,
        sourceMeta:{projectId:source.projectId,sha:commit.id,parentShas:Array.isArray(commit.parent_ids)?commit.parent_ids.filter(id=>typeof id==='string'&&/^[0-9a-f]{40,64}$/.test(id)):[],author:String(commit.author_name||'').slice(0,200),email:commit.author_email,committedAt:at}});
    }
    if(!response.hasMore)return associate();
  }
  throw safe('GitLab 单项目回溯超过 2000 条提交，请缩短回溯天数');
}
module.exports={gitlabUrl,authorFilter,createGitlabClient,collectGitlab};
