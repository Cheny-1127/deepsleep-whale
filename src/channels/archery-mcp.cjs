'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {parse}=require('smol-toml');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const PAGE_SIZE=20;
function configError(message){const error=new Error(message);error.archeryConfig=true;return error;}

// 只读取全局 archery 的 stdio 配置；凭据留在主进程，不复制到桌宠数据目录。
function readArcheryConfig({home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),env=process.env}={}) {
  let data;
  try {
    const file=path.join(home,'config.toml');
    if(fs.statSync(file).size>1024*1024)throw new Error();
    data=parse(fs.readFileSync(file,'utf8'));
  }catch {throw configError('无法读取全局 Codex 配置，请检查 config.toml。');}
  const entry=data.mcp_servers?.archery;
  if(!entry)throw configError('尚未配置全局 Archery MCP，请先在 Codex 中添加 archery。');
  if(entry.enabled===false)throw configError('全局 Archery MCP 已停用，请先在 Codex 中启用。');
  if((Array.isArray(entry.enabled_tools)&&!entry.enabled_tools.includes('work_order_pending_list'))||
    entry.disabled_tools?.includes('work_order_pending_list'))throw configError('全局 Archery MCP 未开放待审核列表工具。');
  if(entry.url||typeof entry.command!=='string'||!path.isAbsolute(entry.command)||
    (entry.args!==undefined&&(!Array.isArray(entry.args)||!entry.args.every(v=>typeof v==='string')))||
    (entry.cwd!==undefined&&(typeof entry.cwd!=='string'||!path.isAbsolute(entry.cwd)))||
    (entry.env_vars!==undefined&&(!Array.isArray(entry.env_vars)||!entry.env_vars.every(v=>typeof v==='string')))||
    (entry.env!==undefined&&(!entry.env||typeof entry.env!=='object'||Array.isArray(entry.env)||!Object.values(entry.env).every(v=>typeof v==='string'))))
    throw configError('Archery MCP 配置无效，需要本地程序的绝对路径。');
  const variables={};
  for(const key of entry.env_vars||[])if(typeof env[key]==='string')variables[key]=env[key];
  Object.assign(variables,entry.env||{});
  let base;
  try {
    base=new URL(variables.ARCHERY_BASE_URL);
    if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error();
    if(!variables.ARCHERY_USERNAME||!variables.ARCHERY_PASSWORD)throw new Error();
  }catch {throw configError('Archery 服务器地址或账号配置不完整，请检查全局 MCP 配置。');}
  const server={command:entry.command,args:entry.args||[],cwd:entry.cwd,env:variables};
  // 配置指纹包含账号和连接参数，更换账号或密码后必须丢弃旧会话与结果。
  const canApprove=(!Array.isArray(entry.enabled_tools)||entry.enabled_tools.includes('work_order_approve'))&&
    !entry.disabled_tools?.includes('work_order_approve');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({server,canApprove})).digest('hex');
  const accountKey=crypto.createHash('sha256').update(JSON.stringify([base.origin,variables.ARCHERY_USERNAME])).digest('hex');
  return {server,fingerprint,accountKey,canApprove,baseUrl:base.origin,
    startupMs:Math.min(120000,Math.max(1000,(Number(entry.startup_timeout_sec)||30)*1000)),
    timeoutMs:Math.min(180000,Math.max(1000,(Number(entry.tool_timeout_sec)||90)*1000))};
}

function createArcheryMcp(config) {
  const client=new Client({name:'deepsleep-archery',version:'0.1.0'});
  // 不继承服务端日志，避免网络库将账号或工单内容写入桌宠日志。
  const transport=new StdioClientTransport({...config.server,stderr:'ignore'});
  let connected=false;
  return {
    async pending(page,{signal}={}) {
      if(!connected){await client.connect(transport,{signal,timeout:config.startupMs});connected=true;}
      // 页面没有任意工具调用入口；读取和逐笔审批分别使用固定方法。
      return client.callTool({name:'work_order_pending_list',arguments:{page,page_size:PAGE_SIZE}},undefined,{signal,timeout:config.timeoutMs});
    },
    async approve(id,{signal}={}) {
      if(!config.canApprove||!connected||!Number.isSafeInteger(id)||id<1)throw new Error('approval_unavailable');
      // 不建新会话、不批量、不重试，更不追加执行 SQL。
      return client.callTool({name:'work_order_approve',arguments:{order_ids:[id],remark:'审核通过'}},undefined,{signal,timeout:config.timeoutMs});
    },
    close:()=>client.close()
  };
}

// 统一读取结构化结果或有长度限制的文本结果，不透传服务端原始错误。
function payloadOf(response) {
  if(response?.isError)throw new Error('mcp_failure');
  let payload=response?.structuredContent;
  if(!payload) {
    const text=response?.content?.filter(item=>item.type==='text').map(item=>item.text).join('');
    if(!text||text.length>256*1024)throw new Error('invalid_response');
    payload=JSON.parse(text);
  }
  return payload;
}
function approvalResult(response,id) {
  const payload=payloadOf(response),data=payload?.data;
  if(payload?.status==='success'&&Array.isArray(data?.succeeded)&&data.succeeded.length===1&&data.succeeded[0]===id&&
    ['failed','unknown','remaining'].every(key=>Array.isArray(data[key])&&data[key].length===0)&&
    Array.isArray(data.results)&&data.results.length===1&&data.results[0].order_id===id&&data.results[0].status==='success')return 'success';
  // 只有明确未执行的返回才记为失败，其余一律视为未知，不按 HTTP/MCP 成功推断审批成功。
  if(['invalid_input','auth_failed','needs_confirmation','type_mismatch'].includes(payload?.status)&&
    !data?.succeeded?.length&&!data?.unknown?.length)return 'failed';
  return 'unknown';
}
// 仅接受明确成功的摘要页，不能把混合来源总数当成待我审核数据工单总数。
function pendingPage(response,page) {
  const payload=payloadOf(response),data=payload?.data,p=data?.pagination;
  if(payload?.status!=='success'||!Array.isArray(data?.items)||data.items.length>PAGE_SIZE||
    p?.page!==page||p.page_size!==PAGE_SIZE||p.scope!=='source_page_filtered'||p.total!==null||
    !Number.isSafeInteger(p.source_total)||p.source_total<data.items.length||typeof p.has_more!=='boolean'||
    p.next_page!==(p.has_more?page+1:null))throw new Error('invalid_response');
  const text=value=>{
    if(value===undefined||value===null)return '';
    if(!['string','number'].includes(typeof value)||String(value).length>2000)throw new Error('invalid_response');
    return String(value);
  };
  const items=data.items.map(item=>{
    if(!Number.isSafeInteger(item.order_id)||item.order_id<1||item.order_type!=='work_order')throw new Error('invalid_response');
    return {id:item.order_id,title:text(item.title)||'（无标题）',submitter:text(item.submitter),
      instance:text(item.instance),database:text(item.database),createdAt:text(item.created_at)};
  });
  return {items,hasMore:p.has_more,sourceTotal:p.source_total};
}
module.exports={readArcheryConfig,createArcheryMcp,pendingPage,approvalResult,PAGE_SIZE};
