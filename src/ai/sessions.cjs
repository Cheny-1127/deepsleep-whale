'use strict';
const {randomUUID}=require('node:crypto');
const MAX_SESSIONS=100,MAX_MESSAGES=500;
const SYSTEM='请根据当前会话的上下文回答，使用简洁、自然的中文；用户另有语言或格式要求时遵循用户要求。不确定的信息请明确说明。';
const preview=text=>String(text||'').replace(/\s+/g,' ').trim().slice(0,100);
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validState(state){
  if(state?.version!==1||!Array.isArray(state.sessions)||state.sessions.length>MAX_SESSIONS)throw Error();
  const ids=new Set();
  for(const session of state.sessions){
    if(!idPattern.test(session?.id)||ids.has(session.id)||typeof session.title!=='string'||!session.title.trim()||session.title.length>80||!Number.isSafeInteger(session.createdAt)||!Number.isSafeInteger(session.updatedAt)||!Array.isArray(session.messages)||session.messages.length>MAX_MESSAGES)throw Error();
    ids.add(session.id);const messages=new Set();
    if(session.connection&&(!/^whale-v1-[a-f0-9]{48}$/.test(session.connection.identity)||!['chat','responses'].includes(session.connection.protocol)||typeof session.connection.model!=='string'))throw Error();
    for(const item of session.messages){
      if(!idPattern.test(item?.id)||messages.has(item.id)||!['user','assistant'].includes(item.role)||typeof item.text!=='string'||item.text.length>2*1024*1024||!Number.isSafeInteger(item.createdAt)||!['sent','pending','failed'].includes(item.status))throw Error();
      if(item.error!==undefined&&typeof item.error!=='string'||item.items!==undefined&&!Array.isArray(item.items))throw Error();
      messages.add(item.id);
    }
  }
  return state;
}
function createAiSessions({store,ai,onChange=()=>{},now=Date.now}){
  let state={version:1,sessions:[]},readError='',unsaved=false,closed=false;const pending=new Map();
  const changed=()=>{try{onChange();}catch{}};
  try{state=validState(store.load());for(const session of state.sessions)for(const message of session.messages)if(message.status==='pending'){message.status='failed';message.error='上次请求已中断，可以手动重试。';}}
  catch{readError='AI 会话无法读取，原记录已保留。请检查系统安全存储或本机文件。';}
  const find=id=>{const value=state.sessions.find(item=>item.id===id);if(!value)throw Error('找不到这个会话，可能已被删除');return value;};
  function editable(id){if(closed)throw Error('AI 会话已关闭');if(readError)throw Error(readError);if(unsaved)throw Error('回复尚未保存，请先重试保存');if(id&&pending.has(id))throw Error('该会话正在回复，请先停止或等待完成');}
  function commit(next,received=false){
    try{store.save(next);}catch(error){if(!received)throw error;state=next;unsaved=true;changed();return;}
    state=next;unsaved=false;changed();
  }
  function replace(session,received=false){commit({...state,sessions:state.sessions.map(item=>item.id===session.id?session:item)},received);}
  const summary=session=>({id:session.id,title:session.title,createdAt:session.createdAt,updatedAt:session.updatedAt,messageCount:session.messages.length,preview:preview(session.messages.at(-1)?.text),busy:pending.has(session.id)});
  function list(){const config=ai.snapshot();return {sessions:state.sessions.map(summary).sort((a,b)=>b.updatedAt-a.updatedAt||b.createdAt-a.createdAt||a.id.localeCompare(b.id)),error:readError||(unsaved?'最新回复暂未保存到本机，请重试保存；不要重新请求模型。':''),unsaved,configured:config.configured,model:config.model,protocol:config.protocol};}
  function get(id){
    const session=find(id),config=ai.snapshot();
    const connectionChanged=Boolean(session.connection&&config.configured&&session.connection.identity!==ai.sessionContext().identity);
    return {...summary(session),connection:session.connection?{model:session.connection.model,protocol:session.connection.protocol,reasoningEffort:session.connection.reasoningEffort}:null,connectionChanged,
      messages:session.messages.map(item=>({id:item.id,role:item.role,text:item.text,createdAt:item.createdAt,status:item.status,...(item.error?{error:item.error}:{}),...(item.usage?{usage:structuredClone(item.usage)}:{})})),
      canSend:config.configured&&!readError&&!unsaved&&!connectionChanged&&!pending.has(id),lastUsage:structuredClone(session.lastUsage||null),lastUsedAt:session.lastUsedAt||null};
  }
  async function send(value,retry=false){
    const id=value?.id;editable(id);let session=find(id);const context=ai.sessionContext();
    if(session.connection&&session.connection.identity!==context.identity)throw Error('AI 配置与本会话不一致，请恢复原配置后继续，或新建会话');
    let text=value?.text;
    if(retry){const last=session.messages.at(-1);if(last?.role!=='user'||last.status!=='failed')throw Error('当前没有可重试的消息');text=last.text;}
    if(typeof text!=='string'||!text.trim()||text.length>100000||text.includes('\0'))throw Error('请输入内容，单次最多 100000 字符');
    if(session.messages.length+(retry?1:2)>MAX_MESSAGES)throw Error('本会话消息已达上限，请新建会话；原记录仍会保留');
    const controller=new AbortController();pending.set(id,controller);
    try{
      const messages=structuredClone(session.messages),stamp=now();
      if(retry){messages.at(-1).status='pending';delete messages.at(-1).error;}else messages.push({id:randomUUID(),role:'user',text:text.trim(),createdAt:stamp,status:'pending'});
      session={...session,title:!session.messages.length&&session.title==='新会话'?preview(text).slice(0,40):session.title,updatedAt:stamp,connection:context,messages};
      replace(session);
      try{
        const history=session.messages.flatMap(item=>item.role==='assistant'&&context.protocol==='responses'&&item.items?.length?structuredClone(item.items):[{role:item.role,content:item.text}]);
        const result=await ai.chat({sessionId:id,system:SYSTEM,messages:history,signal:controller.signal});
        const current=structuredClone(find(id)),finished=now();current.messages.at(-1).status='sent';
        current.messages.push({id:randomUUID(),role:'assistant',text:result.text,createdAt:finished,status:'sent',...(result.items?{items:result.items}:{}),...(result.usage?{usage:result.usage}:{})});
        current.updatedAt=finished;current.lastUsedAt=finished;current.lastUsage=result.usage;replace(current,true);
      }catch(error){
        const current=structuredClone(find(id));current.messages.at(-1).status='failed';current.messages.at(-1).error=error.message;replace(current,true);throw error;
      }
    }finally{pending.delete(id);changed();}
    return get(id);
  }
  return {
    list,get,
    action(name,value){
      if(name==='list')return list();
      if(name==='get')return get(value?.id);
      if(name==='send'||name==='retry')return send(value,name==='retry');
      if(name==='cancel'){pending.get(value?.id)?.abort();return get(value?.id);}
      if(name==='persist'){if(readError)throw Error(readError);commit(state);return list();}
      editable(value?.id);
      if(name==='create'){
        if(state.sessions.length>=MAX_SESSIONS)throw Error('最多保存 100 个会话，请先删除不需要的会话');
        const stamp=now(),session={id:randomUUID(),title:'新会话',createdAt:stamp,updatedAt:stamp,messages:[]};commit({...state,sessions:[...state.sessions,session]});return get(session.id);
      }
      if(name==='rename'){
        if(typeof value?.title!=='string'||!value.title.trim()||value.title.trim().length>80||/[\x00-\x1f\x7f]/.test(value.title))throw Error('会话标题请填写 1–80 个字符');
        const current=find(value?.id);replace({...current,title:value.title.trim()});return get(current.id);
      }
      if(name==='remove'){find(value?.id);commit({...state,sessions:state.sessions.filter(item=>item.id!==value.id)});return list();}
      throw Error('不支持的 AI 会话操作');
    },
    close(){closed=true;for(const controller of pending.values())controller.abort();}
  };
}
module.exports={createAiSessions};
