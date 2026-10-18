'use strict';
// No model or network calls. Mimics only the public client wire formats exercised by the gateway.
const fs=require('node:fs');
const readline=require('node:readline');
const record=value=>{if(process.env.WHALE_AGENT_FIXTURE_LOG)fs.appendFileSync(process.env.WHALE_AGENT_FIXTURE_LOG,JSON.stringify(value)+'\n');};
record({args:process.argv.slice(2),cwd:process.cwd(),configHome:process.env.CODEX_HOME});
if(!process.argv.includes('app-server')) {
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Cursor fixture 结论😀',session_id:'cursor-fixture'}));
}else {
  const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
  let threadId='codex-fixture';const turn={id:'turn-fixture',status:'completed'};
  const metadata=id=>({id,cwd:process.env.WHALE_AGENT_FIXTURE_CWD||process.cwd(),source:'vscode',name:'桌面对话',preview:'private-history-must-not-be-forwarded',status:{type:'idle'},turns:[]});
  let approval;
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);record(request);
    if(!request.method){if(request.id===90){approval=request.result;record({approval});complete();}if(request.id===91){record({userInput:request.result||request.error});complete();}return;}
    if(request.method==='initialized')return;
    if(request.method==='initialize')send({id:request.id,result:{userAgent:'fixture'}});
    else if(request.method==='thread/list')send({id:request.id,result:{data:[metadata('desktop-fixture')],nextCursor:null}});
    else if(request.method==='thread/read') {
      const thread=metadata(request.params.threadId);
      if(request.params.threadId==='foreign-cwd')thread.cwd='/';
      if(request.params.threadId==='busy-thread')thread.status={type:'active'};
      send({id:request.id,result:{thread}});
    }
    else if(['thread/start','thread/resume'].includes(request.method)){
      if(request.params.threadId==='rpc-resume-failed'){send({id:request.id,error:{code:-32600,message:'unsupported resume detail; Authorization: Bearer private-api-key; https://private.example/token'}});return;}
      threadId=request.params.threadId==='replaced-thread'?'wrong-thread':request.params.threadId||'codex-fixture';
      const thread=metadata(threadId);
      if(threadId==='large-history'&&!request.params.excludeTurns)thread.turns=[{id:'old-turn',items:[{type:'agentMessage',text:'x'.repeat(3*1024*1024)}]}];
      send({id:request.id,result:{thread}});
    }
    else if(request.method==='turn/start') {
      const text=request.params.input[0].text;
      if(text==='turn-rpc-failed'){send({id:request.id,error:{code:-32602,message:'invalid argument; api_key=private-api-key'}});return;}
      send({id:request.id,result:{turn}});send({method:'turn/started',params:{threadId,turn}});
      if(text==='turn-failed'){send({method:'turn/completed',params:{threadId,turn:{...turn,status:'failed',error:{message:'401 Unauthorized Bearer private-api-key',codexErrorInfo:'unauthorized'}}}});return;}
      if(text==='hang')return;
      if(text==='approval'){send({id:90,method:'item/commandExecution/requestApproval',params:{threadId,turnId:turn.id,command:'fixture-read',cwd:process.cwd()}});return;}
      if(['question','foreign-question','withdrawn-question'].includes(text)){
        send({id:91,method:'item/tool/requestUserInput',params:{threadId,turnId:text==='foreign-question'?'foreign-turn':turn.id,itemId:'question',questions:[{id:'mode',header:'处理方式',question:'如何处理？',options:[{label:'仅分析',description:'查看原因'},{label:'修改代码',description:'修复问题'}],isOther:true,isSecret:false}]}});
        if(text==='withdrawn-question')setTimeout(()=>{send({method:'serverRequest/resolved',params:{threadId,requestId:91}});complete();},30);
        return;
      }
      if(text==='async-question'){send({method:'item/completed',params:{threadId,turnId:turn.id,item:{id:'async-item',type:'agentMessage',phase:'commentary',text:'请选择处理方式',questions:[{title:'如何处理？',options:['仅分析','修改代码']}]}}});return;}
      complete();
    }else if(request.method==='turn/steer'){record({steeringInput:request.params});send({id:request.id,result:{turnId:turn.id}});complete();}
    else send({id:request.id,result:{}});
  });
  function complete(){
    send({method:'item/completed',params:{threadId,turnId:turn.id,item:{id:'answer',type:'agentMessage',text:'Codex fixture 结论😀'}}});
    send({method:'turn/completed',params:{threadId,turn}});
  }
}
