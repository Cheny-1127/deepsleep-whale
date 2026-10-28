'use strict';
// 真实小屋 IPC 与页面，隐藏窗口；GitLab、Jenkins、日程和笔记全部使用隔离数据。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-reports-ui-'),vault=path.join(dir,'vault'),out=path.join(root,'out');
for(const directory of [vault,out])fs.mkdirSync(directory,{recursive:true});
const now=Date.parse('2026-10-26T18:00:00+08:00');
const groupedMatches=process.env.WHALE_REPORT_MATCH_GROUP_ONLY==='1';
const removingWorks=process.env.WHALE_REPORT_REMOVE_ONLY==='1';
const lifecycleOnly=process.env.WHALE_REPORT_LIFECYCLE_ONLY==='1';
const branchPolicy=process.env.WHALE_REPORT_BRANCH_POLICY_ONLY==='1';
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');
fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,['planner','reports'].includes(id)]))));
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({sources:{codex:false,cursor:false},notifications:false,sound:false}));
if(process.env.WHALE_REPORT_SUMMARY_ONLY==='1'||process.env.WHALE_REPORT_HISTORY_ONLY==='1'||process.env.WHALE_REPORT_MATCH_ONLY==='1'||groupedMatches||removingWorks||lifecycleOnly||branchPolicy){
  const {defaultSettings}=require('../../src/reports/model.cjs');
  const mr=iid=>({iid,title:'修复事项 '+iid,url:'https://gitlab.example.test/business/service/-/merge_requests/'+iid,state:'merged',sourceBranch:'feat-cy-task-'+iid,targetBranch:'main',mergedAt:Date.parse('2026-10-26T08:00:00+08:00')});
  const entry=(id,extra)=>({id,sourceKey:id,date:'2026-10-26',title:'原始提交 '+id,project:'business/service',details:'',source:'gitlab',status:'done',included:true,sourceActive:true,removed:false,edited:false,createdAt:now,updatedAt:now,...extra});
  const records=[];
  for(const iid of [1,2,3])for(let n=0;n<3;n++)records.push(entry('commit-'+iid+'-'+n,{sourceMeta:{mrChecked:true,committedAt:now-3600000,mergeRequests:[mr(iid)]}}));
  for(const [id,iid,hour,target] of [['r1',1,11,'原有服务器'],['r2',2,16,'原有服务器'],['r3',2,17,'EKS'],['r4',3,19,'原有服务器']])records.push(entry(id,{source:'jenkins',title:'原始生产发布 '+id,evidence:'https://jenkins.example.test/job/service/42/',sourceMeta:{release:true,direction:'forward',rangeVerified:true,releasedAt:Date.parse('2026-10-26T'+hour+':00:00+08:00'),target,buildNumber:42,mergeRequests:[mr(iid)]}}));
  records.push(entry('planner',{source:'planner',title:'日程回归验证',details:'补齐边界条件验证',sourceMeta:{completedAt:now}}));
  if(process.env.WHALE_REPORT_MATCH_ONLY==='1')records.splice(0,records.length,
    entry('match-code',{title:'修复会员临近过期时缓存被写成永久有效的问题',evidence:'https://gitlab.example.test/business/service/-/commit/'+'a'.repeat(40),sourceMeta:{mrChecked:true,mergeRequests:[{...mr(1),title:'修复会员临近过期时缓存被写成永久有效的问题'}]}}),
    entry('match-planner',{source:'planner',project:'日程工作',title:'调整VIP播放缓存问题',details:'解决 epilora 到期前最后不足 1 秒的边界漏洞：时间取整为 0 → 工具写成永久缓存 → 读取不验证有效期 → 持续按 VIP 放行。',sourceMeta:{completedAt:now}}),
    entry('ordinary-work',{source:'manual',project:'日常支持',title:'整理本周支持工单',details:'汇总处理结果并更新交接说明'}),
    entry('ordinary-planner',{source:'planner',project:'日程工作',title:'归档合同审批材料',details:'上传签署文件并登记合同编号',sourceMeta:{completedAt:now}}));
  if(process.env.WHALE_REPORT_MATCH_ONLY==='1')for(let i=0;i<12;i++)records.push(entry('match-extra-'+i,{title:'补充提交 '+i,details:'会员、缓存、永久',sourceMeta:{mrChecked:true,mergeRequests:[{...mr(1),title:'修复会员临近过期时缓存被写成永久有效的问题'}]}}));
  if(groupedMatches)records.splice(0,records.length,
    ...[['admin','应用管理支持客户端类型配置与筛选'],['api','应用管理支持客户端类型并修复跨应用列表查询']].map(([project,title],index)=>entry('group-'+project,{project:'business/'+project,sourceMeta:{mrChecked:true,mergeRequests:[{iid:index+1,title,url:'https://gitlab.example.test/business/'+project+'/-/merge_requests/'+(index+1)}]}})),
    entry('group-planner',{source:'planner',project:'日程工作',title:'APP应用类型新增',details:'h5、app、tiktok',sourceMeta:{completedAt:now}}));
  if(removingWorks)records.splice(0,records.length,...[['pay',119,2],['serve',392,1]].flatMap(([project,iid,count])=>Array.from({length:count},(_,i)=>entry('remove-'+project+'-'+i,{project:'business/'+project,sourceMeta:{mrChecked:true,mergeRequests:[{iid,title:'Feat/zhouliuqi 1021 h5 pagsmile pay',url:'https://gitlab.example.test/business/'+project+'/-/merge_requests/'+iid}]}}))));
  if(lifecycleOnly){
    const repositoryUrl='https://gitlab.example.test/business/pay',mergedAt=Date.parse('2026-10-27T17:00:00+08:00'),releasedAt=Date.parse('2026-10-28T16:00:00+08:00');
    const reference={iid:1,title:'新增支付方式',url:repositoryUrl+'/-/merge_requests/1',state:'merged',sourceBranch:'feat-cy-pay',targetBranch:'main',mergedAt};
    records.splice(0,records.length,
      entry('lifecycle-branch-only',{date:'2026-10-23',title:'开发退款方式',project:'business/pay',sourceMeta:{mrChecked:true,repositoryUrl,featureBranch:'feat-cy-refund',committedAt:Date.parse('2026-10-23T10:00:00+08:00')}}),
      entry('lifecycle-code',{title:'开发支付方式',project:'business/pay',details:'补齐支付参数校验',sourceMeta:{mrChecked:true,repositoryUrl,featureBranch:'feat-cy-pay',committedAt:now}}),
      entry('lifecycle-merge',{date:'2026-10-27',title:reference.title,project:'business/pay',details:'代码已合并 main。',sourceMeta:{mrChecked:true,event:'merged',repositoryUrl,committedAt:mergedAt,mergeRequests:[reference]}}),
      entry('lifecycle-release',{date:'2026-10-28',source:'jenkins',title:'生产发布',project:'business/pay',sourceMeta:{release:true,environment:'prod',rangeVerified:true,direction:'forward',releasedAt,target:'EKS',buildNumber:42,mergeRequests:[reference]}}));
  }
  if(branchPolicy){
    const fixtures=[['d-minitv-admin',77,20,'a','v3.10.0'],['d-ossv-operate',71,589,'b','main']].map(([name,projectId,iid,sha,targetBranch])=>({project:'ossv/'+name,projectId,sha:sha.repeat(40),reference:{iid,title:iid===20?'应用管理支持客户端类型配置与筛选':'应用管理支持客户端类型并修复跨应用列表查询',url:'https://gitlab.example.test/ossv/'+name+'/-/merge_requests/'+iid,state:'merged',sourceBranch:'feat-cy-app-client-type',targetBranch,mergedAt:now-7200000}}));
    fs.writeFileSync(path.join(dir,'branch-policy-remote.json'),JSON.stringify(fixtures));
    const oldReference=reference=>({iid:reference.iid,title:reference.title,url:reference.url});
    records.splice(0,records.length,...fixtures.map(value=>entry('gitlab:https://gitlab.example.test:'+value.projectId+':'+value.sha,{project:value.project,title:'开发客户端类型 '+value.project,details:'保留原始提交说明',sourceMeta:{projectId:value.projectId,sha:value.sha,author:'cy',email:'cy@example.test',committedAt:now-10800000,mrChecked:true,mergeRequests:[oldReference(value.reference)]}})),
      entry('branch-policy-release',{source:'jenkins',project:fixtures[1].project,title:'生产发布 #227',sourceMeta:{release:true,environment:'prod',rangeVerified:true,direction:'forward',releasedAt:now-60000,target:'原有服务器',buildNumber:227,mergeRequests:[oldReference(fixtures[1].reference)]}}),
      entry('branch-policy-planner',{source:'planner',project:'日程工作',title:'APP应用类型新增',details:'h5、app、tiktok',sourceMeta:{completedAt:now}}));
  }else for(const record of records)if(record.source==='gitlab')record.sourceMeta.mrLifecycleChecked=true;
  const seed=process.env.WHALE_REPORT_SUMMARY_DATA?JSON.parse(fs.readFileSync(process.env.WHALE_REPORT_SUMMARY_DATA,'utf8')):{version:1,revision:0,settings:defaultSettings(vault),entries:records,weeks:{},sources:Array.from({length:31},(_,i)=>({key:'gitlab:business/repo-'+i,project:'business/repo-'+i,count:0,error:'',checkedAt:now})),archives:{},dirtyDates:[]};
  seed.settings={...seed.settings,archiveDir:vault,autoCollect:false,autoArchive:false,autoWeekly:false};
  if(lifecycleOnly)seed.settings.weeklyTemplate='count={{count}}\n{{summary}}\nDETAILS\n{{details}}';
  if(branchPolicy){
    seed.settings.gitlabProjects=records.filter(record=>record.source==='gitlab').map(record=>({host:'https://gitlab.example.test',projectId:record.sourceMeta.projectId,project:record.project,path:record.project}));seed.settings.gitlabAuthors='cy@example.test';
    seed.workGroups=[{id:'branch-policy-group',date:'2026-10-26',title:'APP应用类型新增',description:'h5、app、tiktok',members:[...records.filter(record=>record.source==='gitlab').map(record=>'mr:'+record.sourceMeta.mergeRequests[0].url),'source:branch-policy-planner']}];
  }
  if(process.env.WHALE_REPORT_HISTORY_ONLY==='1'){
    // 使用原有记录制造未升级账本，远端夹具保留已核实的 MR 元数据；不接触正式数据。
    const normalize=value=>JSON.parse(JSON.stringify(value).replaceAll('https://gitlab.dingdingclub.com','https://gitlab.example.test'));
    Object.assign(seed,normalize(seed));
    const commits=seed.entries.filter(e=>e.source==='gitlab');
    for(const [index,entry] of commits.entries()){
      entry.sourceMeta={projectId:1,sha:(index+1).toString(16).padStart(40,'0'),author:'cy',email:'cy@example.test',committedAt:now-3600000,...entry.sourceMeta};
      entry.sourceKey='gitlab:https://gitlab.example.test:'+entry.sourceMeta.projectId+':'+entry.sourceMeta.sha;
    }
    if(!seed.settings.gitlabProjects.length){seed.settings.gitlabProjects=[{host:'https://gitlab.example.test',projectId:1,project:'business/service',path:'business/service'}];seed.settings.gitlabAuthors='cy@example.test';}
    fs.writeFileSync(path.join(dir,'history-remote.json'),JSON.stringify(seed));
    for(const entry of commits)for(const key of ['mrChecked','mrLifecycleChecked','mergeRequests','parentShas','mrAssociation'])delete entry.sourceMeta[key];
  }
  fs.writeFileSync(path.join(dir,'work-reports.json'),JSON.stringify(seed));
}
const bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`
require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {net,Notification,shell}=require('electron');Notification.isSupported=()=>false;shell.openExternal=async()=>{throw Error('测试不打开外部应用');};global.reportRequests=[];
net.fetch=async(raw,options)=>{
  const url=new URL(raw);if(!['https://jenkins.example.test','https://gitlab.example.test'].includes(url.origin))throw Error('测试不访问外部网络');global.reportRequests.push({url:raw,method:options.method,redirect:options.redirect});
  if(url.origin==='https://jenkins.example.test'){
    if(url.pathname.endsWith('/wfapi/describe'))return Response.json({stages:[{name:'Deploy to EKS',status:'SUCCESS',startTimeMillis:url.pathname.includes('/42/')?${now}-50000:${now}-86450000,durationMillis:10000}]});
    return Response.json({allBuilds:[42,41].map(number=>({number,building:false,result:'SUCCESS',timestamp:number===42?${now}-60000:${now}-86460000,duration:30000,actions:[{causes:[{userId:number===42?'cy':'other'}]},{remoteUrls:['https://gitlab.example.test/business/orders.git'],lastBuiltRevision:{SHA1:(number===42?'b':'a').repeat(40)}}]}))});
  }
  if(url.pathname.endsWith('/repository/compare'))return Response.json({commits:url.searchParams.get('to')==='b'.repeat(40)?[{id:'b'.repeat(40),title:'发布订单超时修复',author_name:'其他同事'}]:[]});
  if(url.pathname.endsWith('/merge_requests'))return Response.json([{iid:9,project_id:21,state:'merged',title:'订单超时修复',merge_commit_sha:'b'.repeat(40)}],{headers:{'x-next-page':''}});
  if(url.pathname.endsWith('/merge_requests/9/commits'))return Response.json([{id:'b'.repeat(40),title:'发布订单超时修复',message:['发布订单超时修复','补齐超时重试与回归'].join(String.fromCharCode(10)),author_name:'其他同事'}],{headers:{'x-next-page':''}});
  return Response.json([],{headers:{'x-next-page':''}});
};
if(process.env.WHALE_REPORT_HISTORY_ONLY==='1'){
  const history=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(dir,'history-remote.json'))},'utf8'));
  net.fetch=async(raw,options)=>{
    const url=new URL(raw);if(url.origin!=='https://gitlab.example.test'||options.method!=='GET'||options.redirect!=='error')throw Error('历史关联测试只读本地夹具');
    global.reportRequests.push({url:raw,method:options.method,redirect:options.redirect});
    const projectId=Number(url.pathname.match(new RegExp('projects/([0-9]+)/'))?.[1]),records=history.entries.filter(e=>e.source==='gitlab'&&e.sourceMeta.projectId===projectId),reply=data=>Response.json(data,{headers:{'x-next-page':''}});
    if(url.pathname.endsWith('/repository/commits'))return reply(records.map(e=>({id:e.sourceMeta.sha,title:e.title,message:e.title+String.fromCharCode(10)+e.details,parent_ids:e.sourceMeta.parentShas||[],author_name:e.sourceMeta.author,author_email:e.sourceMeta.email,committed_date:new Date(e.sourceMeta.committedAt).toISOString()})));
    if(url.pathname.endsWith('/merge_requests')){
      const record=records.find(e=>url.pathname.includes('/'+e.sourceMeta.sha+'/'));
      return reply(record?.sourceMeta.mrAssociation==='explicit-merge-reference'?[]:(record?.sourceMeta.mergeRequests||[]).map(m=>({...m,state:'merged',project_id:projectId})));
    }
    throw Error('未知历史关联接口');
  };
}
if(process.env.WHALE_REPORT_BRANCH_POLICY_ONLY==='1'){
  const fixtures=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(dir,'branch-policy-remote.json'))},'utf8'));
  net.fetch=async(raw,options)=>{
    const url=new URL(raw);if(url.origin!=='https://gitlab.example.test'||options.method!=='GET'||options.redirect!=='error')throw Error('分支状态测试只读隔离夹具');
    global.reportRequests.push({url:raw,method:options.method,redirect:options.redirect});
    const projectId=Number(url.pathname.match(new RegExp('projects/([0-9]+)/'))?.[1]),value=fixtures.find(value=>value.projectId===projectId);if(!value)throw Error('未知测试仓库');
    const reply=data=>Response.json(data,{headers:{'x-next-page':''}}),reference=value.reference;
    if(url.pathname.endsWith('/repository/commits'))return reply([{id:value.sha,title:'开发客户端类型 '+value.project,message:'开发客户端类型 '+value.project+String.fromCharCode(10)+'保留原始提交说明',author_name:'cy',author_email:'cy@example.test',committed_date:'2026-10-26T15:00:00+08:00'}]);
    if(url.pathname.endsWith('/merge_requests'))return reply([{...reference,project_id:projectId,source_branch:reference.sourceBranch,target_branch:reference.targetBranch,merged_at:new Date(reference.mergedAt).toISOString()}]);
    throw Error('未知分支状态测试接口');
  };
}
require(${JSON.stringify(path.join(root,'src/clients/presence.cjs'))}).readClientPresence=async()=>({codex:false,cursor:false});
const planner=require(${JSON.stringify(path.join(root,'src/app/planner.cjs'))}),makePlanner=planner.createPlanner;planner.createPlanner=options=>makePlanner({...options,now:()=>${now}});
const reports=require(${JSON.stringify(path.join(root,'src/app/work-reports.cjs'))}),makeReports=reports.createWorkReports;reports.createWorkReports=options=>makeReports({...options,...(process.env.WHALE_REPORT_GITLAB_ONLY==='1'?{}:{gitlabStore:{load:()=>({url:'https://gitlab.example.test',token:'fixture-gitlab-secret',username:'cy',authors:'cy@example.test'})}}),gitlabFetchImpl:(url,request)=>net.fetch(url,request),now:()=>${now},readEnvironment:()=>({archiveDir:${JSON.stringify(vault)},jenkinsUrl:'https://jenkins.example.test',jenkinsUser:'fixture',jenkinsToken:'fixture-secret'})});
if(process.env.WHALE_REPORT_GITLAB_ONLY==='1'){
  const crypto=require('node:crypto'),key=Buffer.alloc(32,7),storage=require(${JSON.stringify(path.join(root,'src/reports/gitlab-store.cjs'))}),makeStore=storage.createGitlabStore;
  storage.createGitlabStore=options=>makeStore({...options,safeStorage:{isEncryptionAvailable:()=>true,
    encryptString:text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()]);},
    decryptString:raw=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString();}}});
  net.fetch=async(raw,options)=>{
    const url=new URL(raw);if(url.origin!=='https://gitlab.example.test'||!url.pathname.startsWith('/gitlab/api/v4/'))throw Error('测试不访问外部网络');
    if(options.method!=='GET'||options.redirect!=='error'||url.searchParams.has('private_token'))throw Error('不安全的测试请求');
    global.reportRequests.push({url:raw,method:options.method,redirect:options.redirect});
    if(options.headers['PRIVATE-TOKEN']!=='fixture-gitlab-secret')return new Response('bad token',{status:401});
    const response=(data,more=false)=>new Response(JSON.stringify(data),{headers:{'x-next-page':more?String(Number(url.searchParams.get('page')||1)+1):''}}),page=Number(url.searchParams.get('page')||1);
    if(url.pathname.endsWith('/user'))return response({id:1,username:'cy',email:'cy@example.test'});
    if(url.pathname.endsWith('/groups'))return response(page===1?[{id:10,full_path:'business'},{id:11,full_path:'business/platform'}]:[{id:12,full_path:'ops'},{id:13,full_path:'bulk'},{id:14,full_path:'empty'}],page===1);
    if(global.reportGitlabProjectFailure&&url.pathname.endsWith('/projects'))return new Response('unavailable',{status:503});
    if(url.pathname.endsWith('/groups/13/projects'))return response(Array.from({length:201},(_,i)=>({id:1000+i,path_with_namespace:'bulk/repo-'+i})).slice((page-1)*50,page*50),page<5);
    if(url.pathname.endsWith('/groups/14/projects'))return response([]);
    if(url.pathname.endsWith('/groups/10/projects'))return response(page===1?[{id:21,path_with_namespace:'business/orders'},{id:22,path_with_namespace:'business/ignored'}]:[{id:23,path_with_namespace:'business/billing'},{id:24,path_with_namespace:'business/platform/api'}],page===1);
    if(url.pathname.endsWith('/groups/11/projects'))return response([{id:24,path_with_namespace:'business/platform/api'}]);
    if(url.pathname.endsWith('/groups/12/projects'))return response([{id:25,path_with_namespace:'ops/tools'}]);
    if(url.pathname.endsWith('/repository/commits'))return response([{id:'a'.repeat(40),title:'完成 '+url.pathname.split('/')[5]+' 提交',message:'提交结果',author_name:'CY',author_email:'cy@example.test',committed_date:'2026-10-26T10:00:00+08:00'},{id:'b'.repeat(40),title:'历史邮箱误填',message:'历史提交',author_name:'旧作者',author_email:'invalid-email-value',committed_date:'2026-10-26T11:00:00+08:00'},{id:'c'.repeat(40),title:'别人的提交',message:'不应纳入',author_name:'CY-other',author_email:'other@example.test',committed_date:'2026-10-26T12:00:00+08:00'}]);
    if(url.pathname.endsWith('/merge_requests'))return response([]);
    if(url.pathname.endsWith('/refs'))return response([]);
    throw Error('未知测试接口');
  };
}
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app,panel,pet;const errors=[];
async function launch(){
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_TEST_WINDOWS:process.env.WHALE_TEST_WINDOWS||'hidden',WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_CURSOR_HOME:dir,WHALE_QUOTA_API_KEY:'',WHALE_QUOTA_BASE_URL:'https://quota.example.test',WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing')}});
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));await app.firstWindow();
  await app.evaluate(async({BrowserWindow})=>{for(let i=0;i<100&&!BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().endsWith('/index.html'));i++)await new Promise(resolve=>setTimeout(resolve,30));});
  panel=app.windows().find(p=>p.url().endsWith('/index.html'));pet=app.windows().find(p=>p.url().endsWith('/pet.html'));assert.ok(panel);
  await panel.waitForFunction(()=>document.getElementById('reports-module-toggle')?.disabled===false);
  await panel.locator('#nav-reports').click();await panel.locator('#report-date').fill('2026-10-26');await panel.locator('#report-date').dispatchEvent('change');
}
async function entries(){return (await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value.entries;}
async function policy(){const state=await app.evaluate(({BrowserWindow})=>({mode:global.testWindowPolicy.mode,events:global.testWindowPolicy.events,windows:BrowserWindow.getAllWindows().map(win=>({visible:win.isVisible(),focused:win.isFocused(),top:win.isAlwaysOnTop()}))}));assert.ok(state.windows.every(w=>!w.focused&&!w.top));assert.ok(state.events.every(e=>e.type!=='focus'));if(state.mode==='hidden'){assert.ok(state.windows.every(w=>!w.visible));assert.deepEqual(state.events,[]);}}
(async()=>{try{
  await launch();
  if(branchPolicy){
    const card=panel.locator('#report-list .report-work-card');await panel.waitForFunction(async()=>{const result=await window.whale.reports('snapshot',{date:'2026-10-26'});return !result.value.needsMrRefresh&&document.querySelector('#report-list .report-work-badge')?.textContent==='已完成';});
    const fixed=(await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value;
    assert.equal(fixed.needsMrRefresh,false);assert.equal(fixed.entries.length,4);assert.equal(fixed.work.items.length,1);assert.equal(fixed.work.items[0].title,'APP应用类型新增');assert.equal(fixed.work.items[0].description,'h5、app、tiktok');assert.equal(fixed.work.items[0].releases.length,1);
    assert.ok(fixed.entries.filter(entry=>entry.source==='gitlab').every(entry=>entry.sourceMeta.mrLifecycleChecked));assert.equal(fixed.entries.find(entry=>entry.project==='ossv/d-minitv-admin').sourceMeta.mergeRequests[0].targetBranch,'v3.10.0');assert.equal((await app.evaluate(()=>global.reportRequests)).length,4);
    await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/APP应用类型新增\*\*（已完成）/);await panel.locator('#report-preview-dialog [data-close]').click();
    async function snapshot(){return (await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value;}
    async function unmerge(){await panel.getByRole('button',{name:'解除合并',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'解除合并',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===3);}
    await unmerge();assert.match(await panel.locator('#report-feedback').innerText(),/合并同一事项.*重新检查已忽略的关联/);assert.equal(await panel.locator('#report-match-list .report-match').count(),0);
    const separated=await snapshot(),backend=separated.work.items.find(item=>item.mr?.iid===589),planner=separated.work.items.find(item=>item.kind==='planner'),frontend=separated.work.items.find(item=>item.mr?.iid===20);
    async function merge(origin,target,count){await panel.locator('#report-merge').click();const form=panel.locator('#report-work-form');await form.locator('[name="origin"]').selectOption(origin);await form.locator('[name="target"]').selectOption(target);await form.getByRole('button',{name:'确认合并',exact:true}).click();await panel.waitForFunction(count=>document.querySelectorAll('#report-list .report-work-card').length===count,count);}
    await merge(backend.key,planner.key,2);await merge((await snapshot()).work.items.find(item=>item.groupId).key,frontend.key,1);assert.equal((await snapshot()).work.items[0].badge,'已完成');assert.deepEqual((await snapshot()).entries,fixed.entries);
    await unmerge();await panel.getByRole('button',{name:'重新检查已忽略的关联',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('#report-match-list .report-match').length===1);await panel.locator('#report-match-list .report-match > summary').click();await panel.locator('#report-matches').getByRole('button',{name:'确认合并',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===1);assert.equal((await snapshot()).work.items[0].badge,'已完成');assert.deepEqual((await snapshot()).entries,fixed.entries);
    for(const width of [760,1060]){
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(700,680);win.setSize(width,1000);},width);await panel.waitForFunction(width=>window.innerWidth===width,width);assert.ok(await panel.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth));await panel.screenshot({path:path.join(out,`work-reports-branch-policy-${width}.png`),fullPage:true});
    }
    assert.equal(await card.count(),1);await policy();await app.close();app=null;await launch();await panel.waitForFunction(()=>document.querySelector('#report-list .report-work-badge')?.textContent==='已完成');assert.equal((await app.evaluate(()=>global.reportRequests)).length,0);await policy();assert.deepEqual(errors,[]);
    console.log('PASS: production inclusion completes merged work, legacy MR refresh, unmerge/manual remerge/restored reminder merge, unchanged sources, restart and 760/1060px layout');return;
  }
  if(lifecycleOnly){
    const cards=()=>panel.locator('#report-list .report-work-card');
    await panel.locator('#report-date').fill('2026-10-23');await panel.locator('#report-date').dispatchEvent('change');await panel.waitForFunction(()=>document.querySelector('#report-list .report-work-heading h3')?.textContent==='开发退款方式');
    await cards().getByRole('button',{name:'修改信息',exact:true}).click();assert.equal(await panel.locator('#report-work-dialog').isVisible(),true);await panel.locator('#report-work-dialog [data-close]').click();
    async function day(date,badge){
      await panel.locator('#report-date').fill(date);await panel.locator('#report-date').dispatchEvent('change');
      await panel.waitForFunction(badge=>document.querySelector('#report-list .report-work-badge')?.textContent===badge,badge);
      assert.equal(await cards().count(),1);assert.match(await cards().innerText(),/新增支付方式/);
      await panel.locator('#report-preview-day').click();const preview=await panel.locator('#report-day-content').inputValue();assert.match(preview,new RegExp(badge));if(badge!=='已完成')assert.doesNotMatch(preview,/已完成/);await panel.locator('#report-preview-dialog [data-close]').click();
    }
    await day('2026-10-26','开发中');assert.equal(await cards().locator('.report-work-completed').count(),0);
    await day('2026-10-27','待发布');assert.match(await cards().innerText(),/MR 合并 1 条/);assert.doesNotMatch(await cards().innerText(),/GitLab 提交/);
    await day('2026-10-28','已完成');assert.match(await cards().locator('.report-work-completed').innerText(),/2026\/10\/28 16:00/);
    for(const width of [760,1060]){
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(700,680);win.setSize(width,1000);},width);
      await panel.waitForFunction(width=>window.innerWidth===width,width);assert.ok(await panel.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth));
      await panel.screenshot({path:path.join(out,`work-reports-lifecycle-${width}.png`),fullPage:true});
    }
    await panel.locator('#report-weekly-tab').click();await panel.locator('#report-week-date').fill('2026-10-28');await panel.locator('#report-week-date').dispatchEvent('change');await panel.locator('#report-generate').click();
    await panel.waitForFunction(()=>document.getElementById('report-week-content').value.includes('count=1'));
    const [summary,details]=(await panel.locator('#report-week-content').inputValue()).split('DETAILS');assert.equal((summary.match(/新增支付方式/g)||[]).length,1);assert.match(summary,/已完成/);for(const badge of ['开发中','待发布','已完成'])assert.match(details,new RegExp(badge));
    await panel.locator('#report-daily-tab').click();await day('2026-10-26','开发中');await policy();await app.close();app=null;await launch();await day('2026-10-27','待发布');
    assert.equal((await app.evaluate(()=>global.reportRequests)).length,0);await policy();assert.deepEqual(errors,[]);
    console.log('PASS: cross-day lifecycle, main merge event, production completion time, historical daily previews, weekly deduplication, restart and 760/1060px layout');return;
  }
  if(removingWorks){
    const cards=()=>panel.locator('#report-list .report-work-card');await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===2);
    const original=await entries(),controls=()=>cards().first().locator('.report-work-controls');assert.equal(original.length,3);assert.equal(await controls().getByRole('button',{name:'移除',exact:true}).isEnabled(),true);
    await controls().getByRole('button',{name:'移除',exact:true}).click();assert.match(await panel.locator('.ui-confirm-dialog').innerText(),/2 条来源记录/);
    await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(await entries(),original);assert.equal(await cards().count(),2);
    for(const width of [760,1060]){
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(700,680);win.setSize(width,1000);},width);
      await panel.waitForFunction(width=>window.innerWidth===width,width);assert.ok(await panel.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth));
      for(const controls of await panel.locator('.report-work-controls').all())assert.ok(await controls.evaluate(node=>node.scrollWidth<=node.clientWidth));
      await panel.screenshot({path:path.join(out,`work-reports-remove-${width}.png`),fullPage:true});
    }
    await controls().getByRole('button',{name:'移除',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'移除工作',exact:true}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===1);assert.equal((await entries()).length,1);assert.match(await cards().innerText(),/business\/serve/);
    await policy();await app.close();app=null;await launch();await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===1);
    await controls().getByRole('button',{name:'移除',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'移除工作',exact:true}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===0);assert.equal((await entries()).length,0);assert.equal(await panel.locator('#report-list .report-empty').isVisible(),true);
    assert.equal((await app.evaluate(()=>global.reportRequests)).length,0);await policy();assert.deepEqual(errors,[]);
    console.log('PASS: direct work removal, cancel/confirm, multiple sources, preserved other work, restart and empty state, 760/1060px layout');return;
  }
  if(groupedMatches){
    let matches=panel.locator('#report-matches');const cards=()=>matches.locator('.report-work-card'),original=await entries();
    await panel.waitForFunction(()=>document.querySelectorAll('#report-match-list .report-match').length===1);
    assert.match(await matches.innerText(),/可能是同一件工作 · 1 组/);assert.equal(await cards().count(),3);assert.equal(await panel.locator('#report-list .report-work-card').count(),0);
    assert.equal(await matches.locator('.report-match-title').innerText(),'APP应用类型新增');await matches.locator('.report-match > summary').click();
    for(const width of [760,1060]){
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(700,680);win.setSize(width,1000);},width);
      await panel.waitForFunction(width=>window.innerWidth===width,width);assert.ok(await panel.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth));
      assert.equal(await matches.locator('.report-match-grid').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),width===760?1:2);
      const bounds=await Promise.all((await cards().all()).map(card=>card.boundingBox())),footer=await matches.locator('.report-match-footer').boundingBox();
      assert.ok(bounds.every(box=>box&&footer.y>=box.y+box.height));await panel.screenshot({path:path.join(out,`work-reports-grouped-${width}.png`),fullPage:true});
    }
    await matches.getByRole('button',{name:'不是同一件',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('#report-match-list .report-match').length===0);
    assert.equal(await panel.locator('#report-list .report-work-card').count(),3);await policy();await app.close();app=null;await launch();matches=panel.locator('#report-matches');
    assert.equal(await matches.locator('.report-match').count(),0);await matches.getByRole('button',{name:'重新检查已忽略的关联',exact:true}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#report-match-list .report-match').length===1);assert.equal(await cards().count(),3);await matches.locator('.report-match > summary').click();
    await matches.getByRole('button',{name:'确认合并',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('.report-work-card').length===1);
    assert.deepEqual(await entries(),original);assert.equal(await panel.locator('#report-list .report-work-card > .report-work-heading > h3').innerText(),'APP应用类型新增');
    await panel.getByRole('button',{name:'解除合并',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'解除合并',exact:true}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('.report-work-card').length===3);assert.equal(await matches.locator('.report-match').count(),0);assert.deepEqual(await entries(),original);
    assert.equal((await app.evaluate(()=>global.reportRequests)).length,0);await policy();assert.deepEqual(errors,[]);
    console.log('PASS: one group with three work cards, 760/1060px layout, dismiss/restart/restore, merge/unmerge and unchanged sources');return;
  }
  if(process.env.WHALE_REPORT_MATCH_ONLY==='1'){
    await panel.waitForFunction(()=>document.querySelectorAll('#report-match-list .report-match').length===1);
    let original=await entries(),matches=panel.locator('#report-matches');assert.equal(original.length,16);assert.equal(await panel.locator('.report-work-card').count(),4);
    const ordinary=()=>panel.locator('#report-list .report-work-card').filter({has:panel.getByRole('heading',{name:'整理本周支持工单',exact:true})}),ordinaryMarkup=await ordinary().innerHTML();
    const ordinaryPlanner=()=>panel.locator('#report-list .report-work-card').filter({has:panel.getByRole('heading',{name:'归档合同审批材料',exact:true})}),plannerMarkup=await ordinaryPlanner().innerHTML();
    const assertOrdinary=async()=>{
      assert.equal(await ordinary().isVisible(),true);assert.equal(await ordinary().innerHTML(),ordinaryMarkup);assert.equal(await ordinary().locator('.report-work-description').isVisible(),true);assert.match(await ordinary().innerText(),/汇总处理结果并更新交接说明/);
      assert.equal(await ordinaryPlanner().isVisible(),true);assert.equal(await ordinaryPlanner().innerHTML(),plannerMarkup);assert.equal(await ordinaryPlanner().locator('.report-work-meta .report-source-reference').count(),1);assert.equal(await ordinaryPlanner().locator('.report-source-card').count(),0);
    };
    await assertOrdinary();assert.match(await matches.innerText(),/可能是同一件工作 · 1 组/);assert.match(await matches.innerText(),/内容共同涉及：.*缓存/);
    assert.equal(await matches.locator('.report-match').getAttribute('open'),null);assert.equal(await matches.locator('.report-work-card').first().isVisible(),false);
    await matches.locator('.report-match > summary').click();await matches.locator('.report-work-card').first().locator(':scope > .report-work-evidence > summary').click();
    const list=matches.locator('.report-match-source-list'),source=list.locator('.report-source-card').first(),sourceSummary=source.locator(':scope > summary'),sourceBody=source.locator('.report-source-card-content');
    assert.equal(await list.locator('.report-source-card').count(),13);assert.equal(await panel.locator('#report-source-dialog').count(),0);assert.equal(await sourceBody.isVisible(),false);
    assert.equal(await sourceSummary.innerText(),'修复会员临近过期时缓存被写成永久有效的问题');
    await sourceSummary.hover();assert.equal(await source.getAttribute('open'),null);await sourceSummary.focus();assert.equal(await source.getAttribute('open'),null);
    await sourceSummary.click();assert.equal(await sourceBody.isVisible(),true);assert.equal(await panel.locator('dialog[open]').count(),0);assert.match(await sourceBody.innerText(),/GitLab 提交/);assert.match(await sourceBody.innerText(),/https:\/\/gitlab\.example\.test/);
    await sourceBody.getByRole('button',{name:'编辑',exact:true}).click();await panel.waitForFunction(()=>document.getElementById('report-entry-dialog').open);
    assert.equal(await panel.locator('#report-entry-form [name="title"]').inputValue(),'修复会员临近过期时缓存被写成永久有效的问题');await panel.locator('#report-entry-dialog [data-close]').click();
    await panel.evaluate(()=>{window.reportComparisonNode=document.querySelector('#report-match-list .report-source-card');});
    await panel.evaluate(()=>new Promise(resolve=>setTimeout(resolve,5500)));
    assert.equal(await source.getAttribute('open'),'');assert.equal(await panel.evaluate(()=>window.reportComparisonNode.isConnected),true);
    const right=matches.locator('.report-work-card').last(),plannerReference=right.locator('.report-planner-reference'),plannerPopup=plannerReference.locator('.report-planner-popup');
    assert.equal(await right.locator('.report-source-card').count(),0);
    assert.equal(await right.locator(':scope > .report-work-heading > h3').count(),1);assert.equal(await right.locator('.report-work-meta > button.outline').count(),0);
    await plannerReference.locator('.report-planner-trigger').hover();await plannerPopup.waitFor({state:'visible'});assert.match(await plannerPopup.innerText(),/完成日期：2026-10-26/);
    await plannerReference.locator('.report-planner-trigger').focus();await plannerReference.locator('.report-planner-trigger').press('Escape');assert.equal(await plannerPopup.isVisible(),false);await panel.locator('#report-day-summary').click();
    const updated=await panel.evaluate(async()=>{const response=await window.whale.reports('snapshot',{date:'2026-10-26'}),entry=response.value.entries.find(entry=>entry.id==='match-planner');return window.whale.reports('save-entry',{...entry,details:entry.details+' 补充回归结果。'});});assert.equal(updated.error,undefined);
    await panel.waitForFunction(()=>document.querySelector('#report-match-list').textContent.includes('补充回归结果。'));
    assert.equal(await source.getAttribute('open'),'');assert.equal(await list.locator('.report-source-card[open]').count(),1);await sourceSummary.click();original=await entries();
    for(const width of [760,860,1060]){
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(700,680);win.setSize(width,1000);},width);
      await panel.waitForFunction(width=>window.innerWidth===width,width);assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));
      await assertOrdinary();assert.ok(await list.evaluate(node=>node.clientHeight<=420&&node.scrollHeight>node.clientHeight));
      for(const summary of await list.locator('.report-source-card > summary').all())assert.ok((await summary.boundingBox()).height<=50);
      await list.evaluate(node=>{node.scrollTop=0;});await panel.screenshot({path:path.join(out,`work-reports-source-cards-${width}.png`),fullPage:true});
      const last=list.locator('.report-source-card').last();await last.locator(':scope > summary').press('Enter');assert.equal(await last.getAttribute('open'),'');assert.match(await last.locator('.report-source-card-content').innerText(),/会员、缓存、永久/);
      assert.equal(await panel.locator('dialog[open]').count(),0);assert.ok(await last.evaluate(node=>node.scrollWidth<=node.clientWidth));
      await panel.waitForFunction(()=>{const list=document.querySelector('.report-match-source-list'),body=list.lastElementChild.querySelector('.report-source-card-content'),a=list.getBoundingClientRect(),b=body.getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom+1;});await panel.screenshot({path:path.join(out,`work-reports-source-expanded-${width}.png`),fullPage:true});
      await last.locator(':scope > summary').click();assert.equal(await last.locator('.report-source-card-content').isVisible(),false);await assertOrdinary();
      await matches.locator('.report-match > summary').click();assert.equal(await list.isVisible(),false);await matches.locator('.report-match > summary').press('Enter');assert.equal(await list.isVisible(),true);
      const footer=await matches.locator('.report-match-footer').boundingBox(),left=await matches.locator('.report-work-card').first().boundingBox(),rightBounds=await right.boundingBox();assert.ok(footer.y>=Math.max(left.y+left.height,rightBounds.y+rightBounds.height));
    }
    await matches.getByRole('button',{name:'不是同一件',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('#report-match-list .report-match').length===0);assert.equal(await panel.locator('.report-work-card').count(),4);await assertOrdinary();
    assert.equal(await panel.locator('#report-list .report-source-card').count(),0);assert.ok(await panel.locator('#report-list .report-source-reference').count()>0);
    await policy();await app.close();app=null;await launch();await panel.waitForFunction(()=>document.getElementById('report-matches-note').textContent.includes('已忽略 1 组'));matches=panel.locator('#report-matches');
    await matches.getByRole('button',{name:'重新检查已忽略的关联',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('#report-match-list .report-match').length===1);
    await matches.locator('.report-match > summary').click();await matches.getByRole('button',{name:'确认合并',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('.report-work-card').length===3);
    assert.equal(await matches.isVisible(),false);assert.deepEqual(await entries(),original);await assertOrdinary();assert.equal(await panel.locator('#report-list .report-source-card').count(),0);
    await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/今日工作 3 项/);await panel.locator('#report-preview-dialog [data-close]').click();
    await panel.getByRole('button',{name:'解除合并',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'解除合并',exact:true}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('.report-work-card').length===4);assert.equal(await panel.locator('#report-match-list .report-match').count(),0);assert.deepEqual(await entries(),original);await assertOrdinary();
    assert.equal((await app.evaluate(()=>global.reportRequests)).length,0);await policy();assert.deepEqual(errors,[]);
    console.log('PASS: inline source expansion/collapse and keyboard, no source modal, compact planner references on right and below, 13 sources with scrolling, retained expansion on refresh, ordinary cards/footer and 760/860/1060px screenshots');return;
  }
  if(process.env.WHALE_REPORT_SUMMARY_ONLY==='1'||process.env.WHALE_REPORT_HISTORY_ONLY==='1'){
    const originalEntryCount=(await entries()).length;
    await panel.waitForFunction(()=>document.querySelectorAll('.report-work-card').length===4);
    // 该分支独立验证手工合并；自动提醒交互在 MATCH_ONLY 分支验证。
    while(await panel.locator('#report-match-list .report-match').count()){
      const count=await panel.locator('#report-match-list .report-match').count(),group=panel.locator('#report-match-list .report-match').first();
      if(await group.getAttribute('open')===null)await group.locator(':scope > summary').click();await group.getByRole('button',{name:'不是同一件',exact:true}).click();
      await panel.waitForFunction(count=>document.querySelectorAll('#report-match-list .report-match').length<count,count);
    }
    await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===4);
    assert.match(await panel.locator('#report-day-summary').innerText(),/4 项工作 · 0 项待解决 · 0 项计划/);
    assert.equal(await panel.locator('#report-list .report-entry:visible').count(),0);assert.equal(await panel.locator('#report-source-status').getAttribute('open'),null);
    assert.equal(await panel.locator('#report-list .report-release-list li').count(),4);assert.equal(await panel.locator('#report-list .report-work-evidence').count(),3);
    assert.equal(await panel.locator('#report-list .report-release-list:visible').count(),0);
    assert.match(await panel.locator('#report-list').innerText(),/business\/service/);assert.match(await panel.locator('#report-list').innerText(),/MR !2/);assert.match(await panel.locator('#report-list').innerText(),/GitLab 提交 3 条/);
    assert.equal(await panel.locator('#report-list .report-work-release-summary').count(),3);assert.match(await panel.locator('#report-list .report-work-release-summary').nth(1).innerText(),/2 次发布.*原有服务器、EKS.*17:00/);assert.doesNotMatch(await panel.locator('#report-list').innerText(),/Merge branch/);
    assert.equal(await panel.locator('#report-list .report-work-controls').getByRole('button',{name:'修改信息',exact:true}).count(),4);assert.equal(await panel.locator('#report-list').getByRole('button',{name:'合并同一事项',exact:true}).count(),0);assert.equal(await panel.locator('#report-merge').isEnabled(),true);
    assert.equal(await panel.locator('.report-work-badge').filter({hasText:'已完成'}).count(),4);
    const evidence=panel.locator('#report-list .report-work-evidence').first();await evidence.locator('summary').click();assert.match(await evidence.innerText(),/MR !|发布人|版本|提交/);await evidence.locator('summary').click();
    if(process.env.WHALE_REPORT_HISTORY_ONLY==='1'){
      await panel.waitForFunction(()=>!document.getElementById('report-feedback').textContent.includes('正在整理历史'));
      const fixed=(await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value;
      assert.ok(fixed.entries.filter(e=>e.source==='gitlab').every(e=>e.sourceMeta.mrChecked));assert.equal(fixed.settings.autoCollect,false);assert.equal(fixed.busy,false);
      const requests=(await app.evaluate(()=>global.reportRequests)).length;assert.ok(requests>=10);
      await panel.locator('#report-date').dispatchEvent('change');await panel.waitForFunction(()=>!document.getElementById('report-collect').disabled);assert.equal((await app.evaluate(()=>global.reportRequests)).length,requests);
      assert.equal(await panel.locator('#report-repair-day').isVisible(),false);assert.doesNotMatch(await panel.locator('#report-list').innerText(),/历史提交尚未|Merge branch/);
    }
    await panel.locator('#report-source-status > summary').click();assert.match(await panel.locator('#report-source-range').innerText(),/回溯结果.*不代表所选日期/);await panel.locator('#report-source-status > summary').click();
    for(const width of [860,1060]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,1000),width);assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));await panel.screenshot({path:path.join(out,`work-reports-${process.env.WHALE_REPORT_HISTORY_ONLY==='1'?'history':'summary'}-${width}.png`),fullPage:true});}
    await panel.locator('#report-preview-day').click();const preview=await panel.locator('#report-day-content').inputValue();assert.match(preview,/今日工作 4 项/);assert.doesNotMatch(preview,/Merge branch|[0-9a-f]{40}|MR !|原有服务器|EKS|#42|生产发布/);await panel.locator('#report-preview-dialog [data-close]').click();
    const beforeEdit=(await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value,automatic=beforeEdit.work.items.find(item=>item.mr);
    await panel.locator('#report-list .report-work-card').filter({has:panel.getByRole('heading',{name:automatic.title,exact:true})}).getByRole('button',{name:'修改信息',exact:true}).click();
    const editForm=panel.locator('#report-work-form');assert.equal(await editForm.locator('[name="origin"]').isVisible(),false);assert.equal(await editForm.locator('[name="target"]').isVisible(),false);
    await editForm.locator('[name="title"]').fill('修复苹果订阅生效时间偏晚问题');await editForm.locator('[name="description"]').fill('修正订阅生效时刻计算，订阅校验通过。');await editForm.locator('[type="submit"]').click();
    await panel.waitForFunction(()=>!document.getElementById('report-work-dialog').open&&document.getElementById('report-list').textContent.includes('修正订阅生效时刻计算'));
    assert.deepEqual(await entries(),beforeEdit.entries);assert.equal(await panel.locator('#report-list .report-work-card').count(),4);
    for(const width of [760,860,1060]){
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(700,680);win.setSize(width,1000);},width);await panel.waitForFunction(width=>innerWidth===width,width);
      assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));
      for(const card of await panel.locator('#report-list .report-work-card').all()){
        const title=await card.locator('.report-work-heading > h3').boundingBox(),badge=await card.locator('.report-work-heading > .report-work-badge').boundingBox();assert.ok(badge.x>=title.x+title.width);assert.ok(Math.abs(badge.y-title.y)<5);
      }
      await panel.screenshot({path:path.join(out,`work-reports-card-info-${width}.png`),fullPage:true});
    }
    await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/修复苹果订阅生效时间偏晚问题/);assert.match(await panel.locator('#report-day-content').inputValue(),/修正订阅生效时刻计算/);await panel.locator('#report-preview-dialog [data-close]').click();
    await policy();await app.close();app=null;await launch();await panel.waitForFunction(()=>document.getElementById('report-list').textContent.includes('修正订阅生效时刻计算'));
    assert.deepEqual(await entries(),beforeEdit.entries);await panel.getByRole('button',{name:'还原修改',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'还原修改',exact:true}).click();await panel.waitForFunction(()=>!document.getElementById('report-list').textContent.includes('修正订阅生效时刻计算'));
    assert.deepEqual(await entries(),beforeEdit.entries);
    const original=(await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value;
    const plannerEntry=original.entries.find(e=>e.source==='planner'&&e.sourceActive!==false),planner=panel.locator('.report-work-card').filter({has:panel.getByRole('heading',{name:plannerEntry.title,exact:true})});
    await planner.locator('.report-work-controls').getByRole('button',{name:'修改信息',exact:true}).click();assert.equal(await panel.locator('#report-entry-dialog').isVisible(),true);await panel.locator('#report-entry-dialog [data-close]').click();
    await panel.locator('#report-merge').click();const form=panel.locator('#report-work-form');await form.locator('[name="origin"]').selectOption(original.work.items.find(item=>item.kind==='planner').key);
    assert.equal(await form.locator('[name="target"] option').count(),3);assert.doesNotMatch((await form.locator('[name="target"] option').allTextContents()).join(' '),/MR !/);
    const selected=original.work.items.filter(i=>i.mr).at(-1).key;await form.locator('[name="target"]').selectOption(selected);
    assert.equal(await form.locator('[name="title"]').inputValue(),plannerEntry.title);assert.equal(await form.locator('[name="description"]').inputValue(),plannerEntry.details);
    await form.locator('[data-close]').click();assert.equal((await entries()).length,originalEntryCount);assert.equal(await panel.locator('.report-work-card').count(),4);
    await panel.locator('#report-merge').click();await form.locator('[name="origin"]').selectOption(original.work.items.find(item=>item.kind==='planner').key);await form.locator('[name="target"]').selectOption(selected);
    await panel.screenshot({path:path.join(out,'work-reports-merge-dialog.png'),fullPage:true});await form.locator('[name="title"]').fill('修复 VIP 播放缓存过期判断');await form.locator('[type="submit"]').click();
    await panel.waitForFunction(()=>!document.getElementById('report-work-dialog').open&&document.querySelectorAll('#report-list .report-work-card').length===3);
    assert.match(await panel.locator('#report-day-summary').innerText(),/3 项工作/);
    const snapshot=(await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value;assert.equal(snapshot.entries.length,originalEntryCount);assert.equal(snapshot.work.rawCount,14);assert.deepEqual(snapshot.entries,original.entries);
    const linked=panel.locator('.report-work-card').filter({has:panel.getByRole('heading',{name:'修复 VIP 播放缓存过期判断',exact:true})});assert.equal(await linked.count(),1);
    await linked.getByRole('button',{name:'修改信息',exact:true}).click();assert.equal(await form.locator('[name="target"]').isVisible(),false);await form.locator('[name="description"]').fill('修复临近过期时的缓存有效期判断。');await form.locator('[type="submit"]').click();
    await panel.waitForFunction(()=>!document.getElementById('report-work-dialog').open&&document.getElementById('report-list').textContent.includes('修复临近过期时的缓存有效期判断。'));
    await linked.locator('.report-work-evidence > summary').click();assert.equal(await linked.locator('.report-entry').count(),5);await linked.locator('.report-work-evidence > summary').click();
    for(const width of [860,1060]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,1000),width);assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));await panel.screenshot({path:path.join(out,`work-reports-merged-${width}.png`),fullPage:true});}
    await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/今日工作 3 项/);assert.match(await panel.locator('#report-day-content').inputValue(),/修复临近过期时的缓存有效期判断。/);await panel.locator('#report-preview-dialog [data-close]').click();
    if(process.env.WHALE_REPORT_HISTORY_ONLY==='1'){
      await policy();await app.close();app=null;await launch();await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===3);assert.equal((await app.evaluate(()=>global.reportRequests)).length,0);
    }
    await panel.getByRole('button',{name:'解除合并',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(await panel.locator('.report-work-card').count(),3);
    await panel.getByRole('button',{name:'解除合并',exact:true}).click();await panel.locator('.ui-confirm-dialog').getByRole('button',{name:'解除合并',exact:true}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#report-list .report-work-card').length===4);assert.deepEqual(await entries(),original.entries);
    await policy();assert.deepEqual(errors,[]);console.log('PASS: merge/cancel/edit/unmerge/restart, original 14 facts preserved, business preview, hidden evidence and 860/1060px layout; window mode '+(process.env.WHALE_TEST_WINDOWS||'hidden'));return;
  }
  if(process.env.WHALE_REPORT_RELEASE_ONLY==='1'){
    const project={host:'https://gitlab.example.test',projectId:21,project:'business/orders',path:'business/orders'};
    const response=await panel.evaluate(project=>window.whale.reports('settings',{gitlabProjects:[project],gitlabAuthors:'cy@example.test',jenkinsJobs:[{job:'prod/orders',project:project.project,environment:'prod',target:'EKS',userIds:'cy'}]}),project);assert.equal(response.error,undefined);
    await panel.locator('#report-open-settings').click();const settings=panel.locator('#report-settings-form');
    assert.match(await panel.locator('#report-jenkins-source').innerText(),/发布阶段完成时间/);assert.equal(await settings.locator('[name="deploySuccess"]').count(),0);assert.equal(await settings.locator('[data-kind="job"] [name="environment"]').inputValue(),'prod');assert.equal(await settings.locator('[data-kind="job"] [name="environment"] option').count(),1);
    await settings.locator('[data-close="settings-dialog"]').click();await panel.locator('#report-collect').click();await panel.waitForFunction(()=>document.getElementById('report-feedback').textContent.includes('采集完成'));
    assert.equal((await entries()).length,1);assert.match(await panel.locator('#report-list').innerText(),/订单超时修复/);await panel.locator('.report-work-evidence > summary').click();assert.match(await panel.locator('#report-list').innerText(),/发布完成 #42/);assert.match(await panel.locator('#report-list').innerText(),/MR !9/);assert.match(await panel.locator('#report-list').innerText(),/其他同事/);assert.match(await panel.locator('#report-list').innerText(),/补齐超时重试与回归/);
    await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/MR !9/);assert.match(await panel.locator('#report-day-content').inputValue(),/17:59/);await panel.locator('#report-preview-dialog [data-close]').click();
    await panel.locator('#report-collect').click();await panel.waitForFunction(()=>!document.getElementById('report-collect').disabled);assert.equal((await entries()).length,1);
    for(const width of [860,1060]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,850),width);assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));await panel.screenshot({path:path.join(out,`work-reports-releases-${width}.png`),fullPage:true});}
    await policy();assert.deepEqual(errors,[]);console.log('PASS: production-only source settings, automatic deployment evidence, MR commits by all authors, release-time daily preview, deduplication and hidden 860/1060px layout');return;
  }
  if(process.env.WHALE_REPORT_DATES_ONLY==='1'){
    const days=panel.locator('#report-recent-days button'),pick=date=>panel.locator(`#report-recent-days button[data-date="${date}"]`);
    const setToday=async date=>{
      await panel.evaluate(date=>{Date.now=()=>Date.parse(date+'T00:30:00+08:00');document.getElementById('report-date').value=date;document.getElementById('report-date').dispatchEvent(new Event('change'));},date);
      await panel.waitForFunction(date=>document.querySelector('#report-recent-days button:last-child')?.dataset.date===date,date);
      assert.equal(await days.count(),7);assert.equal(await days.last().locator('span').first().innerText(),'今天');assert.equal(await days.nth(5).locator('span').first().innerText(),'昨天');
      const expected=Array.from({length:7},(_,index)=>new Date(Date.parse(date+'T12:00:00Z')-(6-index)*86400000).toISOString().slice(0,10));
      assert.deepEqual(await days.evaluateAll(nodes=>nodes.map(node=>node.dataset.date)),expected);
      assert.equal(await panel.locator('#report-recent-days [aria-pressed="true"]').count(),1);
    };
    await setToday('2026-10-26');
    for(const [date,title] of [['2026-10-26','今天的工作'],['2026-10-25','昨天的工作'],['2026-10-20','第七天的工作'],['2026-10-19','更早的历史']]){
      const result=await panel.evaluate(value=>window.whale.reports('save-entry',value),{date,title,status:'done',project:'日期切换',included:true});assert.equal(result.error,undefined);
    }
    const expectDay=async(date,title)=>{await panel.waitForFunction(({date,title})=>document.getElementById('report-date').value===date&&document.getElementById('report-list').textContent.includes(title),{date,title});assert.equal(await pick(date).getAttribute('aria-pressed'),'true');};
    await pick('2026-10-25').click();await expectDay('2026-10-25','昨天的工作');
    await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/昨天的工作/);assert.doesNotMatch(await panel.locator('#report-day-content').inputValue(),/今天的工作/);await panel.locator('#report-preview-dialog [data-close]').click();
    await panel.locator('#report-add').click();assert.equal(await panel.locator('#report-entry-form [name="date"]').inputValue(),'2026-10-25');await panel.locator('#report-entry-dialog [data-close]').click();
    await pick('2026-10-20').click();await expectDay('2026-10-20','第七天的工作');
    await panel.locator('#report-date').fill('2026-10-19');await panel.locator('#report-date').dispatchEvent('change');await panel.waitForFunction(()=>document.getElementById('report-list').textContent.includes('更早的历史'));assert.equal(await panel.locator('#report-recent-days [aria-pressed="true"]').count(),0);
    // 同一轮中快速切换，不允许较早的请求覆盖最终选中的日期。
    await panel.evaluate(()=>{for(const date of ['2026-10-26','2026-10-25'])document.querySelector(`#report-recent-days [data-date="${date}"]`).click();});await expectDay('2026-10-25','昨天的工作');
    await pick('2026-10-26').press('Enter');await expectDay('2026-10-26','今天的工作');
    for(const width of [860,1060]){
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,850),width);
      assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));assert.ok(await panel.locator('#report-recent-days').evaluate(el=>el.scrollWidth<=el.clientWidth));
      await panel.screenshot({path:path.join(out,`work-reports-dates-${width}.png`),fullPage:true});
    }
    await setToday('2027-01-01');assert.equal(await days.nth(5).getAttribute('data-date'),'2026-12-31');
    await setToday('2024-03-01');assert.equal(await days.nth(5).getAttribute('data-date'),'2024-02-29');
    // 页面刷新时随上海日期滚动，但保留当前查看的历史日期。
    await panel.evaluate(()=>{Date.now=()=>Date.parse('2024-03-02T00:01:00+08:00');document.getElementById('report-date').dispatchEvent(new Event('change'));});
    await panel.waitForFunction(()=>document.querySelector('#report-recent-days button:last-child')?.dataset.date==='2024-03-02');assert.equal(await days.count(),7);assert.equal(await pick('2024-03-01').getAttribute('aria-pressed'),'true');
    await policy();assert.deepEqual(errors,[]);console.log('PASS: seven Shanghai calendar dates, today/yesterday, date selection, preview/new-entry linkage, older history, rapid switching, keyboard, year/leap-day/midnight rollover and hidden 860/1060px layout');return;
  }
  if(process.env.WHALE_REPORT_GITLAB_ONLY==='1'){
    const settings=panel.locator('#report-settings-form'),open=()=>panel.locator('#report-open-settings').click();
    const tree=()=>panel.locator('#report-gitlab-projects'),project=id=>tree().locator('[data-project-id="'+id+'"]'),group=path=>tree().locator('input[data-group-path="'+path+'"]');
    const tab=name=>panel.locator('#report-settings-tab-'+name).click();
    const footer=async()=>{const layout=await panel.evaluate(()=>{const dialog=document.getElementById('report-settings-dialog'),body=document.getElementById('report-settings-body'),button=document.querySelector('#report-settings-form [type="submit"]'),r=button.getBoundingClientRect(),d=dialog.getBoundingClientRect();return {inside:r.top>=d.top&&r.bottom<=d.bottom&&r.bottom<=innerHeight,bodyOverflow:getComputedStyle(body).overflowY,dialogScroll:dialog.scrollHeight>dialog.clientHeight+1};});assert.equal(layout.inside,true);assert.equal(layout.bodyOverflow,'auto');assert.equal(layout.dialogScroll,false);assert.equal(await settings.locator('[type="submit"]').innerText(),'确定并保存');};
    const waitTree=()=>panel.waitForFunction(()=>!document.getElementById('report-gitlab-connect').disabled&&document.getElementById('report-gitlab-error').hidden&&document.querySelectorAll('#report-gitlab-projects [data-project-id]').length===206);
    await open();await footer();assert.equal(await panel.locator('#report-local-source, #report-add-repo').count(),0);assert.doesNotMatch(await panel.locator('#report-settings-panel-sources').innerText(),/本地 Git 仓库/);assert.equal(await panel.locator('#report-settings-tab-sources').getAttribute('aria-selected'),'true');await panel.locator('#report-gitlab-url').fill('https://gitlab.example.test/gitlab');await panel.locator('#report-gitlab-token').fill('fixture-gitlab-secret');await panel.locator('#report-gitlab-connect').click();await waitTree();
    assert.match(await panel.locator('#report-gitlab-status').innerText(),/已连接：cy/);assert.equal(await panel.locator('#report-gitlab-token').inputValue(),'');assert.equal(await panel.locator('#report-gitlab-authors').inputValue(),'cy@example.test');
    assert.equal(await panel.locator('#report-gitlab-connection').getAttribute('open'),null);assert.equal(await panel.locator('#report-gitlab-selection').getAttribute('open'),null);
    assert.equal(await panel.locator('#report-gitlab-projects').evaluate(el=>getComputedStyle(el).overflowY),'visible');
    await footer();
    // 自动读取两页分组、多页仓库，子组按真实路径嵌套，不重复列出。
    assert.equal(await tree().locator('details[data-group-path="business"] details[data-group-path="business/platform"] [data-project-id="24"]').count(),1);
    assert.equal(await group('empty').isDisabled(),true);await group('bulk').click();assert.match(await panel.locator('#report-gitlab-error').innerText(),/200/);
    assert.match(await panel.locator('#report-gitlab-selected-heading').innerText(),/0 \/ 200/);assert.equal(await project(1000).isChecked(),false);
    await project(21).check();assert.match(await panel.locator('#report-settings-state').innerText(),/已选 1 个 GitLab 仓库.*未保存/);await footer();assert.equal(await group('business').evaluate(el=>el.indeterminate),true);
    assert.equal(await tree().locator('details[data-group-path="business"]').getAttribute('open'),'');
    await group('business').check();assert.match(await panel.locator('#report-gitlab-selected-heading').innerText(),/4 \/ 200/);assert.equal(await project(23).isChecked(),true);assert.equal(await group('business/platform').isChecked(),true);
    await project(22).uncheck();assert.equal(await group('business').evaluate(el=>el.indeterminate),true);
    await group('business').click();await group('business').uncheck();assert.match(await panel.locator('#report-gitlab-selected-heading').innerText(),/0 \/ 200/);
    await project(21).check();await project(23).check();await project(25).check();
    await panel.locator('#report-gitlab-search').fill('platform');assert.equal(await project(21).count(),0);assert.equal(await project(24).count(),1);
    await panel.locator('#report-gitlab-search').fill('no-matching-repository');assert.match(await tree().innerText(),/没有匹配/);
    await panel.locator('#report-gitlab-search').fill('');assert.equal(await project(21).isChecked(),true);assert.equal(await project(25).isChecked(),true);
    await panel.locator('#report-gitlab-collapse').click();assert.equal(await tree().locator('details[open]').count(),0);await panel.locator('#report-gitlab-expand').click();
    assert.match(await panel.locator('#report-gitlab-selected-heading').innerText(),/3 \/ 200/);
    await settings.locator('[data-close="settings-dialog"]').click();await open();await waitTree();assert.match(await panel.locator('#report-gitlab-selected-heading').innerText(),/0 \/ 200/);
    assert.match(await panel.locator('#report-gitlab-token').getAttribute('placeholder'),/已保存/);
    await panel.locator('#report-gitlab-connect').click();await waitTree();
    assert.equal(await panel.locator('#report-gitlab-token').inputValue(),'');await project(21).check();await group('business/platform').check();assert.match(await panel.locator('#report-gitlab-selected-heading').innerText(),/2 \/ 200/);
    // 切换页签保留草稿，隐藏页签的无效字段可以自动定位，保存入口始终可见。
    await tab('automation');await settings.locator('[name="intervalMinutes"]').fill('25');await footer();
    await panel.locator('#report-settings-tab-automation').press('ArrowRight');assert.equal(await panel.locator('#report-settings-tab-archive').getAttribute('aria-selected'),'true');await footer();
    await tab('template');const template=await settings.locator('[name="weeklyTemplate"]').inputValue();await settings.locator('[name="weeklyTemplate"]').fill('');await tab('sources');
    await settings.locator('[type="submit"]').click();assert.equal(await panel.locator('#report-settings-tab-template').getAttribute('aria-selected'),'true');assert.match(await panel.locator('#report-settings-error').innerText(),/Markdown/);
    await settings.locator('[name="weeklyTemplate"]').fill(template);await tab('sources');assert.equal(await project(21).isChecked(),true);assert.equal(await project(24).isChecked(),true);
    // 折叠区内的必填项同样会自动展开定位。
    await panel.locator('#report-jenkins-source > summary').click();await panel.locator('#report-add-job').click();await panel.locator('#report-jenkins-source > summary').click();await tab('archive');await settings.locator('[type="submit"]').click();
    assert.equal(await panel.locator('#report-settings-tab-sources').getAttribute('aria-selected'),'true');assert.equal(await panel.locator('#report-jenkins-source').getAttribute('open'),'');
    await settings.locator('[data-kind="job"] .ui-danger-action').click();await footer();
    // 刷新失败时不清空完整旧树和已选项，重试恢复。
    await app.evaluate(()=>{global.reportGitlabProjectFailure=true;});await panel.locator('#report-gitlab-connect').click();await panel.waitForFunction(()=>!document.getElementById('report-gitlab-connect').disabled&&!document.getElementById('report-gitlab-error').hidden);
    assert.equal(await project(21).isChecked(),true);assert.equal(await project(24).isChecked(),true);assert.match(await panel.locator('#report-gitlab-tree-note').innerText(),/保留/);
    await app.evaluate(()=>{global.reportGitlabProjectFailure=false;});await panel.locator('#report-gitlab-connect').click();await waitTree();
    await settings.locator('[type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('report-settings-dialog').open);
    await panel.locator('#report-collect').click();await panel.waitForFunction(()=>document.getElementById('report-feedback').textContent.includes('采集完成'));
    const imported=await entries();assert.equal(imported.length,2);assert.deepEqual(imported.map(e=>e.project).sort(),['business/orders','business/platform/api']);
    await panel.locator('#report-collect').click();await panel.waitForFunction(()=>!document.getElementById('report-collect').disabled);assert.equal((await entries()).length,2);
    assert.ok((await app.evaluate(()=>global.reportRequests)).filter(r=>r.url.includes('/repository/commits')).every(r=>/projects\/(21|24)\//.test(r.url)));
    const snapshot=(await panel.evaluate(()=>window.whale.reports('snapshot',{date:'2026-10-26'}))).value;assert.doesNotMatch(JSON.stringify(snapshot),/fixture-gitlab-secret/);assert.equal(snapshot.settings.intervalMinutes,25);
    assert.equal(fs.readFileSync(path.join(dir,'report-gitlab.enc')).includes('fixture-gitlab-secret'),false);assert.doesNotMatch(fs.readFileSync(path.join(dir,'work-reports.json'),'utf8'),/fixture-gitlab-secret/);
    await open();await waitTree();assert.equal(await panel.locator('#report-gitlab-author-mode').inputValue(),'email');
    await panel.locator('#report-gitlab-filters > summary').click();await panel.locator('#report-gitlab-author-mode').selectOption('name');
    assert.equal(await panel.locator('#report-gitlab-authors').isDisabled(),true);assert.equal(await panel.locator('#report-gitlab-name-field').isVisible(),true);assert.equal(await panel.locator('#report-gitlab-author-names').inputValue(),'cy');
    await panel.locator('#report-gitlab-author-names').fill('CY, 旧作者');await panel.locator('#report-gitlab-author-mode').selectOption('email');assert.equal(await panel.locator('#report-gitlab-authors').inputValue(),'cy@example.test');
    await panel.locator('#report-gitlab-author-mode').selectOption('name');assert.equal(await panel.locator('#report-gitlab-author-names').inputValue(),'CY, 旧作者');
    await panel.locator('#report-gitlab-author-names').fill('');await panel.locator('#report-gitlab-filters > summary').click();await tab('automation');await settings.locator('[type="submit"]').click();
    assert.equal(await panel.locator('#report-settings-tab-sources').getAttribute('aria-selected'),'true');assert.equal(await panel.locator('#report-gitlab-filters').getAttribute('open'),'');assert.match(await panel.locator('#report-settings-error').innerText(),/作者名/);
    await panel.locator('#report-gitlab-author-names').fill('CY, 旧作者');await settings.locator('[type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('report-settings-dialog').open);
    await panel.locator('#report-collect').click();await panel.waitForFunction(()=>!document.getElementById('report-collect').disabled);assert.equal((await entries()).length,4);assert.ok((await entries()).some(e=>e.sourceMeta.email==='invalid-email-value'));assert.ok((await entries()).every(e=>e.sourceMeta.author!=='CY-other'));
    await panel.locator('#report-collect').click();await panel.waitForFunction(()=>!document.getElementById('report-collect').disabled);assert.equal((await entries()).length,4);
    await open();await waitTree();assert.equal(await panel.locator('#report-gitlab-author-mode').inputValue(),'name');assert.equal(await panel.locator('#report-gitlab-author-names').inputValue(),'cy,旧作者');
    assert.match(await panel.locator('#report-settings-state').innerText(),/配置未修改/);await panel.locator('#report-gitlab-connection > summary').click();await panel.locator('#report-gitlab-token').fill('bad-token');await panel.locator('#report-gitlab-connect').click();await panel.waitForFunction(()=>!document.getElementById('report-gitlab-error').hidden);
    assert.match(await panel.locator('#report-gitlab-error').innerText(),/认证|权限/);assert.equal(await panel.locator('#report-gitlab-token').inputValue(),'');
    await panel.locator('#report-gitlab-connect').click();await waitTree();
    await tree().locator('details[data-group-path="bulk"] > summary').click();
    for(const width of [860,1060]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,850),width);
      await panel.locator('#report-settings-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});await footer();await panel.locator('#report-settings-body').evaluate(el=>{el.scrollTop=0;});await footer();assert.ok(await panel.locator('#report-settings-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));await panel.screenshot({path:path.join(out,`work-reports-gitlab-${width}.png`)});}
    await panel.locator('#report-gitlab-filters > summary').click();await panel.locator('#report-gitlab-author-mode').scrollIntoViewIfNeeded();await footer();await panel.screenshot({path:path.join(out,'work-reports-author-filter.png')});
    await settings.locator('[data-close="settings-dialog"]').click();await policy();await assert.rejects(pet.evaluate(()=>window.whale.reports('gitlab-groups')),/仅允许/);
    await app.close();app=null;await launch();await open();assert.match(await panel.locator('#report-gitlab-selected-heading').innerText(),/2 \/ 200/);assert.match(await panel.locator('#report-gitlab-status').innerText(),/已连接：cy/);assert.equal(await panel.locator('#report-gitlab-token').inputValue(),'');
    await waitTree();assert.equal(await panel.locator('#report-gitlab-author-mode').inputValue(),'name');assert.equal(await panel.locator('#report-gitlab-author-names').inputValue(),'cy,旧作者');assert.equal((await entries()).length,4);assert.equal(await project(21).isChecked(),true);assert.equal(await group('business/platform').isChecked(),true);
    await policy();assert.deepEqual(errors,[]);console.log('PASS: GitLab auto-loaded nested tree, automatic pagination, group/partial/project selection, filtering, collapse/expand, atomic selection limit, refresh failure, cancel/save, selected-only remote collection and deduplication, failed token preserves connection, encrypted credentials, fixed visible save/cancel footer, dirty state, tabs/keyboard, author name/email switching, legacy email mistakes, hidden-field validation, restart, IPC guards and hidden 860/1060px UI');return;
  }
  if(process.env.WHALE_REPORT_STATUS_ONLY==='1'){
    const title='APP应用类型新增';
    const saved=await panel.evaluate(title=>window.whale.planner('save-task',{title,notes:'应用类型调整',deadline:'none',category:'work',status:'pending'}),title);
    assert.equal(saved.error,undefined);const task=saved.value.tasks.at(-1),refresh=()=>panel.locator('#report-date').dispatchEvent('change');
    const setStatus=async status=>{const result=await panel.evaluate(({id,status})=>window.whale.planner('set-task-status',{id,status}),{id:task.id,status});assert.equal(result.error,undefined);await refresh();};
    const waitForCards=count=>panel.waitForFunction(count=>document.querySelectorAll('#report-list .report-work-card').length===count,count,{timeout:7000});
    assert.equal((await entries()).length,0);await waitForCards(0);
    await setStatus('done');await waitForCards(1);
    assert.match(await panel.locator('#report-list .report-work-badge').innerText(),/已完成/);
    const entryId=(await entries())[0].id;
    await setStatus('pending');await waitForCards(0);
    assert.equal((await entries())[0].sourceActive,false);
    assert.match(await panel.locator('#report-day-summary').innerText(),/^0 项工作/);
    assert.equal(await panel.getByRole('heading',{name:'这一天还没有工作记录',exact:true}).count(),1);
    await panel.locator('#report-preview-day').click();assert.doesNotMatch(await panel.locator('#report-day-content').inputValue(),/APP应用类型新增/);
    await panel.locator('#report-preview-dialog [data-close]').click();
    const history=await panel.evaluate(()=>window.whale.planner('history',{date:'2026-10-26'}));assert.equal(history.value.items.length,1);
    await setStatus('processing');await waitForCards(0);
    await setStatus('done');await waitForCards(1);assert.equal((await entries()).length,1);assert.equal((await entries())[0].id,entryId);
    await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/APP应用类型新增/);
    await panel.locator('#report-preview-dialog [data-close]').click();
    for(const width of [860,1060]){
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,850),width);
      assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));
      await panel.screenshot({path:path.join(out,`work-reports-status-${width}.png`),fullPage:true});
    }
    await setStatus('pending');await waitForCards(0);await policy();
    await app.close();app=null;await launch();await waitForCards(0);
    assert.equal((await entries())[0].sourceActive,false);
    await panel.screenshot({path:path.join(out,'work-reports-withdrawn.png'),fullPage:true});
    await policy();assert.deepEqual(errors,[]);
    console.log('PASS: pending/processing work omitted, completed work included, withdrawal removes the daily card and preview, completion history retained, recompletion deduplicated, restart and hidden 860/1060px UI');
    return;
  }
  await panel.evaluate(async()=>{for(const category of ['work','personal']){const result=await window.whale.planner('save-task',{title:category==='work'?'完成支付回归':'个人购物',notes:'日程完成情况',deadline:'none',category});await window.whale.planner('toggle-task',{id:result.value.tasks.at(-1).id,completed:true});}});
  await panel.locator('#report-add').click();const form=panel.locator('#report-entry-form');
  await form.locator('[name="title"]').fill('处理告警与支持');await form.locator('[name="project"]').fill('业务保障');await form.locator('[name="details"]').fill('排查告警，验证恢复 <img src=x onerror=alert(1)>');
  await form.locator('[type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('report-entry-dialog').open);
  assert.equal((await entries()).length,2);assert.equal(await panel.locator('#report-list img').count(),0);
  await panel.evaluate(()=>window.whale.reports('settings',{gitlabProjects:[{host:'https://gitlab.example.test',projectId:21,project:'business/orders',path:'business/orders'}],gitlabAuthors:'cy@example.test'}));
  await panel.locator('#report-open-settings').click();const settings=panel.locator('#report-settings-form');
  await panel.locator('#report-jenkins-source > summary').click();await panel.locator('#report-add-job').click();const job=settings.locator('[data-kind="job"]');
  for(const [name,value] of Object.entries({project:'business/orders',job:'prod/orders',target:'EKS',userIds:'cy'}))await job.locator(`[name="${name}"]`).fill(value);
  await panel.locator('#report-settings-tab-template').click();await settings.locator('[name="weeklyTemplate"]').fill('# 周报 {{week_start}} ～ {{week_end}}\n\n## 工作成果\n{{summary}}\n\n## 发版\n{{releases}}\n\n## 下周\n{{next_week}}');
  await settings.locator('[type="submit"]').click();await panel.waitForFunction(()=>!document.getElementById('report-settings-dialog').open);
  await panel.locator('#report-collect').click();await panel.waitForFunction(()=>document.getElementById('report-feedback').textContent.includes('采集完成'));
  assert.equal((await entries()).length,3);await panel.locator('#report-collect').click();await panel.waitForFunction(()=>!document.getElementById('report-collect').disabled);assert.equal((await entries()).length,3);
  assert.ok((await app.evaluate(()=>global.reportRequests)).every(request=>request.method==='GET'&&request.redirect==='error'));
  for(const width of [860,1060]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,850),width);
    assert.ok(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth));await panel.screenshot({path:path.join(out,`work-reports-daily-${width}.png`),fullPage:true});}
  await panel.locator('#report-preview-day').click();assert.match(await panel.locator('#report-day-content').inputValue(),/订单超时修复/);await panel.locator('#report-archive-day').click();await panel.waitForFunction(()=>!document.getElementById('report-preview-dialog').open);
  assert.match(fs.readFileSync(path.join(vault,'日报/2026-10-26.md'),'utf8'),/处理告警/);
  await panel.locator('#report-weekly-tab').click();await panel.locator('#report-week-date').fill('2026-10-26');await panel.locator('#report-week-date').dispatchEvent('change');
  await panel.locator('#report-generate').click();await panel.waitForFunction(()=>document.getElementById('report-week-content').value.includes('工作成果'));
  assert.doesNotMatch(await panel.locator('#report-week-content').inputValue(),/个人购物/);await panel.locator('#report-archive-week').click();await panel.waitForFunction(()=>document.getElementById('report-feedback').textContent.includes('周报已归档'));
  const weekly=path.join(vault,'周报/2026-10-26.md');fs.appendFileSync(weekly,'\n额外手写备注\n');
  await panel.locator('#report-week-content').fill('# 人工整理的周报\n\n交付支付修复并完成上线验证。');await panel.locator('#report-save-week').click();await panel.waitForFunction(()=>document.getElementById('report-feedback').textContent.includes('草稿已保存'));
  await panel.locator('#report-archive-week').click();await panel.waitForFunction(()=>document.getElementById('report-feedback').textContent.includes('周报已归档'));assert.match(fs.readFileSync(weekly,'utf8'),/额外手写备注/);
  await panel.screenshot({path:path.join(out,'work-reports-weekly.png'),fullPage:true});
  fs.writeFileSync(weekly,fs.readFileSync(weekly,'utf8').replace('上线验证','Obsidian 中的新修改'));
  await panel.locator('#report-archive-week').click();await panel.waitForFunction(()=>document.getElementById('report-error').textContent.includes('手动修改'));assert.match(fs.readFileSync(weekly,'utf8'),/Obsidian 中的新修改/);
  await assert.rejects(pet.evaluate(()=>window.whale.reports('snapshot')),/仅允许/);
  await panel.locator('#reports-module-toggle').click();await panel.waitForFunction(()=>document.getElementById('reports-module-toggle').getAttribute('aria-checked')==='false');
  assert.match((await panel.evaluate(()=>window.whale.reports('collect'))).error,/已关闭/);assert.equal(await panel.locator('#reports-module-content').evaluate(el=>el.inert),true);
  await panel.locator('#reports-module-toggle').click();await panel.waitForFunction(()=>document.getElementById('reports-module-toggle').getAttribute('aria-checked')==='true');await policy();
  await app.close();app=null;await launch();assert.equal((await entries()).length,3);assert.match((await panel.evaluate(()=>window.whale.reports('get-week',{date:'2026-10-26'}))).value.content,/人工整理/);
  await panel.locator('#report-open-settings').click();await panel.locator('#report-settings-tab-archive').click();assert.equal(await panel.locator('#report-settings-form [name="archiveDir"]').inputValue(),vault);
  await panel.screenshot({path:path.join(out,'work-reports-settings.png')});await policy();assert.deepEqual(errors,[]);
  console.log('PASS: manual work, planner linkage, simulated Jenkins, source deduplication, custom week template, day/week archive, handwritten preservation/conflicts, restart, IPC and module guards, hidden 860/1060px UI');
}finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
