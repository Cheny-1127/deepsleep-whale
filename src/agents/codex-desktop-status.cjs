'use strict';
const net=require('node:net');
const {randomUUID}=require('node:crypto');
const {desktopSocket,safeSocket}=require('./codex-desktop.cjs');
const {RuntimeProjection}=require('../clients/codex-runtime.cjs');
const LABELS={active:'运行中',idle:'空闲',approval:'等待审批',question:'等待回答',unknown:'状态未知'};
function runtimeStatus(data) {
  const status=data?.threadRuntimeStatus;
  if(status?.type==='idle')return 'idle';
  if(status?.type!=='active'||!Array.isArray(status.activeFlags)||status.activeFlags.some(flag=>!['waitingOnApproval','waitingOnUserInput'].includes(flag)))return 'unknown';
  if(status.activeFlags.includes('waitingOnApproval'))return 'approval';
  if(status.activeFlags.includes('waitingOnUserInput'))return 'question';
  return 'active';
}
// 桌面冷会话的首个快照可能需要数秒；状态查询最多等待 10 秒。
// 一次性只读订阅：不启动 app-server，不提交消息，不处理审批，不保存正文。
function readDesktopStatus(settings,session,{signal,timeoutMs=10000}={}) {
  return new Promise(resolve=>{
    let socket,clientId='',owner='',done=false,bytes=Buffer.alloc(0),pending;
    const projection=new RuntimeProjection();
    const timer=setTimeout(()=>finish(),timeoutMs);
    function send(message){const body=Buffer.from(JSON.stringify(message)),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.write(Buffer.concat([head,body]));}
    function follow(following){send({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:clientId,targetClientIds:[owner],params:{hostId:'local',conversationId:session,following}});}
    function finish(status='unknown') {
      if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(socket?.writable&&clientId&&owner)try{follow(false);}catch{}
      projection.data=null;socket?.destroy();resolve(status);
    }
    const abort=()=>finish();
    function request(method,params,version){pending={requestId:randomUUID(),method};send({type:'request',...pending,sourceClientId:clientId,version,params});}
    function receive(message) {
      if(message.type==='client-discovery-request'){send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});return;}
      if(message.type==='request'){send({type:'response',requestId:message.requestId,resultType:'error',error:'no-handler-for-request'});return;}
      if(message.type==='response'&&message.requestId===pending?.requestId) {
        if(message.resultType!=='success'||message.method!==pending.method){finish();return;}
        const method=pending.method;pending=null;
        if(method==='initialize') {
          clientId=message.result?.clientId;if(typeof clientId!=='string'||!clientId){finish();return;}
          request('thread-owner-discovery',{hostId:'local',conversationId:session},1);
        }else{
          owner=message.handledByClientId;if(typeof owner!=='string'||!owner){finish();return;}
          follow(true);
        }
        return;
      }
      if(message.type!=='broadcast'||!owner||message.targetClientIds&&!message.targetClientIds.includes(clientId))return;
      if(message.method==='client-status-changed'&&message.params?.clientId===owner&&message.params.status==='disconnected'){finish();return;}
      if(message.method!=='thread-stream-state-changed'||message.params?.hostId!=='local'||message.params?.conversationId!==session)return;
      if(message.version!==11||message.sourceClientId!==owner||!projection.update(message.params.change)||projection.data?.id!==session){finish();return;}
      finish(runtimeStatus(projection.data));
    }
    if(signal?.aborted){finish();return;}
    signal?.addEventListener('abort',abort,{once:true});
    try {
      const file=desktopSocket(settings);
      if(!session||!safeSocket(file)){finish();return;}
      socket=net.createConnection(file);
      socket.on('connect',()=>{if(!done)request('initialize',{clientType:'whale-wechat-status'},0);});
      socket.on('error',()=>finish());socket.on('close',()=>finish());
      socket.on('data',chunk=>{
        if(done)return;
        try {
          bytes=Buffer.concat([bytes,chunk]);
          while(bytes.length>=4) {
            const size=bytes.readUInt32LE(0);if(!size||size>32*1024*1024){finish();return;}
            if(bytes.length<size+4)break;
            const message=JSON.parse(bytes.subarray(4,size+4).toString('utf8'));bytes=bytes.subarray(size+4);receive(message);if(done)break;
          }
        }catch{finish();}
      });
    }catch{finish();}
  });
}
module.exports={readDesktopStatus,runtimeStatus,statusLabel:status=>LABELS[status]||LABELS.unknown};
