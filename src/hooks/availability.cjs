'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const unknown=(adapter,message)=>({state:'unknown',checkedAt:Date.now(),message,events:Object.fromEntries(adapter.mappings.map(item=>[item.event,{available:false,reason:message}]))});
function matchCodex(adapter,result) {
  const entries=result?.data;
  if(!Array.isArray(entries)||entries.some(item=>!Array.isArray(item.hooks)||item.errors?.length))return unknown(adapter,'无法读取 Codex Hooks 状态');
  const expected=JSON.parse(adapter.config).hooks;
  const hooks=entries.flatMap(item=>item.hooks);
  const events=Object.fromEntries(adapter.mappings.map(({event})=>{
    const command=expected[event][0].hooks[0].command;
    // 精确匹配本项目命令，其他插件同名事件不能替代鲸鱼娘的接入。
    const matches=hooks.filter(hook=>hook.eventName===event[0].toLowerCase()+event.slice(1)&&hook.handlerType==='command'&&hook.command===command);
    const available=matches.some(hook=>hook.enabled===true&&(hook.trustStatus==='trusted'||(hook.isManaged===true&&hook.trustStatus==='managed')));
    const reason=available?'已启用 · 已信任':!matches.length?'尚未接入鲸鱼娘':matches.every(hook=>hook.enabled!==true)?'Codex 中已禁用':matches.some(hook=>hook.trustStatus==='untrusted'||hook.trustStatus==='unknown')?'请先在 Codex 中审核并信任':'Codex 尚未授予信任';
    return [event,{available,reason}];
  }));
  return {state:'checked',checkedAt:Date.now(),message:'已读取 Codex 启用与信任状态',events};
}
function readCodex(adapter,{binary,cwd,timeout=6000}={}) {
  // 只读查询事件、用户开关和管理策略；未知或超时均不可用，绝不代替用户授予信任。
  return new Promise(resolve=>{
    let child,buffer='',settled=false,listed,config;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);child?.kill();resolve(value);};
    const timer=setTimeout(()=>finish(unknown(adapter,'检测超时，请重新检测')),timeout);
    try {child=spawn(binary,['app-server'],{stdio:['pipe','pipe','pipe']});}catch {finish(unknown(adapter,'无法启动 Codex 状态检测'));return;}
    child.on('error',()=>finish(unknown(adapter,'未找到可用的 Codex 客户端')));
    child.on('exit',()=>finish(unknown(adapter,'Codex 状态检测连接已关闭')));
    child.stdin.on('error',()=>finish(unknown(adapter,'无法读取 Codex 状态')));
    // stderr 排空但不展示或存储，避免泄露客户端日志。
    child.stderr.on('data',()=>{});
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();if(buffer.length>1024*1024){finish(unknown(adapter,'检测返回超出限制'));return;}
      for(;;) {
        const end=buffer.indexOf('\n');if(end<0)break;
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        let value;try {value=JSON.parse(line);}catch {continue;}
        if(value.id===1) {
          if(value.error){finish(unknown(adapter,'当前 Codex 不支持状态检测'));return;}
          send({method:'initialized'});send({id:2,method:'hooks/list',params:{cwd}});
        }
        if(value.id===2) {
          if(value.error){finish(unknown(adapter,'当前 Codex 不支持 Hooks 检测'));return;}
          listed=value.result;send({id:3,method:'config/read',params:{cwd,includeLayers:false}});
        }
        if(value.id===3) {
          if(value.error||!value.result?.config){finish(unknown(adapter,'无法确认 Codex 全局 Hooks 设置'));return;}
          config=value.result.config;send({id:4,method:'configRequirements/read',params:{}});
        }
        if(value.id===4) {
          if(value.error||!Object.hasOwn(value.result||{},'requirements')){finish(unknown(adapter,'无法确认 Codex Hooks 管理策略'));return;}
          try {
            const result=matchCodex(adapter,listed);
            const flags=config.features||{};const policy=value.result.requirements?.featureRequirements||{};
            const disabled=flags.hooks===false||(flags.hooks===undefined&&flags.codex_hooks===false)||policy.hooks===false||policy.codex_hooks===false;
            if(disabled&&result.state==='checked') {
              result.message='Codex 全局 Hooks 已关闭';
              for(const event of Object.values(result.events)){event.available=false;event.reason=result.message;}
            }
            finish(result);
          }catch {finish(unknown(adapter,'Codex 返回的配置无法识别'));}
        }
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'whale-hook-diagnostics',version:'0.1.0'},capabilities:{experimentalApi:true}}});
  });
}
function readCursor(adapter) {
  try {
    const config=JSON.parse(fs.readFileSync(adapter.target,'utf8'));
    if(config.version!==1||!config.hooks||typeof config.hooks!=='object')return unknown(adapter,'Cursor 配置格式无法识别');
    const expected=JSON.parse(adapter.config).hooks;
    const events=Object.fromEntries(adapter.mappings.map(({event})=>{
      const available=config.hooks[event]?.some?.(hook=>hook.command===expected[event][0].command)===true;
      return [event,{available,reason:available?'已配置，等待事件验证':'尚未接入鲸鱼娘'}];
    }));
    return {state:'checked',checkedAt:Date.now(),message:'已读取 Cursor 用户配置',events};
  }catch(error){return error.code==='ENOENT'?{state:'checked',checkedAt:Date.now(),message:'尚未找到 Cursor Hooks 配置',events:Object.fromEntries(adapter.mappings.map(({event})=>[event,{available:false,reason:'尚未接入鲸鱼娘'}]))}:unknown(adapter,'无法读取 Cursor Hooks 配置');}
}
function findCodex() {
  return [process.env.WHALE_CODEX_BIN,'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/Applications/Codex.app/Contents/Resources/codex',...(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,'codex'))].find(file=>{try {return file&&fs.statSync(file).isFile()&&(fs.accessSync(file,fs.constants.X_OK)===undefined);}catch{return false;}});
}
module.exports={unknown,matchCodex,readCodex,readCursor,findCodex};
