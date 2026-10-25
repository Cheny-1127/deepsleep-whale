const $=id=>document.getElementById('wechat-'+id);
const statuses={disconnected:'未连接','logging-in':'正在扫码',connecting:'连接中',connected:'已连接',reconnecting:'正在重连',paused:'已暂停',expired:'登录失效',error:'连接异常'};
const jobs={queued:'排队中',running:'排查中',recovering:'恢复跟踪中',approval:'等待审批',question:'等待回答',completed:'已完成',failed:'未完成',interrupted:'已中断',cancelled:'已取消'};
export function createWechatView() {
  if(!$('view'))return {render(){}};
  let latest,dirty=false,busy=false,rowsKey='',jobsKey='',selectedChat='',openTask='',detailVersion=0,clientKey='',draft=[];
  const taskDetails=new Map(),taskRows=new Map();
  let discovery=null,discoveryKey='',scanning=false,discoveryError='';
  let connectionId='',connectionsKey='',settingsTab='clients';const connectionDrafts=new Map();
  // 发起请求时固定账号，异步返回期间切换页面不会改变该操作的目标。
  const scoped=(value,id=latest?.selectedConnectionId)=>id?{connectionId:id,value}:value;
  function element(tag,text,className){const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;}
  async function toggleTask(job) {
    openTask=openTask===job.id?'':job.id;
    if(!openTask||taskDetails.has(job.id)){drawJobs(latest.jobs,job.id);return;}
    const entry={loading:true};taskDetails.set(job.id,entry);drawJobs(latest.jobs,job.id);
    try {
      const result=await window.whale.wechat('task-detail',scoped(job.id));
      if(result.error)throw new Error(result.error);
      entry.value=result.value;
    }catch(error){entry.error=error.message||'内容读取失败，请收起后重试。';}
    finally{
      entry.loading=false;
      // 删除、解绑或记录淘汰后，迟到的读取结果不能重新显示已清理的正文。
      if(openTask===job.id&&latest.jobs.some(item=>item.id===job.id)){detailVersion++;drawJobs(latest.jobs,job.id);}
    }
  }
  function drawJobs(records,anchorId) {
    const ids=new Set(records.map(job=>job.id));for(const id of taskDetails.keys())if(!ids.has(id))taskDetails.delete(id);
    if(openTask&&!ids.has(openTask))openTask='';
    const groups=new Map();
    for(const job of records){
      const chat=job.chat||{key:job.id,name:'未记录对话',clientName:'',project:''};
      if(!groups.has(chat.key))groups.set(chat.key,{...chat,records:[]});
      groups.get(chat.key).records.push(job);
    }
    if(selectedChat&&!groups.has(selectedChat))selectedChat='';
    const nextKey=JSON.stringify([records,selectedChat,openTask,detailVersion]);if(nextKey===jobsKey)return;jobsKey=nextKey;
    const root=$('jobs');
    if(!groups.size){root.replaceChildren();taskRows.clear();return;}
    const time=job=>Number.isFinite(job.startedAt)?new Date(job.startedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'时间未记录';
    const description=chat=>[chat.project||'未指定项目',chat.clientName,`${chat.records.length} 次任务`].filter(Boolean).join(' · ');
    const label=job=>[jobs[job.state]||job.state,job.delivery==='failed'?'投递失败':job.delivery==='pending'?'待投递':''].filter(Boolean).join(' · ');
    function identity(chat){const copy=element('span',null,'wechat-chat-copy');copy.title=chat.name+' · '+description(chat);copy.append(element('strong',chat.name),element('span',' · '+description(chat),'wechat-chat-meta'));return copy;}
    // 单个对话直接展示明细；多个对话必须由用户选中，不把不同 chat 的任务混在一起。
    const current=groups.size===1?[...groups.values()][0]:groups.get(selectedChat);
    if(!current){
      root.replaceChildren();taskRows.clear();
      root.append(element('p','选择对话查看任务记录。','wechat-hint'));
      for(const chat of groups.values()){
        const button=element('button',null,'wechat-chat-button'),last=chat.records[0];
        button.type='button';button.dataset.chatKey=chat.key;button.disabled=busy;
        const status=element('span',null,'wechat-chat-status');status.append(element('strong',label(last)),element('small',time(last)));
        button.append(identity(chat),status);button.addEventListener('click',()=>{selectedChat=chat.key;openTask='';drawJobs(latest.jobs);});root.append(button);
      }
      return;
    }
    let history=root.querySelector('.wechat-task-history'),heading=root.querySelector('.wechat-chat-heading');
    const sameChat=history?.dataset.chatKey===current.key,pageY=window.scrollY;
    // 保留滚动容器和任务节点；展开、异步加载和状态广播都不能重建整份列表。
    const anchor=sameChat?(taskRows.get(anchorId)?.node||[...history.children].find(node=>node.getBoundingClientRect().bottom>history.getBoundingClientRect().top)):null;
    const anchorTop=anchor?.getBoundingClientRect().top;
    if(!sameChat){
      root.replaceChildren();taskRows.clear();heading=element('div',null,'wechat-chat-heading');history=element('div',null,'wechat-task-history');history.dataset.chatKey=current.key;root.append(heading,history);
    }
    const copy=identity(current);if(heading.firstChild)heading.firstChild.replaceWith(copy);else heading.append(copy);
    if(groups.size>1&&!heading.querySelector('[data-chat-back]')){
      const back=element('button','返回对话列表','outline');back.type='button';back.dataset.chatBack='';back.disabled=busy;
      back.addEventListener('click',()=>{selectedChat='';openTask='';drawJobs(latest.jobs);});heading.append(back);
    }
    if(groups.size===1)heading.querySelector('[data-chat-back]')?.remove();
    const visibleIds=new Set(current.records.map(job=>job.id));
    for(const [id,cached]of taskRows)if(!visibleIds.has(id)){cached.node.remove();taskRows.delete(id);}
    for(const [index,job]of current.records.entries()){
      let cached=taskRows.get(job.id);
      if(!cached){
        const node=element('div',null,'wechat-task'),row=element('div',null,'wechat-row'),timestamp=element('span'),actions=element('span',null,'wechat-task-actions'),status=element('strong');
        actions.append(status);row.append(timestamp,actions);node.append(row);cached={node,timestamp,actions,status};taskRows.set(job.id,cached);
      }
      const {node:task,timestamp,actions,status}=cached;
      const stamp=time(job),state=label(job);if(timestamp.textContent!==stamp)timestamp.textContent=stamp;if(status.textContent!==state)status.textContent=state;
      if(['completed','failed','interrupted','cancelled'].includes(job.state)){
        if(!cached.view){
          const view=element('button',null,'outline');view.type='button';view.dataset.taskView=job.id;
          view.addEventListener('click',()=>{if(taskDetails.get(job.id)?.error)taskDetails.delete(job.id);void toggleTask(job);});actions.append(view);cached.view=view;
        }
        const text=openTask===job.id?'收起内容':'查看内容';if(cached.view.textContent!==text)cached.view.textContent=text;
        cached.view.disabled=busy;cached.view.setAttribute('aria-expanded',String(openTask===job.id));
      }
      if(job.canDelete&&!cached.remove){
        const remove=element('button','删除记录','outline');remove.type='button';remove.dataset.taskDelete=job.id;remove.disabled=busy;
        remove.title='删除本机记录并停止该任务的后续投递，不影响 Codex 对话或已发送消息。';remove.addEventListener('click',()=>void act('delete-task',job.id));actions.append(remove);cached.remove=remove;
      }
      if(!job.canDelete&&cached.remove){cached.remove.remove();cached.remove=null;}
      if(job.failure){
        if(!cached.failure){cached.failure=element('p',null,'wechat-hint');task.insertBefore(cached.failure,cached.content||null);}
        if(cached.failure.textContent!==job.failure.message)cached.failure.textContent=job.failure.message;
      }else if(cached.failure){cached.failure.remove();cached.failure=null;}
      const detailKey=openTask===job.id?`${detailVersion}:${job.state}`:'';
      if(cached.detailKey!==detailKey){
        cached.content?.remove();cached.content=null;cached.detailKey=detailKey;
        if(openTask===job.id){
          const detail=element('div',null,'wechat-task-content'),entry=taskDetails.get(job.id);detail.dataset.taskContent=job.id;
          if(entry?.loading)detail.append(element('p','正在加载内容…','wechat-hint'));
          else if(entry?.error)detail.append(element('p',entry.error,'wechat-hint'));
          else if(entry?.value){
            for(const [title,value,empty]of [['发送内容',entry.value.request,'旧版记录未保留本次发送内容。'],['回复内容',entry.value.response,job.state==='completed'?'旧版记录未保留本次回复。':'本次任务未产生完成回复。']]){
              detail.append(element('strong',title));detail.append(element(value===null?'p':'pre',value===null?empty:value,value===null?'wechat-hint':'wechat-task-text'));
            }
          }
          task.append(detail);cached.content=detail;
        }
      }
      if(history.children[index]!==task)history.insertBefore(task,history.children[index]||null);
    }
    // 前一条正文收起或上方新增记录时，以当前点击/阅读的任务为锚点补偿高度变化。
    if(sameChat){if(anchor?.isConnected)history.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;if(window.scrollY!==pageY)window.scrollTo(window.scrollX,pageY);}
  }
  function readDraft(){return [...$('clients').children].filter(row=>row.dataset.clientId).map(row=>({...draft.find(client=>client.id===row.dataset.clientId),
    ...Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.type==='checkbox'?input.checked:input.value]))}));}
  function editClients(change){draft=change(readDraft());dirty=true;drawClients();render(latest);}
  function discoveredMatch(candidate,list) {
    if(!candidate.available)return;
    const defaults=discovery.defaults;
    // 默认留空的旧记录与检测出的实际路径是同一个实例，不能重复加入优先级。
    const identity=client=>JSON.stringify([client.backend,client.binary||defaults[client.backend+'Binary']||'',client.backend==='codex'?(client.configHome||defaults.codexHome||''):'',client.profile||'']);
    return list.find(client=>identity(client)===identity(candidate));
  }
  function drawDiscovered(locked) {
    $('discovery-status').textContent=scanning?'正在检测运行中的客户端…':discoveryError||discovery?.message||'打开客户端设置时自动检测 Codex / Cursor 桌面客户端。';
    const list=readDraft(),key=JSON.stringify([discovery,list,locked]);
    if(key===discoveryKey){for(const button of $('discovered').querySelectorAll('button'))button.disabled=locked||button.dataset.edge==='true';return;}discoveryKey=key;$('discovered').replaceChildren();
    for(const candidate of discovery?.clients||[]){
      const row=element('div',null,'wechat-discovered-client'),copy=element('div'),match=discoveredMatch(candidate,list);
      copy.append(element('strong',candidate.name),element('p',candidate.reason||candidate.description,'wechat-hint'));
      if(candidate.configHome)copy.append(element('code',candidate.configHome));
      const text=!candidate.available?'需自定义添加':match?.enabled?`已添加 · 优先级 ${list.indexOf(match)+1}`:match?'启用':'添加到优先级';
      const button=element('button',text,'outline');button.type='button';button.dataset.discoveryKey=candidate.key;
      button.dataset.edge=String(!candidate.available||Boolean(match?.enabled)||(!match&&list.length>=12));button.disabled=locked||button.dataset.edge==='true';
      button.addEventListener('click',()=>editClients(clients=>{
        const existing=discoveredMatch(candidate,clients);
        if(existing){existing.enabled=true;return clients;}
        if(clients.length>=12||!candidate.available)return clients;
        return [...clients,{id:'client-'+crypto.randomUUID(),name:candidate.name,backend:candidate.backend,enabled:true,binary:candidate.binary,configHome:candidate.configHome,profile:candidate.profile}];
      }));
      row.append(copy,button);$('discovered').append(row);
    }
  }
  function drawClients() {
    $('clients').replaceChildren();
    for(const [index,client]of draft.entries()) {
      const row=element('section',null,'wechat-client');row.dataset.clientId=client.id;
      const head=element('div',null,'wechat-client-head'),toggle=element('label'),checkbox=element('input');checkbox.type='checkbox';checkbox.dataset.field='enabled';checkbox.checked=client.enabled;
      const title=element('strong',null,'wechat-client-title');
      const updateTitle=name=>{title.textContent=`${name.trim()||'未命名客户端'}（优先级 ${index+1}）`;};updateTitle(client.name);
      toggle.append(checkbox,document.createTextNode('启用'));head.append(title,toggle);
      for(const [text,action,disabled]of [
        ['上移',list=>{[list[index-1],list[index]]=[list[index],list[index-1]];return list;},index===0],
        ['下移',list=>{[list[index+1],list[index]]=[list[index],list[index+1]];return list;},index===draft.length-1],
        ['移除',list=>list.filter(item=>item.id!==client.id),false]
      ]){const button=element('button',text,'outline');button.type='button';button.disabled=disabled;button.dataset.edge=String(disabled);button.addEventListener('click',()=>editClients(action));head.append(button);}
      row.append(head);
      function field(key,label,placeholder='') {const wrapper=element('label',label),input=element('input');input.dataset.field=key;input.value=client[key]||'';input.placeholder=placeholder;
        // 只更新标题文本，保留正在编辑的输入框和光标；排序后由新位置重新生成优先级。
        if(key==='name'){input.required=true;input.maxLength=60;input.addEventListener('input',()=>updateTitle(input.value));}wrapper.append(input);return wrapper;}
      const identity=element('div',null,'wechat-client-identity');identity.append(field('name','名称'));
      const backendLabel=element('label','客户端'),select=element('select');select.dataset.field='backend';
      for(const [value,label]of [['codex','Codex'],['cursor','Cursor CLI']]){const option=element('option',label);option.value=value;select.append(option);}select.value=client.backend;backendLabel.append(select);identity.append(backendLabel);row.append(identity);
      const details=element('details'),codexFields=element('div');details.append(element('summary','高级选项 · 默认无需填写'),field('binary','可执行文件路径（留空自动检测）','客户端 CLI 的绝对路径'));
      codexFields.append(field('configHome','Codex 配置目录（留空沿用本机默认）','例如：/Users/you/.codex'),field('profile','Codex profile（可选）','已有配置中的 profile 名称'));
      codexFields.hidden=client.backend!=='codex';select.addEventListener('change',()=>{codexFields.hidden=select.value!=='codex';});details.append(codexFields);row.append(details);
      if(client.backend==='cursor')row.append(element('p','Cursor 需要已登录的 CLI，使用 Ask 模式；已有编辑器对话不在 Codex 列表中。','wechat-hint'));
      $('clients').append(row);
    }
    if(!draft.length)$('clients').append(element('p','没有配置客户端。仍可扫码连接微信；执行任务前请添加并启用客户端。','wechat-hint'));
  }
  async function act(name,value) {
    if(busy)return;
    if(name==='discover-clients'){scanning=true;discoveryError='';}
    busy=true;$('feedback').textContent='';render(latest);
    try {
      const result=await window.whale.wechat(name,['select-connection','add-connection'].includes(name)?value:scoped(value));
      if(result.error)throw new Error(result.error);
      if(name==='save-clients'){dirty=false;clientKey='';}
      if(name==='discover-clients'){discovery=result.value;discoveryKey='';}
      if(typeof result.value==='string')$('feedback').textContent=result.value;
      else if(name==='save-clients')$('feedback').textContent='客户端已保存。';
      else if(name==='delete-task')$('feedback').textContent='记录已删除。';
      else if(name==='rename-connection'||name==='rename-user')$('feedback').textContent='备注已保存。';
      const data=await window.whale.snapshot();render(data.wechat);
      if(name==='forget')$('settings-dialog').close();
      return true;
    }catch(error){$('feedback').textContent=error.message||'操作未完成，请重试。';if(name==='discover-clients')discoveryError=$('feedback').textContent;return false;}
    finally{
      busy=false;scanning=false;render(latest);
      if(['add-connection','select-connection','forget'].includes(name)){
        [...$('connections').children].find(button=>button.dataset.connectionId===latest.selectedConnectionId)?.focus();
      }
    }
  }
  $('settings').addEventListener('input',()=>{dirty=true;render(latest);});
  $('settings').addEventListener('submit',event=>{event.preventDefault();void act('save-clients',readDraft());});
  for(const backend of ['codex','cursor'])$('add-'+backend).addEventListener('click',()=>editClients(list=>[...list,{id:'client-'+crypto.randomUUID(),name:backend==='codex'?'Codex '+(list.length+1):'Cursor CLI',backend,enabled:true,binary:'',configHome:'',profile:''}]));
  for(const name of ['login','retry','cancel-login'])$(name).addEventListener('click',()=>void act(name));
  $('reconnect').addEventListener('click',()=>{
    if(window.confirm(`重新扫码「${latest.connectionName||'当前微信'}」会暂停它的接收并停止当前任务。继续吗？`)){$('settings-dialog').close();void act('login');}
  });
  $('rename').addEventListener('click',()=>{$('name-form').hidden=false;$('name').value=latest.connectionName||'';$('name').focus();});
  $('name-cancel').addEventListener('click',()=>{$('name-form').hidden=true;$('rename').focus();});
  $('name-form').addEventListener('submit',async event=>{event.preventDefault();if(await act('rename-connection',$('name').value))$('name-form').hidden=true;});
  // 配置只针对打开时选中的微信；原生 dialog 负责焦点约束、Esc 与关闭后的焦点恢复。
  function showSettingsTab(tab) {
    settingsTab=tab;
    // 账号操作常驻列表下方；弹窗只切换客户端、联系人和帮助，不隐藏主页面的账号工具栏。
    const panels={clients:'client-options',contacts:'contacts',help:'help'};
    for(const [name,id]of Object.entries(panels)){
      $(id).hidden=name!==tab;const button=$('tab-'+name);button.setAttribute('aria-selected',String(name===tab));button.tabIndex=name===tab?0:-1;
    }
    if(tab==='clients'&&latest&&!discovery&&!busy)void act('discover-clients');
  }
  function openSettings(tab=settingsTab){if(!$('settings-dialog').open)$('settings-dialog').showModal();showSettingsTab(tab);}
  $('open-settings').addEventListener('click',()=>openSettings(latest?.pending.length?'contacts':settingsTab));
  $('show-help').addEventListener('click',()=>openSettings('help'));
  $('setup-client').addEventListener('click',()=>openSettings('clients'));
  $('close-settings').addEventListener('click',()=>$('settings-dialog').close());
  $('settings-dialog').addEventListener('close',()=>render(latest));
  for(const button of $('settings-dialog').querySelectorAll('[data-settings-tab]')){
    button.addEventListener('click',()=>showSettingsTab(button.dataset.settingsTab));
    button.addEventListener('keydown',event=>{
      const tabs=[...$('settings-dialog').querySelectorAll('[data-settings-tab]')],index=tabs.indexOf(button);
      const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:null;
      if(next!==null){event.preventDefault();tabs[next].focus();showSettingsTab(tabs[next].dataset.settingsTab);}
    });
  }
  document.addEventListener('whale-view-changed',()=>{if($('view').hidden)$('settings-dialog').close();});
  $('add-connection').addEventListener('click',()=>void act('add-connection'));
  $('check').addEventListener('click',()=>void act('discover-clients'));
  $('toggle').addEventListener('click',()=>void act('enable',!latest?.enabled));
  function forgetConnection(){
    // 未扫码的连接也是完整的可删除对象，不能以“已绑定”作为删除入口的显示条件。
    const message=latest.account?`移除「${latest.connectionName||'当前微信'}」将清除它的本机凭据、选择记录、备注和待投递结果，并停止它的任务；其他微信连接和客户端自身的聊天历史不受影响。`:`删除尚未扫码的「${latest.connectionName||'当前微信'}」？其他微信连接和配置不受影响。`;
    if(window.confirm(message))void act('forget');
  }
  $('forget').addEventListener('click',forgetConnection);
  $('remove-draft').addEventListener('click',forgetConnection);
  function contactName(data,user) {return data.contactNames&&Object.hasOwn(data.contactNames,user)?data.contactNames[user]:user===data.account?.owner?'我自己（扫码账号）':`联系人 ${[...data.allowed,...data.pending].indexOf(user)+1}`;}
  function render(data) {
    if(!data)return;
    const switched=connectionId!==data.selectedConnectionId,bound=Boolean(data.account);
    if(switched) {
      // 每个连接保留自己的客户端草稿；切换账号不覆盖未保存配置或带入上个账号的任务正文。
      if(connectionId)connectionDrafts.set(connectionId,{draft:readDraft(),dirty});
      connectionId=data.selectedConnectionId;const saved=connectionDrafts.get(connectionId);
      dirty=Boolean(saved?.dirty);draft=saved?.draft||data.clients.map(client=>({...client}));clientKey='';
      rowsKey='';jobsKey='';selectedChat='';openTask='';detailVersion++;taskDetails.clear();taskRows.clear();$('jobs').replaceChildren();
      discovery=null;discoveryKey='';discoveryError='';drawClients();
    }
    if(switched){$('name-form').hidden=true;$('settings-dialog').close();}
    latest=data;
    const connections=data.connections||[];
    const nextConnectionsKey=JSON.stringify([connections,data.selectedConnectionId]);
    if(nextConnectionsKey!==connectionsKey){
      // 仅身份、状态或选择变化时重画账号卡，后台广播不能反复抢走键盘焦点。
      const focused=document.activeElement?.dataset.connectionId;connectionsKey=nextConnectionsKey;$('connections').replaceChildren();
      for(const item of connections){
        const showStatus=item.account||['logging-in','error'].includes(item.status);
        // 已绑定且停收的账号在重启后可能尚未启动轮询，展示“已暂停”以匹配下方恢复操作。
        const state=item.account&&!item.enabled&&item.status==='disconnected'?'paused':item.status;
        const button=element('button',null,'ui-choice'),name=element('strong',item.name),status=element('small',showStatus?statuses[state]||state:'待扫码');
        const selected=item.id===data.selectedConnectionId;button.type='button';button.dataset.connectionId=item.id;button.setAttribute('aria-pressed',String(selected));status.className='ui-status';status.dataset.state=showStatus?state:'disconnected';if(selected)status.id='wechat-status';
        button.append(name,status);
        const attention=[item.taskCount?`${item.taskCount} 个任务`:null,item.pendingCount?`${item.pendingCount} 位待授权`:null,item.outboxCount?`${item.outboxCount} 条待投递`:null].filter(Boolean).join(' · ');
        if(attention)button.append(element('small',attention,'wechat-account-attention'));
        button.addEventListener('click',()=>{if(item.id!==latest.selectedConnectionId)void act('select-connection',item.id);});$('connections').append(button);
      }
      if(focused)[...$('connections').children].find(button=>button.dataset.connectionId===focused)?.focus();
    }
    const nextClientKey=JSON.stringify(data.clients);
    // 主进程持续广播任务状态，不能因此覆盖用户尚未保存的客户端配置。
    if(!dirty&&nextClientKey!==clientKey){clientKey=nextClientKey;draft=data.clients.map(client=>({...client}));drawClients();}
    const enabled=data.clients.filter(client=>client.enabled);
    const connectionName=data.connectionName||connections.find(item=>item.id===data.selectedConnectionId)?.name||'当前微信';
    $('account-heading').textContent=`管理：${connectionName}`;
    $('settings-scope').textContent=`当前管理：${connectionName}。此处配置只影响这个微信。`;
    $('open-settings').textContent=data.pending.length?`微信设置 · ${data.pending.length} 位待授权`:'微信设置';
    $('client-summary').textContent=enabled.length?`新对话默认使用 ${enabled[0].name}`:'未启用客户端，暂不能执行任务';
    $('client-scope').textContent=`仅用于「${connectionName}」。已有对话继续使用原客户端，新对话使用下方第一个已启用客户端。`;
    $('task-scope').textContent=connectionName;$('users-scope').textContent=`仅管理「${connectionName}」的本机操作权限，其他微信的授权独立保留。`;
    $('users-summary').textContent=`${data.allowed.length} 位已授权${data.pending.length?` · ${data.pending.length} 位待授权`:''}`;
    const working=data.jobs.find(job=>data.active?.id===job.id)||data.jobs.find(job=>['running','approval','question','recovering'].includes(job.state)),queued=data.jobs.filter(job=>job.state==='queued').length;
    $('activity').textContent=[working?`${jobs[working.state]} · ${contactName(data,working.sender)}`:'',queued?`${queued} 个任务排队中`:'',data.outbox?`${data.outbox} 条消息待投递`:''].filter(Boolean).join(' · ');
    $('activity').hidden=!$('activity').textContent;
    const error=data.error||(!data.storageAvailable?'系统安全存储不可用，暂时不能连接微信。':'');
    $('error').hidden=!error;$('error').textContent=error;
    $('feedback').hidden=!$('feedback').textContent||$('settings-dialog').open;
    $('settings-feedback').textContent=$('feedback').textContent;$('settings-feedback').hidden=!$('feedback').textContent;
    $('account').textContent=data.account?`机器人：${data.account.id}`:'扫码绑定机器人账号后，用微信给它发送 /projects。';
    $('owner').textContent=data.account?.owner?`扫码账号：${data.account.owner}`:'';
    const loggingIn=data.status==='logging-in'||Boolean(data.qr);
    $('connection-state').textContent=loggingIn?`请用要接入的微信扫描二维码，完成「${connectionName}」的连接。`:!bound?`「${connectionName}」尚未扫码。扫码后即可通过这个微信发送任务。`:data.status==='expired'?'登录已失效，请重新扫码恢复连接。':!data.enabled?'接收已暂停，恢复后继续接收这个微信的消息。':!enabled.length?'微信已连接；尚未启用客户端，请先设置客户端。':data.status!=='connected'?'正在尝试连接，请稍候。':'';
    $('connection-panel').hidden=!$('connection-state').textContent;
    $('qr-box').hidden=!data.qr;
    if(data.qr){if($('qr').src!==data.qr.image)$('qr').src=data.qr.image;$('qr-status').textContent=data.qr.status;}else $('qr').removeAttribute('src');
    $('toggle').hidden=!bound||data.status==='expired'||loggingIn;$('toggle').textContent=data.enabled?'暂停接收':'恢复接收';
    // 恢复和暂停使用同一入口；提示区不再另放一个重复按钮。
    $('toggle').classList.toggle('primary',!data.enabled);$('toggle').classList.toggle('outline',data.enabled);
    $('remove-draft').hidden=bound||connections.length<2;
    $('setup-client').hidden=!bound||enabled.length>0||loggingIn;
    $('forget').textContent=bound?'移除此微信':'删除此微信';
    $('forget').hidden=!bound;
    $('identity').hidden=!bound;
    for(const button of $('view').querySelectorAll('button'))button.disabled=busy||button.dataset.edge==='true';
    // 检测或保存期间仍可关闭设置、阅读帮助，避免低频配置阻塞页面退出。
    for(const button of $('settings-dialog').querySelectorAll('[data-settings-tab],#wechat-close-settings'))button.disabled=false;
    $('add-connection').disabled=busy||!data.storageAvailable||connections.length>=(data.connectionLimit||8);
    $('login').hidden=loggingIn||(bound&&data.status!=='expired');
    $('login').textContent=data.account?'重新扫码':'扫码连接';
    $('login').disabled=busy||!data.storageAvailable||Boolean(data.qr)||Boolean(data.active);
    $('reconnect').hidden=!bound||data.status==='expired'||loggingIn;$('reconnect').disabled=$('login').disabled;
    $('cancel-login').hidden=!loggingIn;
    for(const input of $('name-form').querySelectorAll('input,button'))input.disabled=busy;
    const locked=busy||Boolean(data.active)||data.jobs.some(job=>['queued','recovering'].includes(job.state));
    for(const input of $('settings').querySelectorAll('input,select,button'))input.disabled=locked||input.dataset.edge==='true';
    $('check').disabled=busy;
    $('add-codex').disabled=locked||draft.length>=12;$('add-cursor').disabled=locked||draft.length>=12;
    drawDiscovered(locked);
    $('outbox').textContent=`待投递 ${data.outbox} 条`;
    $('outbox').hidden=!data.outbox;$('retry').hidden=!data.outbox;
    const nextKey=JSON.stringify([data.allowed,data.pending,data.contactNames,data.account?.owner]);
    if(nextKey!==rowsKey){
      rowsKey=nextKey;$('users').replaceChildren();
      for(const [kind,users]of [['allowed',data.allowed],['pending',data.pending]])for(const user of users){
        const row=element('div',null,'wechat-row wechat-contact'),text=element('div',null,'wechat-contact-copy'),actions=element('div',null,'wechat-contact-actions'),button=element('button',kind==='allowed'?'撤销授权':'授权','outline'),rename=element('button','备注','outline');
        text.append(element('strong',contactName(data,user)),element('small',kind==='allowed'?'已授权操作本机':'待授权，暂不能执行任务'));
        const identity=element('details'),summary=element('summary','查看账号标识');identity.append(summary,element('code',user));text.append(identity);
        const form=element('form',null,'wechat-inline-form'),input=element('input'),save=element('button','保存备注','outline'),cancel=element('button','取消','outline');
        form.hidden=true;input.maxLength=40;input.placeholder='例如：我自己';input.setAttribute('aria-label','联系人备注');save.type='submit';cancel.type='button';
        rename.type='button';button.type='button';rename.addEventListener('click',()=>{form.hidden=false;input.value=latest.contactNames?.[user]||'';input.focus();});
        cancel.addEventListener('click',()=>{form.hidden=true;rename.focus();});form.append(input,save,cancel);
        form.addEventListener('submit',async event=>{event.preventDefault();if(await act('rename-user',{sender:user,name:input.value}))form.hidden=true;});
        button.addEventListener('click',()=>{if(kind==='allowed'&&!window.confirm(`撤销「${contactName(latest,user)}」在当前微信的本机操作权限，并停止其任务和待投递结果？`))return;void act(kind==='allowed'?'remove-user':'allow-user',user);});
        actions.append(rename,button);row.append(text,actions,form);$('users').append(row);
      }
      if(!$('users').children.length)$('users').textContent='暂无联系人';
    }
    for(const input of $('users').querySelectorAll('button,input'))input.disabled=busy;
    $('task-card').hidden=!bound&&!data.jobs.length;
    $('empty').hidden=data.jobs.length>0||!bound;
    $('empty').querySelector('h3').textContent=data.status==='expired'?'恢复连接后，继续用微信发任务':!data.enabled?'恢复接收后，继续用微信发任务':!enabled.length?'设置好客户端，就能开始了':'连接好了，发条微信试试';
    $('start-hint').textContent=data.status==='expired'?'先重新扫码恢复连接，再在微信里发送任务。':!data.enabled?'先恢复接收，再在微信里发送任务。':!enabled.length?'先点击上方“设置客户端”，启用一个客户端后再发送任务。':`用「${connectionName}」给扫码连接的机器人发送：`;
    drawJobs(data.jobs);
  }
  return {render};
}
