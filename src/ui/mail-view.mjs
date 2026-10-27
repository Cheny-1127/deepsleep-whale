import { updateSidebarStatus } from './sidebar-view.mjs';
import { confirmAction } from './confirm-dialog.mjs';
const $=id=>document.getElementById('mail-'+id);
// 小屋按需读取邮箱快照，邮件字段始终通过 textContent 展示，不执行邮件 HTML。
export function createMailView() {
  if(!$('view'))return;
  const detail=$('detail'),deleteButton=$('delete');
  let busy=false,latest=null,listKey='',selected='',request=0,configKey='',dirty=false;
  let pendingAction='';
  let savedPasswordShown=false,passwordScope='',passwordRequest=0,revealing=false;
  function render(data) {
    if(!data)return;latest=data;
    updateSidebarStatus('mail',data);
    // 暂停只改变配置卡片外观，仍允许编辑配置和重新开始接收。
    $('config-card').dataset.paused=String(Boolean(data.config)&&data.enabled===false);
    $('config-state').textContent=data.config?.hasPassword?'已配置':'未配置';
    $('account').textContent=data.email||'填写邮箱后开始接收';
    $('account').title=data.email||'';
    $('error').textContent=data.error||'';$('error').hidden=!data.error;
    $('checked').textContent=data.lastChecked?`上次同步：${new Date(data.lastChecked).toLocaleString('zh-CN')} · 本地正文 ${data.cacheCount||0}/${data.messages.length} 封 · ${data.enabled?'每分钟检查一次':'已暂停同步'}`:'连接后每分钟同步最近邮件，已缓存正文可离线查看。';
    const nextConfig=JSON.stringify(data.config);
    // 后台轮询不能覆盖用户正在编辑的配置草稿。
    if(nextConfig!==configKey&&!dirty) {
      configKey=nextConfig;
      if(data.config){
        for(const name of ['type','email','host','port'])$(name).value=data.config[name];
        $('message-limit').value=data.config.limit;
      }
      updateType();
    }
    updatePasswordState();
    for(const button of $('view').querySelectorAll('[data-mail-action]'))button.disabled=busy||data.busy;
    for(const field of $('settings').querySelectorAll('input,select'))field.disabled=busy||data.busy;
    $('refresh').disabled=busy||data.busy||!data.enabled;
    deleteButton.disabled=busy||data.busy;
    const limit=data.config?.limit||20;
    if(selected&&!data.messages.some(item=>item.id===selected))clearDetail();
    // 列表内容不变时保留原节点，避免轮询打断点击或重置展开位置。
    const key=JSON.stringify(data.messages);
    if(key!==listKey) {
      listKey=key;const rows=[];deleteButton.remove();
      for(const item of data.messages) {
        const row=document.createElement('div');row.className='mail-message-row';
        const button=document.createElement('button');button.type='button';button.className='mail-message';button.dataset.messageId=item.id;
        button.setAttribute('aria-controls','mail-detail');
        const subject=document.createElement('strong'),meta=document.createElement('span');
        subject.id='mail-message-title-'+rows.length;button.dataset.subjectId=subject.id;
        subject.textContent=item.subject;meta.textContent=[item.from,item.date].filter(Boolean).join(' · ');button.append(subject,meta);
        button.addEventListener('click',()=>void read(item));row.append(button);
        rows.push(row);
      }
      $('list').replaceChildren(...rows,detail,deleteButton);
    }
    for(const button of $('list').querySelectorAll('.mail-message')) {
      const expanded=selected===button.dataset.messageId;
      button.setAttribute('aria-pressed',String(expanded));button.setAttribute('aria-expanded',String(expanded));
      // 标题只保留在列表行；删除按钮与打开邮件的按钮并列，避免嵌套交互控件。
      const row=button.parentElement;row.dataset.selected=String(expanded);
      if(expanded){row.append(deleteButton);detail.setAttribute('aria-labelledby',button.dataset.subjectId);if(row.nextSibling!==detail)row.after(detail);}
    }
    deleteButton.hidden=!selected;
    $('empty').hidden=Boolean(data.messages.length);
    $('empty').textContent=data.state==='connected'?'收件箱暂无邮件。':`连接后显示最近 ${limit} 封邮件。`;
    $('limit').hidden=!data.hasMore;
    $('limit').textContent=`仅展示最近 ${limit} 封。两次收取间超过 ${limit} 封的新邮件可能无法完整提醒，请在原邮箱查看完整邮件。`;
  }
  function clearDetail(){selected='';request++;$('detail').hidden=true;deleteButton.hidden=true;$('body').textContent='';$('attachments').textContent='';}
  async function invoke(name,value){const result=await window.whale.mail(name,value);if(result.error)throw new Error(result.error);return result.value;}
  async function sync(){try{render(await invoke('snapshot'));}catch(error){$('error').hidden=false;$('error').textContent=error.message;}}
  async function act(name,value) {
    if(busy&&name!=='pause')return;
    hidePassword();
    busy=true;pendingAction=name;clearDetail();render(latest);$('feedback').textContent='';
    try {
      const data=await invoke(name,value);
      if(name==='connect'&&data.state==='connected'){dirty=false;configKey='';}
      render(data);
    }
    catch(error){$('feedback').textContent=error.message;}
    finally{busy=false;pendingAction='';await sync();}
  }
  async function read(item) {
    if(busy)return;
    if(selected===item.id){clearDetail();render(latest);return;}
    // 再次选择或收起时递增版本，迟到的正文不再覆盖当前选择。
    selected=item.id;const stamp=++request;render(latest);
    $('detail').hidden=false;$('body').textContent='正在读取正文…';$('attachments').textContent='';
    try {
      const detail=await invoke('read',item.id);
      if(stamp!==request)return;
      $('body').textContent=detail.body||'（无纯文本正文）';
      $('attachments').textContent=detail.attachments.length?`附件：${detail.attachments.join('、')}（请在原邮箱打开）`:'';
    }catch(error){if(stamp===request)$('body').textContent=error.message;}
  }
  deleteButton.addEventListener('click',async()=>{
    // 确认前固定邮件与账号；确认期间切换连接后，主进程会拒绝这份旧身份。
    const item=latest?.messages.find(item=>item.id===selected),account=latest?.config;
    if(!item||!account||busy||latest.busy)return;
    if(!await confirmAction({owner:$('view'),title:'删除这封邮件？',message:`将从小屋移除「${item.subject||'无主题邮件'}」及本地正文，后续同步不再显示。原邮箱中的邮件保留。`,confirmLabel:'删除邮件',danger:true}))return;
    busy=true;render(latest);
    try{
      const data=await invoke('delete-message',{id:item.id,account});
      clearDetail();render(data);$('feedback').textContent='邮件已从小屋删除，原邮箱保留。';
    }catch(error){$('feedback').textContent=error.message;}
    finally{busy=false;await sync();}
  });
  for(const button of $('view').querySelectorAll('[data-mail-action]'))button.addEventListener('click',()=>void act(button.dataset.mailAction));
  function updateType(){
    const custom=$('type').value==='custom';$('server-fields').hidden=!custom;
    if(!custom){$('host').value='imap.feishu.cn';$('port').value='993';}
  }
  function draftAccount(){return {email:$('email').value.trim(),type:$('type').value,
    host:$('type').value==='custom'?$('host').value.trim().toLowerCase():'imap.feishu.cn',port:$('type').value==='custom'?Number($('port').value):993};}
  // 比较真实草稿值而非输入事件；仅查看已保存密码不算配置修改。
  function configurationChanged(){
    const config=latest?.config,account=draftAccount();
    return !config||Object.keys(account).some(key=>account[key]!==config[key])||Number($('message-limit').value)!==config.limit||Boolean($('password').value&&!savedPasswordShown);
  }
  function shouldPause(){return Boolean(latest?.enabled&&!configurationChanged());}
  // 同一按钮按状态开始或暂停；配置已修改时改为保存，避免点击后误暂停。
  function updateConnectionControl(){
    const pause=shouldPause(),button=$('connect');
    button.type=pause?'button':'submit';
    button.textContent=pause?'暂停接收':latest?.config&&configurationChanged()?'保存并接收':'开始接收';
    button.disabled=pause?pendingAction==='pause':busy||Boolean(latest?.busy);
  }
  function setPasswordVisible(visible){
    $('password').type=visible?'text':'password';
    const label=visible?'隐藏密码':'显示密码';
    $('password-toggle').setAttribute('aria-label',label);$('password-toggle').title=label;
    $('password-toggle').setAttribute('aria-pressed',String(visible));$('password-slash').hidden=!visible;
  }
  // 只清除为展示而读取的旧密码，用户新输入的值在隐藏后仍保留。
  function hidePassword(){
    passwordRequest++;revealing=false;
    if(savedPasswordShown)$('password').value='';
    savedPasswordShown=false;setPasswordVisible(false);$('password-toggle').disabled=false;
  }
  async function togglePassword(){
    if(revealing||busy)return;
    if($('password').type==='text'){hidePassword();updatePasswordState();return;}
    if($('password').value){setPasswordVisible(true);return;}
    const config=latest?.config,account=draftAccount();
    if(!config?.hasPassword||Object.keys(account).some(key=>account[key]!==config[key])){setPasswordVisible(true);return;}
    const stamp=++passwordRequest;revealing=true;$('password-toggle').disabled=true;
    try {
      // 密码不随轮询传输；显式读取后仍校验版本与草稿身份，防止串号显示。
      const result=await invoke('reveal-password',account);
      if(stamp!==passwordRequest||$('password').value||JSON.stringify(account)!==JSON.stringify(draftAccount()))return;
      savedPasswordShown=true;$('password').value=result.password;setPasswordVisible(true);updatePasswordState();
    }catch(error){if(stamp===passwordRequest)$('feedback').textContent=error.message;}
    finally{if(stamp===passwordRequest){revealing=false;$('password-toggle').disabled=false;}}
  }
  function updatePasswordState(){
    const scope=JSON.stringify([draftAccount(),latest?.config]);
    if(scope!==passwordScope){hidePassword();passwordScope=scope;}
    const config=latest?.config,custom=$('type').value==='custom';
    const same=config?.hasPassword&&config.email===$('email').value.trim()&&config.type===$('type').value&&
      config.host===(custom?$('host').value.trim().toLowerCase():'imap.feishu.cn')&&config.port===(custom?Number($('port').value):993);
    const entered=Boolean($('password').value)&&!savedPasswordShown;
    $('password').placeholder=same?'********':'输入客户端专用密码或授权码';
    $('password-state').textContent=entered?(same?'已填写新密码，保存并接收后替换已保存密码。':'已填写密码，开始接收后保存。'):
      same?'密码已加密保存，无需重复填写。':config?.hasPassword?'当前邮箱或服务器未配置密码，请重新填写。':'尚未配置密码，请填写后开始接收。';
    updateConnectionControl();
  }
  $('connect').addEventListener('click',event=>{if(shouldPause()){event.preventDefault();void act('pause');}});
  $('password-toggle').addEventListener('click',()=>void togglePassword());
  $('password').addEventListener('input',()=>{savedPasswordShown=false;passwordRequest++;revealing=false;$('password-toggle').disabled=false;});
  $('options').addEventListener('toggle',()=>{if(!$('options').open)hidePassword();});
  for(const button of document.querySelectorAll('[data-view]'))if(button.dataset.view!=='mail')button.addEventListener('click',hidePassword);
  $('settings').addEventListener('input',()=>{dirty=true;updatePasswordState();});
  $('type').addEventListener('change',()=>{dirty=true;updateType();updatePasswordState();});
  $('settings').addEventListener('submit',event=>{
    event.preventDefault();
    if(shouldPause()){void act('pause');return;}
    const value=Object.fromEntries(['type','email','host','port','password'].map(name=>[name,$(name).value]));
    // 已保存密码仅供查看，提交空值表示沿用；真正编辑后才提交替换值。
    if(savedPasswordShown)value.password='';
    value.limit=$('message-limit').value;
    $('password').value='';void act('connect',value);
  });
  updateType();
  updatePasswordState();
  const tick=()=>{if(!$('view').hidden&&!busy)void sync();};
  document.getElementById('nav-mail').addEventListener('click',tick);
  setInterval(tick,2000);
}
