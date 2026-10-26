'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {readArcheryConfig,createArcheryMcp,pendingPage,approvalResult}=require('../src/channels/archery-mcp.cjs');
const {createArcheryPending,INTERVAL_MS}=require('../src/channels/archery-pending.cjs');
const tick=()=>new Promise(setImmediate);
function response(page=1,{items=[{order_id:566,order_type:'work_order',title:'工单',submitter:'测试人员'}],more=false,total=items.length}={}) {
  return {structuredContent:{status:'success',data:{items,pagination:{page,page_size:20,total:null,source_total:total,has_more:more,next_page:more?page+1:null,scope:'source_page_filtered'}}}};
}
function fixture(t,options={}) {
  let config={fingerprint:'account-a',baseUrl:'https://archery.example.com',canApprove:true},request=async page=>response(page),now=1000,confirm=async()=>false,approval=async id=>approved(id);
  const jobs=new Set(),calls=[],opened=[],clients=[],confirmations=[],approvalCalls=[];
  const clock={now:()=>now,setTimeout:(fn,ms)=>{const job={fn,ms};jobs.add(job);return job;},clearTimeout:job=>jobs.delete(job)};
  const receiver=createArcheryPending({clock,readConfig:()=>{if(config instanceof Error)throw config;return config;},
    createClient:()=>{const client={closed:0,close(){this.closed++;},pending(page,options){calls.push({page,...options});return request(page,options);},approve(id,options){approvalCalls.push({id,...options});return approval(id,options);}};clients.push(client);return client;},
    openExternal:async url=>opened.push(url),confirmApproval:async item=>{confirmations.push(item);return confirm(item);},settingsFile:options.settingsFile});
  t.after(()=>receiver.close());
  return {receiver,jobs,calls,opened,clients,confirmations,approvalCalls,setConfirm:fn=>confirm=fn,setApproval:fn=>approval=fn,setNow:value=>now=value,setConfig:value=>config=value,setRequest:fn=>request=fn,
    async fire(){assert.equal(jobs.size,1);const job=[...jobs][0];assert.equal(job.ms,INTERVAL_MS);jobs.delete(job);now+=job.ms;job.fn();await tick();}};
}

test('module pause aborts reads without changing auto refresh and late responses cannot repopulate items',async t=>{
  const f=fixture(t);let release;f.setRequest(()=>new Promise(resolve=>release=resolve));
  const pending=f.receiver.action('refresh');await tick();f.receiver.setModuleEnabled(false);
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.receiver.snapshot().enabled,true);
  f.receiver.setModuleEnabled(true);release(response());await pending;assert.equal(f.receiver.snapshot().items.length,0);
  f.receiver.setModuleEnabled(false);assert.equal(f.jobs.size,0);await assert.rejects(f.receiver.action('refresh'),/已关闭/);
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

test('only displayed real order IDs open same-origin detail links; arbitrary tools and URLs are rejected',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');await f.receiver.action('open',566);
  assert.deepEqual(f.opened,['https://archery.example.com/detail/566/']);
  for(const id of [567,'https://evil.example.com','566',true])await assert.rejects(f.receiver.action('open',id),/当前待审核列表/);
  for(const name of ['work_order_execute','work_order_approve','call-tool'])await assert.rejects(f.receiver.action(name,566),/不支持/);
  f.setConfig({fingerprint:'other',baseUrl:'https://other.example.com'});await assert.rejects(f.receiver.action('open',566),/配置已变化/);
  assert.equal(f.receiver.snapshot().items.length,0);assert.equal(f.opened.length,1);
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

test('opening after global config is removed clears old account rows and reports an unsynchronized state',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  const error=new Error('全局 Archery MCP 已停用');error.archeryConfig=true;f.setConfig(error);
  await assert.rejects(f.receiver.action('open',566),/停用/);
  assert.equal(f.receiver.snapshot().items.length,0);assert.equal(f.receiver.snapshot().state,'error');
  assert.equal(f.opened.length,0);
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

test('official MCP client connects over real stdio and calls only pending_list with bounded page size',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-archery-wire-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const trace=path.join(dir,'trace.jsonl'),client=createArcheryMcp({server:{command:process.execPath,args:[path.join(__dirname,'fixtures/archery-mcp.cjs')],env:{TRACE_FILE:trace}},startupMs:3000,timeoutMs:3000});
  try {const result=pendingPage(await client.pending(2),2);assert.equal(result.items[0].id,566);await client.pending(1);}
  finally {await client.close();}
  const requests=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r=>r.method==='initialize').length,1);
  assert.deepEqual(requests.filter(r=>r.method==='tools/call').map(r=>r.params),[
    {name:'work_order_pending_list',arguments:{page:2,page_size:20}},{name:'work_order_pending_list',arguments:{page:1,page_size:20}}]);
});

function approved(id,status='success') {
  return {structuredContent:{status,data:{succeeded:status==='success'?[id]:[],failed:[],unknown:[],remaining:[],
    results:status==='success'?[{order_id:id,status:'success',message:'passed'}]:[]}}};
}

test('approval cancellation never calls MCP and each successful approval confirms exactly one displayed ID',async t=>{
  const f=fixture(t);await f.receiver.action('refresh');
  await f.receiver.action('approve',566);assert.equal(f.confirmations.length,1);assert.equal(f.approvalCalls.length,0);
  assert.match(f.receiver.snapshot().notice,/已取消/);
  f.setConfirm(async()=>true);await f.receiver.action('approve',566);
  assert.deepEqual(f.approvalCalls.map(call=>call.id),[566]);assert.equal(f.confirmations.length,2);
  assert.equal(f.confirmations[1].title,'工单');assert.equal(f.receiver.snapshot().items.length,0);
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
  for(const id of [567,'566',[566],true])await assert.rejects(f.receiver.action('approve',id),/当前待审核列表/);
  f.setNow(301001);await assert.rejects(f.receiver.action('approve',566),/审批不可用/);
  f.setConfig({fingerprint:'restricted',canApprove:false,baseUrl:'https://archery.example.com'});
  await f.receiver.action('refresh');await assert.rejects(f.receiver.action('approve',566),/审批不可用/);
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
