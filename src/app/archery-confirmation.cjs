'use strict';
const {randomUUID}=require('node:crypto');

// 主进程发起逐笔确认，令牌绑定原页面；界面只负责展示，不能自行指定待审核工单。
function createArcheryConfirmation({getWindow=()=>null,timeoutMs=5*60*1000}={}) {
  let pending=null;
  function cancel(){pending?.finish(false);}
  function request(sender,item) {
    if(pending||sender.isDestroyed())return Promise.resolve(false);
    return new Promise(resolve=>{
      const token=randomUUID(),window=getWindow(sender),listeners=[];
      let timer;
      const listen=(target,event)=>{if(target){target.once(event,cancel);listeners.push([target,event]);}};
      const finish=confirmed=>{
        if(pending?.token!==token)return;
        // 先消费令牌并解除监听，再唤醒审批流程，重复回复无法二次触发同一笔审核。
        pending=null;clearTimeout(timer);
        for(const [target,event] of listeners)target.removeListener(event,cancel);
        // 隐藏或停用时同步关闭应用内弹窗，旧令牌随之失效，不能在重开后继续确认。
        if(!sender.isDestroyed())try{sender.send('archery-confirmation',{token,cancelled:true});}catch{}
        resolve(confirmed);
      };
      pending={sender,token,finish};
      // 窗口不再承载原确认界面时立即取消；超时只取消，不默认同意或重新发送审批。
      for(const event of ['destroyed','render-process-gone','did-start-navigation'])listen(sender,event);
      for(const event of ['hide','close'])listen(window,event);
      timer=setTimeout(cancel,timeoutMs);timer.unref?.();
      try{sender.send('archery-confirmation',{token,item});}catch{finish(false);}
    });
  }
  function reply(sender,value) {
    if(!pending||pending.sender!==sender||pending.token!==value?.token||typeof value.confirmed!=='boolean')return false;
    pending.finish(value.confirmed);return true;
  }
  return {request,reply,cancel};
}
module.exports={createArcheryConfirmation};
