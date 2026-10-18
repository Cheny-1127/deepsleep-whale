const $=id=>document.getElementById('wechat-'+id);
const statuses={disconnected:'未连接','logging-in':'正在扫码',connecting:'连接中',connected:'已连接',reconnecting:'正在重连',paused:'已暂停',expired:'登录失效',error:'连接异常'};
const jobs={queued:'排队中',running:'排查中',approval:'等待审批',question:'等待回答',completed:'已完成',failed:'未完成',interrupted:'已中断',cancelled:'已取消'};
export function createWechatView() {
  if(!$('view'))return {render(){}};
  let latest,dirty=false,busy=false,rowsKey='',clientKey='',draft=[];
  function element(tag,text,className){const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;}
  function readDraft(){return [...$('clients').children].filter(row=>row.dataset.clientId).map(row=>({...draft.find(client=>client.id===row.dataset.clientId),
    ...Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.type==='checkbox'?input.checked:input.value]))}));}
  function editClients(change){draft=change(readDraft());dirty=true;drawClients();render(latest);}
  function drawClients() {
    $('clients').replaceChildren();
    for(const [index,client]of draft.entries()) {
      const row=element('section',null,'wechat-client');row.dataset.clientId=client.id;
      const head=element('div',null,'wechat-client-head'),toggle=element('label'),checkbox=element('input');checkbox.type='checkbox';checkbox.dataset.field='enabled';checkbox.checked=client.enabled;
      toggle.append(checkbox,document.createTextNode('启用'));head.append(element('strong',`优先级 ${index+1}`),toggle);
      for(const [text,action,disabled]of [
        ['上移',list=>{[list[index-1],list[index]]=[list[index],list[index-1]];return list;},index===0],
        ['下移',list=>{[list[index+1],list[index]]=[list[index],list[index+1]];return list;},index===draft.length-1],
        ['移除',list=>list.filter(item=>item.id!==client.id),false]
      ]){const button=element('button',text,'outline');button.type='button';button.disabled=disabled;button.dataset.edge=String(disabled);button.addEventListener('click',()=>editClients(action));head.append(button);}
      row.append(head);
      function field(key,label,placeholder='') {const wrapper=element('label',label),input=element('input');input.dataset.field=key;input.value=client[key]||'';input.placeholder=placeholder;
        if(key==='name'){input.required=true;input.maxLength=60;}wrapper.append(input);return wrapper;}
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
    busy=true;$('feedback').textContent='';render(latest);
    try {
      const result=await window.whale.wechat(name,value);
      if(result.error)throw new Error(result.error);
      if(name==='save-clients'){dirty=false;clientKey='';}
      if(typeof result.value==='string')$('feedback').textContent=result.value;
      else if(name==='save-clients')$('feedback').textContent='客户端已保存。';
      const data=await window.whale.snapshot();render(data.wechat);
    }catch(error){$('feedback').textContent=error.message||'操作未完成，请重试。';}
    finally{busy=false;render(latest);}
  }
  $('settings').addEventListener('input',()=>{dirty=true;render(latest);});
  $('settings').addEventListener('submit',event=>{event.preventDefault();void act('save-clients',readDraft());});
  for(const backend of ['codex','cursor'])$('add-'+backend).addEventListener('click',()=>editClients(list=>[...list,{id:'client-'+crypto.randomUUID(),name:backend==='codex'?'Codex '+(list.length+1):'Cursor CLI',backend,enabled:true,binary:'',configHome:'',profile:''}]));
  for(const name of ['login','check','retry','cancel-login'])$(name).addEventListener('click',()=>void act(name));
  $('toggle').addEventListener('click',()=>void act('enable',!latest?.enabled));
  $('forget').addEventListener('click',()=>{if(window.confirm('解绑将清除本机微信凭据、选择记录和待投递结果，并停止任务；客户端自身的聊天历史不受影响。'))void act('forget');});
  function render(data) {
    latest=data;if(!data)return;
    const nextClientKey=JSON.stringify(data.clients);
    // 主进程持续广播任务状态，不能因此覆盖用户尚未保存的客户端配置。
    if(!dirty&&nextClientKey!==clientKey){clientKey=nextClientKey;draft=data.clients.map(client=>({...client}));drawClients();}
    const enabled=data.clients.filter(client=>client.enabled);
    $('client-summary').textContent=enabled.length?`已启用 ${enabled.length} 个 · 优先 ${enabled[0].name}`:'未启用客户端';
    $('status').textContent=statuses[data.status]||data.status;
    const error=data.error||(!data.storageAvailable?'系统安全存储不可用，暂时不能连接微信。':'');
    $('error').hidden=!error;$('error').textContent=error;
    $('account').textContent=data.account?`机器人：${data.account.id}`:'扫码绑定机器人账号后，用微信给它发送 /projects。';
    $('qr-box').hidden=!data.qr;
    if(data.qr){if($('qr').src!==data.qr.image)$('qr').src=data.qr.image;$('qr-status').textContent=data.qr.status;}else $('qr').removeAttribute('src');
    $('toggle').hidden=!data.account;$('toggle').textContent=data.enabled?'暂停接收':'恢复接收';
    $('forget').hidden=!data.account&&!data.error;
    for(const button of $('view').querySelectorAll('button'))button.disabled=busy||button.dataset.edge==='true';
    $('login').disabled=busy||!data.storageAvailable||Boolean(data.qr)||Boolean(data.active);
    const locked=busy||Boolean(data.active)||data.jobs.some(job=>job.state==='queued');
    for(const input of $('settings').querySelectorAll('input,select,button'))input.disabled=locked||input.dataset.edge==='true';
    $('check').disabled=locked||dirty||!enabled.length;
    $('add-codex').disabled=locked||draft.length>=12;$('add-cursor').disabled=locked||draft.length>=12;
    $('outbox').textContent=`待投递 ${data.outbox} 条`;
    const nextKey=JSON.stringify([data.allowed,data.pending,data.jobs]);
    if(nextKey!==rowsKey){
      rowsKey=nextKey;$('users').replaceChildren();$('jobs').replaceChildren();
      for(const [kind,users]of [['allowed',data.allowed],['pending',data.pending]])for(const user of users){
        const row=element('div',null,'wechat-row'),text=element('span',`${user} · ${kind==='allowed'?'已授权':'待授权'}`),button=element('button',kind==='allowed'?'撤销':'授权','outline');
        button.addEventListener('click',()=>void act(kind==='allowed'?'remove-user':'allow-user',user));row.append(text,button);$('users').append(row);
      }
      if(!$('users').children.length)$('users').textContent='暂无联系人';
      for(const job of data.jobs){const row=element('div',null,'wechat-row');row.append(element('span',`${job.sender} · ${new Date(job.startedAt).toLocaleTimeString('zh-CN')}`),element('strong',jobs[job.state]||job.state));$('jobs').append(row);if(job.failure)$('jobs').append(element('p',job.failure.message,'wechat-hint'));}
      if(!data.jobs.length)$('jobs').textContent='尚未收到任务';
      for(const button of $('users').querySelectorAll('button'))button.disabled=busy;
    }
  }
  return {render};
}
