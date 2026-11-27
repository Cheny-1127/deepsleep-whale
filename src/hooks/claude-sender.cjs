#!/usr/bin/env node
'use strict';
// 提醒脚本不作批准或拒绝决定；不写标准输出，避免内容被 Claude Code 当作上下文或决策。
const net=require('node:net');
const {adaptClaude}=require('./adapters.cjs');
const {sanitizeEvent}=require('../domain/activity.cjs');
const {socketPath}=require('./bridge.cjs');
const chunks=[];
let size=0,finished=false,socket;
function done() {
  if(finished)return;finished=true;socket?.destroy();process.exit(0);
}
// 800 毫秒兜底短于 Hooks 配置的 2 秒超时，也短于 SessionEnd 的默认时限。
setTimeout(done,800);
// 工具返回可能带图片等大块内容，解析后只保留标识，上限放宽到 16MB。
process.stdin.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024)done();else chunks.push(chunk);});
process.stdin.on('error',done);
process.stdin.on('end',()=>{
  try {
    const event=sanitizeEvent(adaptClaude(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    if(!event)return done();
    socket=net.createConnection(socketPath());
    socket.on('connect',()=>socket.write(JSON.stringify(event)+'\n'));
    for(const name of ['data','error','end'])socket.on(name,done);
  } catch {done();}
});
