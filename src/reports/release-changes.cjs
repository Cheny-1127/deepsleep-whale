'use strict';
const {createGitlabClient,gitlabUrl}=require('./gitlab.cjs');
const {mrReference}=require('./work-lifecycle.cjs');
const safe=message=>Object.assign(Error(message),{reportSafe:true});
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40,64}$/.test(value);
const message=commit=>typeof commit.message==='string'&&commit.message.trim()?commit.message.trim():commit.title;
async function releaseChanges(project,{from,to,connection,fetchImpl,signal}={}){
  if(!connection||gitlabUrl(connection.url)!==gitlabUrl(project.host))throw safe('请连接发布项目所属的 GitLab，以读取 MR 内容');
  const client=createGitlabClient({...connection,fetchImpl,signal}),base=gitlabUrl(project.host)+'/'+project.path.split('/').map(encodeURIComponent).join('/');
  if(!sha(to)||from&&!sha(from))throw safe('无法确认业务发布版本，未读取 MR');
  if(from===to)return {details:'与前次成功发布版本相同，本次无新增提交。',mergeRequests:[],commitCount:0,direction:'same',rangeVerified:true};
  let commits=[],direction='forward';
  async function compare(left,right){const data=await client.compare(project.projectId,left,right);if(!data||!Array.isArray(data.commits)||data.commits.length>200||data.commits.some(c=>!sha(c?.id)||typeof c.title!=='string'))throw safe('发布版本比较不完整或超过 200 条提交，请缩小范围核对');return data.commits;}
  if(from){
    commits=await compare(from,to);
    const reverse=await compare(to,from);
    if(commits.length&&reverse.length)throw safe('生产版本发生分叉，无法自动确定完整 MR 范围，请核对版本切换');
    if(!commits.length){commits=reverse;direction='rollback';if(!commits.length)throw safe('发布版本关系无法确认，未猜测 MR 范围');}
  }
  const ids=new Set(commits.map(c=>c.id)),mrs=new Map(),covered=new Set(),lines=[],unknown=!from;
  // 无前次版本时只列出目标版本关联 MR，明确提示不能当作完整发布范围。
  if(unknown)lines.push('⚠ 缺少前次成功发布版本；以下仅为目标版本关联 MR，不代表本次完整变更。');
  if(direction==='rollback')lines.push('版本回退：以下为此次回退移除的 MR / 提交。');
  let requests=0;
  async function pages(read){const result=[];for(let page=1;page<=3;page++){if(++requests>400)throw safe('发布 MR 查询超过上限，未保存不完整结果');const response=await read(page);result.push(...response.items);if(result.length>200)throw safe('发布关联 MR 或提交超过 200 条，未保存不完整结果');if(!response.hasMore)return result;}throw safe('发布 MR 分页不完整');}
  for(const commit of unknown?[{id:to}]:commits){
    const items=await pages(page=>client.commitMergeRequests(project.projectId,commit.id,page));
    for(const mr of items){
      if(mr?.state!=='merged')continue;
      if(!Number.isSafeInteger(mr.iid)||mr.iid<1||typeof mr.title!=='string'||mr.project_id!==project.projectId)throw safe('GitLab 返回的发布 MR 格式无效');
      if(!unknown&&![mr.merge_commit_sha,mr.squash_commit_sha,mr.sha].some(id=>ids.has(id)))continue;
      if(mrs.has(mr.iid))continue;
      const changes=await pages(page=>client.mergeRequestCommits(project.projectId,mr.iid,page));
      if(changes.some(c=>!sha(c?.id)||typeof c.title!=='string'||typeof c.author_name!=='string'))throw safe('GitLab 返回的 MR 提交格式无效');
      const complete=unknown||ids.has(mr.merge_commit_sha)||ids.has(mr.squash_commit_sha),included=changes.filter(c=>complete||ids.has(c.id));
      for(const id of [mr.merge_commit_sha,mr.squash_commit_sha,...included.map(c=>c.id)])covered.add(id);
      const url=base+'/-/merge_requests/'+mr.iid;
      let full=mr;if(mr.target_branch&&mr.source_branch&&!Number.isFinite(Date.parse(mr.merged_at))){full=await client.mergeRequest(project.projectId,mr.iid);if(full?.iid!==mr.iid||full.project_id!==project.projectId||full.state!=='merged')throw safe('GitLab 返回的发布 MR 合并信息不完整');}
      mrs.set(mr.iid,mrReference({...mr,...full,url}));
      lines.push(`MR !${mr.iid}：${mr.title}`,url,...included.map(c=>`  ${c.id.slice(0,8)} ${message(c).replace(/\r?\n/g,'\n    ')}（${c.author_name}）`));
    }
  }
  for(const commit of commits.filter(c=>!covered.has(c.id)))lines.push(`直接提交 ${commit.id.slice(0,8)}：${message(commit)}（${String(commit.author_name||'作者未知')}）`);
  if(!lines.length||unknown&&!mrs.size)lines.push('目标版本没有关联的已合并 MR，请通过业务提交链接核对：'+base+'/-/commit/'+to);
  const details=lines.join('\n');
  if(details.length>4000)throw safe('发布 MR 内容超过工作记录长度上限，未截断保存，请拆分核对');
  return {details,repositoryUrl:base,commitShas:[...ids],mergeRequests:[...mrs.values()],directCommitCount:commits.filter(c=>!covered.has(c.id)).length,commitCount:unknown?null:commits.length,direction:unknown?'unknown':direction,rangeVerified:!unknown};
}
module.exports={releaseChanges};
