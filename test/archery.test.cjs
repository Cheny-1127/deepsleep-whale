'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {readArcheryConfig,createArcheryMcp,pendingPage,approvalResult,orderDetail}=require('../src/channels/archery-mcp.cjs');
const {createArcheryPending,INTERVAL_MS}=require('../src/channels/archery-pending.cjs');
const tick=()=>new Promise(setImmediate);
function response(page=1,{items=[{order_id:566,order_type:'work_order',title:'工单',submitter:'测试人员'}],more=false,total=items.length}={}) {
  return {structuredContent:{status:'success',data:{items:items.map(item=>({status:'workflow_manreviewing',...item})),pagination:{page,page_size:20,total:null,source_total:total,has_more:more,next_page:more?page+1:null,scope:'source_page_filtered'}}}};
}
function fixture(t,options={}) {
  let config={fingerprint:'account-a',baseUrl:'https://archery.example.com',canApprove:true,canDetail:true,canList:false,canExecute:true},request=async page=>response(page),now=1000,confirm=async()=>false,approval=async id=>approved(id),detail=async id=>detailResponse(id),largeConfirm=async()=>false;
  const jobs=new Set(),calls=[],clients=[],confirmations=[],approvalCalls=[],executionCalls=[],detailCalls=[],largeConfirmations=[];
  const clock={now:()=>now,setTimeout:(fn,ms)=>{const job={fn,ms};jobs.add(job);return job;},clearTimeout:job=>jobs.delete(job)};
  const receiver=createArcheryPending({clock,readConfig:()=>{if(config instanceof Error)throw config;return config;},
    createClient:()=>{const client={closed:0,close(){this.closed++;},pending(page,options){calls.push({page,...options});return request(page,options);},execute(id,options){executionCalls.push({id,...options});return approval(id,options);},approve(id,options){approvalCalls.push({id,...options});return approval(id,options);},detail(id,options){detailCalls.push({id,...options});return detail(id,options);}};clients.push(client);return client;},
    confirmLargeDetail:async item=>{largeConfirmations.push(item);return largeConfirm(item);},
    confirmApproval:async item=>{confirmations.push(item);return confirm(item);},settingsFile:options.settingsFile});
  t.after(()=>receiver.close());
  return {enableExecution(){config={...config,accountKey:config.accountKey||config.fingerprint,fingerprint:config.fingerprint+'-list',canList:true};},receiver,jobs,calls,clients,confirmations,approvalCalls,executionCalls,detailCalls,largeConfirmations,setDetail:fn=>detail=fn,setLargeConfirm:fn=>largeConfirm=fn,setConfirm:fn=>confirm=fn,setApproval:fn=>approval=fn,setNow:value=>now=value,setConfig:value=>config=value,setRequest:fn=>request=fn,
    async fire(){assert.equal(jobs.size,1);const job=[...jobs][0];assert.equal(job.ms,INTERVAL_MS);jobs.delete(job);now+=job.ms;job.fn();await tick();}};
}

test('module pause aborts reads without changing auto refresh and late responses cannot repopulate items',async t=>{
  const f=fixture(t);let release;f.setRequest(()=>new Promise(resolve=>release=resolve));
  const pending=f.receiver.action('refresh');await tick();f.receiver.setModuleEnabled(false);
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.receiver.snapshot().enabled,true);
  f.receiver.setModuleEnabled(true);release(response());await pending;assert.equal(f.receiver.snapshot().items.length,0);
  f.receiver.setModuleEnabled(false);assert.equal(f.jobs.size,0);await assert.rejects(f.receiver.action('refresh'),/已关闭/);
});

function detailResponse(id=566){return {structuredContent:{status:'success',data:{workflow_id:id,workflow:{id,is_offline_export:0,workflow_name:'测试工单',engineer_display:'测试人员',db_name:'fixture',status:'workflow_manreviewing'},sql_content:'SELECT 1;',review_content:'审核通过',execute_result:'',password:'private-secret'}}};}

test('detail returns only whitelisted content for the exact work order and handles large-result consent',()=>{
  const value=orderDetail(detailResponse(),566);assert.equal(value.sql,'SELECT 1;');assert.equal(value.review,undefined);
  assert.doesNotMatch(JSON.stringify(value),/private-secret|password/);
  for(const change of [r=>r.structuredContent.data.workflow.id=567,r=>r.structuredContent.data.workflow.is_offline_export=1,
    r=>r.structuredContent.status='auth_failed']){const raw=detailResponse();change(raw);assert.throws(()=>orderDetail(raw,566));}
  const large={structuredContent:{status:'needs_confirmation',data:{order_id:566,order_type:'work_order',response_bytes:40000}}};
  assert.equal(orderDetail(large,566).needsConfirmation,true);assert.throws(()=>orderDetail(large,567));
});

test('detail reads only a displayed ID through the existing account session; summaries never include SQL',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');const value=await f.receiver.action('detail',566);
  assert.equal(value.sql,'SELECT 1;');assert.equal(f.clients.length,1);assert.deepEqual(f.detailCalls.map(c=>[c.id,c.allowLarge]),[[566,false]]);
  assert.doesNotMatch(JSON.stringify(f.receiver.snapshot()),/SELECT 1|审核通过/);
  for(const id of [567,'566',true])await assert.rejects(f.receiver.action('detail',id),/当前待处理列表/);
  f.setConfig({fingerprint:'blocked',canDetail:false});await f.receiver.action('refresh');
  await assert.rejects(f.receiver.action('detail',566),/详情不可用/);assert.equal(f.detailCalls.length,1);
});

test('cached details survive refresh and page changes; status updates do not reread SQL',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');await f.receiver.action('detail',566);
  f.setRequest(async page=>response(page,{items:[{order_id:566,order_type:'work_order',status:'workflow_review_pass'}]}));
  await f.receiver.action('refresh');const value=await f.receiver.action('detail',566);
  assert.equal(value.sql,'SELECT 1;');assert.equal(value.status,'workflow_review_pass');assert.equal(value.cached,true);assert.equal(f.detailCalls.length,1);
  f.setRequest(async page=>response(page,{items:[{order_id:566,order_type:'work_order'}],more:page===1}));
  await f.receiver.action('refresh');await f.receiver.action('page',2);await f.receiver.action('page',1);await f.receiver.action('detail',566);
  assert.equal(f.detailCalls.length,1);
  f.setDetail(async()=>{const value=detailResponse();value.structuredContent.data.sql_content='SELECT 2;';return value;});
  assert.equal((await f.receiver.action('detail-refresh',566)).sql,'SELECT 2;');assert.equal(f.detailCalls.length,2);
});

test('detail is serialized with approvals and discards late responses after account changes or module pause',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let release;
  f.setDetail(()=>new Promise(resolve=>release=resolve));const pending=f.receiver.action('detail',566);await tick();
  await assert.rejects(f.receiver.action('approve',566),/正在处理/);
  f.setConfig({fingerprint:'other',canDetail:true});release(detailResponse());await assert.rejects(pending,/配置已变化/);
  assert.equal(f.receiver.snapshot().items.length,0);
  await f.receiver.action('refresh');const paused=f.receiver.action('detail',566);await tick();
  f.receiver.setModuleEnabled(false);f.receiver.setModuleEnabled(true);release(detailResponse());
  await assert.rejects(paused,/已取消/);
});

test('large detail requires a prior size signal and explicit confirmation; cancellation never requests full content',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  await assert.rejects(f.receiver.action('detail-large',566),/先读取/);
  f.setDetail(async(id,{allowLarge})=>allowLarge?detailResponse(id):{structuredContent:{status:'needs_confirmation',data:{order_id:id,order_type:'work_order',response_bytes:40000}}});
  assert.equal((await f.receiver.action('detail',566)).needsConfirmation,true);
  assert.equal((await f.receiver.action('detail-large',566)).cancelled,true);assert.equal(f.detailCalls.length,1);
  f.setLargeConfirm(async()=>true);assert.equal((await f.receiver.action('detail-large',566)).sql,'SELECT 1;');
  assert.deepEqual(f.detailCalls.map(c=>c.allowLarge),[false,true]);assert.equal(f.largeConfirmations.length,2);
  assert.equal(f.approvalCalls.length,0);
});
test('module toggle cancels an old confirmation and preserves unknown submitted approvals',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let confirm;f.setConfirm(()=>new Promise(resolve=>confirm=resolve));
  const pending=f.receiver.action('approve',566);await tick();f.receiver.setModuleEnabled(false);f.receiver.setModuleEnabled(true);confirm(true);await pending;
  assert.equal(f.approvalCalls.length,0,'旧确认不能在重新开启后提交');
  f.setConfirm(async()=>true);f.setApproval(async()=>{throw Error('unknown');});await f.receiver.action('approve',566);
  f.receiver.setModuleEnabled(false);f.receiver.setModuleEnabled(true);await tick();
  await assert.rejects(f.receiver.action('approve',566),/待核实/);assert.equal(f.approvalCalls.length,1,'模块开关不能解除审核防重');
});
test('module pause lets a submitted approval settle and retains its unknown-result guard',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');f.setConfirm(async()=>true);let reject;
  f.setApproval(()=>new Promise((_,fail)=>reject=fail));const pending=f.receiver.action('approve',566);await tick();
  f.receiver.setModuleEnabled(false);assert.equal(f.approvalCalls[0].signal.aborted,false,'已发送的审核继续核实结果');
  reject(Error('disconnected'));await pending;assert.equal(f.jobs.size,0);
  f.receiver.setModuleEnabled(true);await tick();await assert.rejects(f.receiver.action('approve',566),/待核实/);assert.equal(f.approvalCalls.length,1);
});

test('startup reads once, background polling runs every five minutes and snapshots never trigger network',async t=>{
  const f=fixture(t);f.receiver.start();await tick();assert.equal(f.calls.length,1);assert.equal(INTERVAL_MS,300000);
  assert.equal((await f.receiver.action('snapshot')).items.length,1);assert.equal(f.calls.length,1);
  await f.fire();assert.equal(f.calls.length,2);assert.equal(f.receiver.snapshot().lastChecked,1000+INTERVAL_MS);
  assert.equal(f.clients.length,1,'successful polling reuses the MCP session');
});

test('manual refresh and timer cannot overlap and closing aborts and discards late results',async t=>{
  const f=fixture(t);let resolve;f.setRequest(()=>new Promise(done=>resolve=done));
  const first=f.receiver.action('refresh');await tick();const second=f.receiver.action('refresh');
  assert.equal(f.calls.length,1);assert.equal(f.receiver.snapshot().busy,true);
  f.receiver.close();assert.equal(f.calls[0].signal.aborted,true);resolve(response());await Promise.all([first,second]);
  assert.equal(f.receiver.snapshot().items.length,0);assert.equal(f.jobs.size,0);await tick();assert.equal(f.clients[0].closed,1);
});

test('quitting immediately after startup never creates a late MCP child process',async t=>{
  const f=fixture(t);f.receiver.start();f.receiver.close();await tick();
  assert.equal(f.clients.length,0);assert.equal(f.calls.length,0);assert.equal(f.jobs.size,0);
});

test('empty filtered pages can have a next page; only explicit pagination reads another source page',async t=>{
  const f=fixture(t);f.setRequest(async page=>response(page,{items:page===1?[]:[{order_id:9,order_type:'work_order'}],more:page===1,total:30}));
  await f.receiver.action('refresh');assert.equal(f.calls.length,1);assert.equal(f.receiver.snapshot().hasMore,true);
  assert.equal(f.receiver.snapshot().sourceTotal,30);await f.receiver.action('page',2);
  assert.equal(f.receiver.snapshot().page,2);assert.equal(f.receiver.snapshot().items[0].id,9);
  await f.fire();assert.equal(f.calls.at(-1).page,2,'timer refreshes the displayed page');
  await assert.rejects(f.receiver.action('page',3),/上一页/);await assert.rejects(f.receiver.action('page',999),/上一页/);
  await f.receiver.action('page',1);assert.equal(f.receiver.snapshot().page,1);
});

test('network and MCP failures preserve the same account page and last successful time without exposing errors',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');const before=f.receiver.snapshot();
  f.setRequest(async()=>{throw new Error('password=fixture-secret sql=private');});await f.fire();
  const after=f.receiver.snapshot();assert.deepEqual(after.items,before.items);assert.equal(after.lastChecked,before.lastChecked);
  assert.equal(after.state,'error');assert.ok(!JSON.stringify(after).includes('fixture-secret'));assert.equal(f.jobs.size,1);
  f.setRequest(async()=>({isError:true,content:[{type:'text',text:'private server error'}]}));await f.fire();
  assert.ok(!JSON.stringify(f.receiver.snapshot()).includes('private server error'));assert.equal(f.receiver.snapshot().items.length,1);
});

test('changed accounts and disabled config clear old summaries; late old-account results are discarded',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  f.setConfig({fingerprint:'account-b',baseUrl:'https://other.example.com'});
  f.setRequest(async()=>{throw new Error('offline');});await f.fire();
  assert.equal(f.receiver.snapshot().items.length,0);assert.equal(f.receiver.snapshot().lastChecked,null);
  let resolve;f.setRequest(()=>new Promise(done=>resolve=done));const job=f.receiver.action('refresh');await tick();
  f.setConfig({fingerprint:'account-c',baseUrl:'https://third.example.com'});resolve(response());await job;
  assert.equal(f.receiver.snapshot().items.length,0);
  const error=new Error('全局 Archery MCP 已停用');error.archeryConfig=true;f.setConfig(error);await f.fire();
  assert.match(f.receiver.snapshot().error,/停用/);
});

test('removed browser action and arbitrary tools or URLs are rejected without MCP mutations',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  for(const value of [566,567,'https://evil.example.com','566',true])await assert.rejects(f.receiver.action('open',value),/不支持/);
  for(const name of ['work_order_execute','work_order_approve','call-tool'])await assert.rejects(f.receiver.action(name,566),/不支持/);
  assert.equal(f.detailCalls.length,0);assert.equal(f.approvalCalls.length,0);
  f.setConfig({fingerprint:'other',baseUrl:'https://other.example.com'});await assert.rejects(f.receiver.action('detail',566),/配置已变化/);
  assert.equal(f.receiver.snapshot().items.length,0);
});

test('MCP summaries omit SQL, audit IDs and credentials and reject malformed or unsuccessful pagination',()=>{
  const raw=response(1,{items:[{order_id:566,order_type:'work_order',title:'<img src=x>',sql_content:'private-sql',audit_id:99,password:'private-password'}]});
  const result=pendingPage(raw,1);assert.equal(result.items[0].id,566);assert.ok(!JSON.stringify(result).includes('private'));
  const text={content:[{type:'text',text:JSON.stringify(raw.structuredContent)}]};assert.deepEqual(pendingPage(text,1),result);
  for(const mutate of [r=>r.isError=true,r=>r.structuredContent.status='needs_confirmation',r=>r.structuredContent.data.pagination.total=1,
    r=>r.structuredContent.data.pagination.page=2,r=>r.structuredContent.data.items[0].order_type='export_order',r=>r.structuredContent.data.items[0].order_id=true]) {
    const copy=structuredClone(raw);mutate(copy);assert.throws(()=>pendingPage(copy,1));
  }
});

test('reading detail after global config is removed clears old account rows and reports an unsynchronized state',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  const error=new Error('全局 Archery MCP 已停用');error.archeryConfig=true;f.setConfig(error);
  await assert.rejects(f.receiver.action('detail',566),/停用/);
  assert.equal(f.receiver.snapshot().items.length,0);assert.equal(f.receiver.snapshot().state,'error');
});

test('global config loads stdio credentials privately and validates disabled tools, endpoint and executable form',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-archery-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.toml');
  const write=(header='',url='https://archery.example.com')=>fs.writeFileSync(file,`[mcp_servers.archery]\ncommand = ${JSON.stringify(process.execPath)}\n${header}\nenv_vars = ["ARCHERY_PASSWORD"]\n[mcp_servers.archery.env]\nARCHERY_BASE_URL = ${JSON.stringify(url)}\nARCHERY_USERNAME = "fixture-owner"\n`);
  write();const config=readArcheryConfig({home:dir,env:{ARCHERY_PASSWORD:'fixture-secret'}});
  assert.equal(config.server.env.ARCHERY_PASSWORD,'fixture-secret');assert.equal(config.baseUrl,'https://archery.example.com');assert.equal(config.canApprove,true);
  write('disabled_tools = ["work_order_approve"]');const restricted=readArcheryConfig({home:dir,env:{ARCHERY_PASSWORD:'fixture-secret'}});
  assert.equal(restricted.canApprove,false);assert.notEqual(restricted.fingerprint,config.fingerprint);
  assert.notEqual(readArcheryConfig({home:dir,env:{ARCHERY_PASSWORD:'changed'}}).fingerprint,config.fingerprint);
  for(const header of ['enabled = false','disabled_tools = ["work_order_pending_list"]','enabled_tools = ["work_order_execute"]','args = [1]']) {
    write(header);assert.throws(()=>readArcheryConfig({home:dir}),error=>error.archeryConfig&&!error.message.includes('fixture-secret'));
  }
  write('','file:///etc/passwd');assert.throws(()=>readArcheryConfig({home:dir}));
  fs.writeFileSync(file,'[mcp_servers]\n');assert.throws(()=>readArcheryConfig({home:dir}),/尚未配置/);
  fs.writeFileSync(file,'broken = [');assert.throws(()=>readArcheryConfig({home:dir}),/无法读取/);
});

test('official MCP client reuses stdio for fixed list and detail tools with bounded page size',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-archery-wire-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const trace=path.join(dir,'trace.jsonl'),configFile=path.join(dir,'config.toml');
  fs.writeFileSync(configFile,`[mcp_servers.archery]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(path.join(__dirname,'fixtures/archery-mcp.cjs'))}]\n[mcp_servers.archery.env]\nTRACE_FILE=${JSON.stringify(trace)}\n`);
  // 从全局启动配置到真实 stdio 握手，不提供任何 ARCHERY_* 变量，服务仍可自行处理读取。
  const client=createArcheryMcp({...readArcheryConfig({configFile,env:{}}),startupMs:3000,timeoutMs:3000});
  try {const result=pendingPage(await client.pending(2),2);assert.equal(result.items[0].id,566);await client.pending(1);
    assert.equal(orderDetail(await client.detail(566),566).sql,'SELECT 1;');}
  finally {await client.close();}
  const requests=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r=>r.method==='initialize').length,1);
  assert.deepEqual(requests.filter(r=>r.method==='tools/call').map(r=>r.params),[
    {name:'work_order_pending_list',arguments:{page:2,page_size:20}},{name:'work_order_pending_list',arguments:{page:1,page_size:20}},
    {name:'work_order_detail',arguments:{order_id:566,allow_large:false}}]);
});

test('installed MCP keeps its own dotenv credentials; account metadata and configuration changes stay isolated',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-installed-archery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(dir,'pyvenv.cfg'),'home = /fixture/python\n');
  const command=path.join(bin,'archery-mcp'),configFile=path.join(dir,'config.toml'),dotenv=path.join(dir,'.env');
  fs.writeFileSync(configFile,`[mcp_servers.archery]\ncommand=${JSON.stringify(command)}\n`);
  const write=(user='owner',password='private-${literal}')=>fs.writeFileSync(dotenv,`ARCHERY_BASE_URL="https://fixture.example.com/base"\nARCHERY_USERNAME='${user}'\nARCHERY_PASSWORD='${password}'\n`);
  write();const first=readArcheryConfig({configFile,env:{}});
  assert.deepEqual(first.server.env,{},'不复制 MCP 自己的密码到桌宠启动配置');
  assert.equal(first.baseUrl,'https://fixture.example.com');assert.doesNotMatch(JSON.stringify(first),/private-|literal/);
  write('owner','changed');const password=readArcheryConfig({configFile,env:{}});
  assert.notEqual(password.fingerprint,first.fingerprint);assert.equal(password.accountKey,first.accountKey,'改密码不能解除未知审批防重');
  write('another');assert.notEqual(readArcheryConfig({configFile,env:{}}).accountKey,first.accountKey);
  fs.appendFileSync(configFile,'[mcp_servers.archery.env]\nARCHERY_BASE_URL="https://override.example.com"\nARCHERY_USERNAME="override"\n');
  assert.equal(readArcheryConfig({configFile,env:{}}).baseUrl,'https://override.example.com');
  fs.unlinkSync(dotenv);assert.equal(readArcheryConfig({configFile,env:{}}).baseUrl,'https://override.example.com');
});

test('unknown launchers can read pending orders without a guessed external link',async t=>{
  const f=fixture(t);f.setConfig({fingerprint:'wrapper',baseUrl:'',canApprove:true,canDetail:true});
  await f.receiver.action('refresh');assert.equal(f.receiver.snapshot().state,'connected');
  assert.equal(f.receiver.snapshot().canDetail,true);
  await assert.rejects(f.receiver.action('open',566),/不支持/);
});

function approved(id,status='success') {
  return {structuredContent:{status,data:{succeeded:status==='success'?[id]:[],failed:[],unknown:[],remaining:[],
    results:status==='success'?[{order_id:id,status:'success',message:'passed'}]:[]}}};
}

test('the requesting panel confirmation runs under the approval lock and cannot use another default confirmation',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let release,shown;
  const waiting=f.receiver.action('approve',566,item=>{shown=item;return new Promise(resolve=>release=resolve);});await tick();
  assert.equal(shown.id,566);assert.equal(f.confirmations.length,0);assert.equal(f.approvalCalls.length,0);
  assert.equal(f.receiver.snapshot().busy,true);await assert.rejects(f.receiver.action('approve',566),/正在处理/);
  release(true);await waiting;assert.deepEqual(f.approvalCalls.map(call=>call.id),[566]);assert.equal(f.receiver.snapshot().busy,false);
});
test('approval preview uses existing cached details and only reads uncached details on request under the same lock',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let preview;
  await f.receiver.action('approve',566,async(item,context)=>{
    preview=context;assert.equal(context.cachedDetail,null);assert.equal(f.detailCalls.length,0);
    await assert.rejects(f.receiver.action('detail',566),/正在处理/);
    const value=await context.loadDetail(false);assert.equal(value.sql,'SELECT 1;');assert.equal(f.receiver.snapshot().busy,true);
    assert.equal(f.approvalCalls.length,0);return false;
  });
  await assert.rejects(preview.loadDetail(false),/已结束/);assert.equal(f.detailCalls.length,1);
  await f.receiver.action('approve',566,async(item,context)=>{
    assert.equal(context.cachedDetail.sql,'SELECT 1;');assert.equal(context.cachedDetail.cached,true);return false;
  });
  assert.equal(f.detailCalls.length,1);assert.equal(f.approvalCalls.length,0);
});
test('cancelled approval aborts its preview and cannot cache or approve a late detail response',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let context,cancel,release;
  f.setDetail(()=>new Promise(resolve=>release=resolve));
  const waiting=f.receiver.action('approve',566,(_item,preview)=>{context=preview;return new Promise(resolve=>cancel=resolve);});await tick();
  const reading=context.loadDetail(false),rejected=assert.rejects(reading,/取消/);await tick();
  cancel(false);await tick();assert.equal(f.detailCalls[0].signal.aborted,true);assert.equal(f.receiver.snapshot().busy,true);
  release(detailResponse());await rejected;await waiting;assert.equal(f.approvalCalls.length,0);
  await f.receiver.action('approve',566,async(_item,preview)=>{assert.equal(preview.cachedDetail,null);return false;});
});
test('approval preview retains large-content consent and never requests full content after cancellation',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  f.setDetail(async(id,{allowLarge})=>allowLarge?detailResponse(id):{structuredContent:{status:'needs_confirmation',data:{order_id:id,order_type:'work_order',response_bytes:40000}}});
  await f.receiver.action('approve',566,async(_item,preview)=>{
    await assert.rejects(preview.loadDetail(true),/请先读取/);
    assert.equal((await preview.loadDetail(false)).needsConfirmation,true);
    assert.equal((await preview.loadDetail(true)).cancelled,true);assert.equal(f.detailCalls.length,1);
    f.setLargeConfirm(async()=>true);assert.equal((await preview.loadDetail(true)).sql,'SELECT 1;');return false;
  });
  assert.deepEqual(f.detailCalls.map(call=>call.allowLarge),[false,true]);assert.equal(f.approvalCalls.length,0);
});
test('changing accounts during approval preview clears the old list and prevents detail access or approval',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  await f.receiver.action('approve',566,async(_item,preview)=>{
    f.setConfig({fingerprint:'another',canDetail:true,canApprove:true});
    await assert.rejects(preview.loadDetail(false),/配置已变化/);return true;
  });
  assert.equal(f.detailCalls.length,0);assert.equal(f.approvalCalls.length,0);assert.equal(f.receiver.snapshot().items.length,0);
});

test('approval cancellation never calls MCP and each successful approval confirms exactly one displayed ID',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  await f.receiver.action('approve',566);assert.equal(f.confirmations.length,1);assert.equal(f.approvalCalls.length,0);
  assert.match(f.receiver.snapshot().notice,/已取消/);
  f.setConfirm(async()=>true);await f.receiver.action('approve',566);
  assert.deepEqual(f.approvalCalls.map(call=>call.id),[566]);assert.equal(f.confirmations.length,2);
  assert.equal(f.confirmations[1].title,'工单');assert.equal(f.receiver.snapshot().items.length,1);
  assert.match(f.receiver.snapshot().notice,/#566 已审核通过.*未请求执行 SQL/);
  await f.receiver.action('refresh');await assert.rejects(f.receiver.action('approve',566),/已处理/);
  assert.equal(f.approvalCalls.length,1,'stale upstream rows cannot repeat a successful approval');
});

test('confirmation holds the request lock and cancellation releases it without refresh or approval overlap',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let confirm;
  f.setConfirm(()=>new Promise(resolve=>confirm=resolve));const task=f.receiver.action('approve',566);await tick();
  assert.equal(f.jobs.size,0);assert.equal(f.receiver.snapshot().busy,true);
  await assert.rejects(f.receiver.action('approve',566),/正在处理/);
  await assert.rejects(f.receiver.action('page',2),/正在刷新/);
  const refreshed=f.receiver.action('refresh');assert.equal(f.calls.length,1);
  confirm(false);await Promise.all([task,refreshed]);assert.equal(f.approvalCalls.length,0);assert.equal(f.jobs.size,1);
});

test('unlisted IDs, stale lists and disabled approval tools cannot show confirmation or issue approvals',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');f.setConfirm(async()=>true);
  for(const id of [567,'566',[566],true])await assert.rejects(f.receiver.action('approve',id),/当前待处理列表/);
  f.setNow(301001);await assert.rejects(f.receiver.action('approve',566),/审核不可用/);
  f.setConfig({fingerprint:'restricted',canApprove:false,baseUrl:'https://archery.example.com'});
  await f.receiver.action('refresh');await assert.rejects(f.receiver.action('approve',566),/审核不可用/);
  assert.equal(f.receiver.snapshot().canApprove,false);assert.equal(f.confirmations.length,0);assert.equal(f.approvalCalls.length,0);
});

test('account or tool-policy changes while confirming invalidate authorization before any MCP write',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let confirm;
  f.setConfirm(()=>new Promise(resolve=>confirm=resolve));const task=f.receiver.action('approve',566);await tick();
  f.setConfig({fingerprint:'account-b',canApprove:true,baseUrl:'https://other.example.com'});confirm(true);await task;
  assert.equal(f.approvalCalls.length,0);assert.equal(f.receiver.snapshot().items.length,0);assert.match(f.receiver.snapshot().error,/配置已变化/);
});

test('confirmation that outlives the fresh-list limit cannot approve even with an unchanged account',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  f.setConfirm(async()=>{f.setNow(301001);return true;});await f.receiver.action('approve',566);
  assert.equal(f.approvalCalls.length,0);assert.match(f.receiver.snapshot().notice,/刷新/);
});

test('unknown approval results never retry and remain blocked through successful background reads',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');f.setConfirm(async()=>true);
  f.setApproval(async()=>{throw new Error('private password, timeout');});await f.receiver.action('approve',566);
  assert.match(f.receiver.snapshot().notice,/结果未知/);assert.ok(!f.receiver.snapshot().notice.includes('private'));
  assert.equal(f.receiver.snapshot().items[0].approvalStatus,'unknown');
  await f.fire();await f.receiver.action('refresh');
  assert.equal(f.approvalCalls.length,1);assert.equal(f.receiver.snapshot().items[0].approvalStatus,'unknown');
  await assert.rejects(f.receiver.action('approve',566),/待核实/);assert.equal(f.confirmations.length,1);
});

test('explicit no-action failures require a new list and another confirmation before a manual retry',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');f.setConfirm(async()=>true);
  f.setApproval(async id=>approved(id,'needs_confirmation'));await f.receiver.action('approve',566);
  assert.equal(f.receiver.snapshot().items[0].approvalStatus,'failed');assert.equal(f.approvalCalls.length,1);
  await assert.rejects(f.receiver.action('approve',566),/待核实/);
  await f.receiver.action('refresh');assert.equal(f.approvalCalls.length,1);
  f.setApproval(async id=>approved(id));await f.receiver.action('approve',566);
  assert.equal(f.confirmations.length,2);assert.equal(f.approvalCalls.length,2);
});

test('quitting during approval aborts the request and ignores late success without restarting timers',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');f.setConfirm(async()=>true);let resolve;
  f.setApproval(()=>new Promise(done=>resolve=done));const task=f.receiver.action('approve',566);await tick();
  f.receiver.close();assert.equal(f.approvalCalls[0].signal.aborted,true);resolve(approved(566));await task;
  assert.equal(f.receiver.snapshot().items.length,0);assert.equal(f.jobs.size,0);assert.equal(f.receiver.snapshot().notice,'');
});

test('approval responses require the exact requested ID and confirmed success in every result field',()=>{
  assert.equal(approvalResult(approved(566),566),'success');assert.equal(approvalResult(approved(567),566),'unknown');
  for(const mutate of [r=>r.structuredContent.data.unknown.push(566),r=>r.structuredContent.data.remaining.push(567),
    r=>r.structuredContent.data.results[0].status='result_unknown',r=>r.structuredContent.status='result_unknown',
    r=>delete r.structuredContent.data.failed]) {
    const raw=approved(566);mutate(raw);assert.equal(approvalResult(raw,566),'unknown');
  }
  assert.equal(approvalResult(approved(566,'needs_confirmation'),566),'failed');
  assert.equal(approvalResult({content:[{type:'text',text:JSON.stringify(approved(566).structuredContent)}]},566),'success');
  assert.throws(()=>approvalResult({isError:true},566));
});

test('stdio approval uses the existing listed session, exactly one ID, fixed remark and no execution tool',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-archery-approval-wire-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const trace=path.join(dir,'trace.jsonl'),client=createArcheryMcp({canApprove:true,server:{command:process.execPath,
    args:[path.join(__dirname,'fixtures/archery-mcp.cjs')],env:{TRACE_FILE:trace}},startupMs:3000,timeoutMs:3000});
  try {
    await assert.rejects(client.approve(566),/approval_unavailable/);
    await client.pending(1);assert.equal(approvalResult(await client.approve(566),566),'success');
  }finally{await client.close();}
  const requests=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r=>r.method==='initialize').length,1);
  assert.deepEqual(requests.filter(r=>r.method==='tools/call').map(r=>r.params),[
    {name:'work_order_pending_list',arguments:{page:1,page_size:20}},
    {name:'work_order_approve',arguments:{order_ids:[566],remark:'审核通过'}}]);
});

test('unknown approvals stay blocked for the same account across password/policy changes and switching away and back',async t=>{
  const f=fixture(t);const account={accountKey:'server-and-owner',fingerprint:'config-1',canApprove:true,baseUrl:'https://archery.example.com'};
  f.setConfig(account);await f.receiver.action('refresh');f.setConfirm(async()=>true);
  f.setApproval(async()=>{throw Error('timeout');});await f.receiver.action('approve',566);
  f.setConfig({...account,fingerprint:'config-2'});await f.receiver.action('refresh');
  await assert.rejects(f.receiver.action('approve',566),/待核实/);
  f.setConfig({...account,accountKey:'different-owner',fingerprint:'config-3'});await f.receiver.action('refresh');
  assert.equal(f.receiver.snapshot().items[0].approvalStatus,'');
  f.setConfig(account);await f.receiver.action('refresh');await assert.rejects(f.receiver.action('approve',566),/待核实/);
  assert.equal(f.approvalCalls.length,1);
});

test('pause stops scheduled reads until turned back on and survives restart',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archery-enabled-'));
  const settingsFile=path.join(dir,'archery.json');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture(t,{settingsFile});
  f.receiver.start();await tick();assert.equal(f.calls.length,1);assert.equal(f.jobs.size,1);
  assert.equal((await f.receiver.action('set-enabled',false)).enabled,false);
  assert.equal(f.jobs.size,0);assert.equal(JSON.parse(fs.readFileSync(settingsFile,'utf8')).enabled,false);
  await f.receiver.action('refresh');assert.equal(f.calls.length,2);assert.equal(f.jobs.size,0);
  f.receiver.close();
  const resumed=[],jobs2=new Set();
  const restarted=createArcheryPending({settingsFile,clock:{now:()=>1000,setTimeout:(fn,ms)=>{const job={fn,ms};jobs2.add(job);return job;},clearTimeout:job=>jobs2.delete(job)},
    readConfig:()=>({fingerprint:'account-a',baseUrl:'https://archery.example.com',canApprove:true}),
    createClient:()=>({close(){},pending(){resumed.push(1);return response();}})});
  t.after(()=>restarted.close());
  restarted.start();await tick();assert.equal(resumed.length,0);assert.equal(restarted.snapshot().enabled,false);
  await restarted.action('set-enabled',true);assert.equal(resumed.length,1);assert.equal(jobs2.size,1);
  assert.equal(restarted.snapshot().enabled,true);assert.equal(JSON.parse(fs.readFileSync(settingsFile,'utf8')).enabled,true);
});

test('invalid or unsaved pause keeps automatic refresh enabled',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archery-enabled-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture(t,{settingsFile:dir});
  f.receiver.start();await tick();
  await assert.rejects(f.receiver.action('set-enabled','false'),/无效/);
  await assert.rejects(f.receiver.action('set-enabled',false),/保存失败/);
  assert.equal(f.receiver.snapshot().enabled,true);assert.equal(f.jobs.size,1);
});

// 两个来源的分页契约不同，执行列表必须由服务端按已审核状态过滤，不能借审核列表猜测。
function emptyExecutionPage(page=1){const raw=executionPage(page);raw.structuredContent.data.items=[];raw.structuredContent.data.pagination.source_total=0;raw.structuredContent.data.pagination.total=0;return raw;}
function executionPage(page=1,{status='workflow_review_pass',more=false}={}){
  const raw=response(page,{items:[{order_id:566,order_type:'work_order',status}],more,total:more?42:1});
  Object.assign(raw.structuredContent.data.pagination,{scope:'matching_orders',total:more?42:1});return raw;
}
async function readyExecution(f){
  f.enableExecution();f.setRequest(async(page,{mode})=>mode==='execute'?executionPage(page):response(page));
  await f.receiver.action('refresh');
}
test('one processing page merges both sources without extra page filling and the approved status wins duplicate IDs',async t=>{
  const f=fixture(t);await readyExecution(f);
  assert.deepEqual(f.calls.map(c=>[c.page,c.mode]),[[1,'approve'],[1,'execute']]);
  assert.equal(f.receiver.snapshot().items.length,1);assert.equal(f.receiver.snapshot().items[0].status,'workflow_review_pass');
  f.setRequest(async(page,{mode})=>mode==='execute'?executionPage(page,{more:true}):response(page,{items:[{order_id:567,order_type:'work_order'}],more:false}));
  await f.receiver.action('refresh');assert.deepEqual(f.receiver.snapshot().items.map(i=>i.id),[567,566]);
  assert.equal(f.receiver.snapshot().hasMore,true);await f.receiver.action('page',2);
  assert.deepEqual(f.calls.slice(-2).map(c=>[c.page,c.mode]),[[2,'approve'],[2,'execute']]);
  assert.equal(f.executionCalls.length,0);await assert.rejects(f.receiver.action('set-mode','execute'),/不支持/);
});
test('execution requires a separate explicit confirmation and cached details remain available within it',async t=>{
  const f=fixture(t);await readyExecution(f);await f.receiver.action('detail',566);
  await f.receiver.action('execute',566);assert.equal(f.executionCalls.length,0,'默认取消执行');
  await f.receiver.action('execute',566,async(item,preview)=>{
    assert.equal(item.id,566);assert.equal(preview.operation,'execute');assert.equal(preview.cachedDetail.sql,'SELECT 1;');
    assert.equal(preview.cachedDetail.status,'workflow_review_pass');return true;
  });
  assert.deepEqual(f.executionCalls.map(c=>c.id),[566]);assert.equal(f.approvalCalls.length,0);
  assert.match(f.receiver.snapshot().notice,/执行请求已受理.*最终结果/);assert.equal(f.receiver.snapshot().items.length,0);
  await f.receiver.action('refresh');await assert.rejects(f.receiver.action('execute',566,async()=>true),/已处理/);
});
test('approval automatically verifies status in the same list without executing or rereading cached SQL',async t=>{
  const f=fixture(t);let passed=false;
  f.enableExecution();f.setRequest(async(page,{mode})=>mode==='execute'?(passed?executionPage(page):emptyExecutionPage(page)):response(page,{items:passed?[]:[{order_id:566,order_type:'work_order'}]}));
  f.setApproval(async id=>{passed=true;return approved(id);});f.setConfirm(async()=>true);
  await f.receiver.action('refresh');await f.receiver.action('detail',566);await f.receiver.action('approve',566);
  assert.equal(f.executionCalls.length,0);assert.equal(f.receiver.snapshot().items[0].status,'workflow_review_pass');
  assert.equal((await f.receiver.action('detail',566)).cached,true);assert.equal(f.detailCalls.length,1);
  await f.receiver.action('execute',566,async()=>false);assert.equal(f.executionCalls.length,0);
  await f.receiver.action('execute',566,async()=>true);assert.equal(f.executionCalls.length,1);assert.equal(f.approvalCalls.length,1);
});
test('execution rejects wrong status, unknown IDs, stale data and disabled tools before confirmation',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');let confirmations=0;const confirm=async()=>{confirmations++;return true;};
  await assert.rejects(f.receiver.action('execute',566,confirm),/状态/);await readyExecution(f);
  await assert.rejects(f.receiver.action('approve',566,confirm),/状态/);
  for(const id of [567,'566',true,[566]])await assert.rejects(f.receiver.action('execute',id,confirm),/当前待处理列表/);
  f.setNow(301001);await assert.rejects(f.receiver.action('execute',566,confirm),/执行不可用/);
  f.setConfig({fingerprint:'no-execute',canList:true,canExecute:false});await f.receiver.action('refresh');
  await assert.rejects(f.receiver.action('execute',566,confirm),/执行不可用/);
  f.setConfig({fingerprint:'no-list',canList:false,canExecute:true});f.setRequest(async page=>response(page));await f.receiver.action('refresh');
  assert.equal(f.receiver.snapshot().canExecute,false);assert.equal(f.receiver.snapshot().canListExecute,false);
  assert.equal(confirmations,0);assert.equal(f.executionCalls.length,0);
  for(const status of ['workflow_manreviewing','workflow_finish','workflow_executing','',undefined]){
    const raw=executionPage();raw.structuredContent.data.items[0].status=status;
    assert.throws(()=>pendingPage(raw,1,'execute'));
  }
});
test('unknown approval cannot be bypassed by a refreshed execution status',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');f.setConfirm(async()=>true);f.setApproval(async()=>{throw Error('timeout');});
  await f.receiver.action('approve',566);f.enableExecution();f.setRequest(async(page,{mode})=>mode==='execute'?executionPage(page):response(page));await f.receiver.action('refresh');
  await assert.rejects(f.receiver.action('execute',566,async()=>true),/待核实/);assert.equal(f.executionCalls.length,0);
});
test('execution confirmation holds the global lock and cannot survive account changes or expiry',async t=>{
  for(const change of ['account','expiry','module']){
    const f=fixture(t);await readyExecution(f);let finish;
    const task=f.receiver.action('execute',566,()=>new Promise(resolve=>finish=resolve));await tick();
    await assert.rejects(f.receiver.action('execute',566),/正在处理/);
    await assert.rejects(f.receiver.action('page',2),/正在刷新/);
    if(change==='account')f.setConfig({fingerprint:'another',canExecute:true,canList:true});
    if(change==='expiry')f.setNow(301001);
    if(change==='module'){f.receiver.setModuleEnabled(false);f.receiver.setModuleEnabled(true);}
    finish(true);await task;assert.equal(f.executionCalls.length,0,change);
  }
});
test('unknown execution is never retried by polling, module toggles or password changes for the same account',async t=>{
  const f=fixture(t);const config={fingerprint:'one',accountKey:'same-user',canApprove:true,canDetail:true,canList:true,canExecute:true};
  f.setConfig(config);await readyExecution(f);let reject;
  f.setApproval(()=>new Promise((_,fail)=>reject=fail));
  const task=f.receiver.action('execute',566,async()=>true);await tick();f.receiver.setModuleEnabled(false);
  assert.equal(f.executionCalls[0].signal.aborted,false);reject(Error('secret timeout'));await task;
  assert.match(f.receiver.snapshot().notice,/执行结果未知/);assert.doesNotMatch(f.receiver.snapshot().notice,/secret/);
  f.receiver.setModuleEnabled(true);await tick();f.setConfig({...config,fingerprint:'password-changed'});await f.receiver.action('refresh');
  assert.equal(f.receiver.snapshot().items[0].executionStatus,'unknown');
  await assert.rejects(f.receiver.action('execute',566,async()=>true),/待核实/);assert.equal(f.executionCalls.length,1);
});
test('a rejected execution needs a fresh list and new confirmation, never an automatic retry',async t=>{
  const f=fixture(t);await readyExecution(f);f.setApproval(async id=>approved(id,'needs_confirmation'));
  await f.receiver.action('execute',566,async()=>true);assert.equal(f.receiver.snapshot().items[0].executionStatus,'failed');
  await assert.rejects(f.receiver.action('execute',566,async()=>true),/待核实/);
  await f.receiver.action('refresh');assert.equal(f.executionCalls.length,1);
  f.setApproval(async id=>approved(id));await f.receiver.action('execute',566,async()=>true);assert.equal(f.executionCalls.length,2);
});
test('execution stdio uses an approved-status list and exactly one explicit ID with no implicit approval',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-archery-execute-wire-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const trace=path.join(dir,'trace.jsonl'),client=createArcheryMcp({canList:true,canExecute:true,server:{command:process.execPath,
    args:[path.join(__dirname,'fixtures/archery-mcp.cjs')],env:{TRACE_FILE:trace}},startupMs:3000,timeoutMs:3000});
  try{
    await assert.rejects(client.execute(566),/execution_unavailable/);
    assert.equal(pendingPage(await client.pending(1,{mode:'execute'}),1,'execute').items[0].id,566);
    for(const id of ['566',true,[566],-1])await assert.rejects(client.execute(id),/execution_unavailable/);
    assert.equal(approvalResult(await client.execute(566),566),'success');
  }finally{await client.close();}
  assert.deepEqual(fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.method==='tools/call').map(r=>r.params),[
    {name:'work_order_list',arguments:{page:1,page_size:20,status:'workflow_review_pass'}},
    {name:'work_order_execute',arguments:{order_ids:[566]}}
  ]);
});
test('list and execute tool policy changes invalidate the session without disclosing configuration',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-archery-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.toml');
  const read=disabled=>{fs.writeFileSync(file,`[mcp_servers.archery]\ncommand="/fixture/archery-mcp"\ndisabled_tools=["${disabled}"]\n`);return readArcheryConfig({configFile:file,env:{}});};
  const listing=read('work_order_execute');assert.equal(listing.canList,true);assert.equal(listing.canExecute,false);
  const execution=read('work_order_list');assert.equal(execution.canList,false);assert.equal(execution.canExecute,true);
  assert.notEqual(listing.fingerprint,execution.fingerprint);assert.equal(listing.accountKey,execution.accountKey);
});

test('a combined refresh publishes neither source when the other source fails',async t=>{
  const f=fixture(t);await readyExecution(f);const before=f.receiver.snapshot();
  f.setRequest(async(page,{mode})=>{
    if(mode==='execute')throw Error('private-service-error');
    return response(page,{items:[{order_id:999,order_type:'work_order'}]});
  });
  await f.receiver.action('refresh');const after=f.receiver.snapshot();
  assert.deepEqual(after.items,before.items);assert.equal(after.lastChecked,before.lastChecked);
  assert.equal(after.state,'error');assert.equal(after.canApprove,false);assert.equal(after.canExecute,false);
  assert.doesNotMatch(after.error,/private-service-error/);assert.equal(f.calls.length,4);
});
test('an unavailable execution-list tool keeps review-only reading usable without extra requests',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  assert.deepEqual(f.calls.map(c=>c.mode),['approve']);assert.equal(f.receiver.snapshot().items.length,1);
  assert.equal(f.receiver.snapshot().canApprove,true);assert.equal(f.receiver.snapshot().canExecute,false);
  assert.equal(f.receiver.snapshot().canListExecute,false);
});
test('accepted approval does not infer that a multi-stage review is complete',async t=>{
  const f=fixture(t);f.enableExecution();f.setRequest(async(page,{mode})=>mode==='execute'?emptyExecutionPage(page):response(page));
  f.setConfirm(async()=>true);await f.receiver.action('refresh');await f.receiver.action('approve',566);
  assert.equal(f.receiver.snapshot().items[0].status,'workflow_manreviewing');assert.equal(f.receiver.snapshot().items[0].approvalStatus,'success');
  await assert.rejects(f.receiver.action('execute',566,async()=>true),/状态/);assert.equal(f.executionCalls.length,0);
  assert.deepEqual(f.calls.map(c=>c.mode),['approve','execute','approve','execute']);
});
test('a failed status refresh after approval retains its known success and never retries the write',async t=>{
  const f=fixture(t);await readyExecution(f);
  // 先回到同屏的待审核状态，再模拟写入成功后的只读网络失败。
  f.setRequest(async(page,{mode})=>mode==='execute'?emptyExecutionPage(page):response(page));await f.receiver.action('refresh');
  f.setApproval(async id=>{f.setRequest(async()=>{throw Error('offline');});return approved(id);});
  await f.receiver.action('approve',566,async()=>true);
  assert.equal(f.receiver.snapshot().state,'error');assert.equal(f.receiver.snapshot().items[0].approvalStatus,'success');
  assert.equal(f.approvalCalls.length,1);assert.equal(f.executionCalls.length,0);
  await assert.rejects(f.receiver.action('approve',566,async()=>true),/已处理/);
});
