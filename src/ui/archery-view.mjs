import { updateSidebarStatus } from './sidebar-view.mjs';
import { confirmAction } from './confirm-dialog.mjs';
const $=id=>document.getElementById('archery-'+id);

export function createArcheryView() {
  if(!$('view'))return;
  let latest=null,busy=false,listKey='',sequence=0,approvalButtons=[],detailRows=new Map(),actionError='';
  let connection=null,connectionBusy=false,connectionDirty=false,connectionSeen=false;
  let confirmationToken=null;
  window.whale.onArcheryConfirmation(async request=>{
    if(request.cancelled){
      if(confirmationToken===request.token)$('view').querySelector('.ui-confirm-dialog[open]')?.close();
      return;
    }
    confirmationToken=request.token;
    let confirmed=false;
    try{
      const item=request.item;
      confirmed=await confirmAction({owner:$('view'),title:`审核通过工单 #${item.id}？`,
        message:`${item.title}\n提交人：${item.submitter||'—'}\n实例：${item.instance||'—'}\n数据库：${item.database||'—'}\n\n仅审核这一笔工单，不请求执行 SQL。`,confirmLabel:'审核通过'});
    }catch{/* 弹窗无法展示时按取消处理，不保留待确认请求。 */}finally{
      if(confirmationToken===request.token)confirmationToken=null;
      // 只回传本次令牌与明确确认结果；账号、工单编号及权限由主进程再次检查。
      try{await invoke('confirm-approval',{token:request.token,confirmed});}catch{}
    }
  });
  function render(data) {
    if(!data)return;latest=data;
    for(const name of ['config-file','choose-config','default-config','save-config','open-config'])$(name).disabled=busy||data.busy||connectionBusy;
    updateSidebarStatus('archery',data);
    // 开关控制自动刷新，状态文字取实际读取结果，不能把“开启”误报为“已连接”。
    const on=data.enabled!==false;
    $('status').textContent=on?({connected:'已连接',checking:'连接中',error:'连接失败'})[data.state]||'待连接':'已暂停';
    $('status').setAttribute('aria-checked',String(on));
    $('status').title=on?'点击暂停自动刷新':'点击开启自动刷新';
    $('error').textContent=data.error||'';$('error').hidden=!data.error;
    $('feedback').textContent=actionError||data.notice||'';
    const when=data.lastChecked?`上次成功刷新：${new Date(data.lastChecked).toLocaleString('zh-CN')}`:'启动后自动读取待审核列表。';
    $('checked').textContent=data.busy?`${when} · 正在刷新`:`${when} · ${on?'每 5 分钟自动刷新':'已暂停自动刷新'}`;
    $('count').textContent=`本页 ${data.items.length} 条`;
    $('pagination').textContent=`来源第 ${data.page} 页 · ${data.hasMore?'还有下一页':'已到最后一页'}。待办按数据工单筛选，匹配总数未知。`;
    $('empty').hidden=Boolean(data.items.length);
    $('empty').textContent=data.lastChecked?(data.hasMore?'本来源页没有待我审核的数据工单，可以继续查看下一页。':'本页暂无待我审核的数据工单。'):data.busy?'正在读取待审核列表…':'尚未取得待审核列表。';
    $('refresh').disabled=busy||data.busy;
    $('previous').disabled=busy||data.busy||data.page<=1;
    $('next').disabled=busy||data.busy||!data.hasMore;
    $('status').disabled=busy||data.busy;
    for(const {button,id} of approvalButtons){
      const status=data.items.find(item=>item.id===id)?.approvalStatus;
      button.disabled=busy||data.busy||!data.canApprove||Boolean(status);
      button.textContent=({unknown:'结果待核实',failed:'请刷新后核实',success:'已审核通过'})[status]||'审核通过';
      button.title=status==='unknown'?'请核实此工单的审批结果':data.canApprove?'每笔审核前需要确认':'请刷新列表，并确认全局配置开放审核工具';
    }
    for(const entry of detailRows.values()){
      for(const button of [entry.trigger,entry.more,entry.retry,entry.reload].filter(Boolean))button.disabled=busy||data.busy||data.canDetail===false;
    }
    updateConnectionControl();
    // 不变的列表保留原节点，后台状态查询不会打断按钮点击。
    const key=JSON.stringify([data.contentRevision,data.page,data.items.map(item=>item.id)]);
    if(key===listKey){
      for(const item of data.items){
        const entry=detailRows.get(item.id);entry.item=item;
        entry.title.textContent=`#${item.id} ${item.title}`;
        entry.meta.textContent=[item.submitter&&`提交人：${item.submitter}`,item.instance&&`实例：${item.instance}`,item.database&&`数据库：${item.database}`].filter(Boolean).join(' · ');
        entry.date.textContent=item.createdAt?`提交时间：${item.createdAt}`:'';
        if(entry.loaded&&entry.value&&!entry.value.needsConfirmation&&item.status&&entry.value.status!==item.status){
          // 列表轮询只更新状态，保留当前展开位置和已缓存 SQL，不重新请求完整详情。
          entry.value={...entry.value,status:item.status};
          if(entry.statusLine)entry.statusLine.textContent=detailMeta(entry.value);
        }
      }
      return;
    }
    listKey=key;
    // 账号来源或页码变化时重建行；详情仍由主进程按账号隔离缓存。
    approvalButtons=[];detailRows=new Map();
    const rows=data.items.map(item=>{
      const row=document.createElement('article');row.className='archery-order';
      const copy=document.createElement('button'),title=document.createElement('strong'),meta=document.createElement('span'),date=document.createElement('small');
      // 工单字段统一以纯文本展示，绝不执行服务端返回的 HTML。
      copy.type='button';copy.className='archery-message';
      title.id=`archery-title-${item.id}`;title.className='archery-title';title.textContent=`#${item.id} ${item.title}`;
      meta.className='archery-message-meta';
      meta.textContent=[item.submitter&&`提交人：${item.submitter}`,item.instance&&`实例：${item.instance}`,item.database&&`数据库：${item.database}`].filter(Boolean).join(' · ');
      date.textContent=item.createdAt?`提交时间：${item.createdAt}`:'';
      copy.append(title,meta,date);
      copy.disabled=busy||data.busy||data.canDetail===false;
      const box=document.createElement('section');box.className='archery-detail';box.id=`archery-detail-${item.id}`;box.hidden=true;
      box.setAttribute('aria-labelledby',title.id);
      const entry={item,title,meta,date,trigger:copy,box,expanded:false,loaded:false,value:null};detailRows.set(item.id,entry);
      copy.setAttribute('aria-expanded','false');copy.setAttribute('aria-pressed','false');copy.setAttribute('aria-controls',box.id);
      copy.addEventListener('click',()=>void toggleDetail(entry));
      const controls=document.createElement('div');controls.className='archery-actions';
      const approve=document.createElement('button');approve.type='button';approve.className='primary';
      approve.textContent=({unknown:'结果待核实',failed:'请刷新后核实',success:'已审核通过'})[item.approvalStatus]||'审核通过';
      approve.disabled=busy||data.busy||!data.canApprove||Boolean(item.approvalStatus);
      approve.title=item.approvalStatus==='unknown'?'请核实此工单的审批结果':data.canApprove?'每笔审核前需要确认':'请刷新列表，并确认全局配置开放审核工具';
      approve.addEventListener('click',()=>void act('approve',item.id));
      approvalButtons.push({button:approve,id:item.id});controls.append(approve);
      row.append(copy,controls,box);return row;
    });
    $('list').replaceChildren(...rows);
  }
  function renderConnection(data){
    if(!data)return;connection=data;
    // 后台轮询只更新已保存状态，不能覆盖用户尚未提交的路径草稿。
    if(!connectionDirty)$('config-file').value=data.configFile;
    if(!connectionSeen)$('connection-options').open=!data.valid;
    connectionSeen=true;
    if(data.error)$('connection-feedback').textContent=data.error;
    else if(!connectionDirty){
      const allowed=data.permissions||{};
      $('connection-feedback').textContent=`工具权限：详情${allowed.detail?'已开放':'未开放'} · 审核${allowed.approve?'已开放':'未开放'} · 执行${allowed.execute?'已开放':'未开放'}`;
    }
    updateConnectionControl();
  }
  function configurationChanged(){return !connection||$('config-file').value.trim()!==connection.configFile;}
  function updateConnectionControl(){
    // 已保存路径与实际连接结果分别判断，避免连接成功后仍提示再次保存。
    const changed=configurationChanged(),configured=Boolean(connection?.valid&&!changed),connected=configured&&latest?.state==='connected';
    $('save-config').textContent=connectionBusy?'连接中…':connected?'已连接':configured?'重新连接':'保存并连接';
    $('save-config').disabled=busy||latest?.busy||connectionBusy||connected;
    $('connection-state').textContent=changed&&connection?'未保存':connected?'已连接':connection?.valid?'已配置':'未配置';
  }
  async function invoke(name,value){const result=await window.whale.archery(name,value);if(result.error)throw new Error(result.error);return result.value;}
  function expandDetail(entry,value){
    entry.expanded=value;entry.box.hidden=!value;
    entry.trigger.setAttribute('aria-expanded',String(value));entry.trigger.setAttribute('aria-pressed',String(value));
  }
  function detailMeta(data){
    const status=({workflow_manreviewing:'待人工审核',workflow_review_pass:'审核通过',workflow_finish:'已正常结束'})[data.status]||data.status;
    return [status&&`状态：${status}`,data.group&&`资源组：${data.group}`,data.instance&&`实例：${data.instance}`,data.database&&`数据库：${data.database}`].filter(Boolean).join(' · ');
  }
  function showDetail(entry,data,message=''){
    const {box}=entry;box.replaceChildren();entry.more=entry.retry=entry.reload=entry.statusLine=null;
    if(message){
      const error=document.createElement('p');error.className='archery-detail-error';error.textContent=message;
      const retry=document.createElement('button');retry.type='button';retry.className='outline';retry.textContent='重试';
      retry.addEventListener('click',()=>void loadDetail(entry));entry.retry=retry;box.append(error,retry);
    }else if(data.needsConfirmation){
      const hint=document.createElement('p');hint.textContent=`详情约 ${Math.ceil(data.bytes/1024)} KB，完整加载前需要确认。`;
      const more=document.createElement('button');more.type='button';more.className='outline';more.textContent='加载完整详情';
      more.addEventListener('click',()=>void loadDetail(entry,true));entry.more=more;box.append(hint,more);
    }else{
      const meta=document.createElement('p');meta.className='archery-detail-meta';
      meta.textContent=detailMeta(data);entry.statusLine=meta;
      box.append(meta);
      for(const [label,content] of [['SQL 内容',data.sql],['执行结果',data.execution]]){
        const heading=document.createElement('h3'),pre=document.createElement('pre');heading.textContent=label;pre.textContent=content||'暂无内容';
        box.append(heading,pre);
      }
      if(data.cached||data.cacheWarning){
        const hint=document.createElement('p');hint.className='wechat-hint';hint.textContent=data.cacheWarning||'详情已缓存，状态随列表更新。';box.append(hint);
      }
      const reload=document.createElement('button');reload.type='button';reload.className='text-button';reload.textContent='重新加载详情';
      reload.addEventListener('click',()=>void loadDetail(entry,false,true));entry.reload=reload;box.append(reload);
    }
  }
  async function toggleDetail(entry){
    if(busy||latest?.busy||latest?.canDetail===false)return;
    const expanded=!entry.expanded;
    // 与邮件一致，一次只展开选中的记录；切换时保留其他工单已读取的详情。
    if(expanded)for(const other of detailRows.values())if(other!==entry)expandDetail(other,false);
    expandDetail(entry,expanded);
    if(entry.expanded&&!entry.loaded)await loadDetail(entry);
  }
  async function loadDetail(entry,large=false,force=false){
    if(busy||latest?.busy||latest?.canDetail===false)return;
    sequence++;busy=true;expandDetail(entry,true);entry.box.textContent='正在读取工单详情…';render(latest);
    let data,message='';
    try{data=await invoke(large?'detail-large':force?'detail-refresh':'detail',entry.item.id);}
    catch(error){message=error.message;}
    finally{busy=false;render(latest);await sync();}
    // 请求期间换账号、翻页或关闭模块后，迟到结果不得写回新行。
    if(detailRows.get(entry.item.id)!==entry)return;
    if(data?.cancelled)data=entry.value;
    // 主动重载失败时保留已显示的 SQL，仅补充失败说明，避免错误页面覆盖可用缓存。
    if(message&&entry.value&&!entry.value.needsConfirmation){data={...entry.value,cacheWarning:message};message='';}
    if(data){entry.value=data;entry.loaded=true;}
    showDetail(entry,data,message||(!data?'详情读取已取消。':''));
  }
  async function sync() {
    if(busy)return;
    const stamp=++sequence;
    try {const [data,source]=await Promise.all([invoke('snapshot'),invoke('connection')]);if(stamp===sequence){render(data);renderConnection(source);}}
    catch {if(stamp===sequence){$('error').textContent='无法读取 Archery 状态，请稍后重试。';$('error').hidden=false;}}
  }
  async function act(name,value) {
    if(busy||latest?.busy)return;
    sequence++;busy=true;actionError='';render(latest);
    try {render(await invoke(name,value));}
    catch(error){actionError=error.message;}
    finally {busy=false;render(latest);await sync();}
  }
  $('open-config').addEventListener('click',async()=>{
    try{await invoke('open-config');}catch(error){$('connection-feedback').textContent=error.message;}
  });
  function markPathDirty(){
    connectionDirty=configurationChanged();
    // 新选路径尚未连接，不继续展示上一次保存失败的旧错误。
    if(connectionDirty)$('connection-feedback').textContent='路径尚未保存，点击“保存并连接”生效。';
    else renderConnection(connection);
    updateConnectionControl();
  }
  $('config-file').addEventListener('input',markPathDirty);
  $('default-config').addEventListener('click',()=>{if(connection){$('config-file').value=connection.defaultFile;markPathDirty();}});
  $('choose-config').addEventListener('click',async()=>{
    if(busy||connectionBusy||latest?.busy)return;
    connectionBusy=true;render(latest);
    try{const file=await invoke('choose-config');if(file){$('config-file').value=file;markPathDirty();}}
    catch(error){$('connection-feedback').textContent=error.message;}
    finally{connectionBusy=false;render(latest);}
  });
  $('connection-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||connectionBusy||latest?.busy)return;
    // 原路径连接失败时只重连，不重复写入同一配置；已连接时忽略重复提交。
    if(!configurationChanged()&&connection?.valid){if(latest?.state!=='connected')await act('refresh');return;}
    sequence++;busy=true;connectionBusy=true;render(latest);
    let saved=false;
    try{
      const source=await invoke('save-config',$('config-file').value.trim());
      connectionDirty=false;renderConnection(source);saved=true;
    }catch(error){$('connection-feedback').textContent=error.message;}
    finally{
      connectionBusy=false;busy=false;render(latest);
      // 保存失败时保留用户草稿和校验说明；成功后再同步连接结果。
      if(saved){
        await sync();
        if(latest?.state==='connected')$('connection-options').open=false;
        $('connection-feedback').textContent=latest?.error?`路径已保存，连接失败：${latest.error}`:'配置已保存，已按所选文件连接。';
      }
    }
  });
  $('status').addEventListener('click',()=>{if(latest)void act('set-enabled',latest.enabled===false);});
  $('refresh').addEventListener('click',()=>void act('refresh'));
  $('previous').addEventListener('click',()=>void act('page',latest.page-1));
  $('next').addEventListener('click',()=>void act('page',latest.page+1));
  document.getElementById('nav-archery').addEventListener('click',()=>void sync());
  // 这里只查询主进程内存快照，真正的五分钟 MCP 请求不依赖页面是否可见。
  setInterval(()=>{if(!$('view').hidden)void sync();},2000);
}
