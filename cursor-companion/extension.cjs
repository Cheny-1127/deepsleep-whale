'use strict';
const vscode=require('vscode');
const net=require('node:net');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {SOCKET_NAME,PENDING_NAME,parseJumpRequest}=require('./protocol.cjs');
const directory=path.join(os.homedir(),'Library','Application Support','deepsleep-whale-pet');
const seen=new Set();
function report(packet) {
  const client=net.createConnection(path.join(directory,'events.sock'));
  client.setTimeout(1500,()=>client.destroy());
  client.on('error',()=>{});
  client.on('connect',()=>client.end(JSON.stringify(packet)+'\n'));
}
function delay(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
async function openInGlass(packet) {
  if(!packet||seen.has(packet.request))return;
  seen.add(packet.request);
  let ok=false;
  try {
    const started=Date.now();
    while(Date.now()-started<12000) {
      const attempt=Date.now();
      // 只在智能体窗口执行；返回 true 表示该本地对话已被选中。
      ok=await vscode.commands.executeCommand('glass.openAgentById',packet.id)===true;
      if(ok||Date.now()-attempt>2000)break;
      await delay(400);
    }
    if(!ok)vscode.window.showErrorMessage('鲸鱼娘未能在智能体窗口找到这个对话。');
  } catch {
    vscode.window.showErrorMessage('鲸鱼娘未能打开这个 Cursor 对话，请确认聊天仍存在且 Cursor 版本兼容。');
  } finally { report({type:'cursor-chat-result',request:packet.request,session_id:`cursor:${packet.id}`,ok}); }
}
function consumePending() {
  const file=path.join(directory,PENDING_NAME);
  let text;
  try { text=fs.readFileSync(file,'utf8');fs.unlinkSync(file); }
  catch { return; }
  let data;
  try { data=JSON.parse(text); }
  catch { return; }
  if(typeof data.expires==='number'&&data.expires<Date.now())return;
  openInGlass(parseJumpRequest(JSON.stringify({id:data.id,request:data.request})));
}
function claimListener(context) {
  const file=path.join(directory,SOCKET_NAME);
  const start=retry=>{
    const server=net.createServer(client=>{
      client.on('error',()=>{});
      let body='';
      client.on('data',chunk=>{
        body+=chunk.toString();
        if(Buffer.byteLength(body)>1024){client.destroy();return;}
        if(!body.includes('\n'))return;
        client.end();
        openInGlass(parseJumpRequest(body));
      });
    });
    server.once('error',error=>{
      if(error.code!=='EADDRINUSE'||retry)return;
      const probe=net.createConnection(file);
      probe.once('connect',()=>probe.end());
      probe.once('error',()=>{try{fs.unlinkSync(file);}catch{}start(true);});
    });
    let owned=false;
    server.listen(file,()=>{
      owned=true;
      try { fs.chmodSync(file,0o600); } catch {}
      consumePending();
      try {
        const watcher=fs.watch(directory,(_event,name)=>{if(name===PENDING_NAME)consumePending();});
        context.subscriptions.push({dispose:()=>watcher.close()});
      } catch {}
    });
    context.subscriptions.push({dispose:()=>{server.close();if(owned)try{fs.unlinkSync(file);}catch{}}});
  };
  try { fs.mkdirSync(directory,{recursive:true,mode:0o700}); } catch { return; }
  start(false);
}
function activate(context) {
  // 自定义扩展链接会被 Cursor 强制送到 IDE，所以只在智能体窗口里监听本机跳转。
  vscode.commands.getCommands(true).then(commands=>{
    if(commands.includes('glass.openAgentById'))claimListener(context);
  });
}
module.exports={activate};
