'use strict';
const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const {once}=require('node:events');
const frame=value=>{const body=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32LE(body.length);return Buffer.concat([head,body]);};
async function desktopFixture({home,cwd=home,session='desktop-fixture',busy=false,autoComplete=false}={}) {
  const dir=path.join(home,'ipc');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const socketPath=path.join(dir,'ipc.sock'),connections=new Set(),wire=[];
  const previous={turnId:'previous-turn',status:busy?'inProgress':'completed',params:{clientUserMessageId:'old'},items:[{type:'agentMessage',id:'old-answer',phase:'final_answer',text:'private-history'}]};
  let revision=0,state={id:session,cwd,threadRuntimeStatus:{type:busy?'active':'idle',activeFlags:[]},requests:[],turnHistory:{kind:'canonical',history:{entitiesByKey:{old:previous}}}};
  const following=new Set();
  function broadcast(change,extra={}){for(const socket of following)if(!socket.destroyed)socket.write(frame({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'desktop-owner',targetClientIds:['whale-client'],params:{hostId:'local',conversationId:session,change},...extra}));}
  function snapshot(extra){broadcast({type:'snapshot',revision:++revision,conversationState:state},extra);}
  function patch(patches){broadcast({type:'patches',baseRevision:revision,revision:++revision,patches});}
  function idle(){state.threadRuntimeStatus.type='idle';previous.status='completed';snapshot();}
  function complete(text='桌面回复😀') {
    const turn=state.turnHistory.history.entitiesByKey.current;if(!turn)return;
    turn.items=[{type:'commandExecution',id:'tool',aggregatedOutput:'private-tool-output'},{type:'agentMessage',id:'progress',phase:'commentary',text:'private-progress'},{type:'agentMessage',id:'answer',phase:'final_answer',text}];
    turn.status='completed';state.threadRuntimeStatus.type='idle';snapshot();
  }
  const server=net.createServer(socket=>{
    connections.add(socket);let bytes=Buffer.alloc(0);socket.on('close',()=>{connections.delete(socket);following.delete(socket);});socket.on('error',()=>{});
    const respond=(m,result)=>socket.write(frame({type:'response',requestId:m.requestId,method:m.method,handledByClientId:'desktop-owner',resultType:'success',result}));
    socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4&&bytes.length>=bytes.readUInt32LE(0)+4){const size=bytes.readUInt32LE(0),m=JSON.parse(bytes.subarray(4,size+4));bytes=bytes.subarray(size+4);wire.push(m);
      if(m.type==='request'&&m.method==='initialize')respond(m,{clientId:'whale-client'});
      else if(m.type==='request'&&m.method==='thread-owner-discovery')respond(m,{supportsUntrustedAppInput:true});
      else if(m.method==='thread-stream-following-changed'){if(m.params.following){following.add(socket);snapshot();}else following.delete(socket);}
      else if(m.type==='request'&&m.method==='thread-follower-start-turn') {
        if(m.params.turnStart.request.input[0].text==='desktop-rejected'){socket.write(frame({type:'response',requestId:m.requestId,resultType:'error',error:'private-api-key https://private.example/rejected'}));continue;}
        const request=m.params.turnStart.request;
        state.threadRuntimeStatus.type='active';state.turnHistory.history.entitiesByKey.current={turnId:'forwarded-turn',status:'inProgress',params:{clientUserMessageId:request.clientUserMessageId},items:[]};snapshot();
        if(autoComplete)complete();
        respond(m,{result:{turn:{id:'forwarded-turn',status:'inProgress'}}});
      } else if(m.type==='request'&&m.method==='thread-follower-interrupt-turn')respond(m,{ok:true,interruptedTurnId:m.params.expectedTurnId});
      else if(m.type==='request'&&['thread-follower-command-approval-decision','thread-follower-file-approval-decision'].includes(m.method))respond(m,{ok:true});
    }});
  });server.listen(socketPath);await once(server,'listening');fs.chmodSync(socketPath,0o600);
  return {socketPath,wire,connections,snapshot,patch,broadcast,complete,idle,get state(){return state;},
    send(message){for(const socket of connections)socket.write(frame(message));},
    async close(){for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
module.exports={desktopFixture};
