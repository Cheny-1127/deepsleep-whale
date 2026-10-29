'use strict';
const {createGitlabClient,gitlabUrl}=require('./gitlab.cjs');
const {authorFilter,isMergeCommit}=require('./commit-authorship.cjs');
const {mrReference}=require('./work-lifecycle.cjs');
const safe=message=>Object.assign(Error(message),{reportSafe:true});
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40,64}$/.test(value);
const message=commit=>typeof commit.message==='string'&&commit.message.trim()?commit.message.trim():commit.title;
async function releaseChanges(project,{from,to,connection,fetchImpl,signal,authors,authorMode,authorNames,releasedAt}={}){
  if(!connection||gitlabUrl(connection.url)!==gitlabUrl(project.host))throw safe('请连接发布项目所属的 GitLab，以读取 MR 内容');
  const client=createGitlabClient({...connection,fetchImpl,signal}),base=gitlabUrl(project.host)+'/'+project.path.split('/').map(encodeURIComponent).join('/');
  if(!sha(to)||from&&!sha(from))throw safe('无法确认业务发布版本，未读取 MR');
  const filter=authorFilter({authors,authorMode,authorNames});
  if(from===to)return {details:'与前次成功发布版本相同，本次无新增提交。',mergeRequests:[],commitCount:0,ownCommitCount:0,direction:'same',rangeVerified:true};
  let commits=[],direction='forward';
  async function compare(left,right){const data=await client.compare(project.projectId,left,right);if(!data||!Array.isArray(data.commits)||data.commits.length>200||data.commits.some(c=>!sha(c?.id)||typeof c.title!=='string'||typeof c[filter.field]!=='string'))throw safe('发布版本比较不完整或超过 200 条提交，请缩小范围核对');return data.commits;}
  if(from){
    commits=await compare(from,to);
    const reverse=await compare(to,from);
    if(commits.length&&reverse.length)throw safe('生产版本发生分叉，无法自动确定完整 MR 范围，请核对版本切换');
    if(!commits.length){commits=reverse;direction='rollback';if(!commits.length)throw safe('发布版本关系无法确认，未猜测 MR 范围');}
  }
  const authored=commit=>filter.matches(commit)&&!isMergeCommit(commit);
  const ids=new Set(commits.map(c=>c.id)),own=new Map(commits.filter(authored).map(c=>[c.id,c])),mrs=new Map(),allMrs=new Map(),covered=new Set(),lines=[],unknown=!from;
  // 无前次版本时只核对目标提交或其关联 MR，不能当作完整发布范围。
  if(unknown)lines.push('⚠ 缺少前次成功发布版本；以下仅为目标提交或其关联 MR，不代表本次完整变更。');
  if(direction==='rollback')lines.push('版本回退：以下为此次回退移除的 MR / 提交。');
  let requests=0;
  async function pages(read){const result=[];for(let page=1;page<=3;page++){if(++requests>400)throw safe('发布 MR 查询超过上限，未保存不完整结果');const response=await read(page);result.push(...response.items);if(result.length>200)throw safe('发布关联 MR 或提交超过 200 条，未保存不完整结果');if(!response.hasMore)return result;}throw safe('发布 MR 分页不完整');}
  for(const commit of unknown?[{id:to}]:commits){
    const items=await pages(page=>client.commitMergeRequests(project.projectId,commit.id,page));
    for(const mr of items){
      if(mr?.state!=='merged')continue;
      if(!Number.isSafeInteger(mr.iid)||mr.iid<1||typeof mr.title!=='string'||mr.project_id!==project.projectId)throw safe('GitLab 返回的发布 MR 格式无效');
      if(!unknown&&![mr.merge_commit_sha,mr.squash_commit_sha,mr.sha].some(id=>ids.has(id)))continue;
      if(allMrs.has(mr.iid))continue;
      const url=base+'/-/merge_requests/'+mr.iid;
      let full=mr;if(mr.target_branch&&mr.source_branch&&!Number.isFinite(Date.parse(mr.merged_at))){full=await client.mergeRequest(project.projectId,mr.iid);if(full?.iid!==mr.iid||full.project_id!==project.projectId||full.state!=='merged')throw safe('GitLab 返回的发布 MR 合并信息不完整');}
      const reference=mrReference({...mr,...full,url});
      if(Number.isFinite(releasedAt)&&reference?.mergedAt>releasedAt)continue;
      const changes=await pages(page=>client.mergeRequestCommits(project.projectId,mr.iid,page));
      if(changes.some(c=>!sha(c?.id)||typeof c.title!=='string'||typeof c.author_name!=='string'||typeof c[filter.field]!=='string'))throw safe('GitLab 返回的 MR 提交格式无效');
      const complete=unknown||ids.has(mr.merge_commit_sha)||ids.has(mr.squash_commit_sha),included=changes.filter(c=>complete||ids.has(c.id));
      // 普通合并只认发布区间内本人的真实提交；squash 需回查被压缩的原提交确认贡献。
      const owned=included.filter(c=>authored(c)&&(unknown||ids.has(c.id)||ids.has(mr.squash_commit_sha)));
      for(const commit of owned)own.set(commit.id,commit);
      for(const id of [mr.merge_commit_sha,mr.squash_commit_sha,...included.map(c=>c.id)])covered.add(id);
      // 全部 MR 留作来源核对，业务事项只关联包含本人提交的 MR，避免把代发内容算成本人工作。
      allMrs.set(mr.iid,reference);if(owned.length)mrs.set(mr.iid,reference);
      lines.push(`MR !${mr.iid}：${mr.title}`,url,...included.map(c=>`  ${c.id.slice(0,8)} ${message(c).replace(/\r?\n/g,'\n    ')}（${c.author_name}）`));
    }
  }
  if(unknown&&!allMrs.size){
    const commit=await client.commit(project.projectId,to);
    if(commit?.id!==to||typeof commit.title!=='string'||typeof commit.author_name!=='string'||typeof commit[filter.field]!=='string')throw safe('GitLab 返回的目标提交作者信息不完整');
    commits.push(commit);ids.add(commit.id);if(authored(commit))own.set(commit.id,commit);
  }
  for(const commit of commits.filter(c=>!covered.has(c.id)))lines.push(`直接提交 ${commit.id.slice(0,8)}：${message(commit)}（${String(commit.author_name||'作者未知')}）`);
  if(!lines.length||unknown&&!allMrs.size)lines.push('目标版本没有关联的已合并 MR，请通过业务提交链接核对：'+base+'/-/commit/'+to);
  const details=lines.join('\n');
  if(own.size&&details.length>4000)throw safe('发布 MR 内容超过工作记录长度上限，未截断保存，请拆分核对');
  return {details,repositoryUrl:base,commitShas:[...ids],ownCommitShas:[...own.keys()],ownCommitTitles:[...own.values()].map(c=>c.title),mergeRequests:[...mrs.values()],allMergeRequests:[...allMrs.values()],directCommitCount:commits.filter(c=>!covered.has(c.id)).length,commitCount:unknown?null:commits.length,ownCommitCount:own.size,direction:unknown?'unknown':direction,rangeVerified:!unknown};
}
module.exports={releaseChanges};
