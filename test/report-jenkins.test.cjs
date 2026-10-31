'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collectJenkins}=require('../src/reports/jenkins.cjs');
const start=Date.parse('2026-10-26T10:00:00+08:00'),A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),D='d'.repeat(40);
const environment={jenkinsUrl:'https://jenkins.example.test/ci',jenkinsUser:'reader',jenkinsToken:'fixture-private-token'};
const source={job:'prod/pay',project:'ossv/pay',environment:'prod',target:'EKS',userIds:'cy',deploySuccess:false};
const project={projectId:7,host:'https://gitlab.example.test',project:'ossv/pay',path:'ossv/pay'},connection={url:project.host,token:'fixture-gitlab-secret'};
const commit=(id,title,author_name='其他作者',author_email='other@example.test')=>({id,title,message:title,author_name,author_email,committed_date:'2026-10-20T12:00:00+08:00'});
const mr={iid:11,project_id:7,state:'merged',title:'修复支付超时',merge_commit_sha:B,sha:C,source_branch:'feat-cy-pay',target_branch:'main',merged_at:'2026-10-26T09:00:00+08:00'};
function build(number,overrides={}){return {number,building:false,result:'SUCCESS',timestamp:number===1?start-86400000:start,duration:600000,actions:[{causes:[{userId:number===1?'other':'cy'}]},{remoteUrls:['https://gitlab.example.test/devops/pipeline.git'],lastBuiltRevision:{SHA1:D}},{remoteUrls:['https://legacy.gitlab.test/ossv/pay.git'],lastBuiltRevision:{SHA1:number===1?A:B}}],...overrides};}
function fixture({builds=[build(2),build(1)],stages={},compare,mergeRequests=[mr],mrCommits=[commit(C,'修复超时重试','Alice','cy@example.test'),commit(D,'补充支付回归','Bob')],mrCommitsByIid={},targetCommit=commit(B,'直接变更')}={}){
  const calls=[];
  const fetchImpl=async(raw,request)=>{
    const url=new URL(raw);calls.push({url,request});assert.equal(request.method,'GET');assert.equal(request.redirect,'error');
    if(url.hostname==='jenkins.example.test'){
      assert.ok(request.headers.Authorization);assert.equal(request.headers['PRIVATE-TOKEN'],undefined);
      if(url.pathname.endsWith('/pay/api/json'))return Response.json({allBuilds:builds});
      const number=Number(url.pathname.match(/\/pay\/(\d+)\//)?.[1]),b=builds.find(b=>b.number===number);assert.ok(b);
      return Response.json({stages:stages[number]||[{name:'Deploy to EKS',status:'SUCCESS',startTimeMillis:b.timestamp+120000,durationMillis:60000}]});
    }
    assert.equal(url.hostname,'gitlab.example.test');assert.equal(request.headers['PRIVATE-TOKEN'],'fixture-gitlab-secret');assert.equal(request.headers.Authorization,undefined);
    assert.ok(!url.searchParams.has('private_token'));
    if(url.pathname.endsWith('/repository/compare')){assert.equal(url.searchParams.get('straight'),'true');return Response.json(compare?compare(url):{commits:url.searchParams.get('to')===B?[commit(B,'Merge release'),commit(C,'修复超时重试')]:[],compare_timeout:false});}
    if(url.pathname.endsWith('/merge_requests'))return Response.json(mergeRequests,{headers:{'x-next-page':''}});
    const iid=Number(url.pathname.match(/\/merge_requests\/(\d+)\/commits$/)?.[1]);if(iid)return Response.json(mrCommitsByIid[iid]||mrCommits,{headers:{'x-next-page':''}});
    if(url.pathname.endsWith('/repository/commits/'+B))return Response.json(targetCommit);
    throw Error('unexpected fixture URL');
  };
  return {calls,options:{since:start-1000,until:start+600000,environment,connection,authors:'cy@example.test',gitlabProjects:[project],fetchImpl,gitlabFetchImpl:fetchImpl}};
}
test('actual production deployment time, business SHA and previous deployment determine MR contents, including other authors',async()=>{
  const f=fixture(),items=await collectJenkins(source,f.options);assert.equal(items.length,1);const item=items[0];
  assert.match(item.title,/发布完成/);assert.equal(item.sourceMeta.release,true);assert.equal(item.sourceMeta.completedAt,start+180000);assert.equal(item.sourceMeta.previousSha,A);assert.equal(item.sourceMeta.sha,B);assert.equal(item.sourceMeta.previousBuild,1);assert.equal(item.sourceMeta.rangeVerified,true);
  assert.match(item.details,/MR !11/);assert.match(item.details,/Alice/);assert.match(item.details,/Bob/);assert.doesNotMatch(JSON.stringify(items),/fixture-private-token|fixture-gitlab-secret|pipeline\.git/);
  assert.equal(item.sourceMeta.mergeRequests.length,1);assert.equal(item.sourceMeta.mergeRequests[0].targetBranch,'main');assert.equal(item.sourceMeta.mergeRequests[0].mergedAt,Date.parse(mr.merged_at));assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/merge_requests/11/commits')).length,1);
  assert.deepEqual(item.sourceMeta.commitShas,[B,C]);assert.equal(item.sourceMeta.repositoryUrl,'https://gitlab.example.test/ossv/pay');
  assert.equal(item.sourceMeta.ownCommitCount,1);
});
test('build-only, skipped deployment, failures, non-production and other publishers are not releases',async()=>{
  const onlyBuild=build(3,{actions:[{causes:[{userId:'cy'}],parameters:[{name:'ACTION',value:'build'}]}]});
  const f=fixture({builds:[onlyBuild,build(4),build(5,{result:'FAILURE'}),build(6,{building:true,result:null}),build(7,{actions:[{causes:[{userId:'other'}]},{remoteUrls:['https://gitlab.example.test/ossv/pay.git'],lastBuiltRevision:{SHA1:B}}]}),build(1)],stages:{4:[{name:'Deploy to EKS',status:'NOT_EXECUTED',startTimeMillis:start,durationMillis:1}]}});
  assert.deepEqual(await collectJenkins(source,f.options),[]);assert.deepEqual(await collectJenkins({...source,environment:'uat'},f.options),[]);assert.ok(!f.calls.some(c=>c.url.hostname==='gitlab.example.test'));
});
test('Shanghai deployment completion date differs from build start and MR commit dates; window uses deployment time',async()=>{
  const midnight=Date.parse('2026-10-27T00:00:00+08:00'),f=fixture({builds:[build(2,{timestamp:midnight-120000}),build(1)],stages:{2:[{name:'Deploy to EKS',status:'SUCCESS',startTimeMillis:midnight-1000,durationMillis:2000}]}});
  const items=await collectJenkins(source,{...f.options,since:midnight,until:midnight+86400000-1});assert.equal(items.length,1);assert.equal(items[0].date,'2026-10-27');assert.equal(items[0].sourceMeta.releasedAt,midnight+1000);
  assert.deepEqual(await collectJenkins(source,{...f.options,since:midnight-86400000,until:midnight-1}),[]);
});
test('same-SHA deployments have no new own commits and are excluded',async()=>{
  const previous=build(1);previous.actions.at(-1).lastBuiltRevision.SHA1=B;const f=fixture({builds:[build(2),previous]});
  assert.deepEqual(await collectJenkins(source,f.options),[]);assert.ok(!f.calls.some(c=>c.url.hostname==='gitlab.example.test'));
});
test('rollback reports removed MR contents; direct commits are retained without forcing an MR',async()=>{
  const f=fixture({compare:url=>({commits:url.searchParams.get('from')===A?[]:[commit(B,'回退内容'),commit(C,'修复超时重试')]})});
  const items=await collectJenkins(source,f.options);assert.equal(items[0].sourceMeta.direction,'rollback');assert.match(items[0].details,/回退移除/);
  const direct=fixture({mergeRequests:[],compare:url=>({commits:url.searchParams.get('to')===B?[commit(B,'直接修复','Cheny','cy@example.test')]:[]})});const result=await collectJenkins(source,direct.options);assert.match(result[0].details,/直接提交.*直接修复.*Cheny/);
});
test('missing baseline is explicitly unverified and lists only target-associated MR',async()=>{
  const f=fixture({builds:[build(2)]}),items=await collectJenkins(source,f.options);assert.equal(items[0].sourceMeta.rangeVerified,false);assert.equal(items[0].sourceMeta.previousSha,'');assert.match(items[0].details,/不代表本次完整变更/);assert.match(items[0].details,/MR !11/);assert.ok(!f.calls.some(c=>c.url.pathname.endsWith('/repository/compare')));
});
test('server deployment requires release ACTION and cannot infer existing artifact SHA from checkout',async()=>{
  const stages={2:[{name:'发布/回滚/启动/停止',status:'SUCCESS',startTimeMillis:start+120000,durationMillis:60000}]};const current=build(2);current.actions[0].parameters=[{name:'ACTION',value:'build_deploy'},{name:'IMAGE_TAG',value:'无需选择'}];
  const f=fixture({builds:[current,build(1)],stages});assert.equal((await collectJenkins(source,f.options)).length,1);
  current.actions[0].parameters[1].value='old-artifact';await assert.rejects(collectJenkins(source,fixture({builds:[current,build(1)],stages}).options),/制品/);
  delete current.actions[0].parameters;await assert.rejects(collectJenkins(source,fixture({builds:[current,build(1)],stages}).options),/ACTION/);
});
test('previous release is ordered by deployment completion and target, including other publishers',async()=>{
  const old=build(1),late=build(3,{timestamp:start-600000,duration:900000}),current=build(2,{timestamp:start+100000,duration:600000});late.actions.at(-1).lastBuiltRevision.SHA1=C;late.actions[0].causes=[{userId:'other'}];
  const f=fixture({builds:[current,late,old],stages:{3:[{name:'Deploy to EKS',status:'SUCCESS',startTimeMillis:start+100000,durationMillis:60000}],2:[{name:'Deploy to EKS',status:'SUCCESS',startTimeMillis:start+200000,durationMillis:60000}]}});
  const result=await collectJenkins(source,f.options);assert.equal(result[0].sourceMeta.previousBuild,3);assert.equal(result[0].sourceMeta.previousSha,C);
});
test('missing business SHA, invalid stages, auth and GitLab failure reject safely without partial results or secrets',async()=>{
  await assert.rejects(collectJenkins(source,{...fixture().options,environment:{}}),/配置 Jenkins/);
  await assert.rejects(collectJenkins(source,{...fixture().options,gitlabProjects:[]}),/业务仓库/);
  await assert.rejects(collectJenkins(source,{...fixture().options,fetchImpl:async()=>new Response('',{status:403})}),/权限/);
  const invalid=build(2);invalid.actions=invalid.actions.slice(0,2);await assert.rejects(collectJenkins(source,fixture({builds:[invalid,build(1)]}).options),/业务仓库发布 SHA/);
  await assert.rejects(collectJenkins(source,fixture({stages:{2:[{name:'Build Image',status:'SUCCESS'}]}}).options),/部署阶段/);
  await assert.rejects(collectJenkins(source,{...fixture().options,gitlabFetchImpl:async()=>{throw Error('fixture-gitlab-secret');}}),error=>error.reportSafe&&!error.message.includes('fixture-gitlab-secret'));
});

test('MR lookup paginates and deduplicates without dropping later pages, bounds compare size',async()=>{
  const f=fixture(),seen=[];
  const gitlabFetchImpl=async(raw,request)=>{const url=new URL(raw);if(url.pathname.endsWith('/repository/commits/'+B+'/merge_requests')||url.pathname.endsWith('/repository/commits/'+C+'/merge_requests')){const page=Number(url.searchParams.get('page'));seen.push(page);return Response.json(page===1?Array.from({length:100},()=>mr):[mr],{headers:{'x-next-page':page===1?'2':''}});}return f.options.gitlabFetchImpl(raw,request);};
  const result=await collectJenkins(source,{...f.options,gitlabFetchImpl});assert.equal(result[0].sourceMeta.mergeRequests.length,1);assert.ok(seen.includes(2));
  const huge=fixture({compare:()=>({commits:Array.from({length:201},(_,i)=>commit(i.toString(16).padStart(40,'0'),'too many'))})});await assert.rejects(collectJenkins(source,huge.options),/200 条/);
});
test('metadata truncation is reported rather than silently returning an incomplete release window',async()=>{
  const builds=Array.from({length:201},(_,i)=>build(202-i));await assert.rejects(collectJenkins(source,fixture({builds}).options),/200 次/);
});

test('MR commit bodies are shown and divergent production histories are not mislabeled as forward releases',async()=>{
  const f=fixture({mrCommits:[{...commit(C,'提交标题','Alice','cy@example.test'),message:'提交标题\n\n修复重试链路并补齐回归测试'}]});assert.match((await collectJenkins(source,f.options))[0].details,/修复重试链路并补齐回归测试/);
  const divergent=fixture({compare:()=>({commits:[commit(C,'分支变化')]})});await assert.rejects(collectJenkins(source,divergent.options),/分叉/);
});
test('server baselines cannot cross actual deployment targets',async()=>{
  const current=build(3,{timestamp:start+100000}),otherTarget=build(2),previous=build(1);
  for(const [b,target] of [[current,'server-a'],[otherTarget,'server-b'],[previous,'server-a']])b.actions[0].parameters=[{name:'ACTION',value:'build_deploy'},{name:'RELEASE_SERVERS',value:target}];
  otherTarget.actions.at(-1).lastBuiltRevision.SHA1=C;
  const stages=Object.fromEntries([current,otherTarget,previous].map(b=>[b.number,[{name:'发布/回滚/启动/停止',status:'SUCCESS',startTimeMillis:b.timestamp+120000,durationMillis:60000}]]));
  const items=await collectJenkins(source,fixture({builds:[current,otherTarget,previous],stages}).options);assert.equal(items[0].sourceMeta.previousBuild,1);assert.equal(items[0].sourceMeta.targetScope,'["server-a"]');
});

test('publishing for others is excluded by commit author, not by the Jenkins publisher',async()=>{
  const f=fixture({mrCommits:[commit(C,'同事的变更','Someone','someone@example.test')]});
  assert.deepEqual(await collectJenkins(source,f.options),[]);
  const direct=fixture({mergeRequests:[]});assert.deepEqual(await collectJenkins(source,direct.options),[]);
  const unknown=fixture({builds:[build(2)],mrCommits:[commit(C,'同事的变更')]});assert.deepEqual(await collectJenkins(source,unknown.options),[]);
});

test('release ownership uses the active exact author filter with aliases, whitespace and case',async()=>{
  const f=fixture();
  const email=await collectJenkins(source,{...f.options,authors:'wrong@example.test, CY@EXAMPLE.TEST '});assert.equal(email.length,1);
  const name=await collectJenkins(source,{...f.options,authors:'wrong@example.test',authorMode:'name',authorNames:'  ALICE, 余朝元 '});assert.equal(name.length,1);
  assert.deepEqual(await collectJenkins(source,{...f.options,authorMode:'name',authorNames:'Alice-other'}),[]);
  await assert.rejects(collectJenkins(source,{...f.options,authors:''}),/作者邮箱/);
  await assert.rejects(collectJenkins(source,{...f.options,authorMode:'name',authorNames:''}),/作者名/);
});

test('own commits outside a partial MR release range do not turn a colleague release into personal work',async()=>{
  const f=fixture({compare:url=>({commits:url.searchParams.get('to')===B?[commit(C,'仅发布同事的新提交')]:[]}),mergeRequests:[{...mr,merge_commit_sha:D}],mrCommits:[commit(C,'本次变更'),commit(D,'以前的个人提交','Alice','cy@example.test')]});
  assert.deepEqual(await collectJenkins(source,f.options),[]);
});

test('a squash release can prove ownership from the included MR commits',async()=>{
  const f=fixture({compare:url=>({commits:url.searchParams.get('to')===B?[commit(B,'压缩合并','Someone')]:[]}),mergeRequests:[{...mr,merge_commit_sha:null,squash_commit_sha:B}]});
  const result=await collectJenkins(source,f.options);assert.equal(result.length,1);assert.equal(result[0].sourceMeta.ownCommitCount,1);assert.match(result[0].details,/Bob/);
});

test('incomplete author evidence fails without retiring existing release records',async()=>{
  const own=commit(C,'缺失邮箱','Alice');delete own.author_email;
  await assert.rejects(collectJenkins(source,fixture({mrCommits:[own]}).options),/提交格式无效/);
});

test('an initial direct release verifies the target commit author without inventing a baseline',async()=>{
  const f=fixture({builds:[build(2)],mergeRequests:[],targetCommit:commit(B,'直接修复','CY','cy@example.test')}),items=await collectJenkins(source,f.options);
  assert.equal(items.length,1);assert.equal(items[0].sourceMeta.rangeVerified,false);assert.equal(items[0].sourceMeta.ownCommitCount,1);assert.match(items[0].details,/直接提交.*直接修复/);
  const other=fixture({builds:[build(2)],mergeRequests:[]});assert.deepEqual(await collectJenkins(source,other.options),[]);
});

test('long colleague-only release descriptions are excluded before report length validation',async()=>{
  const f=fixture({mrCommits:[commit(C,'同事说明'.repeat(1200))]});assert.deepEqual(await collectJenkins(source,f.options),[]);
});

test('a personal merge commit cannot prove ownership of a colleague production release',async()=>{
  const merged={...commit(B,"Merge branch 'feat/colleague-pay' into 'main'",'CY','cy@example.test'),parent_ids:[A,C]};
  const f=fixture({compare:url=>({commits:url.searchParams.get('to')===B?[merged,commit(C,'同事的支付功能')]:[]}),mrCommits:[commit(C,'同事的支付功能')]});
  assert.deepEqual(await collectJenkins(source,f.options),[]);
  const initial=fixture({builds:[build(2)],mergeRequests:[],targetCommit:merged});assert.deepEqual(await collectJenkins(source,initial.options),[]);
});

test('mixed releases keep colleague evidence but expose only personally authored MR work',async()=>{
  const second={...mr,iid:12,title:'同事的支付功能',merge_commit_sha:D,sha:D,source_branch:'feat/colleague-pay'};
  const f=fixture({compare:url=>({commits:url.searchParams.get('to')===B?[commit(B,'Merge release'),commit(C,'本人修复','Alice','cy@example.test'),commit(D,'同事的支付功能')]:[]}),mergeRequests:[mr,second],mrCommitsByIid:{11:[commit(C,'本人修复','Alice','cy@example.test')],12:[commit(D,'同事的支付功能')]}});
  const items=await collectJenkins(source,f.options);assert.equal(items.length,1);assert.deepEqual(items[0].sourceMeta.mergeRequests.map(m=>m.iid),[11]);assert.deepEqual(items[0].sourceMeta.ownCommitShas,[C]);assert.match(items[0].details,/MR !12：同事的支付功能/);
  const {workSummary}=require('../src/reports/work-summary.cjs');assert.deepEqual(workSummary(items.map((item,i)=>({...item,id:'r'+i}))).items.map(item=>item.mr?.iid),[11]);
});

test('later backflow MRs and baseline-only personal commits cannot become release work',async()=>{
  const future={...mr,iid:393,title:'Main',source_branch:'main',target_branch:'feat/colleague-pay',merged_at:'2026-10-27T12:00:00+08:00'};
  const f=fixture({mergeRequests:[mr,future]});const items=await collectJenkins(source,f.options);assert.deepEqual(items[0].sourceMeta.mergeRequests.map(m=>m.iid),[11]);assert.doesNotMatch(items[0].details,/MR !393/);
  const past=fixture({compare:url=>({commits:url.searchParams.get('to')===B?[commit(B,'同事的新合并')]:[]}),mrCommits:[commit(C,'基线里已有的本人提交','Alice','cy@example.test')]});assert.deepEqual(await collectJenkins(source,past.options),[]);
});

test('personal direct commits do not inherit titles from colleague MRs in a mixed release',async()=>{
  const f=fixture({compare:url=>({commits:url.searchParams.get('to')===B?[commit(B,'本人直接修复','CY','cy@example.test'),commit(C,'同事功能')]:[]}),mergeRequests:[{...mr,merge_commit_sha:D}],mrCommits:[commit(C,'同事功能')]});
  const items=await collectJenkins(source,f.options),{workSummary}=require('../src/reports/work-summary.cjs');assert.equal(items.length,1);assert.deepEqual(items[0].sourceMeta.mergeRequests,[]);assert.equal(workSummary(items.map(item=>({...item,id:'release'}))).items[0].title,'本人直接修复');
});

test('explicit repository aliases resolve renamed business SCM paths without accepting unrelated revisions',async()=>{
  const renamed={...project,project:'ossv/pay-renamed',path:'ossv/pay-renamed'};
  const scoped={...source,project:renamed.project,repositoryAliases:'ossv/pay'};
  const f=fixture(),options={...f.options,gitlabProjects:[renamed]};
  await assert.rejects(collectJenkins({...scoped,repositoryAliases:''},options),/业务仓库发布 SHA/);
  const items=await collectJenkins(scoped,options);
  assert.equal(items.length,1);assert.equal(items[0].sourceMeta.sha,B);assert.equal(items[0].sourceMeta.previousSha,A);
  assert.equal(items[0].sourceMeta.repositoryUrl,'https://gitlab.example.test/ossv/pay-renamed');
  const unrelated=fixture({builds:[build(2),build(1)]});
  await assert.rejects(collectJenkins({...scoped,repositoryAliases:'ossv/another'}, {...unrelated.options,gitlabProjects:[renamed]}),/业务仓库发布 SHA/);
  const ambiguous=build(2);ambiguous.actions.push({remoteUrls:['https://legacy.gitlab.test/ossv/pay-renamed.git'],lastBuiltRevision:{SHA1:D}});
  await assert.rejects(collectJenkins(scoped,{...fixture({builds:[ambiguous,build(1)]}).options,gitlabProjects:[renamed]}),/业务仓库发布 SHA/);
});
