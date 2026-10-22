'use strict';
const {startLocalAgent}=require('./local-agent.cjs');
const {startDesktopAgent,isDesktopCheckpoint}=require('./codex-desktop.cjs');
const {AgentError}=require('./agent-error.cjs');
function trackDesktop(options) {
  const {retryDelayMs=1000,reconnectTimeoutMs=30000,timeoutMs=600000}=options;
  const deadline=Date.now()+timeoutMs;
  let handle,checkpoint=options.checkpoint,recovering=Boolean(options.recovering),retryDeadline=0,retryTimer,reconnectTimer,done=false;
  let resolveResult,rejectResult;
  const promise=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  function finish(error,result){if(done)return;done=true;clearTimeout(retryTimer);clearTimeout(reconnectTimer);error?rejectResult(error):resolveResult(result);}
  function beginReconnect() {
    if(retryDeadline)return;
    retryDeadline=Math.min(deadline,Date.now()+reconnectTimeoutMs);
    // 重连的总期限独立于单次 RPC；连接成功但桌面一直不响应也必须结束等待。
    reconnectTimer=setTimeout(()=>{finish(new AgentError('RECOVERY_UNKNOWN','desktop'));handle?.detach();},Math.max(1,retryDeadline-Date.now()));
    reconnectTimer.unref?.();
  }
  function failed(error) {
    if(done)return;
    // 仅对连接故障恢复监听；提交标记一旦落盘，所有后续连接都禁止 start-turn。
    if(isDesktopCheckpoint(checkpoint)&&['DELIVERY_UNKNOWN','DESKTOP_UNAVAILABLE'].includes(error.code)) {
      beginReconnect();
      const remaining=retryDeadline-Date.now();
      if(remaining>0){
        recovering=true;
        try{options.onRecovering?.();}catch{finish(new AgentError('TRACKING_STORE','desktop'));return;}
        retryTimer=setTimeout(attempt,Math.min(retryDelayMs,remaining));return;
      }
      finish(new AgentError('RECOVERY_UNKNOWN','desktop'));return;
    }
    finish(error);
  }
  function attempt() {
    if(done)return;retryTimer=null;
    if(recovering)beginReconnect();
    handle=startDesktopAgent({...options,recovering,checkpoint,timeoutMs:Math.max(1,deadline-Date.now()),onCheckpoint:value=>{
      // 持久化成功后才更新内存检查点；落盘失败时停止跟踪，不能凭未保存的关联继续恢复。
      options.onCheckpoint?.(value);checkpoint=value;
      if(value.turnId){retryDeadline=0;clearTimeout(reconnectTimer);}
    }});
    void handle.promise.then(result=>finish(null,result),failed);
  }
  attempt();
  return {promise,
    cancel(){if(done)return;if(retryTimer){finish(new AgentError('CANCELLED','desktop'));return;}handle.cancel();},
    detach(){if(done)return;finish(new AgentError('DELIVERY_UNKNOWN','desktop'));handle?.detach();}
  };
}
function startWechatAgent(options) {
  // 已选桌面对话交给原 owner；CLI 新建会话继续使用本地执行路径，不自动切换接管方式。
  return options.settings.backend==='codex'&&options.session&&options.transport!=='local'
    ?trackDesktop(options):options.recovering?{promise:Promise.reject(new AgentError('RECOVERY_UNKNOWN','desktop')),cancel(){}}:startLocalAgent(options);
}
module.exports={startWechatAgent};
