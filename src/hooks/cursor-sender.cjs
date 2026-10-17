#!/usr/bin/env node
'use strict';
const net=require('node:net');
const {adaptCursor}=require('./adapters.cjs');
const {sanitizeEvent}=require('../domain/activity.cjs');
const {socketPath}=require('./bridge.cjs');
let body='',finished=false,socket;
let response=process.argv[2]==='beforeSubmitPrompt'?{continue:true}:{};
function done() {
  if(finished)return;finished=true;socket?.destroy();
  // 只采集非工具权限回调，不返回 permission 或自动继续任务的指令。
  process.stdout.write(JSON.stringify(response)+'\n',()=>process.exit(0));
}
setTimeout(done,800);
process.stdin.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>1024*1024)done();});
process.stdin.on('error',done);
process.stdin.on('end',()=>{
  try {
    const input=JSON.parse(body);
    if(input.hook_event_name==='beforeSubmitPrompt')response={continue:true};
    const event=sanitizeEvent(adaptCursor(input));
    if(!event)return done();
    socket=net.createConnection(socketPath());
    socket.on('connect',()=>socket.write(JSON.stringify(event)+'\n'));
    for(const name of ['data','error','end'])socket.on(name,done);
  } catch {done();}
});
