'use strict';
const fs=require('node:fs');
const {readArcheryConfig,createArcheryMcp,pendingPage,approvalResult,orderDetail}=require('./archery-mcp.cjs');
const {createArcheryCache}=require('./archery-cache.cjs');
const INTERVAL_MS=5*60*1000;

// 轮询属于主进程，关闭或切换页面不会停止；快照只返回摘要，详情由独立缓存按账号隔离。
function createArcheryPending({readConfig=readArcheryConfig,createClient=createArcheryMcp,confirmApproval=async()=>false,confirmExecution=async()=>false,
  confirmLargeDetail=async()=>false,cache=createArcheryCache(),
  clock={now:()=>Date.now(),setTimeout,clearTimeout},intervalMs=INTERVAL_MS,settingsFile}={}) {
  let closed=false,timer,flight=null,controller,client=null,config=null,page=1,enabled=true;
  let moduleEnabled=true,moduleGeneration=0,approving=false;
  let items=[],hasMore=false,sourceTotal=null,lastChecked=null,state='idle',error='',notice='';
  try {
    const saved=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
    if(typeof saved.enabled==='boolean')enabled=saved.enabled;
  } catch {} // 首次使用或配置损坏时默认开启，不覆盖原文件。
  const approvals=new Map(),largeDetails=new Map();let contentRevision=0;
  const accountKey=()=>config?.accountKey||config?.fingerprint;
  const approvalKey=(id,operation='approve')=>`${accountKey()}:${id}:${operation}`;
  const eligible=(operation='approve')=>Boolean(moduleEnabled&&(operation==='execute'?config?.canExecute&&config?.canList:config?.canApprove)&&client&&state==='connected'&&lastChecked!==null&&clock.now()-lastChecked<5*60*1000);
  function snapshot(){return {state,error,notice,enabled,canListExecute:Boolean(config?.canList),contentRevision,canDetail:Boolean(config?.canDetail&&(client&&state==='connected'||items.some(item=>cache.has(accountKey(),item.id)))),canApprove:eligible(),canExecute:eligible('execute'),busy:Boolean(flight),page,
    items:items.map(item=>({...item,approvalStatus:approvals.get(approvalKey(item.id))||'',executionStatus:approvals.get(approvalKey(item.id,'execute'))||''})),hasMore,sourceTotal,lastChecked,intervalMs};}
  function clearTimer(){clock.clearTimeout(timer);timer=null;}
  function dropClient(){const old=client;client=null;if(old)void Promise.resolve().then(()=>old.close()).catch(()=>{});}
  // 防重记录按服务器与账号隔离，切换密码/工具配置不解除该账号的未知结果限制。
  function clearItems(){items=[];hasMore=false;sourceTotal=null;lastChecked=null;notice='';largeDetails.clear();contentRevision++;}
  function currentConfig() {
    let current;
    try {current=readConfig();}
    catch(cause) {
      controller?.abort();dropClient();clearItems();config=null;page=1;state='error';
      error=cause.archeryConfig?cause.message:'无法读取全局 Archery 配置，请检查后刷新。';throw new Error(error);
    }
    if(current.fingerprint!==config?.fingerprint) {
      controller?.abort();dropClient();clearItems();config=null;page=1;state='error';
      error='全局 Archery 配置已变化，请先刷新列表。';throw new Error(error);
    }
    return current;
  }
  function schedule(){clearTimer();if(!closed&&moduleEnabled&&enabled){timer=clock.setTimeout(()=>void refresh(),intervalMs);timer.unref?.();}}
  function setEnabled(value) {
    if(closed)throw new Error('Archery 接入已关闭。');
    if(typeof value!=='boolean')throw new Error('无效的自动刷新设置');
    if(value===enabled)return snapshot();
    if(flight)throw new Error('正在刷新，请稍后修改设置');
    // 先落盘再改运行态；保存失败时开关保持原样。
    try {
      if(!settingsFile)throw new Error();
      fs.writeFileSync(settingsFile+'.tmp',JSON.stringify({enabled:value}),{mode:0o600});
      fs.renameSync(settingsFile+'.tmp',settingsFile);
    }catch {throw new Error('自动刷新设置保存失败，请重试');}
    enabled=value;
    if(!enabled){clearTimer();return snapshot();}
    return refresh();
  }
  function refresh(target=page) {
    if(closed||!moduleEnabled)return Promise.resolve(snapshot());
    if(flight)return flight.then(()=>snapshot(),()=>snapshot());
    clearTimer();state='checking';error='';controller=new AbortController();
    const signal=controller.signal;
    // 异步开始，确保 flight 已赋值，手动刷新与定时器不会并发启动两个请求。
    flight=Promise.resolve().then(async()=>{
      // 启动后立即退出时，尚未运行的微任务也不能再创建后台子进程。
      if(closed||signal.aborted)return;
      try {
        const next=readConfig();
        if(config?.fingerprint!==next.fingerprint) {
          dropClient();clearItems();page=1;target=1;config=next;
        }
        if(!client)client=createClient(config);
        // 两个来源读取同一页后一次性发布，不能把任一来源失败当成“没有待处理”。
        const review=pendingPage(await client.pending(target,{signal,mode:'approve'}),target);
        if(closed||signal.aborted)return;
        const execution=config.canList?pendingPage(await client.pending(target,{signal,mode:'execute'}),target,'execute'):null;
        // 同一工单可能恰好在读取期间完成审核，以后读取到的待执行状态优先，避免重复行。
        const merged=new Map(review.items.map(item=>[item.id,item]));
        for(const item of execution?.items||[])merged.set(item.id,item);
        // 每次最多合并两页摘要；任一来源仍有下一页就保留翻页入口，总数不当作去重后的工单数。
        const result={items:[...merged.values()].sort((a,b)=>b.id-a.id),hasMore:review.hasMore||Boolean(execution?.hasMore),
          sourceTotal:execution?review.sourceTotal+execution.sourceTotal:review.sourceTotal};
        if(closed||signal.aborted)return;
        // 请求期间更换全局账号时，不让迟到的旧账号结果重新进入页面。
        if(readConfig().fingerprint!==config.fingerprint) {
          dropClient();clearItems();config=null;page=1;
          throw new Error('config_changed');
        }
        items=result.items;hasMore=result.hasMore;sourceTotal=result.sourceTotal;page=target;
        // 明确失败的审批可在重新读取后再次由用户确认；未知结果不能靠刷新解除防重。
        for(const [id,status] of approvals)if(status==='failed')approvals.delete(id);
        lastChecked=clock.now();state='connected';
      }catch(cause) {
        if(closed||signal.aborted)return;
        dropClient();
        if(cause.archeryConfig){clearItems();config=null;page=1;}
        state='error';error=cause.archeryConfig?cause.message:'读取待处理工单失败，请检查网络、Archery 账号及 MCP 服务；稍后会自动重试。';
      }
    }).finally(()=>{flight=null;controller=null;schedule();}).then(()=>snapshot());
    return flight;
  }
  function perform(operation,id,confirm=operation==='execute'?confirmExecution:confirmApproval) {
    const executing=operation==='execute',label=executing?'执行':'审核';
    if(flight)throw new Error('正在处理 Archery 请求，请稍后操作。');
    currentConfig();
    const item=items.find(item=>item.id===id);
    if(!Number.isSafeInteger(id)||!item)throw new Error('请从当前待处理列表选择工单。');
    const key=approvalKey(id,operation);
    // 未知审核结果不能借工单状态变化绕过核实；两种动作分别记录防重。
    if(approvals.has(key)||approvals.get(approvalKey(id))==='unknown')throw new Error('此工单已处理或结果待核实，请打开工单查看。');
    if(item.status!==(executing?'workflow_review_pass':'workflow_manreviewing'))throw Error('工单状态不支持此操作，请刷新列表。');
    if(!eligible(operation))throw new Error(`${label}不可用，请先刷新列表，并确认全局配置开放对应工具。`);
    clearTimer();controller=new AbortController();notice='';approving=true;
    // 即使关闭后立即重开，也不能沿用关闭前尚未提交的审核或执行确认。
    const generation=moduleGeneration;let refreshAfterApproval=false;
    flight=Promise.resolve().then(async()=>{
      let sent=false;
      try {
        if(closed||!moduleEnabled||generation!==moduleGeneration)return;
        // 主进程在锁内发起逐笔确认，界面回复后仍须重新校验账号、权限和列表时效。
        let previewFlight=null,previewController=null,confirming=true,confirmed;
        const cached=config.canDetail?cache.get(accountKey(),id):null;
        try{
          confirmed=await confirm({...item},{operation,canDetail:config.canDetail,cachedDetail:cached?{...cached,status:item.status||cached.status}:null,
            loadDetail:async allowLarge=>{
              if(!confirming||previewFlight)throw Error('审核确认已结束或正在读取详情。');
              previewController=new AbortController();
              const signal=previewController.signal;
              // 复用详情校验与缓存，只为当前确认工单开放读取，审批锁始终保留。
              previewFlight=Promise.resolve().then(()=>detail(id,allowLarge,false,{generation,signal,active:()=>confirming}));
              try{return await previewFlight;}finally{previewFlight=null;previewController=null;}
            }});
        }finally{
          confirming=false;previewController?.abort();
          // 取消后等只读请求结束再释放锁，避免旧详情与下一笔审核交错。
          if(previewFlight)await previewFlight.catch(()=>{});
        }
        if(closed)return;
        if(!moduleEnabled||generation!==moduleGeneration){notice=`模块已关闭，本次${label}已取消。`;return;}
        if(confirmed!==true){notice=`已取消${label}工单 #${id}。`;return;}
        currentConfig();
        if(!eligible(operation))throw new Error('列表已过期，请刷新后重新确认操作。');
        sent=true;
        const result=approvalResult(await client[operation](id,{signal:controller.signal}),id);
        if(closed)return;
        currentConfig();
        approvals.set(key,result);
        if(result==='success') {
          if(executing)items=items.filter(item=>item.id!==id);
          // 审核受理不代表所有审批节点结束，自动只读核对真实状态后再显示执行按钮。
          else refreshAfterApproval=true;
          notice=executing?`工单 #${id} 执行请求已受理，最终结果以工单详情为准。`:`工单 #${id} 已审核通过，未请求执行 SQL。`;
        }else {
          dropClient();
          notice=result==='failed'?`工单 #${id} ${label}未完成，未自动重试，请刷新后核实。`:
            `工单 #${id} ${label}结果未知，未自动重试，请打开工单核实；本次运行不再重复${label}此编号。`;
        }
      }catch {
        if(closed)return;
        if(sent) {
          // 请求发出后的异常可能已在服务器生效，绝不能自动重发。
          approvals.set(key,'unknown');
          dropClient();notice=`工单 #${id} ${label}结果未知，未自动重试，请打开工单核实；本次运行不再重复${label}此编号。`;
        }else notice=error||`无法确认${label}，请刷新列表后重试。`;
      }
    }).finally(()=>{approving=false;flight=null;controller=null;schedule();}).then(()=>{
      // 写入锁释放后才核对状态，避免刷新等待自身；读取失败也不会重发已成功的审核请求。
      return refreshAfterApproval&&!closed&&moduleEnabled&&generation===moduleGeneration?refresh():snapshot();
    });
    return flight;
  }
  function detail(id,allowLarge=false,force=false,confirmation=null){
    if(flight&&!confirmation)throw Error('正在处理 Archery 请求，请稍后查看详情。');
    if(confirmation&&(!confirmation.active()||confirmation.signal.aborted||closed||!moduleEnabled||confirmation.generation!==moduleGeneration))throw Error('审核确认已取消。');
    // 命中本地缓存也必须先校验当前配置、列表编号及详情权限，不能沿用旧账号的访问资格。
    currentConfig();
    const item=items.find(item=>item.id===id);
    if(!Number.isSafeInteger(id)||!item)throw Error('请从当前待处理列表选择工单。');
    if(!config.canDetail)throw Error('详情不可用，请刷新列表并确认已开放详情工具。');
    // 缓存命中只合并当前摘要状态，翻页、刷新或重启不再重复读取完整 SQL。
    const saved=!force&&!allowLarge&&cache.get(accountKey(),id);
    if(saved)return {...saved,status:item.status||saved.status};
    if(!client||state!=='connected')throw Error('详情不可用，请刷新列表并确认已开放详情工具。');
    const key=`${config.fingerprint}:${id}`,large=largeDetails.get(key),generation=confirmation?.generation??moduleGeneration;
    if(allowLarge&&!large)throw Error('请先读取工单详情，再确认是否完整展开。');
    if(!confirmation){clearTimer();controller=new AbortController();}
    const signal=confirmation?.signal||controller.signal;
    const cancelled=()=>closed||signal.aborted||!moduleEnabled||generation!==moduleGeneration||Boolean(confirmation&&!confirmation.active());
    const reading=Promise.resolve().then(async()=>{
      try{
        if(cancelled())throw Error();
        // 大结果由主进程逐次确认，页面不能直接传 allow_large 绕过 MCP 的询问。
        if(allowLarge){
          const confirmed=await confirmLargeDetail({...item,bytes:large.bytes});
          if(cancelled())throw Error();
          currentConfig();
          if(confirmed!==true)return {id,cancelled:true};
        }
        const response=await client.detail(id,{signal,allowLarge});
        if(cancelled())throw Error();
        currentConfig();
        const result=orderDetail(response,id);
        if(result.needsConfirmation)largeDetails.set(key,{bytes:result.bytes});else{
          largeDetails.delete(key);cache.set(accountKey(),result);
          return {...(cache.get(accountKey(),id)||result),status:item.status||result.status};
        }
        return result;
      }catch{
        if(error&&state==='error')throw Error(error);
        throw Error(cancelled()?'详情读取已取消。':'读取工单详情失败，请稍后重试或刷新列表。');
      }
    });
    if(confirmation)return reading;
    flight=reading.finally(()=>{flight=null;controller=null;schedule();});
    return flight;
  }
  async function action(name,value,confirm) {
    if(closed)throw new Error('Archery 接入已关闭。');
    if(name==='snapshot')return snapshot();
    if(!moduleEnabled)throw Error('Archery 已关闭，请先开启');
    if(name==='refresh')return refresh();
    if(name==='set-enabled')return setEnabled(value);
    if(name==='approve'||name==='execute')return perform(name,value,confirm);
    if(name==='detail'||name==='detail-large'||name==='detail-refresh')return detail(value,name==='detail-large',name==='detail-refresh');
    if(name==='page') {
      if(flight)throw new Error('正在刷新，请稍后翻页。');
      if(!Number.isSafeInteger(value)||value<1||!(value===page-1||(value===page+1&&hasMore)))throw new Error('请使用上一页或下一页按钮。');
      return refresh(value);
    }
    throw new Error('不支持的 Archery 操作。');
  }
  return {snapshot,action,setModuleEnabled(value){
    if(moduleEnabled===value)return;moduleEnabled=value;moduleGeneration++;
    if(!value){
      clearTimer();
      // 已发出的审核或执行必须接收结果并保留防重记录，不能靠切换模块解除未知结果限制。
      if(!approving){controller?.abort();if(state==='checking')state=lastChecked===null?'idle':'connected';}
    }else if(enabled&&!flight)void refresh();
  },start(){if(!closed&&moduleEnabled&&!flight&&enabled)void refresh();},close(){closed=true;clearTimer();controller?.abort();dropClient();clearItems();approvals.clear();config=null;}};
}
module.exports={createArcheryPending,INTERVAL_MS};
