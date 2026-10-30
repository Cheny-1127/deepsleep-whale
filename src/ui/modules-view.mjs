const labels={subscriptions:'消息订阅',archery:'Archery',hooks:'Hooks 配置',wechat:'微信接入',mail:'邮箱接收',quota:'API 额度',shortcuts:'快捷操作',planner:'日程备忘',reports:'工作报告'};

export function createModulesView({render}) {
  const rows=new Map();let latest={},saving=new Set();
  for(const [id,label] of Object.entries(labels)){
    const page=document.getElementById(id+'-view'),header=page?.querySelector(':scope > header');if(!header)continue;
    const content=document.createElement('div');content.className='module-content';content.id=id+'-module-content';
    // 保留现有节点与监听；开关在禁用区外，关闭后仍能通过键盘重新开启。
    for(const node of [...page.childNodes])if(node!==header)content.append(node);
    page.append(content);
    const actions=document.createElement('div');actions.className='module-header-actions';
    for(const node of [...header.children].slice(1))actions.append(node);
    const toggle=document.createElement('button');toggle.type='button';toggle.className='module-toggle';toggle.id=id+'-module-toggle';
    toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','开启'+label);toggle.setAttribute('aria-controls',content.id);toggle.disabled=true;
    const caption=document.createElement('span');caption.className='module-toggle-label';
    const track=document.createElement('span');track.className='module-toggle-track';track.setAttribute('aria-hidden','true');track.append(caption);toggle.append(track);
    actions.append(toggle);header.append(actions);
    const error=document.createElement('p');error.className='ui-alert module-error';error.setAttribute('role','alert');error.hidden=true;page.insertBefore(error,content);
    rows.set(id,{page,content,actions,toggle,caption,error});
    toggle.addEventListener('click',async()=>{
      // 同一模块保存期间防止连击；等主进程确认后再更新状态，失败时保留原开关。
      if(saving.has(id))return;saving.add(id);error.hidden=true;update(latest);
      try {const result=await window.whale.modules({id,enabled:latest[id]===false});if(result.error)throw Error(result.error);render(result.value);}
      catch(failure){error.textContent=failure.message||'开关未保存，请重试。';error.hidden=false;}
      finally{saving.delete(id);update(latest);}
    });
  }
  function update(modules){
    latest=modules||{};
    for(const [id,row] of rows){
      const enabled=latest[id]!==false;row.page.dataset.moduleEnabled=String(enabled);row.content.inert=!enabled;
      row.content.setAttribute('aria-disabled',String(!enabled));row.caption.textContent=enabled?'已开启':'未开启';
      row.toggle.setAttribute('aria-checked',String(enabled));row.toggle.disabled=saving.has(id)||!Object.hasOwn(latest,id);
      row.toggle.title=enabled?'关闭此模块，保留已有数据和配置':'开启此模块';
      // 标题中的原有操作同样禁用；独立的总开关保持可用。
      for(const action of row.actions.children)if(action!==row.toggle)action.inert=!enabled;
      if(!enabled)for(const dialog of row.page.querySelectorAll('dialog[open]'))dialog.close();
      const nav=document.getElementById('nav-'+id);if(nav){nav.dataset.moduleEnabled=String(enabled);nav.title=enabled?(nav.dataset.status?nav.dataset.status+' · 点击查看或设置 · ':'')+'长按整理菜单':'未开启 · 点击进入开启模块 · 长按整理菜单';}
    }
  }
  return {render:update};
}
