'use strict';
const fs=require('node:fs'),path=require('node:path'),{parseEnv}=require('node:util');
function readReportEnvironment({rootDir=path.resolve(__dirname,'../..'),env=process.env}={}){
  let local={};try{local=parseEnv(fs.readFileSync(path.join(rootDir,'.env'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('工作报告环境配置无法读取');}
  const value=name=>(env[name]??local[name]??'').trim();
  // 凭据只供主进程读取，既不写入工作账本，也不返回页面或注入子进程环境。
  return {archiveDir:value('WHALE_REPORT_OBSIDIAN_DIR'),jenkinsUrl:value('WHALE_REPORT_JENKINS_URL'),jenkinsUser:value('WHALE_REPORT_JENKINS_USERNAME'),jenkinsToken:value('WHALE_REPORT_JENKINS_TOKEN')};
}
module.exports={readReportEnvironment};
