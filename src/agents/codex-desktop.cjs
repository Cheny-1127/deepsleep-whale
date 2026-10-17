'use strict';
const fs=require('node:fs'),net=require('node:net'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {AgentError}=require('./agent-error.cjs');
const IGNORE=Symbol('ignore'),MAX_FRAME=64*1024*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'?value:null;
function item(value) {
  if(!object(value))return null;
  if(value.type==='agentMessage')return {type:value.type,id:text(value.id),text:text(value.text),phase:text(value.phase)};
  if(value.type==='fileChange')return {type:value.type,id:text(value.id),changes:Array.isArray(value.changes)?value.changes.map(change=>({path:text(change.path),diff:text(change.diff)})):[]};
  return {type:text(value.type),id:text(value.id)};
}
function approval(value) {
  if(!object(value))return null;
  const params=value.params||{};
  return {id:typeof value.id==='string'||Number.isSafeInteger(value.id)?value.id:null,method:text(value.method),params:{
    threadId:text(params.threadId),turnId:text(params.turnId),itemId:text(params.itemId),command:text(params.command),cwd:text(params.cwd),reason:text(params.reason),grantRoot:params.grantRoot??null}};
}
function turn(value) {
  return object(value)?{turnId:text(value.turnId),rootTurnId:text(value.rootTurnId),status:text(value.status),
    params:{clientUserMessageId:text(value.params?.clientUserMessageId)},items:Array.isArray(value.items)?value.items.map(item):[]}:null;
}
function turnPart(value,parts) {
  if(!parts.length)return turn(value);
  const [key,index,field]=parts;
  if(['turnId','rootTurnId','status'].includes(key)&&parts.length===1)return text(value);
  if(key==='params')return parts.length===1?{clientUserMessageId:text(value?.clientUserMessageId)}:parts.length===2&&index==='clientUserMessageId'?text(value):IGNORE;
  if(key!=='items')return IGNORE;
  if(parts.length===1)return Array.isArray(value)?value.map(item):null;
  if(parts.length===2)return item(value);
  if(field==='changes') {
    if(parts.length===3)return Array.isArray(value)?value.map(change=>({path:text(change.path),diff:text(change.diff)})):[];
    if(parts.length===4)return {path:text(value?.path),diff:text(value?.diff)};
    return parts.length===5&&['path','diff'].includes(parts[4])?text(value):IGNORE;
  }
  return parts.length===3&&['type','id','text','phase'].includes(field)?text(value):IGNORE;
}
// 仅在内存保留选中聊天的轮次关联与助手文本；工具输出、认证和其他字段不进入投影。
function project(value,parts=[]) {
  const [root,a,b]=parts;
  if(!parts.length)return object(value)?{id:text(value.id),cwd:text(value.cwd),threadRuntimeStatus:project(value.threadRuntimeStatus,['threadRuntimeStatus']),
    turns:project(value.turns,['turns']),turnHistory:project(value.turnHistory,['turnHistory']),requests:project(value.requests,['requests'])}:null;
  if(['id','cwd'].includes(root)&&parts.length===1)return text(value);
  if(root==='threadRuntimeStatus')return parts.length===1?{type:text(value?.type)}:parts.length===2&&a==='type'?text(value):IGNORE;
  if(root==='turns')return parts.length===1?(Array.isArray(value)?value.map(turn):[]):turnPart(value,parts.slice(2));
  if(root==='requests') {
    if(parts.length===1)return Array.isArray(value)?value.map(approval):[];
    if(parts.length===2)return approval(value);
    if(parts.length===3&&a!==undefined&&b==='params')return approval({params:value}).params;
    if(parts.length===3&&['id','method'].includes(b))return b==='id'&&(typeof value==='string'||Number.isSafeInteger(value))?value:text(value);
    return parts.length===4&&b==='params'&&['threadId','turnId','itemId','command','cwd','reason','grantRoot'].includes(parts[3])?value:IGNORE;
  }
  if(root!=='turnHistory')return IGNORE;
  if(parts.length===1)return object(value)?{kind:text(value.kind),history:project(value.history,['turnHistory','history'])}:null;
  if(parts.length===2&&a==='kind')return text(value);
  if(a!=='history')return IGNORE;
  if(parts.length===2)return {entitiesByKey:project(value?.entitiesByKey,['turnHistory','history','entitiesByKey'])};
  if(b!=='entitiesByKey')return IGNORE;
  return parts.length===3?(object(value)?Object.fromEntries(Object.entries(value).map(([key,t])=>[key,turn(t)])):{}):turnPart(value,parts.slice(4));
}
class DesktopProjection {
  constructor(){this.revision=null;this.data=null;}
  update(change) {
    if(!Number.isSafeInteger(change?.revision)||change.revision<0)return false;
    if(change.type==='snapshot'){this.data=project(change.conversationState);this.revision=change.revision;return Boolean(this.data);}
    // 增量必须接在已知版本之后；缺帧时停止转发，不能用不完整状态判断任务结束。
    if(change.type!=='patches'||!this.data||change.baseRevision!==this.revision||change.revision<=this.revision||!Array.isArray(change.patches))return false;
    for(const patch of change.patches) {
      const parts=patch.path;
      if(!Array.isArray(parts)||parts.some(key=>!['string','number'].includes(typeof key)||['__proto__','prototype','constructor'].includes(key))||!['add','replace','remove'].includes(patch.op))return false;
      const value=project(patch.value,parts);if(value===IGNORE)continue;
      if(!parts.length){if(patch.op==='remove'||!value)return false;this.data=value;continue;}
      let parent=this.data;
      for(const key of parts.slice(0,-1)){if(!object(parent)&&!Array.isArray(parent)||!Object.hasOwn(parent,key))return false;parent=parent[key];}
      const key=parts.at(-1);
      if(Array.isArray(parent)) {
        const index=Number(key);if(!Number.isInteger(index)||index<0||index>parent.length||patch.op!=='add'&&index===parent.length)return false;
        if(patch.op==='remove')parent.splice(index,1);else if(patch.op==='add')parent.splice(index,0,value);else parent[index]=value;
      }else if(object(parent)){if(patch.op==='remove')delete parent[key];else parent[key]=value;}else return false;
    }
    this.revision=change.revision;return true;
  }
  turns(){return [...(this.data?.turns||[]),...Object.values(this.data?.turnHistory?.history?.entitiesByKey||{})].filter(Boolean);}
}
function desktopSocket(settings) {return path.join(settings.configHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'ipc','ipc.sock');}
function safeSocket(file) {
  try {
    const socket=fs.lstatSync(file),dir=fs.lstatSync(path.dirname(file)),uid=process.getuid?.();
    return uid!==undefined&&socket.isSocket()&&socket.uid===uid&&dir.isDirectory()&&dir.uid===uid&&!(dir.mode&0o022)&&!(socket.mode&0o077);
  }catch{return false;}
}
function startDesktopAgent({settings,text:prompt,session,onSession=()=>{},onApproval,timeoutMs=600000,rpcTimeoutMs=15000}) {
  let socket,clientId='',owner='',bytes=Buffer.alloc(0),done=false,submitted=false,cancelled=false,turnId='',starting=false,stopping=false;
  const messageId=randomUUID(),projection=new DesktopProjection(),pending=new Map(),reviewed=new Set();
  let resolveResult,rejectResult;
  const promise=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  const timer=setTimeout(()=>cancel('TIMEOUT'),timeoutMs);timer.unref?.();
  function send(message) {
    if(!socket?.writable||done)throw new AgentError(submitted?'DELIVERY_UNKNOWN':'DESKTOP_UNAVAILABLE','desktop');
    const body=Buffer.from(JSON.stringify(message)),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.write(Buffer.concat([head,body]));
  }
  function follow(following){send({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:clientId,targetClientIds:[owner],params:{hostId:'local',conversationId:session,following}});}
  function finish(error,result) {
    if(done)return;
    if(owner&&clientId&&socket?.writable)try{follow(false);}catch{}
    done=true;clearTimeout(timer);clearTimeout(streamTimer);
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(new AgentError(submitted?'DELIVERY_UNKNOWN':'DESKTOP_UNAVAILABLE','desktop'));}pending.clear();
    projection.data=null;socket?.end();socket?.destroy();
    error?rejectResult(error):resolveResult({text:result||'本轮没有返回文本结果。',session});
  }
  function request(method,params,version,targetClientId) {
    return new Promise((resolve,reject)=>{
      const requestId=randomUUID(),wait=setTimeout(()=>{pending.delete(requestId);reject(new AgentError(submitted?'DELIVERY_UNKNOWN':'DESKTOP_UNAVAILABLE','desktop'));},rpcTimeoutMs);wait.unref?.();
      pending.set(requestId,{resolve,reject,timer:wait,method});
      try{send({type:'request',requestId,method,version,sourceClientId:clientId,params,...(targetClientId?{targetClientId}:{}),timeoutMs:rpcTimeoutMs});}
      catch(error){clearTimeout(wait);pending.delete(requestId);reject(error);}
    });
  }
  async function interrupt(code) {
    if(done||stopping)return;
    if(!turnId){if(!submitted)finish(new AgentError(code,'desktop'));return;}
    stopping=true;
    try{await request('thread-follower-interrupt-turn',{conversationId:session,expectedTurnId:turnId,mode:'user-stop'},4,owner);finish(new AgentError(code,'desktop'));}
    catch(error){finish(error);}
  }
  let cancelCode='CANCELLED';
  function cancel(code='CANCELLED'){cancelled=true;cancelCode=code;void interrupt(code);}
  function reviewApprovals(own) {
    if(!onApproval||!turnId||own?.status!=='inProgress')return;
    for(const entry of projection.data.requests||[]) {
      if(!entry||reviewed.has(entry.id)||entry.id===null||entry.params.threadId!==session||entry.params.turnId!==turnId)continue;
      const command=entry.method==='item/commandExecution/requestApproval',file=entry.method==='item/fileChange/requestApproval';
      if(!command&&!file)continue;
      const detail=command?entry.params.command:own.items.find(item=>item?.type==='fileChange'&&item.id===entry.params.itemId)?.changes?.map(change=>`${change.path}\n${change.diff||''}`).join('\n');
      if(!detail||detail.length>8000||entry.params.grantRoot)continue;
      reviewed.add(entry.id);
      void Promise.resolve().then(()=>onApproval({kind:command?'command':'file',detail:[detail,entry.params.reason].filter(Boolean).join('\n'),cwd:entry.params.cwd||settings.cwd}))
        .then(accepted=>{
          if(done||cancelled||!projection.data?.requests?.some(current=>current?.id===entry.id&&current.params.turnId===turnId))return;
          return request(command?'thread-follower-command-approval-decision':'thread-follower-file-approval-decision',
            {conversationId:session,requestId:entry.id,decision:accepted?'accept':'decline'},1,owner);
        }).catch(()=>finish(new AgentError('INTERACTION','desktop')));
    }
  }
  function observe() {
    if(done)return;
    const data=projection.data;
    if(data?.id!==session)throw new AgentError('DESKTOP_PROTOCOL','desktop');
    let cwd;try{cwd=fs.realpathSync(data.cwd);}catch{throw new AgentError('PROJECT','desktop');}
    if(cwd!==settings.cwd)throw new AgentError('PROJECT','desktop');
    // 用本次消息 ID 建立轮次关联，再跟踪服务端轮次 ID，排除旧历史和桌面其他任务。
    const matches=projection.turns().filter(turn=>turn.params?.clientUserMessageId===messageId||turnId&&turn.turnId===turnId);
    const own=matches.find(turn=>['completed','failed','interrupted'].includes(turn.status))||matches[0];
    if(own?.turnId){if(turnId&&turnId!==own.turnId)throw new AgentError('DESKTOP_PROTOCOL','desktop');turnId=own.turnId;}
    if(cancelled){void interrupt(cancelCode);return;}
    if(own&&['completed','failed','interrupted'].includes(own.status)) {
      if(own.status!=='completed'){finish(new AgentError('TURN_FAILED','desktop'));return;}
      const answers=own.items.filter(item=>item?.type==='agentMessage'),finals=answers.filter(item=>item.phase==='final_answer');
      const result=(finals.length?finals:answers.filter(item=>!item.phase)).map(item=>item.text||'').join('\n\n');
      if(result.length>100000)throw new AgentError('REPLY_LIMIT','desktop');
      finish(null,result);return;
    }
    reviewApprovals(own);
    if(submitted||starting)return;
    if(data.threadRuntimeStatus?.type==='active')return;
    if(data.threadRuntimeStatus?.type!=='idle')throw new AgentError('DESKTOP_PROTOCOL','desktop');
    // 发出请求即视为可能已送达；断线或响应丢失时不重投，防止同一任务执行两次。
    starting=true;submitted=true;
    // 交给原会话 owner 处理；不传模型、cwd、provider、权限或额外提示。
    void request('thread-follower-start-turn',{conversationId:session,turnStart:{request:{threadId:session,input:[{type:'text',text:prompt,text_elements:[]}],clientUserMessageId:messageId},context:{inheritThreadSettings:true}}},2,owner)
      .then(response=>{
        if(done)return;
        const id=response.result?.result?.turn?.id;
        if(typeof id!=='string'||turnId&&id!==turnId)throw new AgentError('DELIVERY_UNKNOWN','desktop');
        turnId=id;observe();
      }).catch(error=>finish(error));
  }
  function receive(message) {
    if(done)return;
    if(message.type==='client-discovery-request'){send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});return;}
    if(message.type==='request'){send({type:'response',requestId:message.requestId,resultType:'error',error:'no-handler-for-request'});return;}
    if(message.type==='response') {
      const waiting=pending.get(message.requestId);if(!waiting)return;
      pending.delete(message.requestId);clearTimeout(waiting.timer);
      if(message.resultType!=='success')waiting.reject(new AgentError(waiting.method==='thread-follower-start-turn'?'DELIVERY_UNKNOWN':'DESKTOP_UNAVAILABLE','desktop'));
      else if(message.method!==waiting.method||owner&&message.handledByClientId!==owner)waiting.reject(new AgentError('DESKTOP_PROTOCOL','desktop'));
      else waiting.resolve(message);
      return;
    }
    if(message.type!=='broadcast'||!owner||message.targetClientIds&&!message.targetClientIds.includes(clientId))return;
    if(message.method==='client-status-changed'&&message.params?.clientId===owner&&message.params.status==='disconnected')throw new AgentError(submitted?'DELIVERY_UNKNOWN':'DESKTOP_UNAVAILABLE','desktop');
    if(message.method!=='thread-stream-state-changed'||message.params?.hostId!=='local'||message.params?.conversationId!==session)return;
    if(message.version!==11||message.sourceClientId!==owner||!projection.update(message.params.change))throw new AgentError('DESKTOP_PROTOCOL','desktop');
    clearTimeout(streamTimer);observe();
  }
  let streamTimer;
  async function connect() {
    const file=desktopSocket(settings);
    if(!session||!safeSocket(file))throw new AgentError('DESKTOP_UNAVAILABLE','desktop');
    socket=net.createConnection(file);
    socket.on('data',chunk=>{
      if(done)return;
      try {
        bytes=Buffer.concat([bytes,chunk]);
        while(bytes.length>=4) {
          const size=bytes.readUInt32LE(0);if(!size||size>MAX_FRAME)throw new AgentError('DESKTOP_PROTOCOL','desktop');
          if(bytes.length<size+4)break;
          const message=JSON.parse(bytes.subarray(4,size+4).toString('utf8'));bytes=bytes.subarray(size+4);receive(message);if(done)break;
        }
      }catch(error){finish(error instanceof AgentError?error:new AgentError('DESKTOP_PROTOCOL','desktop'));}
    });
    socket.on('error',()=>finish(new AgentError(submitted?'DELIVERY_UNKNOWN':'DESKTOP_UNAVAILABLE','desktop')));
    socket.on('close',()=>{if(!done)finish(new AgentError(submitted?'DELIVERY_UNKNOWN':'DESKTOP_UNAVAILABLE','desktop'));});
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
    const initialized=await request('initialize',{clientType:'whale-wechat-forwarder'},0);
    clientId=initialized.result?.clientId;if(typeof clientId!=='string'||!clientId)throw new AgentError('DESKTOP_PROTOCOL','desktop');
    const discovered=await request('thread-owner-discovery',{hostId:'local',conversationId:session},1);
    owner=discovered.handledByClientId;if(typeof owner!=='string'||!owner)throw new AgentError('DESKTOP_PROTOCOL','desktop');
    onSession(session);follow(true);
    streamTimer=setTimeout(()=>finish(new AgentError('DESKTOP_PROTOCOL','desktop')),rpcTimeoutMs);streamTimer.unref?.();
  }
  void connect().catch(error=>finish(error instanceof AgentError?error:new AgentError('DESKTOP_UNAVAILABLE','desktop')));
  return {promise,cancel};
}
module.exports={startDesktopAgent,desktopSocket,DesktopProjection};
