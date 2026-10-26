'use strict';
const fs=require('node:fs');
const {readArcheryConfig,createArcheryMcp,pendingPage,approvalResult}=require('./archery-mcp.cjs');
const INTERVAL_MS=5*60*1000;

// 轮询属于主进程，关闭或切换页面不会停止；工单摘要只在内存保留。
function createArcheryPending({readConfig=readArcheryConfig,createClient=createArcheryMcp,openExternal,confirmApproval=async()=>false,
  clock={now:()=>Date.now(),setTimeout,clearTimeout},intervalMs=INTERVAL_MS,settingsFile}={}) {
  let closed=false,timer,flight=null,controller,client=null,config=null,page=1,enabled=true;
  let moduleEnabled=true,moduleGeneration=0,approving=false;
  let items=[],hasMore=false,sourceTotal=null,lastChecked=null,state='idle',error='',notice='';
  try {
    const saved=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
    if(typeof saved.enabled==='boolean')enabled=saved.enabled;
  } catch {} // 首次使用或配置损坏时默认开启，不覆盖原文件。
  const approvals=new Map();
  const approvalKey=id=>`${config?.accountKey||config?.fingerprint}:${id}`;
  const eligible=()=>Boolean(moduleEnabled&&config?.canApprove&&client&&state==='connected'&&lastChecked!==null&&clock.now()-lastChecked<5*60*1000);
  function snapshot(){return {state,error,notice,enabled,canApprove:eligible(),busy:Boolean(flight),page,
    items:items.map(item=>({...item,approvalStatus:approvals.get(approvalKey(item.id))||''})),hasMore,sourceTotal,lastChecked,intervalMs};}
  function clearTimer(){clock.clearTimeout(timer);timer=null;}
  function dropClient(){const old=client;client=null;if(old)void Promise.resolve().then(()=>old.close()).catch(()=>{});}
  // 防重记录按服务器与账号隔离，切换密码/工具配置不解除该账号的未知结果限制。
  function clearItems(){items=[];hasMore=false;sourceTotal=null;lastChecked=null;notice='';}
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
    if(flight)return flight;
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
        const result=pendingPage(await client.pending(target,{signal}),target);
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
        state='error';error=cause.archeryConfig?cause.message:'读取待审核工单失败，请检查网络、Archery 账号及 MCP 服务；稍后会自动重试。';
      }
    }).finally(()=>{flight=null;controller=null;schedule();}).then(()=>snapshot());
    return flight;
  }
  function approve(id) {
    if(flight)throw new Error('正在处理 Archery 请求，请稍后审核。');
    currentConfig();
    const item=items.find(item=>item.id===id);
    if(!Number.isSafeInteger(id)||!item)throw new Error('请从当前待审核列表选择工单。');
    const key=approvalKey(id);
    if(approvals.has(key))throw new Error('此工单已处理或结果待核实，请打开工单查看。');
    if(!eligible())throw new Error('审批不可用，请先刷新列表，并确认全局配置开放审核工具。');
    clearTimer();controller=new AbortController();notice='';approving=true;
    // 即使关闭后立即重开，也不能沿用关闭前尚未提交的审核确认。
    const generation=moduleGeneration;
    flight=Promise.resolve().then(async()=>{
      let sent=false;
      try {
        if(closed||!moduleEnabled||generation!==moduleGeneration)return;
        // 确认在主进程进行，渲染页面不能跳过逐笔确认直接调用 MCP。
        const confirmed=await confirmApproval({...item});
        if(closed)return;
        if(!moduleEnabled||generation!==moduleGeneration){notice='模块已关闭，本次审核已取消。';return;}
        if(confirmed!==true){notice=`已取消审核工单 #${id}。`;return;}
        currentConfig();
        if(!eligible())throw new Error('列表已过期，请刷新后重新确认审核。');
        sent=true;
        const result=approvalResult(await client.approve(id,{signal:controller.signal}),id);
        if(closed)return;
        currentConfig();
        approvals.set(key,result);
        if(result==='success') {
          items=items.filter(item=>item.id!==id);
          notice=`工单 #${id} 已审核通过，未请求执行 SQL。`;
        }else {
          dropClient();
          notice=result==='failed'?`工单 #${id} 审批未完成，未自动重试，请刷新后核实。`:
            `工单 #${id} 审批结果未知，未自动重试，请打开工单核实；本次运行不再重复审批此编号。`;
        }
      }catch {
        if(closed)return;
        if(sent) {
          // 请求发出后的异常可能已在服务器生效，绝不能自动重发。
          approvals.set(key,'unknown');
          dropClient();notice=`工单 #${id} 审批结果未知，未自动重试，请打开工单核实；本次运行不再重复审批此编号。`;
        }else notice=error||'无法确认审核，请刷新列表后重试。';
      }
    }).finally(()=>{approving=false;flight=null;controller=null;schedule();}).then(()=>snapshot());
    return flight;
  }
  async function action(name,value) {
    if(closed)throw new Error('Archery 接入已关闭。');
    if(name==='snapshot')return snapshot();
    if(!moduleEnabled)throw Error('Archery 已关闭，请先开启');
    if(name==='refresh')return refresh();
    if(name==='set-enabled')return setEnabled(value);
    if(name==='approve')return approve(value);
    if(name==='page') {
      if(flight)throw new Error('正在刷新，请稍后翻页。');
      if(!Number.isSafeInteger(value)||value<1||!(value===page-1||(value===page+1&&hasMore)))throw new Error('请使用上一页或下一页按钮。');
      return refresh(value);
    }
    if(name==='open') {
      const current=currentConfig();
      if(!Number.isSafeInteger(value)||!items.some(item=>item.id===value))throw new Error('请从当前待审核列表选择工单。');
      // 链接由全局配置的同源地址与已展示编号生成，不信任服务端提供的任意 URL。
      await openExternal(new URL(`/detail/${value}/`,current.baseUrl).href);
      return snapshot();
    }
    throw new Error('不支持的 Archery 操作。');
  }
  return {snapshot,action,setModuleEnabled(value){
    if(moduleEnabled===value)return;moduleEnabled=value;moduleGeneration++;
    if(!value){
      clearTimer();
      // 已发出的审核必须接收结果并保留防重记录，不能靠切换模块解除未知结果限制。
      if(!approving){controller?.abort();if(state==='checking')state=lastChecked===null?'idle':'connected';}
    }else if(enabled&&!flight)void refresh();
  },start(){if(!closed&&moduleEnabled&&!flight&&enabled)void refresh();},close(){closed=true;clearTimer();controller?.abort();dropClient();clearItems();approvals.clear();config=null;}};
}
module.exports={createArcheryPending,INTERVAL_MS};
