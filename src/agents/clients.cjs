'use strict';
const {validateSettings}=require('./local-agent.cjs');
const defaultClients=()=>[{id:'codex-default',name:'本机 Codex',backend:'codex',enabled:true,binary:'',configHome:'',profile:''}];
function validateClients(value,{checkPaths=true}={}) {
  if(!Array.isArray(value)||value.length>12)throw new Error('最多配置 12 个客户端');
  const ids=new Set();
  return value.map(item=>{
    if(!item||typeof item.id!=='string'||!/^[\w-]{1,80}$/.test(item.id)||ids.has(item.id))throw new Error('客户端标识无效或重复');
    ids.add(item.id);
    if(typeof item.name!=='string'||!item.name.trim()||item.name.length>60||/[\r\n]/.test(item.name))throw new Error('客户端名称应为 1–60 个字符');
    if(typeof item.enabled!=='boolean')throw new Error('客户端启用状态无效');
    const {cwd:_,...settings}=validateSettings({...item,cwd:''},{requireCwd:false,checkPaths:checkPaths&&item.enabled});
    return {id:item.id,name:item.name.trim(),enabled:item.enabled,...settings};
  });
}
module.exports={defaultClients,validateClients};
