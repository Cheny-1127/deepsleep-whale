'use strict';
const {randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {BASE,incoming,splitText}=require('./wechat-api.cjs');
const {fresh,migrate,bindingKey}=require('./wechat-store.cjs');
const {validateSettings,resolveBinary}=require('../agents/local-agent.cjs');
const {startWechatAgent}=require('../agents/wechat-agent.cjs');
const {validateClients}=require('../agents/clients.cjs');
const {listCodexThreads,readCodexThread}=require('../agents/codex-catalog.cjs');
const {failureDetails,AgentError}=require('../agents/agent-error.cjs');
const {isDesktopCheckpoint}=require('../agents/codex-desktop.cjs');
const {normalizeQuestions}=require('../agents/user-input.cjs');
const {createTitleReader}=require('../clients/chat-metadata.cjs');
const {discoverRunningClients}=require('../clients/discovery.cjs');

function wait(ms,signal) {
  return new Promise(resolve=>{
    if(signal?.aborted){resolve();return;}
    const end=()=>{clearTimeout(timer);signal?.removeEventListener('abort',end);resolve();};
    const timer=setTimeout(end,ms);timer.unref?.();signal?.addEventListener('abort',end,{once:true});
  });
}
const HELP='/projects 查看最近项目（next 下一页）\n/project 编号或绝对路径 选择项目\n/chats [条数] 查看已有 Codex 对话（默认 5，最多 20）\n/chats next [条数] 查看下一页（表格中可回复 0 或 0 10）\n/chat 编号 继续已有对话\n/new [项目编号或绝对路径] 新建对话，下一条文字开始执行\n/clients 查看已启用客户端及优先级\n/client 编号或 auto 选择客户端\n/status 查看当前对话和任务\n/stop 停止任务\n/question 查看当前待回答问题\n/answer 问题编号 答案 回答指定问题\n/allow 编号 同意本次审批\n/deny 编号 拒绝审批\n/retry 重发待投递结果\n/help 查看帮助';
const COMMANDS=new Set(['/projects','/project','/chats','/chat','/new','/clients','/client','/status','/stop','/question','/answer','/allow','/deny','/retry','/help']);
function parseCommand(text) {
  const input=text.trim(),[raw='']=input.split(/\s+/,1);
  // 只规范指令词，保留任务正文、路径和审批编号的原始内容。
  const command=raw.replace(/[\u200b-\u200d\u2060\ufeff]/g,'').replace(/^／/,'/').replace(/[。．.,，!！?？;；]+$/,'').toLowerCase();
  return {command,token:input.slice(raw.length).trim()};
}
function tableCell(value,limit) {
  const chars=Array.from(String(value||'').replace(/\s+/gu,' ').trim());
  const label=chars.length>limit?chars.slice(0,limit-1).join('')+'…':chars.join('');
  return label.replace(/([\\|`*_\[\]<>])/g,'\\$1');
}
function chatTable(menu,failed) {
  const header=`已有对话（第 ${menu.chatPage} 页，每页 ${menu.chatLimit} 条）：\n\n| 编号 | 对话 | 项目 / 客户端 |\n| --- | --- | --- |\n`;
  const rows=menu.chats.map((entry,i)=>`| ${i+1} | ${tableCell(entry.name,28)} | ${tableCell(path.basename(entry.cwd||'')||'未指定项目',20)} · ${tableCell(entry.clientName,18)} |`);
  const navigation=menu.chatHasNext?`| 0 | 下一页 | 当前每页 ${menu.chatLimit} 条 |\n`:'';
  const footer='\n回复编号选择对话，例如：1。\n选好后直接发消息继续聊。'+(menu.chatHasNext?'\n回复 0 翻页；0 10 表示接下来每页 10 条。':'\n已是最后一页。')+(failed.length?'\n以下实例查询失败（没有执行任务）：'+failed.join('、'):'');
  // 为最后一段的操作行及提示预留空间；只在完整表格行之间分段。
  const limit=1800-Array.from(navigation+footer).length,parts=[];let part=header;
  for(const row of rows){if(Array.from(part+row+'\n').length>limit){parts.push(part.trimEnd());part=header;}part+=row+'\n';}
  parts.push(part+navigation+footer);return parts;
}
function replyParts(text) {
  const value=String(text),parts=splitText(value);
  if(parts.length<2)return parts;
  // 编号也占消息长度；预留空间后再分段，原文和编号一同持久化以供断点重投。
  return splitText(value,1768).map((part,index,all)=>`【结果 ${index+1}/${all.length}】\n\n${part}`);
}
function createWechatGateway({store,api,makeQr,runAgent=startWechatAgent,listThreads=listCodexThreads,readThread=readCodexThread,discoverClients=discoverRunningClients,onChange=()=>{},loginDelay=1000,pollDelay=500,questionTimeoutMs=300000,execution,validateAccount=()=>{},loginTokens=()=>[]}) {
  let state,loadError='',status='disconnected',error='',deliveryError='',failedDeliveryId='',deliveryRetryAt=0,deliveryFailures=0,qr=null,loginController,pollController,closed=false,active=null,flushing=false;
  const approvals=new Map(),inputs=new Map();
  const titleReaders=new Map();
  let typing=null,typingQueue=Promise.resolve();
  const menus=new Map(),commands=new Map(),queryContexts=new Map();let queryEpoch=0;
  try {state=migrate(store.load());}catch(e){state=fresh();loadError=e.message;}
  // 失效凭据与主动暂停不同；重启后仍应引导重新扫码，不能把旧 token 当作可恢复的连接。
  if(state.account?.stale){state.enabled=false;status='expired';error='微信登录已失效，请重新扫码';}
  // 重启只恢复有持久化关联的桌面监听；排队消息和 CLI 任务绝不重新执行。
  for(const job of state.jobs)if(['running','queued','approval','question','recovering'].includes(job.state)){
    if(typeof job.text==='string')job.exchange??={request:job.text};
    if(job.state!=='queued'&&job.route?.settings?.backend==='codex'&&job.route.transport==='desktop'&&job.route.threadId&&isDesktopCheckpoint(job.checkpoint))job.state='recovering';
    else{
      job.state='interrupted';job.finishedAt=Date.now();job.recoveryNotice=true;
      job.failure={...failureDetails(new AgentError('RECOVERY_UNKNOWN','desktop')),message:'桌宠重启后，原任务的结果跟踪已中断，暂时无法确认执行结果。请到原会话查看。'};
    }
    delete job.text;
  }
  // 问题只能交回仍在运行的原请求；重启不重发已经失效的提问。
  state.outbox=state.outbox.filter(item=>!item.questionId);
  function jobChat(job,cache) {
    const route=job.route||{},settings=route.settings||{};
    const binding=state.account?state.bindings[bindingKey(state.account.id,job.sender)]:null;
    // 排队消息只继承仍有效的原绑定；已结束但未建立对话的任务不能事后挂到新对话。
    const threadId=route.threadId||(job.state==='queued'&&binding?.id===route.bindingId?binding.threadId:'')||'';
    // 对话标题可重复；聚合键包含客户端和配置目录，防止不同实例的同名对话混在一起。
    const identity=[route.clientId,settings.backend,settings.binary,settings.configHome,settings.profile,threadId||route.bindingId||job.id];
    const key=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    if(cache.has(key))return cache.get(key);
    let name=route.threadName||'';
    if(!closed&&threadId&&settings.backend==='codex') {
      const home=settings.configHome||'';
      if(!titleReaders.has(home))titleReaders.set(home,createTitleReader(home||undefined));
      const local=titleReaders.get(home).lookup(threadId);
      if(local.kind==='chat'&&local.title)name=local.title;
    }
    const chat={key,threadId,name:typeof name==='string'&&name.trim()?name.replace(/\s+/gu,' ').trim().slice(0,160):threadId?'对话 '+threadId.slice(-8):route.bindingId?'尚未建立对话':'未记录对话 · '+String(job.id).slice(-8),
      project:typeof settings.cwd==='string'?path.basename(settings.cwd):'',
      clientName:state.clients.find(client=>client.id===route.clientId)?.name||route.clientName||(settings.backend==='cursor'?'Cursor CLI':settings.backend==='codex'?'Codex':'未记录客户端')};
    cache.set(key,chat);return chat;
  }
  function queueRecoveryReplies() {
    let changedState=false;
    for(const job of state.jobs){
      // 队列满时保留待通知标记，已有消息腾出空间后再补入，不阻断微信重连。
      if(state.outbox.length>=100)break;
      if(job.recoveryNotice){
        // 标记和待投递消息同次保存；投递失败或再次重启仍沿用同一个消息 ID。
        delete job.recoveryNotice;changedState=true;
        try{queueReply(job.sender,job.failure.message+'\n不会自动重新执行，可发送 /status 查看。',undefined,job.id);}
        catch(error){job.recoveryNotice=true;throw error;}
      }else if(job.state==='completed'&&['pending','failed'].includes(job.delivery)&&typeof job.exchange?.response==='string'&&!state.outbox.some(item=>item.jobId===job.id)){
        queueReply(job.sender,job.exchange.response,undefined,job.id);
      }
    }
    if(changedState)persist();
  }
  function canDeleteJob(job){return active?.job!==job&&(['failed','interrupted','cancelled'].includes(job.state)||(job.state==='completed'&&job.delivery==='failed'));}
  function snapshot() {
    const chats=new Map();
    return {status,error:loadError||error||deliveryError,storageAvailable:store.available(),enabled:state.enabled,
      account:state.account?{id:state.account.id,owner:state.account.owner}:null,
      qr:qr?{image:qr.image,status:qr.status}:null,clients:state.clients.map(item=>({...item})),allowed:[...state.allowed],pending:[...state.pending],
      // 展示全部保留的最近记录，避免高频对话的八条任务挤掉其他对话；不暴露正文或客户端配置。
      jobs:state.jobs.slice(-50).reverse().map(job=>({id:job.id,sender:job.sender,state:job.state,startedAt:job.startedAt,finishedAt:job.finishedAt,chat:jobChat(job,chats),delivery:job.delivery,canDelete:canDeleteJob(job),...(job.failure?{failure:job.failure}:{})})),
      active:active?{id:active.job.id,sender:active.job.sender}:null,outbox:state.outbox.length};
  }
  function changed(){updateTyping();onChange();}
  function sendTyping(entry,enabled) {
    if(enabled&&entry.pending)return;
    if(enabled)entry.pending=true;
    // 串行发送开始/停止，避免上一轮的迟到响应把下一轮输入状态关闭或重新开启。
    typingQueue=typingQueue.then(async()=>{
      if(enabled&&typing!==entry)return;
      if(enabled)entry.started=true;
      const signal=enabled?AbortSignal.any([entry.controller.signal,AbortSignal.timeout(1500)]):AbortSignal.timeout(1500);
      const context=state.account===entry.account?state.contexts[entry.sender]||entry.context:entry.context;
      await api.typing(entry.account,entry.sender,enabled,context,signal);
    }).catch(()=>{}).finally(()=>{if(enabled)entry.pending=false;});
  }
  function stopTyping() {
    const previous=typing;if(!previous)return;
    typing=null;clearInterval(previous.timer);previous.controller.abort();
    if(previous.started)sendTyping(previous,false);
  }
  function updateTyping() {
    const current=active&&!active.stopping&&active.job.state==='running'&&state.enabled&&!closed&&pollController&&!pollController.signal.aborted&&state.allowed.includes(active.job.sender)?active:null;
    if(typing&&(typing.job!==current?.job||typing.account!==state.account))stopTyping();
    if(!current||typing||typeof api.typing!=='function')return;
    // 输入状态只是提示：失败不影响任务、审批或结果投递，也不额外发文字回执。
    const entry={job:current.job,account:state.account,sender:current.job.sender,context:state.contexts[current.job.sender],controller:new AbortController()};
    typing=entry;sendTyping(entry,true);
    entry.timer=setInterval(()=>sendTyping(entry,true),2000);entry.timer.unref?.();
  }
  function queryContext(key){if(!queryContexts.has(key))queryContexts.set(key,new AbortController());return queryContexts.get(key);}
  function invalidateQueries(){queryEpoch++;for(const controller of queryContexts.values())controller.abort();queryContexts.clear();menus.clear();commands.clear();}
  function persist() {
    try{if(loadError)throw new Error(loadError);store.save(state);}
    catch {
      state.enabled=false;status='error';error='微信状态无法安全保存，已暂停连接和任务';
      stopPoll();stopTask();invalidateQueries();changed();const failure=new Error(error);failure.code='STORAGE';throw failure;
    }
  }
  function tellError(message){error=message;changed();}
  function queueReply(sender,text,questionId,jobId) {
    if(!state.allowed.includes(sender)||!state.account)return;
    if(state.outbox.length>=100)throw new Error('待投递消息过多，请先恢复微信连接');
    // 不截断完整结果；表格沿用完整行分段。每份结果共用一个队列项与稳定投递 ID。
    state.outbox.push({id:randomUUID(),sender,parts:Array.isArray(text)?text:replyParts(text),index:0,...(questionId?{questionId}:{}),...(jobId?{jobId}:{})});
    const job=state.jobs.find(job=>job.id===jobId);if(job)job.delivery='pending';persist();
  }
  async function flush() {
    if(flushing||Date.now()<deliveryRetryAt||!state.enabled||!state.account||!pollController||pollController.signal.aborted)return;
    flushing=true;
    const deliveryController=pollController,deliveryAccount=state.account;let item;
    try {
      queueRecoveryReplies();
      while(state.enabled&&state.outbox.length&&pollController===deliveryController&&state.account===deliveryAccount&&!deliveryController.signal.aborted) {
        item=state.outbox[0];
        if(!state.allowed.includes(item.sender)){state.outbox.shift();persist();continue;}
        const account=state.account,controller=pollController;
        await api.send(account,item.sender,item.parts[item.index],state.contexts[item.sender],`${item.id}-${item.index}`,controller.signal);
        // 停用、解绑或换账号期间结束的旧发送不能改写新账号的数据。
        if(controller!==pollController||account!==state.account||controller.signal.aborted)break;
        if(state.outbox[0]!==item)continue; // 删除记录或联系人撤权可能在发送途中移除当前消息。
        deliveryFailures=0;deliveryRetryAt=0;deliveryError='';failedDeliveryId='';
        const job=state.jobs.find(job=>job.id===item.jobId);
        item.index++;if(item.index>=item.parts.length){state.outbox.shift();if(job)job.delivery='sent';}else if(job)job.delivery='pending';persist();changed();queueRecoveryReplies();
        await wait(300,controller.signal);
      }
    }catch(e){
      if(deliveryController!==pollController||deliveryAccount!==state.account||!state.outbox.includes(item))return;
      if(e.code===-14){failedDeliveryId=item.id;const job=state.jobs.find(job=>job.id===item.jobId);if(job)job.delivery='failed';expire();}
      else if(e.code!=='STORAGE'&&pollController&&!pollController.signal.aborted&&e.name!=='AbortError'){
        deliveryFailures++;deliveryRetryAt=Date.now()+Math.min(60000,5000*2**Math.min(deliveryFailures-1,4));
        failedDeliveryId=item.id;const job=state.jobs.find(job=>job.id===item.jobId);if(job){job.delivery='failed';try{persist();}catch{return;}}
        deliveryError=e.code?e.message:'微信结果尚未送达，可稍后重试；任务不会重跑';changed();
      }
    }finally{flushing=false;if(item&&!state.outbox.includes(item)&&state.outbox.length)void flush();}
  }
  function reply(sender,text,jobId){queueReply(sender,text,undefined,jobId);void flush();}
  function denyApprovals() {for(const approval of approvals.values()){clearTimeout(approval.timer);discardPrompt(approval);approval.resolve(false);}approvals.clear();}
  function stopTask() {if(active)active.stopping=true;stopTyping();denyApprovals();for(const entry of [...inputs.values()])finishInput(entry,null,false);active?.handle?.cancel();}
  function currentInput(sender){return [...inputs.values()].find(entry=>entry.sender===sender&&entry.job===active?.job);}
  // 编号包含当前题序；上一题的显式回复不能误答下一题。
  function inputToken(entry){return `${entry.id}-${entry.index+1}`;}
  function interactionState(job) {
    if(active?.job===job&&['running','approval','question','recovering'].includes(job.state))job.state=[...approvals.values()].some(entry=>entry.jobId===job.id)?'approval':[...inputs.values()].some(entry=>entry.job===job)?'question':'running';
  }
  function discardPrompt(entry){state.outbox=state.outbox.filter(item=>item.questionId!==entry.prompt);entry.prompt='';}
  function showQuestion(entry,{details=false}={}) {
    discardPrompt(entry);entry.prompt=inputToken(entry);
    const question=entry.questions[entry.index];
    const options=question.options.map((option,index)=>`${index+1}. ${option.label}${option.description?'\n   '+option.description:''}`).join('\n');
    const instruction=options?'直接回复一个选项编号，例如：1。\n也可以用自己的话说明选择、要求或疑问。':'直接回复你的答案；不清楚时，也可以直接说出你的疑问。';
    // 问题与操作说明分开；正常回答不用复制问题或填写内部编号。
    queueReply(entry.sender,`Codex 需要你回答（第 ${entry.index+1}/${entry.questions.length} 题）\n${question.header?'\n'+question.header+'\n':''}\n【问题】\n${question.question}${options?'\n\n【选项】\n'+options:''}\n\n【回复方式】\n${instruction}\n你的下一条文字会作为本题回答，交回当前任务。\n\n重看问题：/question\n取消任务：/stop${details?'\n指定这道题作答：/answer '+entry.prompt+' 你的答案':''}`,entry.prompt);
    void flush();
  }
  function finishInput(entry,response,advance=true) {
    if(!inputs.delete(entry.id))return;
    clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);discardPrompt(entry);
    entry.resolve(response);interactionState(entry.job);
    if(state.account)delete menuFor(bindingKey(state.account.id,entry.sender)).choice;
    if(advance){const next=currentInput(entry.sender);if(next)showQuestion(next);}
    persist();changed();
  }
  function requestInput(job,request) {
    if(!state.enabled||active?.job!==job||!state.allowed.includes(job.sender)||request.signal?.aborted)return Promise.resolve(null);
    const questions=normalizeQuestions(request.questions);
    return new Promise((resolve,reject)=>{
      // 答案和回调只保存在内存，并绑定发送者与活动任务；持久化仅记录任务的等待状态。
      const entry={id:randomUUID().slice(0,8),sender:job.sender,job,questions,index:0,answers:{},resolve,signal:request.signal,prompt:''};
      entry.abort=()=>{try{finishInput(entry,null);}catch{}};
      entry.timer=setTimeout(()=>{
        if(!inputs.has(entry.id))return;
        stopTask();try{reply(job.sender,'等待你的回答已超时，已请求停止本次任务；不会自动替你作答。');}catch{}
      },questionTimeoutMs);entry.timer.unref?.();
      inputs.set(entry.id,entry);entry.signal?.addEventListener('abort',entry.abort,{once:true});
      try{
        delete menuFor(bindingKey(state.account.id,job.sender)).choice;
        interactionState(job);persist();changed();
        if(entry.signal?.aborted)finishInput(entry,null);else if(currentInput(job.sender)===entry)showQuestion(entry);
      }catch(error){inputs.delete(entry.id);clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);reject(error);}
    });
  }
  function answerInput(sender,value,token) {
    const entry=currentInput(sender);
    if(!entry||token&&token!==inputToken(entry)){reply(sender,'这个问题已结束、已过期或不属于你。发送 /question 查看当前问题。');return;}
    const question=entry.questions[entry.index],input=value.trim();
    if(!input){reply(sender,'请回复选项编号或输入答案。');return;}
    const option=question.options.length&&/^\d+$/.test(input)?question.options[Number(input)-1]:null;
    if(question.options.length&&/^\d+$/.test(input)&&!option){reply(sender,`选项编号请输入 1 至 ${question.options.length}，也可以输入自己的文字答案。`);return;}
    // 选项回填原标签；文字保留原样，不在确认消息中回显可能敏感的答案。
    Object.defineProperty(entry.answers,question.id,{value:{answers:[option?option.label:value]},enumerable:true,configurable:true});
    discardPrompt(entry);entry.index++;
    if(entry.index<entry.questions.length)showQuestion(entry);
    else finishInput(entry,{answers:entry.answers});
  }
  function stopPoll(){pollController?.abort();pollController=null;stopTyping();}
  function expire() {
    if(state.account)state.account.stale=true;
    state.enabled=false;status='expired';error='微信登录已失效，请重新扫码';stopPoll();stopTask();invalidateQueries();
    try{persist();}catch{}changed();
  }
  async function requestApproval(job,request) {
    if(!state.enabled||!state.allowed.includes(job.sender)||active?.job!==job)return false;
    const id=randomUUID().slice(0,8);job.state='approval';persist();changed();
    return new Promise(resolve=>{
      const entry={sender:job.sender,jobId:job.id,resolve,prompt:id};
      const timer=setTimeout(()=>{approvals.delete(id);discardPrompt(entry);interactionState(job);resolve(false);try{persist();}catch{}changed();},120000);timer.unref?.();
      entry.timer=timer;approvals.set(id,entry);
      try{queueReply(job.sender,`需要你确认本次${request.kind==='file'?'文件修改':'命令执行'}：\n${request.detail}\n目录：${request.cwd}\n同意请发送 /allow ${id}\n拒绝请发送 /deny ${id}\n两分钟未处理会拒绝。`,id);void flush();}
      catch {clearTimeout(timer);approvals.delete(id);discardPrompt(entry);resolve(false);}
    });
  }
  function schedule() {
    if(active||closed||!state.enabled||!state.account)return;
    const job=state.jobs.find(item=>item.state==='recovering')||state.jobs.find(item=>item.state==='queued');if(!job)return;
    const recovering=job.state==='recovering';
    if(!state.allowed.includes(job.sender)){job.state='cancelled';persist();schedule();return;}
    const settings={...job.route.settings},key=bindingKey(state.account.id,job.sender),binding=state.bindings[key];
    // 绑定可能已被后续选择替换；只有同一绑定才能继承执行期间新建的会话。
    const session=job.route.threadId||(binding?.id===job.route.bindingId?binding.threadId:'');
    const transport=settings.backend==='codex'&&session?(job.route.transport||(binding?.id===job.route.bindingId?binding.transport:null)||'desktop'):'local';
    const release=execution?execution.acquire(job):()=>{};if(!release)return;
    const current={job,handle:null};
    try {
      // 拿到跨账号执行锁后，保存失败也必须走统一清理，不能遗留锁或启动未落盘的任务。
      if(session)job.route.threadId=session;
      if(!recovering){job.state='running';job.startedAt=Date.now();}persist();
      active=current;changed();
      current.handle=runAgent({settings,text:recovering?undefined:job.text,session:session||undefined,transport,recovering,checkpoint:job.checkpoint,
        ...(recovering?{timeoutMs:Math.max(15000,600000-(Date.now()-job.startedAt))}:{}),
        onCheckpoint:value=>{
          if(active!==current||closed)throw new AgentError('CANCELLED','desktop');
          // 消息 ID 与已知轮次只能保持一致，防止重连后把同一会话的其他任务当作原任务。
          if(!isDesktopCheckpoint(value)||job.checkpoint&&(job.checkpoint.messageId!==value.messageId||job.checkpoint.turnId&&job.checkpoint.turnId!==value.turnId))throw new AgentError('TRACKING_STORE','desktop');
          job.checkpoint={...value};job.state='running';persist();changed();
        },
        // 断线前的审批回调已经失效，恢复后只接受重新核实的原请求。
        onRecovering:()=>{if(active===current&&!closed){denyApprovals();job.state='recovering';persist();changed();}},
        onSession:id=>{if(active===current){job.route.threadId=id;job.route.transport=transport;if(state.bindings[key]?.id===job.route.bindingId){state.bindings[key].threadId=id;state.bindings[key].transport=transport;}persist();}},onApproval:request=>requestApproval(job,request),onUserInput:request=>requestInput(job,request)});
      void current.handle.promise.then(result=>{
        if(active!==current)return;
        // 完整问答随任务加密保存，仅主动查看详情时读取；持续广播的快照只包含摘要。
        job.state='completed';job.finishedAt=Date.now();job.exchange={request:job.exchange?.request??job.text,response:result.text};delete job.text;
        queueReply(job.sender,result.text,undefined,job.id);persist();
      },cause=>{
        if(active!==current)return;
        job.failure=failureDetails(cause);job.state=job.failure.code==='CANCELLED'?'cancelled':['RECOVERY_UNKNOWN','TURN_INTERRUPTED'].includes(job.failure.code)?'interrupted':'failed';job.finishedAt=Date.now();delete job.text;
        queueReply(job.sender,job.failure.message+'\n不会自动重新执行，可发送 /status 查看。',undefined,job.id);
      }).catch(()=>{state.enabled=false;status='error';error='任务状态无法保存，已暂停微信执行';stopPoll();})
        .finally(()=>{release();if(active===current){denyApprovals();for(const entry of [...inputs.values()])try{finishInput(entry,null,false);}catch{}active=null;try{persist();}catch{}changed();void flush();schedule();}});
    }catch(cause) {
      release();job.failure=failureDetails(cause);job.state='failed';job.finishedAt=Date.now();delete job.text;active=null;
      try{reply(job.sender,job.failure.message+'\n没有切换其他实例或重新执行。',job.id);persist();}catch{}changed();schedule();
    }
  }
  function enabledClients(){return state.clients.filter(client=>client.enabled);}
  function selectedClient(binding) {
    if(binding?.clientId)return enabledClients().find(client=>client.id===binding.clientId);
    return enabledClients()[0];
  }
  function menuFor(key){if(!menus.has(key))menus.set(key,{});return menus.get(key);}
  function chooseBinding(key,value){state.bindings[key]={id:randomUUID(),threadId:'',automatic:true,...value};delete menuFor(key).choice;persist();}
  function hasWork(sender){return state.jobs.some(job=>job.sender===sender&&['queued','running','approval','question','recovering'].includes(job.state));}
  function projectPath(value,menu) {
    const item=/^[1-9]\d*$/.test(value||'')?menu.projects?.[Number(value)-1]:null;
    const cwd=item?.cwd||value;
    if(!cwd||!path.isAbsolute(cwd)||!fs.statSync(cwd,{throwIfNoEntry:false})?.isDirectory())throw new Error('项目不存在。先发送 /projects，再用 /project 编号；也可使用本机项目的绝对路径。');
    return fs.realpathSync(cwd);
  }
  async function chatCatalog(sender,key,{next=false,size,valid}) {
    const binding=state.bindings[key],menu=menuFor(key);
    const clients=enabledClients().filter(client=>client.backend==='codex'&&(!binding?.clientId||client.id===binding.clientId));
    if(!clients.length){reply(sender,'没有可查询的 Codex 实例。用 /clients 查看，或在电脑的可选客户端设置中启用 Codex。');return;}
    const scope=JSON.stringify(clients.map(client=>client.id));
    if(next&&menu.chatScope!==scope){reply(sender,'请先发送 /chats 查看对话，再回复 0 翻页。');return;}
    if(next&&!menu.chatHasNext){menu.choice='chat';reply(sender,'没有下一页了。回复当前表格的编号选择对话，或发送 /chats 重新查看。');return;}
    // undefined 表示该实例尚未成功查询，null 表示已到末尾；失败不能误标为末页。
    // 先复制未展示缓存和游标，查询结果通过有效性校验后再更新菜单。
    const limit=size??(next?menu.chatLimit:5),cursors=next?{...menu.chatCursors}:{},remaining=next?[...menu.chatRemaining]:[];
    const failed=new Set(),blocked=new Set();
    // 空页（例如过滤掉子代理）仍可能带游标；限定补页轮数，避免异常服务无限查询。
    for(let round=0;remaining.length<limit&&round<20;round++) {
      const pending=clients.filter(client=>cursors[client.id]!==null&&!blocked.has(client.id));
      if(!pending.length)break;
      const pages=await Promise.all(pending.map(async client=>{
        const cursor=cursors[client.id]??null;
        try{return {client,cursor,...await listThreads(client,{cursor,limit,signal:queryContext(key).signal})};}
        catch{return {client,cursor,failed:true};}
      }));
      if(!valid())return;
      for(const page of pages) {
        if(page.failed||(page.cursor&&page.nextCursor===page.cursor)){failed.add(page.client.name);blocked.add(page.client.id);continue;}
        cursors[page.client.id]=page.nextCursor||null;
        for(const thread of page.threads)remaining.push({...thread,clientId:page.client.id,clientName:page.client.name});
      }
    }
    if(!valid())return;
    menu.chatScope=scope;menu.chatLimit=limit;menu.chatCursors=cursors;menu.choice='chat';
    menu.chatHasNext=remaining.length>limit||clients.some(client=>cursors[client.id]!==null);
    if(!remaining.length) {
      // 翻页失败时保留上一页编号，避免回复数字落到错误的会话或变成任务。
      menu.chatRemaining=[];
      if(!next){menu.chats=[];menu.chatPage=0;}
      reply(sender,failed.size?'对话查询失败，请回复 0 重试；没有执行任务。':menu.chatHasNext?'本次尚未找到可显示的对话，回复 0 继续查看。':next?'没有下一页了。回复当前表格的编号选择对话，或发送 /chats 重新查看。':'还没有找到可继续的对话。发送 /projects 选择项目后新建。');return;
    }
    menu.chats=remaining.slice(0,limit);menu.chatRemaining=remaining.slice(limit);menu.chatPage=next?menu.chatPage+1:1;
    reply(sender,chatTable(menu,[...failed]));
  }
  async function catalog(sender,key,{next=false,valid}) {
    const binding=state.bindings[key],menu=menuFor(key);
    const clients=enabledClients().filter(client=>client.backend==='codex'&&(!binding?.clientId||client.id===binding.clientId));
    if(!clients.length){reply(sender,'没有可查询的 Codex 实例。用 /clients 查看，或在电脑的可选客户端设置中启用 Codex。');return;}
    const pages=await Promise.all(clients.map(async client=>{
      if(next&&!menu.projectCursors?.[client.id])return {client,threads:[],nextCursor:null};
      try{return {client,...await listThreads(client,{cursor:next?menu.projectCursors[client.id]:null,limit:20,signal:queryContext(key).signal})};}
      catch{return {client,threads:[],failed:true,nextCursor:next?menu.projectCursors?.[client.id]||null:null};}
    }));
    if(!valid())return;
    const entries=pages.flatMap(page=>page.threads.map(thread=>({...thread,clientId:page.client.id,clientName:page.client.name})));
    menu.projectCursors=Object.fromEntries(pages.map(page=>[page.client.id,page.nextCursor||null]));
    const failed=pages.filter(page=>page.failed).map(page=>page.client.name);
    // 最近对话提供项目来源；无历史的项目可用绝对路径直接选择。
    const seen=new Set();menu.projects=entries.filter(entry=>entry.cwd&&!seen.has(entry.cwd)&&seen.add(entry.cwd)).slice(0,80);
    menu.choice=menu.projects.length?'project':null;
    let text=menu.projects.length?'最近项目：\n\n'+menu.projects.map((entry,i)=>`${i+1}. ${path.basename(entry.cwd)||entry.cwd}\n   ${entry.cwd}`).join('\n\n')+'\n\n回复数字选择项目，例如：1。\n选好后直接描述你要排查的问题。':'还没有找到最近项目。\n请发送 /project 加电脑上的项目完整路径，例如：\n/project /Users/你的用户名/项目目录';
    if(Object.values(menu.projectCursors).some(Boolean))text+=menu.choice?'\n回复“下一页”查看更多。':'\n发送 /projects next 继续查看。';
    if(failed.length)text+='\n以下实例查询失败（没有执行任务）：'+failed.join('、');
    reply(sender,text);
  }
  async function route(message,valid) {
    const {sender,text}=message;
    if(!text){reply(sender,'当前支持文字消息，请直接发送文字描述。');return;}
    let {command,token}=parseCommand(text);
    const key=bindingKey(state.account.id,sender),binding=state.bindings[key],menu=menuFor(key);
    // 回答优先于聊天/客户端菜单，不能把数字答案解释成切换选择或新任务。
    if(command==='/answer'){const match=token.match(/^(\S+)(?:\s+([\s\S]*))?$/);answerInput(sender,match?.[2]||'',match?.[1]);return;}
    if(command==='/question'){const entry=currentInput(sender);if(entry)showQuestion(entry,{details:true});else reply(sender,'当前没有等待你回答的问题。');return;}
    // 等待回答时仅保留已知控制指令；绝对路径等以 / 开头的文字仍是答案。
    if(currentInput(sender)&&!COMMANDS.has(command)){answerInput(sender,text);return;}
    // 0 只在菜单中作为翻页操作；选中会话后清除 choice，数字恢复为原始任务正文。
    if(menu.choice&&menu.choice!=='chat'&&/^0(?:\s|$)/.test(text.trim())){reply(sender,'0 翻页仅用于对话表格。请先发送 /chats。');return;}
    if(menu.choice==='chat'&&/^(?:0|下一页|next)(?:\s|$)/i.test(text.trim())){command='/chats';token=text.trim().replace(/^(?:0|下一页|next)/i,'next');}
    else if(menu.choice&&/^[1-9]\d*$/.test(text.trim())){command='/'+menu.choice;token=text.trim();}
    else if(['project','chat'].includes(menu.choice)&&['下一页','next'].includes(text.trim())){command=menu.choice==='project'?'/projects':'/chats';token='next';}
    if(command==='/help'){delete menu.choice;reply(sender,HELP);return;}
    if(command==='/status') {
      const job=[...state.jobs].reverse().find(j=>j.sender===sender);
      reply(sender,`${selectedClient(binding)?.name||'没有启用的客户端'} · ${binding?.cwd||'尚未选择项目'}\n对话：${binding?.threadId||'下一条任务将新建'}\n最近任务：${job?job.state:'暂无'}${job?.failure?'\n'+job.failure.message:''}\n待投递：${state.outbox.length}`);return;
    }
    if(command==='/retry'){deliveryRetryAt=0;void flush();return;}
    if(command==='/stop') {
      for(const job of state.jobs)if(job.sender===sender&&(job.state==='queued'||job.state==='recovering'&&active?.job!==job)){job.state='cancelled';delete job.text;}
      if(active?.job.sender===sender)stopTask();persist();reply(sender,'已请求停止你的任务。');return;
    }
    if(command==='/clients') {
      menu.clients=enabledClients().map(client=>client.id);
      menu.choice=menu.clients.length?'client':null;
      reply(sender,menu.clients.length?'已启用客户端（按优先级）：\n'+enabledClients().map((client,i)=>`${i+1}. ${client.name} · ${client.backend}`).join('\n')+'\n\n回复数字选择客户端，例如：1。\n发送 /client auto 恢复优先级选择。':'尚未启用客户端，请在电脑的可选客户端设置中启用。');return;
    }
    if(command==='/projects'){await catalog(sender,key,{next:token==='next',valid});return;}
    if(command==='/chats') {
      const args=token?token.split(/\s+/):[],next=args[0]?.toLowerCase()==='next';if(next)args.shift();
      if(args.length>1||(args.length===1&&(!/^\d+$/.test(args[0])||Number(args[0])<1||Number(args[0])>20))){reply(sender,'每页条数请输入 1 至 20 的整数。例如：/chats 10 或 0 10。');return;}
      await chatCatalog(sender,key,{next,size:args.length?Number(args[0]):undefined,valid});return;
    }
    if(['/client','/project','/new','/chat'].includes(command)) {
      if(hasWork(sender)){reply(sender,'请先停止或等待你的任务结束，再切换项目、实例或对话。');return;}
      if(command==='/client') {
        const id=menu.clients?.[Number(token)-1],client=enabledClients().find(item=>item.id===id);
        if(token!=='auto'&&!client){reply(sender,'先发送 /clients，再用 /client 编号 选择。');return;}
        chooseBinding(key,{clientId:client?.id||'',cwd:binding?.cwd||'',automatic:token==='auto'});menus.delete(key);
        reply(sender,token==='auto'?'已恢复按优先级选择，新任务将新建对话。':`已选择 ${client.name}，新任务将新建对话。`);return;
      }
      if(command==='/chat') {
        const entry=menu.chats?.[Number(token)-1],client=enabledClients().find(item=>item.id===entry?.clientId);
        if(!entry||!client){reply(sender,'先发送 /chats，再用 /chat 编号 选择。');return;}
        let thread;
        try{thread=await readThread(client,entry.id,{signal:queryContext(key).signal});}catch{if(valid())reply(sender,'对话查询失败，请重新发送 /chats；没有启动任务。');return;}
        if(!valid())return;
        const cwd=projectPath(thread.cwd,{});
        chooseBinding(key,{clientId:client.id,cwd,threadId:thread.id,threadName:thread.name,transport:'desktop',automatic:false});
        reply(sender,`已选择 ${thread.name} · ${client.name}\n${cwd}\n直接发消息，我会原样转给这个桌面对话，并把本轮回复发回来。桌面正在回复时会先等待。`);return;
      }
      const cwd=token?projectPath(token,menu):binding?.cwd;
      if(!cwd){await catalog(sender,key,{valid});return;}
      // 新建时自动模式重新按优先级选实例；已有对话续接始终固定所属实例。
      chooseBinding(key,{clientId:binding?.automatic===false?binding.clientId:'',cwd,automatic:binding?.automatic!==false});
      reply(sender,`已选择项目：${cwd}\n下一条文字将在 ${selectedClient(state.bindings[key])?.name||'优先客户端'} 新建对话。`);return;
    }
    if(command==='/allow'||command==='/deny') {
      const approval=approvals.get(token);
      if(!approval||approval.sender!==sender||approval.jobId!==active?.job.id){reply(sender,'审批不存在、已过期或不属于当前任务。');return;}
      clearTimeout(approval.timer);approvals.delete(token);discardPrompt(approval);interactionState(active.job);persist();approval.resolve(command==='/allow');
      reply(sender,command==='/allow'?'已同意本次请求。':'已拒绝本次请求。');changed();return;
    }
    if(command.startsWith('/')){reply(sender,'没认出这条指令。\n查看项目请发送 /projects，查看已有对话请发送 /chats。\n完整说明请发送 /help。');return;}
    if(!binding?.cwd){reply(sender,'先选择要处理的项目或对话：/projects 查看项目；/chats 查看桌面已有对话。也可发送 /project 本机绝对路径。');return;}
    const client=selectedClient(binding);
    if(!client){reply(sender,'所选实例未启用。请发送 /clients，再用 /client 编号或 /client auto 选择；没有切换账号执行。');return;}
    const settings=validateSettings({...client,cwd:binding.cwd});
    if((execution?execution.count():state.jobs.filter(j=>['queued','running','approval','question','recovering'].includes(j.state)).length)>=5){reply(sender,'任务队列已满，请等待或停止已有任务。');return;}
    delete menu.choice;
    if(!binding.id)binding.id=randomUUID();
    if(!binding.clientId)binding.clientId=client.id;
    const notifyQueue=(active||execution?.busy())&&!state.jobs.some(job=>job.sender===sender&&job.state==='queued');
    // 入队时保留原文与路由快照，后续切换项目或客户端不能改变已排队消息的执行目标。
    state.jobs.push({id:randomUUID(),sender,text,exchange:{request:text},state:'queued',startedAt:Date.now(),route:{clientId:client.id,clientName:client.name,settings,threadId:binding.threadId||'',threadName:binding.threadId?binding.threadName||'':'',transport:binding.transport||'',bindingId:binding.id}});
    state.jobs=state.jobs.slice(-50);persist();if(notifyQueue)reply(sender,'消息已排队，前面的任务结束后会继续处理。');schedule();
  }
  function accept(raw) {
    const message=incoming(raw,state.account.id);if(!message||state.seen.includes(message.id))return;
    // 先保存去重记录与会话令牌，再启动任务；写入失败则停止，不冒险重复执行。
    state.seen.push(message.id);state.seen=state.seen.slice(-2000);
    if(!state.allowed.includes(message.sender)) {
      if(!state.pending.includes(message.sender))state.pending=[...state.pending,message.sender].slice(-20);
      persist();changed();return;
    }
    if(message.context){state.contexts[message.sender]=message.context;deliveryRetryAt=0;}
    persist();
    const epoch=queryEpoch,account=state.account,key=bindingKey(account.id,message.sender);
    const {command}=parseCommand(message.text);
    if(command==='/stop'){queryContexts.get(key)?.abort();queryContexts.delete(key);commands.delete(key);menus.delete(key);}
    const context=queryContext(key);
    const valid=()=>!closed&&state.enabled&&state.account===account&&epoch===queryEpoch&&queryContexts.get(key)===context&&state.allowed.includes(message.sender);
    // 每位发送者按收件顺序处理选择与任务，异步查询不能让下一条文字跑进旧对话。
    // 停止、审批和状态不能被缓慢的目录查询阻塞；停止同时废弃尚未处理的旧消息。
    const urgent=['/stop','/allow','/deny','/status','/answer','/question'].includes(command)||Boolean(currentInput(message.sender)&&!COMMANDS.has(command));
    const pending=(urgent?Promise.resolve():commands.get(key)||Promise.resolve()).then(()=>{if(valid())return route(message,valid);})
      .catch(e=>{if(valid()&&e.code!=='STORAGE'){try{reply(message.sender,'操作未完成：'+(e.message||'请重试'));}catch{}}})
      .finally(()=>{if(commands.get(key)===pending)commands.delete(key);changed();});
    if(!urgent)commands.set(key,pending);changed();
  }
  function startPoll() {
    stopPoll();if(!state.account||!state.enabled||closed)return;
    queueRecoveryReplies();
    // 新一轮恢复的状态不能继续显示上次扫码或连接失败的错误；实际失败由本轮轮询重新报告。
    const controller=new AbortController();pollController=controller;status='connecting';error='';changed();
    void (async()=>{
      let failures=0;
      while(!controller.signal.aborted&&state.enabled&&!closed) {
        try {
          const response=await api.updates(state.account,state.cursor,controller.signal);
          if(controller.signal.aborted)break;
          failures=0;status='connected';error='';
          for(const raw of Array.isArray(response.msgs)?response.msgs:[])accept(raw);
          if(typeof response.get_updates_buf==='string'&&response.get_updates_buf!==state.cursor){state.cursor=response.get_updates_buf;persist();}
          changed();void flush();schedule();await wait(pollDelay,controller.signal);
        }catch(e) {
          if(controller.signal.aborted)break;
          if(e.code==='STORAGE')break;
          if(e.code===-14){expire();break;}
          if(e.name==='TimeoutError')continue;
          failures++;status='reconnecting';error=e.code?e.message:'微信连接暂时不可用，正在重连';changed();
          await wait(failures>=3?30000:2000,controller.signal);
        }
      }
    })();
  }
  async function login() {
    if(!store.available())throw new Error('系统安全存储不可用，不能保存微信连接');
    if(loadError)throw new Error(loadError);
    loginController?.abort();stopPoll();stopTask();invalidateQueries();state.enabled=false;persist();
    const controller=new AbortController();loginController=controller;status='logging-in';error='';qr=null;changed();
    const data=await api.qr(controller.signal,loginTokens());
    if(controller.signal.aborted)return;
    if(typeof data.qrcode!=='string'||typeof data.qrcode_img_content!=='string'||!data.qrcode||!data.qrcode_img_content||data.qrcode_img_content.length>4096)throw new Error('微信未返回可用二维码');
    const image=await makeQr(data.qrcode_img_content);
    if(controller.signal.aborted||loginController!==controller)return;
    qr={code:data.qrcode,image,status:'等待扫码'};changed();
    void (async()=>{
      let host=api.baseUrl||BASE,deadline=Date.now()+480000;
      try {
        while(!controller.signal.aborted&&Date.now()<deadline) {
          let result;
          try{result=await api.qrStatus(data.qrcode,host,controller.signal);}catch(e){if(e.name==='TimeoutError')continue;throw e;}
          if(controller.signal.aborted)break;
          if(result.status==='confirmed') {
            if(!result.ilink_bot_id||!result.bot_token)throw new Error('微信确认信息缺少账号凭据');
            const id=String(result.ilink_bot_id),owner=String(result.ilink_user_id||''),previous=state.account;
            const account={id,token:String(result.bot_token),baseUrl:api.validate(result.baseurl||BASE),owner};
            // 只有管理器校验为同一微信的续接，才允许新机器人 ID 继承旧授权、会话和历史。
            const renewal=validateAccount(id,owner)===true,same=previous?.id===id||renewal;
            if(!same){const clients=state.clients;state=fresh();state.clients=clients;invalidateQueries();}
            else if(previous.id!==id){
              // 同一微信换了机器人凭据：保留桌面对话和历史，只迁移路由键，旧游标和上下文不能跨机器人复用。
              for(const sender of state.allowed){const key=bindingKey(previous.id,sender);if(Object.hasOwn(state.bindings,key)){state.bindings[bindingKey(id,sender)]=state.bindings[key];delete state.bindings[key];}}
              state.cursor='';state.contexts={};state.seen=[];
            }
            state.account=account;
            if(state.account.owner&&!state.allowed.includes(state.account.owner))state.allowed.push(state.account.owner);
            deliveryError='';failedDeliveryId='';deliveryRetryAt=0;deliveryFailures=0;
            state.enabled=true;persist();qr=null;loginController=null;startPoll();return;
          }
          if(result.status==='binded_redirect')throw new Error('这个微信已绑定本机的已有连接；请切换到原连接，需要恢复时在原连接重新扫码。');
          if(result.status==='expired')throw new Error('二维码已过期，请点击扫码连接重新获取');
          if(result.status==='scaned_but_redirect'&&result.redirect_host)host=api.validate('https://'+result.redirect_host);
          qr.status=result.status==='scaned'?'已扫码，请在手机确认':'等待扫码';changed();await wait(loginDelay,controller.signal);
        }
        if(!controller.signal.aborted)throw new Error('扫码登录超时，请重新获取二维码');
      }catch(e){if(!controller.signal.aborted){status='error';qr=null;tellError(e.message);}}
    })();
  }
  return {
    snapshot,
    // 仅供连接管理器调度，避免计算队列时读取历史标题或传递正文与凭据。
    schedulingState:()=>({enabled:state.enabled,connected:Boolean(state.account),jobs:state.jobs.map(({id,state,startedAt})=>({id,state,startedAt}))}),
    wake:schedule,
    start(){if(!loadError&&state.enabled&&state.account){try{persist();startPoll();}catch{}}else if(loadError){status='error';changed();}},
    async action(name,value) {
      if(name==='login') {try{await login();}catch(e){status='error';tellError(e.message);throw e;}}
      else if(name==='cancel-login'){loginController?.abort();loginController=null;qr=null;status='paused';changed();}
      else if(name==='save-clients') {
        if(active||state.jobs.some(j=>['queued','recovering'].includes(j.state)))throw new Error('请先停止或等待任务结束，再修改客户端');
        const clients=validateClients(value);
        // 名称和优先级不改变账号身份；更换客户端身份时必须清除旧会话，避免跨账号续接。
        const identity=client=>JSON.stringify([client.backend,client.binary,client.configHome,client.profile]);
        for(const binding of Object.values(state.bindings)) {
          const before=state.clients.find(client=>client.id===binding.clientId),after=clients.find(client=>client.id===binding.clientId);
          if(before&&after&&identity(before)!==identity(after)){binding.threadId='';delete binding.threadName;delete binding.transport;binding.id=randomUUID();}
        }
        state.clients=clients;invalidateQueries();persist();changed();
      }
      else if(name==='check') {
        const clients=value?state.clients.filter(client=>client.id===value):enabledClients();
        if(!clients.length)throw new Error('请先启用并保存客户端');
        for(const client of clients)resolveBinary(validateSettings(client,{requireCwd:false}));
        error='';changed();return '已找到客户端；沿用本机配置，实际登录与服务连接会在首次任务时验证。';
      }
      // 发现操作只返回本机候选项，不启用、不保存，也不启动模型任务。
      else if(name==='discover-clients')return discoverClients();
      else if(name==='enable') {
        if(typeof value!=='boolean')throw new Error('连接设置无效');
        if(value&&!state.account)throw new Error('请先扫码连接微信');
        if(value&&state.account.stale)throw new Error('微信登录已失效，请重新扫码恢复连接');
        loginController?.abort();loginController=null;qr=null;
        state.enabled=value;persist();if(value)startPoll();else{stopPoll();stopTask();invalidateQueries();status=state.account?.stale?'expired':'paused';changed();}
      } else if(name==='allow-user') {
        if(!state.pending.includes(value))throw new Error('联系人尚未发来消息');
        state.allowed=[...new Set([...state.allowed,value])];state.pending=state.pending.filter(v=>v!==value);persist();changed();
      } else if(name==='remove-user') {
        state.allowed=state.allowed.filter(v=>v!==value);state.pending=state.pending.filter(v=>v!==value);delete state.contexts[value];
        delete state.bindings[bindingKey(state.account?.id,value)];invalidateQueries();
        if(active?.job.sender===value)stopTask();
        for(const job of state.jobs)if(job.sender===value&&(job.state==='queued'||job.state==='recovering'&&active?.job!==job)){job.state='cancelled';delete job.text;}
        state.outbox=state.outbox.filter(item=>item.sender!==value);persist();changed();
      } else if(name==='task-detail') {
        const job=state.jobs.find(job=>job.id===value);if(!job)throw new Error('任务记录不存在或已清理');
        // 正文只响应小屋的主动查看，不进入每 200ms 广播的快照，也不读取客户端其他轮次。
        return {id:job.id,request:job.exchange?.request??job.text??null,response:job.exchange?.response??null};
      } else if(name==='delete-task') {
        const job=state.jobs.find(job=>job.id===value);if(!job)throw new Error('任务记录不存在或已清理');
        if(active?.job===job||['queued','running','approval','question','recovering'].includes(job.state))throw new Error('请等待任务结束后再删除记录');
        if(!canDeleteJob(job))throw new Error('仅可删除失败、中断或取消的任务记录');
        // 同时移除该任务尚未发出的结果，保留去重游标与其他任务，避免删除后重发或重跑。
        const removed=state.outbox.filter(item=>item.jobId===job.id);
        state.outbox=state.outbox.filter(item=>item.jobId!==job.id);state.jobs=state.jobs.filter(item=>item!==job);
        if(removed.some(item=>item.id===failedDeliveryId)){deliveryError='';failedDeliveryId='';deliveryRetryAt=0;deliveryFailures=0;}
        persist();changed();void flush();
      } else if(name==='retry'){deliveryError='';deliveryRetryAt=0;void flush();changed();}
      else if(name==='forget') {
        const clients=state.clients;
        loginController?.abort();loginController=null;stopPoll();stopTask();invalidateQueries();active=null;qr=null;store.remove();state=fresh();state.clients=clients;loadError='';error='';deliveryError='';failedDeliveryId='';deliveryRetryAt=0;deliveryFailures=0;status='disconnected';
        if(store.available())persist();changed();
      }else throw new Error('未知微信操作');
      return snapshot();
    },
    close(){
      if(closed)return;closed=true;
      // 退出只拆掉桌面监听，保留已提交轮次；主动 /stop、停用及撤权仍按原规则停止任务。
      const current=active;active=null;
      if(current?.handle?.detach)current.handle.detach();else current?.handle?.cancel();
      loginController?.abort();stopPoll();stopTask();invalidateQueries();for(const reader of titleReaders.values())reader.close();titleReaders.clear();
    }
  };
}
module.exports={createWechatGateway,HELP,wait};
