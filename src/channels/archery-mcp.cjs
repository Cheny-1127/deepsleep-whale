'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {parse}=require('smol-toml');
const {parseEnv}=require('node:util');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const PAGE_SIZE=20;
function configError(message){const error=new Error(message);error.archeryConfig=true;return error;}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

function installedMetadata(command){
  // 独立安装的服务由自身读取虚拟环境根目录 .env；桌宠只用其地址和账号隔离缓存、检测配置变化。
  // 不搜索工作目录或源码，不把文件中的密码复制到启动环境，更不要求用户重复填写。
  const bin=path.dirname(command),root=path.dirname(bin);
  if(!/^archery-mcp(?:\.exe)?$/.test(path.basename(command))||!['bin','Scripts'].includes(path.basename(bin))||
    !fs.existsSync(path.join(root,'pyvenv.cfg')))return {values:{},revision:''};
  try{
    const file=path.join(root,'.env');
    if(fs.statSync(file).size>1024*1024)return {values:{},revision:'oversized'};
    const text=fs.readFileSync(file,'utf8'),values=parseEnv(text);
    return {values:{ARCHERY_BASE_URL:values.ARCHERY_BASE_URL,ARCHERY_USERNAME:values.ARCHERY_USERNAME},revision:hash(text)};
  }catch{return {values:{},revision:'unavailable'};}
}

// 只读取全局 archery 的 stdio 配置；凭据留在主进程，不复制到桌宠数据目录。
function readArcheryConfig({home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),env=process.env,configFile}={}) {
  let data;
  try {
    const file=configFile||path.join(home,'config.toml');
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
  // 启动配置与服务的账号配置分开：缺少 env 不代表 MCP 缺少凭据，连接结果由实际工具调用确认。
  const installed=installedMetadata(entry.command),metadata={...installed.values,...variables};
  let baseUrl='';
  if(metadata.ARCHERY_BASE_URL)try {
    const base=new URL(metadata.ARCHERY_BASE_URL);
    if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error();
    baseUrl=base.origin;
  }catch {throw configError('Archery 服务器地址无效，请检查 MCP 的连接配置。');}
  const server={command:entry.command,args:entry.args||[],cwd:entry.cwd,env:variables};
  // 配置指纹包含账号和连接参数，更换账号或密码后必须丢弃旧会话与结果。
  const canApprove=(!Array.isArray(entry.enabled_tools)||entry.enabled_tools.includes('work_order_approve'))&&
    !entry.disabled_tools?.includes('work_order_approve');
  const allowed=name=>(!Array.isArray(entry.enabled_tools)||entry.enabled_tools.includes(name))&&!entry.disabled_tools?.includes(name);
  const canDetail=allowed('work_order_detail'),canExecute=allowed('work_order_execute');
  const fingerprint=hash(JSON.stringify({server,canApprove,canDetail,canExecute,installed:installed.revision}));
  // 密码变化只使会话失效；同一账号的未知审批结果继续防重。未知启动器按配置来源保守隔离。
  const accountKey=hash(JSON.stringify(baseUrl&&metadata.ARCHERY_USERNAME?[baseUrl,metadata.ARCHERY_USERNAME]:
    [configFile||path.join(home,'config.toml'),entry.command,entry.args||[],entry.cwd||'']));
  return {server,fingerprint,accountKey,canApprove,canDetail,canExecute,baseUrl,
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
    async detail(id,{signal,allowLarge=false}={}) {
      if(!config.canDetail||!connected||!Number.isSafeInteger(id)||id<1||typeof allowLarge!=='boolean')throw new Error('detail_unavailable');
      return client.callTool({name:'work_order_detail',arguments:{order_id:id,allow_large:allowLarge}},undefined,{signal,timeout:config.timeoutMs});
    },
    close:()=>client.close()
  };
}

// 统一读取结构化结果或有长度限制的文本结果，不透传服务端原始错误。
function payloadOf(response,maxLength=256*1024) {
  if(response?.isError)throw new Error('mcp_failure');
  let payload=response?.structuredContent;
  if(!payload) {
    const text=response?.content?.filter(item=>item.type==='text').map(item=>item.text).join('');
    if(!text||text.length>maxLength)throw new Error('invalid_response');
    payload=JSON.parse(text);
  }
  return payload;
}

function orderDetail(response,id){
  const limit=16*1024*1024,payload=payloadOf(response,limit),data=payload?.data;
  if(Buffer.byteLength(JSON.stringify(payload)||'')>limit)throw Error('invalid_response');
  if(payload?.status==='needs_confirmation'){
    if(data?.order_id!==id||data.order_type!=='work_order'||!Number.isSafeInteger(data.response_bytes)||data.response_bytes<1)throw Error('invalid_response');
    return {id,needsConfirmation:true,bytes:data.response_bytes};
  }
  // 内容记录 ID 不是工单号，必须同时核对 workflow 身份与数据工单类型。
  const workflow=data?.workflow;
  if(payload?.status!=='success'||workflow?.id!==id||workflow.is_offline_export!==0||
    (data.workflow_id!==undefined&&data.workflow_id!==id))throw Error('invalid_response');
  const text=value=>{
    if(value===null||value===undefined)return '';
    if(!['string','number','boolean'].includes(typeof value))throw Error('invalid_response');
    return String(value);
  };
  const content=value=>value&&typeof value==='object'?JSON.stringify(value,null,2):text(value);
  // 仅按需向发起页面返回展示字段；不透传凭据、任意链接或上游新增字段。
  return {id,needsConfirmation:false,title:text(workflow.workflow_name),submitter:text(workflow.engineer_display||workflow.engineer),
    instance:text(workflow.instance__instance_name||workflow.instance),database:text(workflow.db_name),
    status:text(workflow.status),group:text(workflow.group_name),createdAt:text(workflow.create_time),
    sql:text(data.sql_content),execution:content(data.execute_result)};
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
      instance:text(item.instance),database:text(item.database),createdAt:text(item.created_at),status:text(item.status)};
  });
  return {items,hasMore:p.has_more,sourceTotal:p.source_total};
}
module.exports={readArcheryConfig,createArcheryMcp,pendingPage,approvalResult,orderDetail,PAGE_SIZE};
