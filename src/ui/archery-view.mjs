import { updateSidebarStatus } from './sidebar-view.mjs';
const $=id=>document.getElementById('archery-'+id);

export function createArcheryView() {
  if(!$('view'))return;
  let latest=null,busy=false,listKey='',sequence=0,approvalButtons=[],actionError='';
  let connection=null,connectionBusy=false,connectionDirty=false,connectionSeen=false;
  function render(data) {
    if(!data)return;latest=data;
    for(const name of ['config-file','choose-config','default-config','save-config','open-config'])$(name).disabled=busy||data.busy||connectionBusy;
    updateSidebarStatus('archery',data);
    // 「已连接 / 已暂停」只控制本地定时读取，不表示 Archery 服务端会话状态。
    const on=data.enabled!==false;
    $('status').textContent=on?'已连接':'已暂停';
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
    for(const {button,status} of approvalButtons)button.disabled=busy||data.busy||!data.canApprove||Boolean(status);
    // 不变的列表保留原节点，后台状态查询不会打断按钮点击。
    const key=JSON.stringify(data.items);
    if(key===listKey)return;listKey=key;
    approvalButtons=[];
    const rows=data.items.map(item=>{
      const row=document.createElement('article');row.className='archery-order';
      const copy=document.createElement('div'),title=document.createElement('strong'),meta=document.createElement('p'),date=document.createElement('small');
      // 工单字段统一以纯文本展示，绝不执行服务端返回的 HTML。
      title.textContent=`#${item.id} ${item.title}`;
      meta.textContent=[item.submitter&&`提交人：${item.submitter}`,item.instance&&`实例：${item.instance}`,item.database&&`数据库：${item.database}`].filter(Boolean).join(' · ');
      date.textContent=item.createdAt?`提交时间：${item.createdAt}`:'';
      copy.append(title,meta,date);
      const open=document.createElement('button');open.type='button';open.className='outline';open.textContent='打开工单';
      open.addEventListener('click',()=>void act('open',item.id));
      const controls=document.createElement('div');controls.className='archery-actions';
      const approve=document.createElement('button');approve.type='button';approve.className='primary';
      approve.textContent=({unknown:'结果待核实',failed:'请刷新后核实',success:'已审核通过'})[item.approvalStatus]||'审核通过';
      approve.disabled=busy||data.busy||!data.canApprove||Boolean(item.approvalStatus);
      approve.title=item.approvalStatus==='unknown'?'请打开原工单核实审批结果':data.canApprove?'每笔审核前需要确认':'请刷新列表，并确认全局配置开放审核工具';
      approve.addEventListener('click',()=>void act('approve',item.id));
      approvalButtons.push({button:approve,status:item.approvalStatus});controls.append(open,approve);
      row.append(copy,controls);return row;
    });
    $('list').replaceChildren(...rows);
  }
  function renderConnection(data){
    if(!data)return;connection=data;
    $('connection-state').textContent=data.valid?'已配置':'未配置';
    // 后台轮询只更新已保存状态，不能覆盖用户尚未提交的路径草稿。
    if(!connectionDirty)$('config-file').value=data.configFile;
    if(!connectionSeen&&!data.valid)$('connection-options').open=true;
    connectionSeen=true;
    if(data.error)$('connection-feedback').textContent=data.error;
    else if(!connectionDirty){
      const allowed=data.permissions||{};
      $('connection-feedback').textContent=`工具权限：详情${allowed.detail?'已开放':'未开放'} · 审核${allowed.approve?'已开放':'未开放'} · 执行${allowed.execute?'已开放':'未开放'}`;
    }
  }
  async function invoke(name,value){const result=await window.whale.archery(name,value);if(result.error)throw new Error(result.error);return result.value;}
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
  $('config-file').addEventListener('input',()=>{connectionDirty=true;});
  $('default-config').addEventListener('click',()=>{if(connection){$('config-file').value=connection.defaultFile;connectionDirty=true;}});
  $('choose-config').addEventListener('click',async()=>{
    if(busy||connectionBusy||latest?.busy)return;
    connectionBusy=true;render(latest);
    try{const file=await invoke('choose-config');if(file){$('config-file').value=file;connectionDirty=true;}}
    catch(error){$('connection-feedback').textContent=error.message;}
    finally{connectionBusy=false;render(latest);}
  });
  $('connection-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||connectionBusy||latest?.busy)return;
    sequence++;busy=true;connectionBusy=true;render(latest);
    let saved=false;
    try{
      const source=await invoke('save-config',$('config-file').value.trim());
      connectionDirty=false;renderConnection(source);saved=true;
    }catch(error){$('connection-feedback').textContent=error.message;}
    finally{
      connectionBusy=false;busy=false;render(latest);
      // 保存失败时保留用户草稿和校验说明；成功后再同步连接结果。
      if(saved){await sync();$('connection-feedback').textContent=latest?.error?`路径已保存，连接失败：${latest.error}`:'配置已保存，已按所选文件连接。';}
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
