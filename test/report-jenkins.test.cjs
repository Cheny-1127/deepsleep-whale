'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collectJenkins}=require('../src/reports/jenkins.cjs');
const start=Date.parse('2026-10-26T10:00:00+08:00'),A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),D='d'.repeat(40);
const environment={jenkinsUrl:'https://jenkins.example.test/ci',jenkinsUser:'reader',jenkinsToken:'fixture-private-token'};
const source={job:'prod/pay',project:'ossv/pay',environment:'prod',target:'EKS',userIds:'cy',deploySuccess:false};
const project={projectId:7,host:'https://gitlab.example.test',project:'ossv/pay',path:'ossv/pay'},connection={url:project.host,token:'fixture-gitlab-secret'};
const commit=(id,title,author_name='其他作者')=>({id,title,message:title,author_name,committed_date:'2026-10-20T12:00:00+08:00'});
const mr={iid:11,project_id:7,state:'merged',title:'修复支付超时',merge_commit_sha:B,sha:C};
function build(number,overrides={}){return {number,building:false,result:'SUCCESS',timestamp:number===1?start-86400000:start,duration:600000,actions:[{causes:[{userId:number===1?'other':'cy'}]},{remoteUrls:['https://gitlab.example.test/devops/pipeline.git'],lastBuiltRevision:{SHA1:D}},{remoteUrls:['https://legacy.gitlab.test/ossv/pay.git'],lastBuiltRevision:{SHA1:number===1?A:B}}],...overrides};}
function fixture({builds=[build(2),build(1)],stages={},compare,mergeRequests=[mr],mrCommits=[commit(C,'修复超时重试','Alice'),commit(D,'补充支付回归','Bob')]}={}){
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
    if(url.pathname.endsWith('/merge_requests/11/commits'))return Response.json(mrCommits,{headers:{'x-next-page':''}});
    throw Error('unexpected fixture URL');
  };
  return {calls,options:{since:start-1000,until:start+600000,environment,connection,gitlabProjects:[project],fetchImpl,gitlabFetchImpl:fetchImpl}};
}
test('actual production deployment time, business SHA and previous deployment determine MR contents, including other authors',async()=>{
  const f=fixture(),items=await collectJenkins(source,f.options);assert.equal(items.length,1);const item=items[0];
  assert.match(item.title,/发布完成/);assert.equal(item.sourceMeta.release,true);assert.equal(item.sourceMeta.completedAt,start+180000);assert.equal(item.sourceMeta.previousSha,A);assert.equal(item.sourceMeta.sha,B);assert.equal(item.sourceMeta.previousBuild,1);assert.equal(item.sourceMeta.rangeVerified,true);
  assert.match(item.details,/MR !11/);assert.match(item.details,/Alice/);assert.match(item.details,/Bob/);assert.doesNotMatch(JSON.stringify(items),/fixture-private-token|fixture-gitlab-secret|pipeline\.git/);
  assert.equal(item.sourceMeta.mergeRequests.length,1);assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/merge_requests/11/commits')).length,1);
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
test('same-SHA deployments remain separate release facts without invented MR changes',async()=>{
  const previous=build(1);previous.actions.at(-1).lastBuiltRevision.SHA1=B;const f=fixture({builds:[build(2),previous]});
  const items=await collectJenkins(source,f.options);assert.equal(items.length,1);assert.equal(items[0].sourceMeta.direction,'same');assert.match(items[0].details,/无新增提交/);assert.ok(!f.calls.some(c=>c.url.hostname==='gitlab.example.test'));
});
test('rollback reports removed MR contents; direct commits are retained without forcing an MR',async()=>{
  const f=fixture({compare:url=>({commits:url.searchParams.get('from')===A?[]:[commit(B,'回退内容'),commit(C,'修复超时重试')]})});
  const items=await collectJenkins(source,f.options);assert.equal(items[0].sourceMeta.direction,'rollback');assert.match(items[0].details,/回退移除/);
  const direct=fixture({mergeRequests:[],compare:url=>({commits:url.searchParams.get('to')===B?[commit(B,'直接修复','Cheny')]:[]})});const result=await collectJenkins(source,direct.options);assert.match(result[0].details,/直接提交.*直接修复.*Cheny/);
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
  const f=fixture({mrCommits:[{...commit(C,'提交标题','Alice'),message:'提交标题\n\n修复重试链路并补齐回归测试'}]});assert.match((await collectJenkins(source,f.options))[0].details,/修复重试链路并补齐回归测试/);
  const divergent=fixture({compare:()=>({commits:[commit(C,'分支变化')]})});await assert.rejects(collectJenkins(source,divergent.options),/分叉/);
});
test('server baselines cannot cross actual deployment targets',async()=>{
  const current=build(3,{timestamp:start+100000}),otherTarget=build(2),previous=build(1);
  for(const [b,target] of [[current,'server-a'],[otherTarget,'server-b'],[previous,'server-a']])b.actions[0].parameters=[{name:'ACTION',value:'build_deploy'},{name:'RELEASE_SERVERS',value:target}];
  otherTarget.actions.at(-1).lastBuiltRevision.SHA1=C;
  const stages=Object.fromEntries([current,otherTarget,previous].map(b=>[b.number,[{name:'发布/回滚/启动/停止',status:'SUCCESS',startTimeMillis:b.timestamp+120000,durationMillis:60000}]]));
  const items=await collectJenkins(source,fixture({builds:[current,otherTarget,previous],stages}).options);assert.equal(items[0].sourceMeta.previousBuild,1);assert.equal(items[0].sourceMeta.targetScope,'["server-a"]');
});
