'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {readArcheryConfig}=require('../channels/archery-mcp.cjs');
// 仅保存全局配置文件路径；每次操作重新读取，账号、密码和启动命令不进入界面或本机设置。
function createArcheryConnection({dataDir,home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),readConfig=readArcheryConfig}={}){
  const file=path.join(dataDir,'archery-connection.json'),defaultFile=path.join(home,'config.toml');
  let configFile=defaultFile,loadError='';
  try{
    if(fs.existsSync(file)){
      const saved=JSON.parse(fs.readFileSync(file,'utf8'));
      if(typeof saved.configFile!=='string'||!path.isAbsolute(saved.configFile))throw Error();
      configFile=saved.configFile;
    }
  // 来源损坏时停止连接，避免静默回退默认目录而连接到另一个 Archery 账号。
  }catch{loadError='Archery 配置来源无法读取，请重新选择并保存配置文件。';}
  function read(){if(loadError)throw Error(loadError);return readConfig({configFile});}
  function snapshot(){
    let config,error=loadError;
    if(!error)try{config=read();}catch(cause){error=cause.archeryConfig?cause.message:'无法读取 Archery 配置，请检查文件。';}
    // 快照仅暴露路径、校验说明与工具权限，不返回启动参数和环境变量。
    return {configFile,defaultFile,valid:Boolean(config),error,permissions:config?{detail:config.canDetail,approve:config.canApprove,reject:config.canReject,execute:config.canExecute}:null};
  }
  function save(value){
    if(typeof value!=='string'||!path.isAbsolute(value)||path.basename(value)!=='config.toml')throw Error('请选择 Codex 全局 config.toml 文件的绝对路径。');
    // 先读取校验，再原子保存；不启动 MCP，也不写入用户的 Codex 配置。
    readConfig({configFile:value});
    try{
      fs.writeFileSync(file+'.tmp',JSON.stringify({configFile:value}),{mode:0o600});fs.renameSync(file+'.tmp',file);
    }catch{throw Error('配置路径保存失败，原配置保留。');}
    configFile=value;loadError='';return snapshot();
  }
  return {read,snapshot,save};
}
module.exports={createArcheryConnection};
