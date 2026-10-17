'use strict';
const {execFile}=require('node:child_process');

function detectClients(processes) {
  if(typeof processes!=='string')throw new Error('无法读取客户端进程');
  const executables=processes.split('\n').map(line=>line.trim());
  // 只匹配桌面主程序；CLI、app-server、Helper 和后台 Agent 均不代表客户端仍打开。
  return {
    cursor:executables.some(file=>/\/Cursor\.app\/Contents\/MacOS\/Cursor$/.test(file)),
    codex:executables.some(file=>/\/(?:Codex\.app\/Contents\/MacOS\/Codex|ChatGPT\.app\/Contents\/MacOS\/ChatGPT)$/.test(file))
  };
}
function readClientPresence({listProcesses}={}) {
  const read=listProcesses||(()=>new Promise((resolve,reject)=>{
    // 只读可执行文件路径，不读取命令参数、窗口标题或聊天内容。
    execFile('/bin/ps',['-axo','comm='],{timeout:1500,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout));
  }));
  return Promise.resolve().then(read).then(detectClients).catch(()=>null);
}
module.exports={detectClients,readClientPresence};
