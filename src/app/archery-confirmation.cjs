'use strict';
const {randomUUID}=require('node:crypto');

// 主进程发起逐笔确认，令牌绑定原页面；界面只负责展示，不能自行指定工单或把审核确认改成执行。
function createArcheryConfirmation({getWindow=()=>null,timeoutMs=5*60*1000}={}) {
  let pending=null;
  function cancel(){pending?.finish(false);}
  function request(sender,item,preview={}) {
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
      pending={sender,token,finish,preview,reading:false};
      // 窗口不再承载原确认界面时立即取消；超时只取消，不默认同意或重新发送审批。
      for(const event of ['destroyed','render-process-gone','did-start-navigation'])listen(sender,event);
      for(const event of ['hide','close'])listen(window,event);
      timer=setTimeout(cancel,timeoutMs);timer.unref?.();
      // 动作来自主进程已校验的调用；页面回复只消费令牌，审核令牌不能授权后续执行。
      try{sender.send('archery-confirmation',{token,item,operation:['execute','reject'].includes(preview.operation)?preview.operation:'approve',cachedDetail:preview.cachedDetail||null,canDetail:preview.canDetail===true});}catch{finish(false);}
    });
  }
  function reply(sender,value) {
    if(!pending||pending.sender!==sender||pending.token!==value?.token||typeof value.confirmed!=='boolean')return false;
    if(value.confirmed&&pending.reading)return false;
    // 原因只属于主进程发起的拒绝令牌；页面回复不能把通过确认改成拒绝或指定其他工单。
    if(value.confirmed&&pending.preview.operation==='reject'){
      if(typeof value.remark!=='string'||!value.remark.trim()||value.remark.trim().length>1000)return false;
      pending.finish({confirmed:true,remark:value.remark.trim()});
    }else pending.finish(value.confirmed);
    return true;
  }
  async function detail(sender,value){
    const current=pending;
    // 详情只属于当前确认令牌，编号由主进程闭包固定，页面不能借此读取其他工单。
    if(!current||current.sender!==sender||current.token!==value?.token)throw Error('审核确认已失效，请重新打开工单。');
    if(!current.preview.canDetail||typeof current.preview.loadDetail!=='function')throw Error('详情不可用，请检查详情工具权限。');
    if(typeof value.allowLarge!=='boolean'||current.reading)throw Error('正在读取详情或请求无效，请稍后重试。');
    current.reading=true;
    try{
      const result=await current.preview.loadDetail(value.allowLarge);
      if(pending!==current)throw Error('审核确认已取消。');
      return result;
    }finally{current.reading=false;}
  }
  return {request,reply,cancel,detail};
}
module.exports={createArcheryConfirmation};
