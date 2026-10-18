'use strict';
const {execFile}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {executable,resolveBinary}=require('../agents/local-agent.cjs');

function run(file,args,options={}) {
  return new Promise((resolve,reject)=>execFile(file,args,{encoding:'utf8',timeout:1500,maxBuffer:1024*1024,...options},(error,stdout)=>{
    // lsof 遇到刚退出的进程可返回 1；仅接受其已完整返回的记录，不接受超时/截断结果。
    if(error&&!(file==='/usr/sbin/lsof'&&error.code===1&&stdout))reject(error);else resolve(stdout);
  }));
}
function realPath(file){try{return fs.realpathSync(file);}catch{return file;}}
function defaultPaths(canonical){
  const binary=backend=>{try{return canonical(resolveBinary({backend}));}catch{return '';}};
  return {codexBinary:binary('codex'),codexHome:canonical(process.env.CODEX_HOME||path.join(os.homedir(),'.codex')),cursorBinary:binary('cursor')};
}
async function discoverRunningClients({platform=process.platform,listProcesses=()=>run('/bin/ps',['-axo','pid=,ppid=,comm=']),
  listOpenFiles=pids=>run('/usr/sbin/lsof',['-nP','-a','-p',pids.join(','),'-Fpn'],{timeout:4000,maxBuffer:4*1024*1024}),
  isExecutable=executable,canonical=realPath,defaults=defaultPaths(canonical)}={}) {
  if(platform!=='darwin')throw new Error('当前仅支持自动检测 macOS 桌面客户端，请自定义添加');
  let processes;
  // comm 仅包含程序路径；不读取进程参数、环境变量、认证文件或对话正文。
  try{processes=(await listProcesses()).split('\n').flatMap(line=>{
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return match?[{pid:Number(match[1]),parent:Number(match[2]),file:match[3].trim()}]:[];
  });}catch{throw new Error('无法检测运行中的客户端，请重试或自定义添加');}
  const desktops=processes.flatMap(process=>{
    const match=process.file.match(/^(.*\.app\/Contents)\/MacOS\/(ChatGPT|Codex|Cursor)$/);
    return match?[{...process,root:match[1],backend:match[2]==='Cursor'?'cursor':'codex'}]:[];
  }).slice(0,16);
  // 用父子进程关系和安装目录锁定同一实例，避免把另一个 Codex 的后端或账号配进来。
  const children=new Map(desktops.filter(item=>item.backend==='codex').map(item=>[item.pid,processes.filter(child=>child.parent===item.pid&&child.file.startsWith(item.root+'/')&&/\/codex$/.test(child.file))]));
  const pids=[...children].flatMap(([pid,rows])=>[pid,...rows.map(row=>row.pid)]).slice(0,64),homes=new Map();
  if(pids.length){
    let files='';try{files=await listOpenFiles(pids);}catch{/* 无法确认目录时保留候选项，禁止盲用默认账号。 */}
    let pid;
    for(const line of files.split('\n')){
      if(/^p\d+$/.test(line)){pid=Number(line.slice(1));continue;}
      if(!pids.includes(pid)||!line.startsWith('n/'))continue;
      const match=line.slice(1).match(/^(.*)\/(?:state_\d+\.sqlite(?:-wal|-shm)?|ipc\/ipc\.sock)$/);
      if(match){if(!homes.has(pid))homes.set(pid,new Set());homes.get(pid).add(canonical(match[1]));}
    }
  }
  const clients=[],seen=new Set();
  for(const desktop of desktops){
    let binary='',configHome='',reason='',description;
    if(desktop.backend==='codex'){
      const backends=children.get(desktop.pid)||[],directories=new Set([desktop.pid,...backends.map(row=>row.pid)].flatMap(pid=>[...(homes.get(pid)||[])]));
      // 配置目录必须由该实例实际打开的数据库或 IPC 路径唯一确认，缺失或歧义时交给用户选择。
      if(directories.size===1)configHome=[...directories][0];
      else reason=directories.size?'检测到多个配置目录，请自定义添加以明确选择':'无法确定此实例的配置目录，请自定义添加';
      const binaries=[...new Set(backends.map(row=>canonical(row.file)))];
      // 优先使用该桌面进程自己的后端，不能拿另一个安装位置的 Codex 代替。
      const bundled=[desktop.root+'/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',desktop.root+'/Resources/codex'];
      binary=binaries.length===1&&isExecutable(binaries[0])?binaries[0]:!binaries.length?bundled.find(isExecutable)||'':'';
      if(!binary)reason=reason||'无法确定可执行文件，请自定义添加';
      description='沿用此配置目录；已有桌面对话继承原设置，新对话使用目录默认配置。';
    }else{
      const workers=[...new Set(processes.filter(row=>/\/Cursor\/User\/globalStorage\/anysphere\.cursor-agent-worker\/agent-cli\/\.local\/bin\/cursor-agent$/.test(row.file)).map(row=>canonical(row.file)))];
      binary=defaults.cursorBinary||((workers.length===1&&isExecutable(workers[0]))?workers[0]:'');
      if(!binary||!isExecutable(binary)){binary='';reason='未找到 Cursor CLI，请安装并登录 CLI，或自定义指定路径';}
      description='通过 Cursor CLI 接入，使用 CLI 的登录；不读取编辑器已有对话。';
    }
    binary=binary?canonical(binary):'';
    const key=JSON.stringify([desktop.backend,binary,configHome,reason?desktop.root:'']);
    if(seen.has(key))continue;seen.add(key);
    const appName=path.basename(path.dirname(desktop.root),'.app');
    clients.push({key,name:desktop.backend==='cursor'?'Cursor CLI':appName==='ChatGPT'?'Codex':appName,backend:desktop.backend,binary,configHome,profile:'',available:!reason,reason,description});
  }
  return {clients,defaults,message:clients.length?`发现 ${clients.length} 个运行中的客户端。添加后调整优先级并保存。`:'未发现运行中的 Codex / Cursor 桌面客户端。请打开客户端后刷新，或自定义添加。'};
}
module.exports={discoverRunningClients};
