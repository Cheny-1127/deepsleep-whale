'use strict';

const {createHmac}=require('node:crypto');
const DEFAULTS={baseUrl:'',model:'',protocol:'chat',reasoningEffort:''};
const MAX_RESPONSE=2*1024*1024;
class AiError extends Error{}
const fail=message=>{throw new AiError(message);};
function text(value,max,label){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(label+'不正确');
  return value.trim();
}
function connectionInput(value,previous){
  const raw=text(value?.baseUrl,2048,'API 地址');let url;
  try{url=new URL(raw);}catch{fail('请填写完整的 API 地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/\s/.test(raw))fail('API 地址只支持无账号、参数和片段的 HTTP 或 HTTPS 地址');
  url.pathname=url.pathname.replace(/\/+$/,'');
  if(/\/(chat\/completions|responses)$/i.test(url.pathname))fail('API 地址请填写基础地址，例如 https://example.com/v1');
  const baseUrl=url.href.replace(/\/+$/,'');
  const model=text(value?.model,200,'模型名称');
  if(!['chat','responses'].includes(value?.protocol))fail('请选择支持的接口类型');
  const reasoningEffort=value?.reasoningEffort===undefined?previous?.reasoningEffort||'':value.reasoningEffort;
  if(!['','low','medium','high','xhigh','max'].includes(reasoningEffort))fail('请选择支持的推理强度');
  let apiKey=typeof value?.apiKey==='string'?value.apiKey.trim():'';
  if(!apiKey){
    if(previous&&previous.baseUrl!==baseUrl)fail('更换 API 地址后，请重新填写密钥');
    apiKey=previous?.apiKey||'';
  }
  if(!apiKey||apiKey.length>4096||/[^\x21-\x7e]/.test(apiKey))fail('请填写有效的 API Key 密钥');
  return {baseUrl,apiKey,model,protocol:value.protocol,reasoningEffort};
}
async function jsonBody(response){
  if(Number(response.headers.get('content-length'))>MAX_RESPONSE)fail('AI 返回内容过大');
  const reader=response.body?.getReader();if(!reader)fail('AI 未返回内容');
  const chunks=[];let size=0;
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE)fail('AI 返回内容过大');chunks.push(Buffer.from(value));}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('AI 接口返回格式不正确，请检查接口类型和地址');}
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
}
function outputText(data,protocol){
  let output;
  if(protocol==='responses'){
    if(data?.status!=='completed')fail('AI 响应未完成，请重试');
    const messages=(data.output||[]).filter(item=>item.type==='message'&&item.role==='assistant');
    if(messages.some(item=>item.status&&item.status!=='completed'))fail('AI 响应未完成，请重试');
    output=messages.flatMap(item=>item.content||[]).filter(item=>item.type==='output_text'&&typeof item.text==='string').map(item=>item.text).join('\n');
  }else{
    const choice=data?.choices?.[0];if(choice?.finish_reason!=='stop'||choice.message?.tool_calls?.length)fail('AI 响应未完成，请检查模型或重试');
    output=choice.message?.content;
  }
  if(typeof output!=='string'||!output.trim())fail('AI 未返回文本，请检查模型和接口类型');
  return output.trim();
}
function cacheKey(value,system,sessionId=''){
  const parts=[1,value.baseUrl,value.protocol,value.model,value.reasoningEffort,system];if(sessionId)parts.push(sessionId);
  const scope=JSON.stringify(parts);
  return 'whale-v1-'+createHmac('sha256',value.apiKey).update(scope).digest('hex').slice(0,48);
}
function reportedUsage(usage){
  if(!usage||typeof usage!=='object')return null;
  const count=(...values)=>values.find(value=>Number.isSafeInteger(value)&&value>=0)??null;
  const input=usage.input_tokens_details,prompt=usage.prompt_tokens_details;
  const result={
    inputTokens:count(usage.input_tokens,usage.prompt_tokens),
    outputTokens:count(usage.output_tokens,usage.completion_tokens),
    cacheReadTokens:count(input?.cached_tokens,prompt?.cached_tokens,usage.cache_read_input_tokens,usage.cache_read_tokens,usage.cached_tokens,usage.prompt_cache_hit_tokens),
    cacheWriteTokens:count(input?.cache_write_tokens,prompt?.cache_write_tokens,input?.cache_creation_tokens,prompt?.cache_creation_tokens,usage.cache_write_tokens,usage.cache_creation_input_tokens,usage.cache_write_input_tokens,usage.cache_creation_tokens)
  };
  return Object.values(result).every(value=>value===null)?null:result;
}
function conversationInput(messages,protocol){
  if(!Array.isArray(messages)||!messages.length||messages.length>2000)fail('会话上下文不正确或过长');
  if(Buffer.byteLength(JSON.stringify(messages))>1024*1024)fail('会话上下文过长，请新建会话；原记录仍会保留');
  for(const item of messages){
    if(protocol==='responses'&&item?.type==='reasoning'){
      if(typeof item.encrypted_content!=='string'||!item.encrypted_content)fail('会话推理记录不完整，请新建会话');
      continue;
    }
    if(!['user','assistant'].includes(item?.role)||item.type&&item.type!=='message')fail('会话消息格式不正确');
    const content=item.content;
    if(typeof content==='string'){if(!content.trim()||content.includes('\0'))fail('会话内容不能为空');}
    else if(protocol!=='responses'||!Array.isArray(content)||!content.length||content.some(part=>!['input_text','output_text','refusal'].includes(part?.type)||typeof (part.type==='refusal'?part.refusal:part.text)!=='string'))fail('会话仅支持文本内容');
  }
  if(messages.at(-1)?.role!=='user')fail('请提供本次要发送的内容');
  return structuredClone(messages);
}
function conversationOutput(data){
  if(!Array.isArray(data.output)||data.output.some(item=>!['message','reasoning'].includes(item?.type)))fail('当前会话仅支持文本回复');
  // 没有加密内容的旧版 reasoning 项不能在 store:false 的后续请求中按 ID 取回。
  return structuredClone(data.output.filter(item=>item.type!=='reasoning'||typeof item.encrypted_content==='string'&&item.encrypted_content));
}
function createAiService({store,fetchImpl=globalThis.fetch,timeoutMs=120000}){
  let connection=null,error='',closed=false,testController=null,lastUsage=null;const requests=new Set();
  try{const saved=store.load();if(saved)connection=connectionInput(saved);}catch(reason){error=reason instanceof AiError?'AI 配置格式不兼容，原文件已保留':reason.message;}
  const snapshot=()=>({...DEFAULTS,...(connection?{baseUrl:connection.baseUrl,model:connection.model,protocol:connection.protocol,reasoningEffort:connection.reasoningEffort}:{}),configured:Boolean(connection),hasKey:Boolean(connection?.apiKey),error,busy:requests.size>0,lastUsage:lastUsage?{...lastUsage}:null});
  function editable(){if(closed)fail('AI 服务已关闭');if(requests.size)fail('AI 请求正在进行，请稍后修改配置');}
  async function request(value,{prompt,system='',signal,messages,sessionId=''}={}){
    if(closed)fail('AI 服务已关闭');
    if(messages===undefined&&(typeof prompt!=='string'||!prompt.trim()||prompt.length>100000||prompt.includes('\0')))fail('AI 请求内容为空或过长');
    if(typeof system!=='string'||system.length>30000)fail('AI 写作要求过长');
    if(sessionId&&!/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId))fail('会话编号不正确');
    const history=messages===undefined?null:conversationInput(messages,value.protocol);
    const controller=new AbortController();requests.add(controller);
    const abort=()=>controller.abort(new AiError('AI 请求已取消'));
    let rejectAbort;const interrupted=new Promise((_,reject)=>rejectAbort=reject);
    const onAbort=()=>rejectAbort(controller.signal.reason instanceof AiError?controller.signal.reason:new AiError('AI 请求已取消'));
    controller.signal.addEventListener('abort',onAbort,{once:true});signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(new AiError('AI 请求超时，请检查连接或稍后重试')),timeoutMs);
    const endpoint=value.protocol==='responses'?'responses':'chat/completions';
    const body=value.protocol==='responses'?{model:value.model,input:history||prompt,...(history?{include:['reasoning.encrypted_content']}:{}),...(system?{instructions:system}:{}),...(value.reasoningEffort?{reasoning:{effort:value.reasoningEffort}}:{}),store:false,stream:false}:{model:value.model,messages:[...(system?[{role:'system',content:system}]:[]),...(history||[{role:'user',content:prompt}])],...(value.reasoningEffort?{reasoning_effort:value.reasoningEffort}:{}),store:false,stream:false};
    body.prompt_cache_key=cacheKey(value,system,sessionId);
    try{
      const result=await Promise.race([interrupted,(async()=>{
        if(controller.signal.aborted)throw controller.signal.reason;
        const response=await fetchImpl(value.baseUrl+'/'+endpoint,{method:'POST',headers:{Authorization:'Bearer '+value.apiKey,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
        if(!response.ok){
          try{await response.body?.cancel();}catch{}
          if([401,403].includes(response.status))fail('API 密钥无效或没有模型访问权限');
          if(response.status===400&&value.reasoningEffort)fail('AI 请求参数不受支持（HTTP 400），请尝试「模型默认」或检查模型和接口类型');
          if(response.status===429)fail('AI 请求受限，请检查额度或稍后重试');
          if(response.status===404)fail('未找到 AI 接口或模型，请检查地址、接口类型和模型名称');
          fail('AI 服务请求失败（HTTP '+response.status+'），请检查配置后重试');
        }
        const data=await jsonBody(response);
        return {text:outputText(data,value.protocol),usage:reportedUsage(data?.usage),...(history?{items:value.protocol==='responses'?conversationOutput(data):null}:{})};
      })()]);
      lastUsage=result.usage?{model:value.model,protocol:value.protocol,...result.usage}:null;
      return result;
    }catch(reason){if(reason instanceof AiError)throw reason;if(controller.signal.aborted)throw controller.signal.reason;fail('无法连接 AI 服务，请检查地址、网络和接口类型');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);controller.abort();requests.delete(controller);}
  }
  return {
    snapshot,
    sessionContext(){if(!connection)fail('请先打开「AI 功能 → 配置」保存模型连接');const {baseUrl,model,protocol,reasoningEffort}=connection;return {identity:cacheKey(connection,'local-conversation'),baseUrl,model,protocol,reasoningEffort};},
    save(value){editable();if(error)fail('请先清除无法读取的旧配置，再重新保存');const next=connectionInput(value,connection);store.save(next);connection=next;lastUsage=null;return snapshot();},
    clear(){editable();store.clear();connection=null;error='';lastUsage=null;return snapshot();},
    async test(value){if(testController)fail('连接测试正在进行');if(error)fail('请先清除无法读取的旧配置');const candidate=connectionInput(value,connection);testController=new AbortController();
      try{const result=await request(candidate,{prompt:'请只回复 OK。',signal:testController.signal});return {ok:true,usage:result.usage};}finally{testController=null;}
    },
    cancelTest(){testController?.abort();},
    async generate(value){if(closed)fail('AI 服务已关闭');if(!connection)fail('请先打开「AI 功能 → 配置」保存模型连接');return (await request({...connection},value)).text;},
    async chat(value){if(closed)fail('AI 服务已关闭');if(!connection)fail('请先打开「AI 功能 → 配置」保存模型连接');if(!value?.sessionId||!value?.messages)fail('请提供会话编号和消息');return request({...connection},value);},
    close(){closed=true;for(const controller of requests)controller.abort(new AiError('AI 请求已取消'));}
  };
}
module.exports={createAiService};
