'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkReports}=require('../src/app/work-reports.cjs');
const NOW=Date.parse('2026-10-26T18:00:00+08:00'),host='https://gitlab.example.test/gitlab',token='fixture-private-token';
const user={id:1,username:'cy',email:'cy@example.test'},group={id:10,name:'业务',full_path:'business'},project={id:21,name:'订单',path_with_namespace:'business/orders'};
const commit=(sha,email='cy@example.test')=>({id:sha.repeat(40),title:'修复订单超时',message:'修复订单超时\n\n补齐重试',author_name:'CY',author_email:email,committed_date:'2026-10-26T10:00:00+08:00'});
function reply(value,headers={}){return new Response(JSON.stringify(value),{headers});}
function fixture(t,fetchImpl,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-report-gitlab-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let credentials=null;
  const credentialStore={load:()=>credentials,save:value=>{credentials=structuredClone(value);}};
  const create=()=>createWorkReports({dataDir:dir,now:()=>NOW,readEnvironment:()=>({}),fetchImpl,gitlabStore:credentialStore,...options});
  const reports=create();t.after(()=>reports.close());return {dir,reports,create,credentialStore};}

test('GitLab connection, cross-group selection and remote commits survive restart without exposing the token',async t=>{
  const requests=[],f=fixture(t,async(raw,options)=>{const url=new URL(raw);requests.push({url,options});assert.equal(options.headers['PRIVATE-TOKEN'],token);
    if(url.pathname.endsWith('/user'))return reply(user);
    if(url.pathname.endsWith('/groups'))return reply([group]);
    if(url.pathname.endsWith('/groups/10/projects'))return reply([project]);
    if(url.pathname.endsWith('/repository/commits'))return reply([commit('a'),commit('b','colleague@example.test')]);
    if(url.pathname.endsWith('/merge_requests'))return reply([]);
    if(url.pathname.endsWith('/refs'))return reply([]);
    throw Error('unexpected request');});
  const connected=await f.reports.action('gitlab-connect',{url:host,token});assert.equal(connected.username,'cy');assert.equal(connected.authors,'cy@example.test');
  assert.equal((await f.reports.action('gitlab-groups')).items[0].fullPath,'business');
  const projects=await f.reports.action('gitlab-projects',{groupId:10});assert.equal(projects.items[0].project,'business/orders');
  await f.reports.action('settings',{gitlabProjects:projects.items,gitlabAuthors:'CY@example.test'});
  await f.reports.action('collect');await f.reports.action('collect');
  const snapshot=f.reports.snapshot({date:'2026-10-26'});assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].source,'gitlab');assert.equal(snapshot.entries[0].project,'business/orders');
  assert.match((await f.reports.action('preview-day',{date:'2026-10-26'})).content,/修复订单超时/);
  assert.doesNotMatch(JSON.stringify([connected,snapshot]),/fixture-private-token/);assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),/fixture-private-token/);
  const restarted=f.create();t.after(()=>restarted.close());assert.equal(restarted.snapshot().settings.gitlabProjects.length,1);assert.equal(restarted.snapshot().gitlab.username,'cy');
  const before=requests.length;await restarted.action('collect');assert.equal(restarted.snapshot({date:'2026-10-26'}).entries.length,1);
  assert.ok(requests.length>before);assert.ok(requests.every(r=>r.options.method==='GET'&&r.options.redirect==='error'&&!r.url.searchParams.has('private_token')));
  const query=requests.find(r=>r.url.pathname.endsWith('/repository/commits')).url.searchParams;assert.equal(query.get('all'),'true');assert.ok(query.has('since')&&query.has('until'));
  await restarted.action('save-entry',{...snapshot.entries[0],included:false});await restarted.action('collect');
  assert.doesNotMatch((await restarted.action('preview-day',{date:'2026-10-26'})).content,/修复订单超时/);
});

test('GitLab pagination supports missing headers, validates IDs, and bounds commit history without partial results',async()=>{
  const {createGitlabClient,collectGitlab}=require('../src/reports/gitlab.cjs');const pages=[];
  const client=createGitlabClient({url:host,token,fetchImpl:async(raw)=>{const url=new URL(raw),page=Number(url.searchParams.get('page'));pages.push(page);return reply(page===1?Array.from({length:50},(_,i)=>({...group,id:i+1})):[]);}});
  const first=await client.groups({page:1,search:'业务'});assert.equal(first.items.length,50);assert.equal(first.hasMore,true);
  assert.equal((await client.groups({page:2})).hasMore,false);assert.deepEqual(pages,[1,2]);
  await assert.rejects(client.projects({groupId:'10/../../user'}),/分组/);
  let count=0;const source={host,projectId:21,project:'business/orders'};
  await assert.rejects(collectGitlab(source,{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:'cy@example.test',fetchImpl:async()=>{count++;return reply(Array.from({length:100},()=>commit('a')));}}),/2000/);
  assert.equal(count,21);
  const result=await collectGitlab(source,{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:'cy@example.test',fetchImpl:async raw=>reply(new URL(raw).pathname.endsWith('/repository/commits')?[commit('a'),commit('a'),commit('b','other@example.test')]:[])});assert.equal(result.length,1);
});

test('GitLab authentication and response failures are safe and never replace a working connection',async t=>{
  let fail=false;const f=fixture(t,async raw=>{if(fail)return new Response(token,{status:401});return reply(raw.endsWith('/user')?user:[group]);});
  await f.reports.action('gitlab-connect',{url:host,token});fail=true;
  await assert.rejects(f.reports.action('gitlab-connect',{url:host,token:'replacement-token'}),/认证|权限/);assert.equal(f.credentialStore.load().token,token);
  const {createGitlabClient}=require('../src/reports/gitlab.cjs');
  for(const url of ['http://gitlab.example.test','https://user:password@gitlab.example.test','https://gitlab.example.test/?token=secret'])assert.throws(()=>createGitlabClient({url,token}),/HTTPS|地址/);
  for(const response of [reply({bad:'shape'}),new Response('not json'),new Response('[]',{headers:{'content-length':String(3*1024*1024)}})]){
    await assert.rejects(createGitlabClient({url:host,token,fetchImpl:async()=>response}).groups(),error=>error.reportSafe&&!error.message.includes(token));
  }
  await assert.rejects(createGitlabClient({url:host,token,fetchImpl:async()=>{throw Error(token);}}).groups(),error=>error.reportSafe&&!error.message.includes(token));
});

test('GitLab sources stay bound to their server and late results cannot write after module disable',async t=>{
  let finish;const f=fixture(t,async(raw)=>{if(raw.endsWith('/user'))return reply(user);if(new URL(raw).pathname.endsWith('/groups'))return reply([group]);return new Promise(resolve=>{finish=()=>resolve(reply([commit('a')]));});});
  await f.reports.action('gitlab-connect',{url:host,token});const selected={host,projectId:21,project:'business/orders'};
  await f.reports.action('settings',{gitlabProjects:[selected],gitlabAuthors:user.email});
  const pending=f.reports.action('collect');await new Promise(setImmediate);assert.ok(finish);f.reports.setModuleEnabled(false);f.reports.setModuleEnabled(true);finish();await pending;
  assert.equal(f.reports.snapshot().total,0);
  await f.reports.action('gitlab-connect',{url:'https://other.example.test',token});
  const collected=await f.reports.action('collect');assert.equal(collected.total,0);assert.match(collected.sources[0].error,/实例|地址/);
  await assert.rejects(f.reports.action('settings',{gitlabProjects:Array.from({length:201},(_,i)=>({...selected,projectId:i+1}))}),/200/);
});

test('a token with user access but no group access never replaces the previous connection',async t=>{
  let denyGroups=false;const f=fixture(t,async raw=>raw.endsWith('/user')?reply(user):denyGroups?new Response('insufficient scope',{status:403}):reply([group]));
  await f.reports.action('gitlab-connect',{url:host,token});denyGroups=true;
  await assert.rejects(f.reports.action('gitlab-connect',{url:host,token:'insufficient-scope-token'}),/认证|权限/);
  assert.equal(f.credentialStore.load().token,token);
});

test('malformed GitLab user, group, project and commit items return safe errors',async()=>{
  const {createGitlabClient,collectGitlab}=require('../src/reports/gitlab.cjs');
  for(const [method,args] of [['currentUser',undefined],['groups',undefined],['projects',{groupId:10}]]){
    const client=createGitlabClient({url:host,token,fetchImpl:async()=>reply(method==='currentUser'?null:[null])});
    await assert.rejects(client[method](args),error=>error.reportSafe&&/格式/.test(error.message));
  }
  await assert.rejects(collectGitlab({host,projectId:21,project:'business/orders'},{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,fetchImpl:async()=>reply([null])}),error=>error.reportSafe&&/格式/.test(error.message));
});

test('GitLab connection and collection use their own transport when the Electron transport fails',async t=>{
  let generalCalls=0,gitlabCalls=0;
  const f=fixture(t,async()=>{generalCalls++;return new Response('server error',{status:500});},{gitlabFetchImpl:async raw=>{gitlabCalls++;const p=new URL(raw).pathname;return reply(p.endsWith('/user')?user:p.endsWith('/groups')?[group]:p.endsWith('/repository/commits')?[commit('a')]:[]);}});
  await f.reports.action('gitlab-connect',{url:host,token});await f.reports.action('gitlab-groups');
  await f.reports.action('settings',{gitlabProjects:[{host,projectId:21,project:'business/orders'}],gitlabAuthors:user.email});
  await f.reports.action('collect');assert.equal(f.reports.snapshot({date:'2026-10-26'}).entries.length,1);
  assert.equal(generalCalls,0);assert.ok(gitlabCalls>=4);
});

test('GitLab reconnect reuses its saved token for blank input without returning it',async t=>{
  let requests=0;const f=fixture(t,async(raw,options)=>{requests++;assert.equal(options.headers['PRIVATE-TOKEN'],token);return reply(new URL(raw).pathname.endsWith('/user')?user:[group]);});
  await f.reports.action('gitlab-connect',{url:host,token});
  const restarted=f.create();t.after(()=>restarted.close());
  for(const empty of ['',undefined,'  ']){
    const connected=await restarted.action('gitlab-connect',{url:host+'/',token:empty});
    assert.equal(connected.connected,true);assert.equal(connected.url,host);assert.doesNotMatch(JSON.stringify(connected),/fixture-private-token/);
  }
  assert.equal(requests,8);assert.equal(f.credentialStore.load().token,token);
});

test('blank GitLab input cannot reuse a token for another server or deployment path',async t=>{
  let requests=0;const f=fixture(t,async raw=>{requests++;return reply(new URL(raw).pathname.endsWith('/user')?user:[group]);});
  await assert.rejects(f.reports.action('gitlab-connect',{url:host,token:''}),/Token/);assert.equal(requests,0);
  await f.reports.action('gitlab-connect',{url:host,token});const before=requests;
  for(const url of ['https://other.example.test/gitlab','https://gitlab.example.test/other'])await assert.rejects(f.reports.action('gitlab-connect',{url,token:''}),/地址|实例/);
  assert.equal(requests,before);assert.equal(f.credentialStore.load().url,host);assert.equal(f.credentialStore.load().token,token);
});

test('GitLab author-name selection includes email mistakes, excludes other authors and survives restart',async t=>{
  const items=[
    {...commit('a','old-invalid-email'),author_name:'yuchaoyuan'},
    {...commit('b','old@example.test'),author_name:'余朝元'},
    {...commit('c',user.email),author_name:'another-author'},
    {...commit('d','old@example.test'),author_name:'yuchaoyuan-other'},
    {...commit('e','old@example.test'),author_name:'YUCHAoyuan'},
    {...commit('a','old-invalid-email'),author_name:'yuchaoyuan'}
  ];
  const f=fixture(t,async raw=>reply(new URL(raw).pathname.endsWith('/user')?user:new URL(raw).pathname.endsWith('/groups')?[group]:new URL(raw).pathname.endsWith('/repository/commits')?items:[]));
  await f.reports.action('gitlab-connect',{url:host,token});
  await f.reports.action('settings',{gitlabProjects:[{host,projectId:21,project:'business/orders'}],gitlabAuthorMode:'name',gitlabAuthorNames:' yuchaoyuan，余朝元\nYUCHAoyuan ',gitlabAuthors:user.email});
  await f.reports.action('collect');await f.reports.action('collect');
  const snapshot=f.reports.snapshot({date:'2026-10-26'});assert.equal(snapshot.entries.length,3);assert.equal(snapshot.settings.gitlabAuthorMode,'name');assert.equal(snapshot.settings.gitlabAuthorNames,'yuchaoyuan,余朝元');
  assert.deepEqual(snapshot.entries.map(e=>e.sourceMeta.sha).sort(),['a','b','e'].map(v=>v.repeat(40)));
  const restarted=f.create();t.after(()=>restarted.close());assert.equal(restarted.snapshot().settings.gitlabAuthorMode,'name');await restarted.action('collect');assert.equal(restarted.snapshot({date:'2026-10-26'}).entries.length,3);
  await restarted.action('settings',{gitlabAuthorMode:'email'});await restarted.action('collect');
  assert.equal(restarted.snapshot({date:'2026-10-26'}).entries.length,4);assert.equal(restarted.snapshot().sources[0].count,1);
});

test('GitLab validates only the active author filter and migrates existing email settings',async t=>{
  const f=fixture(t,async()=>reply([])),source={host,projectId:21,project:'business/orders'};
  await f.reports.action('settings',{gitlabProjects:[source],gitlabAuthors:user.email});
  // 模拟升级前没有新字段的已保存配置。
  const file=path.join(f.dir,'work-reports.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));delete saved.settings.gitlabAuthorMode;delete saved.settings.gitlabAuthorNames;fs.writeFileSync(file,JSON.stringify(saved));
  const restarted=f.create();t.after(()=>restarted.close());assert.equal(restarted.snapshot().settings.gitlabAuthorMode,'email');assert.equal(restarted.snapshot().settings.gitlabAuthors,user.email);
  await assert.rejects(restarted.action('settings',{gitlabAuthorMode:'unknown'}),/筛选方式/);
  await assert.rejects(restarted.action('settings',{gitlabAuthorMode:'name',gitlabAuthorNames:''}),/作者名/);
  await restarted.action('settings',{gitlabAuthorMode:'name',gitlabAuthorNames:'余朝元,yuchaoyuan',gitlabAuthors:''});
  await assert.rejects(restarted.action('settings',{gitlabAuthorMode:'email'}),/邮箱/);
  await restarted.action('settings',{gitlabAuthorMode:'email',gitlabAuthors:'CY@example.test'});
  assert.equal(restarted.snapshot().settings.gitlabAuthors,user.email);assert.equal(restarted.snapshot().settings.gitlabAuthorNames,'余朝元,yuchaoyuan');
});

test('commit MR associations use exact project identity, paginate and deduplicate opened and merged MRs',async()=>{
  const {collectGitlab}=require('../src/reports/gitlab.cjs');const calls=[];
  const source={host,projectId:21,project:'business/orders'},merged={iid:9,project_id:21,state:'merged',title:'订单修复'};
  const result=await collectGitlab(source,{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,fetchImpl:async raw=>{
    const url=new URL(raw);calls.push(url);if(url.pathname.endsWith('/repository/commits'))return reply([commit('a'),commit('a')]);
    const page=Number(url.searchParams.get('page'));return reply(page===1?[merged,{...merged,project_id:99},{...merged,iid:10,state:'opened'}]:[merged],{'x-next-page':page===1?'2':''});
  }});
  assert.equal(result.length,1);assert.equal(result[0].sourceMeta.mrChecked,true);assert.deepEqual(result[0].sourceMeta.mergeRequests,[{iid:9,title:'订单修复',url:host+'/business/orders/-/merge_requests/9',state:'merged'},{iid:10,title:'订单修复',url:host+'/business/orders/-/merge_requests/10',state:'opened'}]);
  assert.equal(calls.length,3);
});

test('unmerged commits retain one unambiguous feature branch and opened MR lifecycle metadata',async()=>{
  const {collectGitlab}=require('../src/reports/gitlab.cjs'),source={host,projectId:21,project:'business/orders'},options={since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email};
  const opened={iid:9,project_id:21,state:'opened',title:'订单功能',source_branch:'feat-cy-orders',target_branch:'main'};
  for(const refs of [[{type:'branch',name:'feat-cy-orders'}],[{type:'branch',name:'main'},{type:'branch',name:'feat-cy-orders'}],[{type:'branch',name:'feat-cy-orders'},{type:'branch',name:'feat-cy-other'}]]){
    const entries=await collectGitlab(source,{...options,fetchImpl:async raw=>{const p=new URL(raw).pathname;return reply(p.endsWith('/repository/commits')?[commit('a')]:p.endsWith('/refs')?refs:[],{'x-next-page':''});}});
    assert.equal(entries[0].sourceMeta.featureBranch,refs.length===1?'feat-cy-orders':undefined);
  }
  const entries=await collectGitlab(source,{...options,fetchImpl:async raw=>reply(new URL(raw).pathname.endsWith('/repository/commits')?[commit('a')]:[opened],{'x-next-page':''})});
  assert.equal(entries[0].sourceMeta.mergeRequests[0].state,'opened');assert.equal(entries[0].sourceMeta.mergeRequests[0].sourceBranch,'feat-cy-orders');assert.equal(entries[0].sourceMeta.mergeRequests[0].targetBranch,'main');
});

test('tracked old commits refresh outside the lookback and create an exact main merge event',async()=>{
  const {collectGitlab}=require('../src/reports/gitlab.cjs'),source={host,projectId:21,project:'business/orders'},mergedAt=NOW-3600000,calls=[];
  const mr={iid:9,project_id:21,state:'merged',title:'订单功能',source_branch:'feat-cy-orders',target_branch:'main'},url=host+'/business/orders/-/merge_requests/9';
  const old={source:'gitlab',sourceKey:'gitlab:'+host+':21:'+'a'.repeat(40),title:'开发订单功能',project:source.project,date:'2026-10-01',status:'done',sourceMeta:{projectId:21,sha:'a'.repeat(40),email:user.email,committedAt:Date.parse('2026-10-01T10:00:00+08:00'),mergeRequests:[{iid:9,title:mr.title,url,state:'opened',sourceBranch:mr.source_branch,targetBranch:'main'}]}};
  const entries=await collectGitlab(source,{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,trackedEntries:[old],fetchImpl:async raw=>{const p=new URL(raw).pathname;calls.push(p);return reply(p.endsWith('/repository/commits')?[]:p.endsWith('/merge_requests/9')?{...mr,merged_at:new Date(mergedAt).toISOString()}:[mr],{'x-next-page':''});}});
  assert.equal(entries.length,2);assert.equal(entries[0].sourceKey,old.sourceKey);assert.equal(entries[0].date,old.date);assert.equal(entries[0].sourceMeta.mergeRequests[0].mergedAt,mergedAt);
  const event=entries.find(entry=>entry.sourceMeta.event==='merged');assert.ok(event);assert.equal(event.date,'2026-10-26');assert.equal(event.sourceMeta.mergeRequests[0].targetBranch,'main');assert.ok(calls.some(path=>path.endsWith('/merge_requests/9')));
});

test('merging a colleague feature does not collect their task or create its merge event',async()=>{
  const {collectGitlab}=require('../src/reports/gitlab.cjs'),source={host,projectId:21,project:'business/orders'},mr={iid:119,project_id:21,title:'同事的支付功能',state:'merged',source_branch:'feat/colleague-pay',target_branch:'main',merged_at:'2026-10-26T12:00:00+08:00'};
  for(const merge of [{...commit('a'),title:"Merge branch 'feat/colleague-pay' into 'main'",parent_ids:['b'.repeat(40),'c'.repeat(40)]},{...commit('a'),title:'解决合并冲突',parent_ids:['b'.repeat(40),'c'.repeat(40)]}]){
    const entries=await collectGitlab(source,{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,fetchImpl:async raw=>reply(new URL(raw).pathname.endsWith('/repository/commits')?[merge,commit('b','colleague@example.test')]:[mr],{'x-next-page':''})});
    assert.deepEqual(entries,[]);
  }
  const old={source:'gitlab',sourceKey:'gitlab:'+host+':21:'+'a'.repeat(40),title:"Merge branch 'feat/colleague-pay' into 'main'",project:source.project,date:'2026-10-01',status:'done',sourceMeta:{projectId:21,sha:'a'.repeat(40),email:user.email,committedAt:NOW-30*86400000,mergeRequests:[{...mr,url:host+'/business/orders/-/merge_requests/119'}]}};
  const entries=await collectGitlab(source,{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,trackedEntries:[old],fetchImpl:async raw=>reply(new URL(raw).pathname.endsWith('/repository/commits')?[]:[mr],{'x-next-page':''})});assert.deepEqual(entries,[]);
  const contributed=await collectGitlab(source,{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,fetchImpl:async raw=>reply(new URL(raw).pathname.endsWith('/repository/commits')?[commit('c')]:[mr],{'x-next-page':''})});
  assert.equal(contributed.length,2);assert.equal(contributed[0].sourceMeta.sha,'c'.repeat(40));assert.equal(contributed[1].sourceMeta.event,'merged');
});

test('frontend merge events preserve a variable target branch without allowing it for backend repositories',async()=>{
  const {collectGitlab}=require('../src/reports/gitlab.cjs'),mergedAt=NOW-1000;
  const mr={iid:20,project_id:21,state:'merged',title:'应用类型新增',source_branch:'feat-cy-client-type',target_branch:'v3.10.0',merged_at:new Date(mergedAt).toISOString()};
  for(const project of ['ossv/d-minitv-admin','ossv/d-ossv-operate']){
    const result=await collectGitlab({host,projectId:21,project},{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,fetchImpl:async raw=>reply(new URL(raw).pathname.endsWith('/repository/commits')?[commit('a')]:[mr],{'x-next-page':''})});
    const event=result.find(entry=>entry.sourceMeta.event==='merged');
    if(project==='ossv/d-minitv-admin'){assert.ok(event);assert.equal(event.details,'代码已合并 v3.10.0。');assert.equal(event.sourceMeta.mergeRequests[0].targetBranch,'v3.10.0');}else assert.equal(event,undefined);
  }
});

test('MR association failures and truncated pages cannot save half-associated source results',async t=>{
  const f=fixture(t,async raw=>new URL(raw).pathname.endsWith('/repository/commits')?reply([commit('a')]):new Response('no access',{status:403}));
  f.credentialStore.save({url:host,token});await f.reports.action('settings',{gitlabProjects:[{host,projectId:21,project:'business/orders'}],gitlabAuthors:user.email});
  await f.reports.action('collect');assert.equal(f.reports.snapshot().total,0);assert.match(f.reports.snapshot().sources[0].error,/认证|权限/);
  const {collectGitlab}=require('../src/reports/gitlab.cjs');
  await assert.rejects(collectGitlab({host,projectId:21,project:'business/orders'},{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,fetchImpl:async raw=>{
    const url=new URL(raw);if(url.pathname.endsWith('/repository/commits'))return reply([commit('a')]);return reply([],{'x-next-page':String(Number(url.searchParams.get('page'))+1)});
  }}),/分页不完整/);
});

test('business commits retain verified SHA associations while intermediate merges do not introduce colleague work',async()=>{
  const {collectGitlab}=require('../src/reports/gitlab.cjs');
  const merged={iid:9,project_id:21,state:'merged',title:'订单修复',merge_commit_sha:'f'.repeat(40)};
  const items=[commit('a'),{...commit('b'),message:"Merge branch feature\n\nSee merge request business/orders!9",parent_ids:['a'.repeat(40),'c'.repeat(40)]},{...commit('c'),message:'普通提交\nSee merge request business/orders!9',parent_ids:['a'.repeat(40)]},{...commit('d'),message:'合并其他项目\nSee merge request other/orders!9',parent_ids:['a'.repeat(40),'c'.repeat(40)]},commit('f')];
  const result=await collectGitlab({host,projectId:21,project:'business/orders'},{since:NOW-86400000,until:NOW,connection:{url:host,token},authors:user.email,fetchImpl:async raw=>{const p=new URL(raw).pathname;return reply(p.endsWith('/repository/commits')?items:p.includes('/'+'a'.repeat(40)+'/merge_requests')?[merged]:[],{'x-next-page':''});}});
  assert.deepEqual(result.map(e=>e.sourceMeta.sha),['a','c','f'].map(value=>value.repeat(40)));assert.deepEqual(result.map(e=>e.sourceMeta.mergeRequests.length),[1,0,1]);
});
