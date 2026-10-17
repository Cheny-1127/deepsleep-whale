'use strict';
const fs=require('node:fs');
const net=require('node:net');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IGNORE=Symbol('ignore'),MAX_FRAME=32*1024*1024;
const turnFields=new Set(['turnId','rootTurnId','status']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const projectTurn=value=>object(value)?Object.fromEntries([...turnFields].filter(k=>typeof value[k]==='string').map(k=>[k,value[k]])):null;
const requestId=value=>typeof value==='string'||Number.isSafeInteger(value)?String(value):null;
const projectRequest=value=>object(value)?{id:requestId(value.id),params:{itemId:typeof value.params?.itemId==='string'?value.params.itemId:null,turnId:typeof value.params?.turnId==='string'?value.params.turnId:null}}:null;
function projectHistory(value) {
  if(!object(value))return null;
  const entities=value.history?.entitiesByKey;
  return {kind:typeof value.kind==='string'?value.kind:null,history:{entitiesByKey:object(entities)?Object.fromEntries(Object.entries(entities).map(([k,v])=>[k,projectTurn(v)])):null}};
}
// 快照/补丁在内存解析后立即丢弃正文；只保留轮次、请求/调用 ID 和运行状态。
function project(value,parts=[]) {
  const [root,a,b,c,d]=parts;
  if(!parts.length)return object(value)?{
    id:typeof value.id==='string'?value.id:null,requests:project(value.requests,['requests']),
    threadRuntimeStatus:project(value.threadRuntimeStatus,['threadRuntimeStatus']),
    turns:Array.isArray(value.turns)?value.turns.map(projectTurn):[],turnHistory:projectHistory(value.turnHistory)
  }:null;
  if(root==='requests') {
    if(parts.length===1)return Array.isArray(value)?value.map(projectRequest):null;
    if(parts.length===2)return projectRequest(value);
    if(parts.length===3&&b==='id')return requestId(value);
    if(b==='params') {
      if(parts.length===3)return projectRequest({params:value})?.params;
      if(parts.length===4&&['itemId','turnId'].includes(c))return typeof value==='string'?value:null;
    }
    return IGNORE;
  }
  if(root==='threadRuntimeStatus') {
    if(parts.length===1)return object(value)?{type:typeof value.type==='string'?value.type:null,activeFlags:Array.isArray(value.activeFlags)&&value.activeFlags.every(v=>typeof v==='string')?[...value.activeFlags]:null}:null;
    if(a==='type'&&parts.length===2)return typeof value==='string'?value:null;
    if(a==='activeFlags')return parts.length===2?(Array.isArray(value)&&value.every(v=>typeof v==='string')?[...value]:null):parts.length===3?(typeof value==='string'?value:null):IGNORE;
    return IGNORE;
  }
  if(root==='turns') {
    if(parts.length===1)return Array.isArray(value)?value.map(projectTurn):null;
    if(parts.length===2)return projectTurn(value);
    return parts.length===3&&turnFields.has(b)?(typeof value==='string'?value:null):IGNORE;
  }
  if(root==='turnHistory') {
    if(parts.length===1)return projectHistory(value);
    if(a==='kind'&&parts.length===2)return typeof value==='string'?value:null;
    if(a!=='history')return IGNORE;
    if(parts.length===2)return projectHistory({history:value})?.history;
    if(b!=='entitiesByKey')return IGNORE;
    if(parts.length===3)return object(value)?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,projectTurn(v)])):null;
    if(parts.length===4)return projectTurn(value);
    return parts.length===5&&turnFields.has(d)?(typeof value==='string'?value:null):IGNORE;
  }
  return IGNORE;
}
function applyPatch(data,patch) {
  const parts=patch.path;
  if(!Array.isArray(parts)||parts.some(k=>!['string','number'].includes(typeof k)||['__proto__','prototype','constructor'].includes(k))||!['add','replace','remove'].includes(patch.op))return false;
  const value=project(patch.value,parts);
  if(value===IGNORE)return true;
  if(!parts.length)return false;
  let parent=data;
  for(const key of parts.slice(0,-1)) {
    if(!object(parent)&&!Array.isArray(parent)||!Object.hasOwn(parent,key))return false;
    parent=parent[key];
  }
  const key=parts.at(-1);
  if(Array.isArray(parent)) {
    if(!Number.isInteger(Number(key))||Number(key)<0||Number(key)>parent.length)return false;
    const index=Number(key);
    if(patch.op==='remove'||patch.op==='replace') {if(index>=parent.length)return false;}
    if(patch.op==='remove')parent.splice(index,1);
    else if(patch.op==='add')parent.splice(index,0,value);
    else parent[index]=value;
  } else if(object(parent)) {
    if(patch.op==='remove')delete parent[key];else parent[key]=value;
  } else return false;
  return true;
}
class RuntimeProjection {
  constructor(){this.revision=null;this.data=null;}
  update(change) {
    if(!change||!Number.isSafeInteger(change.revision)||change.revision<0){this.data=null;return false;}
    if(change.type==='snapshot')this.data=project(change.conversationState);
    else if(change.type==='patches'&&this.data&&change.baseRevision===this.revision&&change.revision>this.revision&&Array.isArray(change.patches)) {
      for(const patch of change.patches)if(!applyPatch(this.data,patch)){this.data=null;return false;}
    } else {this.data=null;return false;}
    this.revision=change.revision;
    return Boolean(this.data);
  }
  observation(sessionId,turnId) {
    const data=this.data,status=data?.threadRuntimeStatus;
    if(data?.id!==sessionId||!Array.isArray(data.requests)||!status||!['active','idle'].includes(status.type))return null;
    const turns=data.turnHistory?.kind==='canonical'?Object.values(data.turnHistory.history?.entitiesByKey||{}):data.turns;
    const turn=turns?.find(t=>t&&(t.turnId===turnId||t.rootTurnId===turnId));
    if(!turn||status.type==='active'&&turn.status!=='inProgress')return null;
    if(status.type==='active'&&(!Array.isArray(status.activeFlags)||status.activeFlags.some(f=>!['waitingOnApproval','waitingOnUserInput'].includes(f))))return null;
    const requests=data.requests.filter(r=>r?.id&&r.params?.itemId&&(!r.params.turnId||r.params.turnId===turnId)).map(r=>({id:r.id,itemId:r.params.itemId}));
    return {sessionId,turnId,waiting:data.requests.length>0||status.type==='active'&&status.activeFlags.length>0,active:status.type==='active',requests};
  }
}
function safeSocket(file) {
  try {
    const socket=fs.lstatSync(file),dir=fs.lstatSync(path.dirname(file)),uid=process.getuid?.();
    return uid!==undefined&&socket.isSocket()&&socket.uid===uid&&dir.isDirectory()&&dir.uid===uid&&!(dir.mode&0o022)&&!(socket.mode&0o077);
  } catch {return false;}
}
function createCodexRuntime({socketPath=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'ipc','ipc.sock'),onState=()=>{},onReset=()=>{},onStatus=()=>{},retryMs=2000}={}) {
  let socket=null,clientId=null,timer=null,handshake=null,closed=false;
  const sessions=new Map(),projections=new Map(),owners=new Map();
  let status={state:'disconnected',lastSyncedAt:null};
  function setStatus(state){status={...status,state};onStatus({...status});}
  function send(message){if(!socket?.writable)return;const body=Buffer.from(JSON.stringify(message)),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.write(Buffer.concat([head,body]));}
  function follow(id,following){if(clientId)send({type:'broadcast',method:'thread-stream-following-changed',sourceClientId:clientId,version:1,params:{conversationId:id,hostId:'local',following}});}
  function reset(){projections.clear();owners.clear();onReset();}
  function schedule(){if(!closed&&sessions.size&&!timer){timer=setTimeout(()=>{timer=null;connect();},retryMs);timer.unref?.();}}
  function connect() {
    if(closed||socket||!sessions.size)return;
    // 只连接已存在且属于当前用户的私有 socket；绝不启动、接管或修改 Codex 服务。
    if(!safeSocket(socketPath)){setStatus('unavailable');schedule();return;}
    let bytes=Buffer.alloc(0);const current=net.createConnection(socketPath);socket=current;setStatus('connecting');
    const requestId=randomUUID();
    current.on('connect',()=>{
      send({type:'request',requestId,sourceClientId:'',version:0,method:'initialize',params:{clientType:'whale-status-observer'}});
      handshake=setTimeout(()=>current.destroy(),3000);handshake.unref?.();
    });
    function receive(message) {
      if(message.type==='client-discovery-request') {
        send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});return;
      }
      // 不提供任何请求处理器，包括批准、拒绝、发消息和修改客户端设置。
      if(message.type==='request') {send({type:'response',requestId:message.requestId,resultType:'error',error:'no-handler-for-request'});return;}
      if(message.type==='response'&&message.requestId===requestId) {
        if(message.resultType!=='success'||message.method!=='initialize'||typeof message.result?.clientId!=='string'){current.destroy();return;}
        clearTimeout(handshake);clientId=message.result.clientId;setStatus('connected');
        for(const id of sessions.keys())follow(id,true);
        return;
      }
      const params=message.params,id=params?.conversationId;
      if(message.type==='broadcast'&&message.method==='client-status-changed'&&params?.status==='disconnected'&&[...owners.values()].includes(params.clientId)){current.destroy();return;}
      if(message.type!=='broadcast'||message.method!=='thread-stream-state-changed'||params?.hostId!=='local'||!sessions.has(id)||!clientId||message.targetClientIds&&!message.targetClientIds.includes(clientId))return;
      // 此协议来自当前桌面版，非稳定公共 API。版本、来源或补丁链异常即重连，期间不清理待处理。
      if(message.version!==11||typeof message.sourceClientId!=='string'){setStatus('unsupported');current.destroy();return;}
      if(owners.has(id)&&owners.get(id)!==message.sourceClientId){current.destroy();return;}
      owners.set(id,message.sourceClientId);
      let projection=projections.get(id);
      if(!projection){projection=new RuntimeProjection();projections.set(id,projection);}
      if(!projection.update(params.change)){current.destroy();return;}
      const observation=projection.observation(id,sessions.get(id));
      if(observation){status.lastSyncedAt=Date.now();onState(observation);}
    }
    current.on('data',chunk=>{
      if(socket!==current)return;
      try {
        bytes=Buffer.concat([bytes,chunk]);
        while(bytes.length>=4){const size=bytes.readUInt32LE(0);if(!size||size>MAX_FRAME)throw Error('invalid frame');if(bytes.length<size+4)break;
          const message=JSON.parse(bytes.subarray(4,size+4).toString('utf8'));bytes=bytes.subarray(size+4);receive(message);if(current.destroyed)break;}
      } catch {current.destroy();}
    });
    current.on('error',()=>current.destroy());
    current.on('close',()=>{if(socket!==current)return;clearTimeout(handshake);socket=null;clientId=null;reset();setStatus('disconnected');schedule();});
  }
  return {
    setSessions(items) {
      const next=new Map(items.filter(s=>UUID.test(s.session_id)&&typeof s.turn_id==='string'&&s.turn_id!=='unknown').slice(0,100).map(s=>[s.session_id,s.turn_id]));
      for(const id of sessions.keys())if(!next.has(id)){follow(id,false);projections.delete(id);owners.delete(id);}
      for(const [id,turn] of next)if(!sessions.has(id))follow(id,true);
      sessions.clear();for(const entry of next)sessions.set(...entry);
      if(!sessions.size){clearTimeout(timer);timer=null;socket?.destroy();return;}
      connect();
    },
    snapshot(){return {...status};},
    close(){closed=true;clearTimeout(timer);clearTimeout(handshake);for(const id of sessions.keys())follow(id,false);sessions.clear();socket?.destroy();reset();}
  };
}
module.exports={createCodexRuntime,RuntimeProjection};
