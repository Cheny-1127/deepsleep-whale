import {confirmAction} from './confirm-dialog.mjs';
import {aiMarkdownHtml} from './ai-markdown.mjs';

export function createAiSessionsView(){
  const page=document.getElementById('ai-sessions-view'),content=document.getElementById('ai-sessions-content');if(!content)return;
  const $=id=>document.getElementById('ai-session-'+id),el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const icon=path=>'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="'+path+'"/></svg>';
  content.innerHTML=`<div class="sessions-feedback"><p id="ai-session-error" class="ui-alert" role="alert" hidden></p><button id="ai-session-persist" class="outline" type="button" hidden>重试保存</button></div>
    <div class="sessions-layout"><aside class="sessions-history" aria-label="会话历史"><div class="sessions-history-heading"><h2>历史会话</h2><span id="ai-session-count"></span></div><button id="ai-session-new" class="soft" type="button">＋ 新建会话</button><input id="ai-session-search" type="search" placeholder="搜索会话" aria-label="搜索会话"><div id="ai-session-list" class="sessions-list"></div></aside>
      <section class="sessions-chat" aria-label="当前会话"><div class="sessions-chat-heading"><div class="sessions-chat-title"><h2 id="ai-session-title">开始一段新对话</h2><div class="sessions-chat-meta"><button id="ai-session-id" type="button" aria-label="复制会话编号" hidden></button><span id="ai-session-model"></span></div></div><div class="sessions-chat-actions"><button id="ai-session-rename" class="ui-icon-button" type="button" aria-label="修改会话标题" title="修改标题">${icon('M12.5 3.5a2 2 0 0 1 3 3L7 15l-4 1 1-4Z M11 5l3 3')}</button><button id="ai-session-delete" class="ui-icon-button" type="button" aria-label="删除当前会话" title="删除会话">${icon('M3 5h14 M7 5V3h6v2 M5 5l1 12h8l1-12 M8 8v6 M12 8v6')}</button></div></div>
      <p id="ai-session-notice" class="sessions-notice" role="status" hidden></p><div id="ai-session-messages" class="sessions-messages" role="log" aria-label="对话记录" aria-live="polite"></div>
      <div class="sessions-compose"><p id="ai-session-usage" class="sessions-usage" hidden></p><form id="ai-session-form"><textarea id="ai-session-input" rows="3" maxlength="100000" aria-label="发送给 AI 的内容" placeholder="接着说点什么…"></textarea><div class="sessions-compose-actions"><span id="ai-session-hint">⌘ / Ctrl + Enter 发送</span><button id="ai-session-stop" class="outline" type="button" hidden>停止回复</button><button id="ai-session-send" class="primary" type="submit">发送</button></div></form><p id="ai-session-feedback" class="sessions-note" role="status" hidden></p></div></section></div>
    <dialog id="ai-session-rename-dialog" class="ui-dialog sessions-rename-dialog" aria-labelledby="ai-session-rename-heading"><form id="ai-session-rename-form"><h2 id="ai-session-rename-heading">修改会话标题</h2><label for="ai-session-rename-input">会话标题<input id="ai-session-rename-input" maxlength="80" required autocomplete="off"></label><p id="ai-session-rename-error" class="ui-alert" role="alert" hidden></p><div class="sessions-rename-actions"><button id="ai-session-rename-cancel" class="outline" type="button">取消</button><button id="ai-session-rename-save" class="primary" type="submit">保存</button></div></form></dialog>`;
  let currentId=null,desiredId=null,displayedId=null,detail=null,data={sessions:[],configured:false},revision=0,uiError='',mutating=false;
  const drafts=new Map(),sending=new Set();
  const request=async(name,value)=>{const result=await window.whale.aiSessions(name,value);if(result.error)throw Error(result.error);return result.value;};
  const when=time=>new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(time));
  const message=(id,text)=>{$(id).textContent=text||'';$(id).hidden=!text;};
  function renderError(){message('error',data.error||uiError);$('persist').hidden=!data.unsaved;}
  function renderList(){
    const query=$('search').value.trim().toLowerCase(),items=data.sessions.filter(item=>(item.title+' '+item.preview).toLowerCase().includes(query));
    $('count').textContent=String(data.sessions.length);$('list').replaceChildren();
    for(const item of items){
      const button=el('button','sessions-history-item');button.type='button';button.dataset.sessionId=item.id;button.classList.toggle('selected',item.id===currentId);button.setAttribute('aria-pressed',String(item.id===currentId));
      const heading=el('span','sessions-history-title',item.title),meta=el('span','sessions-history-time',when(item.updatedAt)+(item.busy?' · 回复中':'')),summary=el('span','sessions-history-preview',item.preview||'还没有开始聊天');
      button.append(heading,meta,summary);button.addEventListener('click',()=>void refresh(item.id));$('list').append(button);
    }
    if(!items.length)$('list').append(el('p','sessions-history-empty',query?'没有找到匹配的会话':'新建一段对话，之后可以从这里继续。'));
    $('new').disabled=mutating||Boolean(data.error);
  }
  function renderDetail(){
    const changed=displayedId!==currentId;
    if(changed){if(displayedId)drafts.set(displayedId,$('input').value);$('input').value=drafts.get(currentId)||'';displayedId=currentId;message('feedback','');}
    $('title').textContent=detail?.title||'开始一段新对话';$('id').hidden=!detail;$('id').textContent=detail?'#'+detail.id.slice(0,8):'';
    $('id').title=detail?'复制会话编号：'+detail.id:'';
    $('model').textContent=detail?.connection?.model||data.model||'尚未配置 AI';
    const busy=Boolean(detail?.busy||sending.has(currentId));
    const notice=!data.configured?'先点击右上角「配置」保存连接，再开始聊天。':detail?.connectionChanged?'AI 配置与本会话不一致，请恢复原配置后继续，或新建会话。':'';message('notice',notice);
    $('rename').disabled=$('delete').disabled=!detail||busy||mutating||Boolean(data.error);$('id').disabled=!detail;
    $('input').disabled=!detail||!data.configured||Boolean(data.error)||Boolean(detail?.connectionChanged);
    $('input').placeholder=detail?'接着说点什么…':'先新建一段会话';
    $('send').disabled=!detail?.canSend||busy||!$('input').value.trim();$('send').hidden=busy;$('stop').hidden=!busy;
    $('hint').textContent=busy?'回复会保存在当前会话中':'⌘ / Ctrl + Enter 发送';
    const box=$('messages'),top=box.scrollTop,follow=changed||box.scrollHeight-box.clientHeight-top<80;box.replaceChildren();
    if(!detail?.messages.length){const empty=el('div','sessions-empty');empty.append(el('div','sessions-empty-mark','≈'),el('h3','',detail?'从这里开始聊':'今天想聊点什么？'),el('p','',detail?'发送后的记录会保存在本机，下次打开还能接着聊。':'新建会话，或从左侧打开之前的对话。'));box.append(empty);}
    for(const item of detail?.messages||[]){
      const row=el('article','session-message');row.dataset.role=item.role;row.dataset.messageId=item.id;
      row.append(el('div','session-message-meta',(item.role==='user'?'你':'AI')+' · '+when(item.createdAt)));
      const body=el('div','session-message-body');if(item.role==='assistant')body.innerHTML=aiMarkdownHtml(item.text);else body.textContent=item.text;row.append(body);
      if(item.status==='failed'){
        const failure=el('div','session-message-failure');failure.append(el('span','',item.error||'本次请求未完成'));
        if(item===detail.messages.at(-1)){const retry=el('button','text-button','重试本条');retry.type='button';retry.dataset.retry='true';retry.disabled=busy||!detail.canSend;retry.addEventListener('click',()=>void send(true));failure.append(retry);}row.append(failure);
      }
      box.append(row);
    }
    if(busy){const pending=el('p','sessions-pending','正在回复…');pending.setAttribute('role','status');box.append(pending);}
    const usage=detail?.lastUsage;
    message('usage',usage?'上次请求 '+when(detail.lastUsedAt)+' · 输入 '+(usage.inputTokens??'—')+' tokens · '+(usage.cacheReadTokens==null?'上游未返回缓存读取量':'缓存读取 '+usage.cacheReadTokens+' tokens'):'');
    $('usage').title='仅记录上次请求的用量，不代表上游缓存现在仍然有效。';
    box.scrollTop=follow?box.scrollHeight:top;
  }
  async function refresh(preferred=desiredId){
    desiredId=preferred;const ticket=++revision;
    try{
      const next=await request('list');const id=next.sessions.some(item=>item.id===preferred)?preferred:next.sessions[0]?.id||null;
      const selected=id?await request('get',{id}):null;if(ticket!==revision)return;
      data=next;currentId=desiredId=id;detail=selected;renderError();renderList();renderDetail();
    }catch(error){if(ticket===revision){uiError=error.message;renderError();}}
  }
  async function mutate(name,value){
    if(mutating)return;mutating=true;uiError='';renderList();renderDetail();renderError();
    try{const result=await request(name,value);await refresh(name==='create'?result.id:desiredId);if(name==='create')$('input').focus();}
    catch(error){uiError=error.message;renderError();}
    finally{mutating=false;renderList();renderDetail();}
  }
  async function send(retry=false){
    const id=currentId,text=$('input').value.trim(),before=detail?.messages.length||0;
    if(!detail?.canSend||sending.has(id)||!retry&&!text)return;
    sending.add(id);uiError='';if(!retry){$('input').value='';drafts.set(id,'');}renderError();renderDetail();
    try{await request(retry?'retry':'send',{id,...(!retry?{text}:{})});}
    catch(error){uiError=error.message;}
    finally{
      sending.delete(id);await refresh();
      if(!retry&&currentId===id&&detail?.messages.length<=before&&!$('input').value){$('input').value=text;drafts.set(id,text);renderDetail();}
      if(currentId===id&&!$('input').disabled)$('input').focus();
    }
  }
  $('new').addEventListener('click',()=>void mutate('create'));$('search').addEventListener('input',renderList);
  $('form').addEventListener('submit',event=>{event.preventDefault();void send();});
  $('input').addEventListener('input',()=>{if(currentId)drafts.set(currentId,$('input').value);$('send').disabled=!detail?.canSend||sending.has(currentId)||!$('input').value.trim();if(uiError){uiError='';renderError();}});
  $('input').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.isComposing){event.preventDefault();void send();}});
  $('stop').addEventListener('click',async()=>{try{await request('cancel',{id:currentId});}catch(error){uiError=error.message;renderError();}});
  $('persist').addEventListener('click',()=>void mutate('persist'));
  $('id').addEventListener('click',async()=>{try{await request('copy-id',{id:currentId});message('feedback','会话编号已复制');}catch(error){uiError=error.message;renderError();}});
  $('delete').addEventListener('click',async()=>{
    if(!detail)return;const id=currentId;
    if(await confirmAction({owner:page,title:'删除这段会话？',message:'「'+detail.title+'」及本机保存的对话记录将被删除。',confirmLabel:'删除会话',danger:true})){drafts.delete(id);await mutate('remove',{id});}
  });
  $('rename').addEventListener('click',()=>{if(!detail)return;$('rename-input').value=detail.title;message('rename-error','');$('rename-dialog').showModal();$('rename-input').select();});
  $('rename-cancel').addEventListener('click',()=>$('rename-dialog').close());
  $('rename-form').addEventListener('submit',async event=>{
    event.preventDefault();$('rename-save').disabled=true;
    try{await request('rename',{id:currentId,title:$('rename-input').value});$('rename-dialog').close();await refresh();}catch(error){message('rename-error',error.message);}finally{$('rename-save').disabled=false;}
  });
  document.addEventListener('whale-view-changed',()=>{if(!page.hidden)void refresh();});
  window.whale.onAiSessionsChanged(()=>{if(!page.hidden)void refresh();});
}
