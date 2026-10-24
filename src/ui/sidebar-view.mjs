// 只根据确认的配置标记状态；暂停的入口仍可进入设置和查看缓存。
export function updateSidebarStatus(id,data) {
  const button=document.getElementById('nav-'+id);
  if(!button||!data)return;
  let status='';
  if(id==='hooks') {
    // 能力检测完成后才判断“未启用”，避免检测中的临时状态让菜单闪灰。
    const sources=Object.keys(data.settings.sources).filter(source=>data.settings.sources[source]);
    if(!sources.length)status='已暂停';
    else if(sources.every(source=>data.hookAvailability?.[source]?.state==='checked'&&
      !Object.entries(data.hookAvailability[source].events).some(([event,value])=>value.available&&data.settings.events?.[source]?.[event]!==false)))status='未启用';
  } else if(id==='wechat')status=!data.account?'未连接':data.enabled===false?'已暂停':'';
  else if(id==='mail')status=!data.config?'未配置':data.enabled===false?'已暂停':'';
  else if(id==='archery')status=data.enabled===false?'已暂停':'';
  // 多账号功能仅在全部账号暂停时置灰；单个账号暂停不代表整个功能停用。
  else if(id==='subscriptions')status=!data.accounts.length?'未订阅':data.accounts.every(account=>!account.enabled)?'已暂停':'';
  else if(id==='quota')status=data.accounts.length&&data.accounts.every(account=>account.refreshEnabled===false)?'已暂停':'';
  // 主进程频繁广播快照，相同状态不重复修改 DOM 或读屏说明。
  if(button.dataset.status===status)return;
  button.dataset.status=status;
  button.title=(status?status+' · 点击查看或设置 · ':'')+'长按整理菜单';
  // 视觉上只保留灰色背景，具体原因通过悬停提示和 aria-describedby 提供。
  let badge=button.querySelector('.sidebar-status');
  if(!badge){badge=document.createElement('span');badge.className='sidebar-status';badge.id='sidebar-status-'+id;button.append(badge);}
  badge.textContent=status;badge.hidden=!status;
  if(status)button.setAttribute('aria-describedby',badge.id);else button.removeAttribute('aria-describedby');
}

// 菜单节点只移动、不重建，保留页面切换监听与未读徽标。
export function createSidebarView() {
  const sidebar=document.querySelector('.sidebar'),nav=sidebar?.querySelector('nav');
  if(!nav)return;
  const buttons=[...nav.querySelectorAll('[data-view]')],rows=new Map();
  let layout={visible:buttons.map(button=>button.dataset.view),more:[]};
  // layout 是当前预览；saved 只记录落盘成功的布局，供保存失败时回滚。
  let saved=structuredClone(layout),ready=false,saving=false,editing=false,press=null,drag=null,frame=0,suppressClick=false;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const make=(tag,className,text)=>{const el=document.createElement(tag);el.className=className;if(text)el.textContent=text;return el;};
  const visible=make('div','sidebar-list'),more=make('div','sidebar-list sidebar-more-list');
  visible.id='sidebar-visible';more.id='sidebar-more-list';more.hidden=true;
  const moreGroup=make('div','sidebar-more-group');
  const toggle=make('button','sidebar-more-toggle');toggle.type='button';toggle.id='sidebar-more-toggle';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',more.id);
  const toggleLabel=make('span','sidebar-more-label'),toggleCount=make('span','sidebar-more-count');
  const chevron=document.createElementNS('http://www.w3.org/2000/svg','svg');
  chevron.setAttribute('viewBox','0 0 12 12');chevron.setAttribute('aria-hidden','true');
  const chevronPath=document.createElementNS(chevron.namespaceURI,'path');chevronPath.setAttribute('d','m4 2 4 4-4 4');chevron.append(chevronPath);
  toggle.append(chevron,toggleLabel,toggleCount);moreGroup.append(toggle,more);
  const empty=make('p','sidebar-empty','暂无收纳的菜单');
  const organize=make('button','sidebar-organize','整理');organize.type='button';organize.id='sidebar-organize';organize.setAttribute('aria-label','整理菜单');organize.disabled=true;
  sidebar.querySelector('.nav-label').append(organize);
  const feedback=make('p','sidebar-feedback');feedback.id='sidebar-feedback';feedback.setAttribute('role','status');
  for(const button of buttons) {
    const id=button.dataset.view,row=make('div','sidebar-row'),control=make('button','sidebar-transfer');
    row.dataset.menu=id;control.type='button';control.hidden=true;
    // 用同一组细线绘制加减号，避免字体基线与字重造成视觉偏移。
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    icon.setAttribute('viewBox','0 0 12 12');icon.setAttribute('aria-hidden','true');
    for(const [line,vertical] of [['M2 6h8',false],['M6 2v8',true]]) {
      const stroke=document.createElementNS(icon.namespaceURI,'path');stroke.setAttribute('d',line);
      if(vertical)stroke.classList.add('sidebar-plus-stroke');icon.append(stroke);
    }
    control.append(icon);
    const label=button.textContent.trim().replace(/^[^\p{L}\p{N}]+/u,'').trim();
    button.title='长按整理菜单';control.dataset.label=label;
    // 移动原有节点以保留未读徽标；名称单独限宽，避免收纳后撑出侧栏。
    const copy=make('span','sidebar-menu-label');copy.append(...button.childNodes);button.append(copy);
    row.append(button,control);rows.set(id,row);visible.append(row);
    control.addEventListener('click',()=>{
      if(!ready||saving||drag)return;
      // 跨区域移动只由加减按钮触发，追加到目标末尾，不改变页面或后台功能状态。
      const source=layout.more.includes(id)?'more':'visible',target=source==='more'?'visible':'more';
      layout[source]=layout[source].filter(item=>item!==id);layout[target].push(id);
      rearrange();void save();
      // 收纳后把焦点留在可见入口，避免隐藏节点持有焦点。
      if(target==='more'&&more.hidden)toggle.focus();else button.focus();
    });
  }
  nav.append(visible,moreGroup,feedback);
  function update() {
    sidebar.classList.toggle('sidebar-editing',editing);
    organize.textContent=editing?'完成':'整理';organize.setAttribute('aria-label',editing?'完成整理':'整理菜单');organize.setAttribute('aria-pressed',String(editing));
    for(const [id,row] of rows) {
      const inside=layout.more.includes(id),control=row.querySelector('.sidebar-transfer');
      control.toggleAttribute('data-restore',inside);control.hidden=!inside&&!editing;control.disabled=saving||!ready;
      control.setAttribute('aria-label',`${inside?'移回常用':'收进更多'}：${control.dataset.label}`);
    }
    const selected=layout.more.some(id=>rows.get(id).querySelector('.selected'));
    toggle.classList.toggle('contains-selected',selected);
    moreGroup.classList.toggle('is-expanded',!more.hidden);
    toggleLabel.textContent=more.hidden?'显示更多':'收起更多';
    toggleCount.textContent=String(layout.more.length);toggleCount.hidden=!layout.more.length;
    toggle.setAttribute('aria-label',`${toggleLabel.textContent}，${layout.more.length} 个菜单${selected?'，当前页面在更多中':''}`);
    toggle.title=selected?'当前页面在更多中':'';
    empty.hidden=layout.more.length>0;
    nav.setAttribute('aria-busy',String(saving));
  }
  function rearrange(animate=true) {
    const before=new Map([...rows.values()].map(row=>[row,row.getBoundingClientRect()]));
    // FLIP：先排好最终位置，再用位移动画让邻项平滑让位，不逐帧改布局。
    for(const row of rows.values())row.getAnimations().forEach(animation=>animation.cancel());
    for(const id of layout.visible)visible.append(rows.get(id));
    for(const id of layout.more)more.append(rows.get(id));
    more.append(empty);update();
    if(!animate||reduced.matches)return;
    for(const [row,rect] of before) {
      if(row===drag?.row||!rect.height||!row.getBoundingClientRect().height)continue;
      const delta=rect.top-row.getBoundingClientRect().top;
      if(delta)row.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:180,easing:'ease-out'});
    }
  }
  async function save() {
    if(JSON.stringify(layout)===JSON.stringify(saved))return;
    // 保存期间阻止新的布局修改，避免旧请求失败后覆盖后续操作。
    saving=true;feedback.textContent='正在保存…';update();
    try {saved=await window.whale.sidebar(structuredClone(layout));feedback.textContent='已保存';}
    catch {layout=structuredClone(saved);rearrange();feedback.textContent='保存失败，已恢复上次布局，请重试。';}
    finally {saving=false;update();}
  }
  function setEditing(value) {editing=value;if(!value)suppressClick=false;update();}
  organize.addEventListener('click',()=>{if(drag)finish(false);setEditing(!editing);});
  toggle.addEventListener('click',()=>{more.hidden=!more.hidden;toggle.setAttribute('aria-expanded',String(!more.hidden));update();});
  document.addEventListener('whale-view-changed',update);
  // 捕获阶段拦截整理/拖动产生的 click，避免已有导航监听误切换页面。
  nav.addEventListener('click',event=>{
    if(event.target.closest('[data-view]')&&(editing||suppressClick)) {event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}
  },true);
  function clearPress() {if(press)clearTimeout(press.timer);press=null;}
  function begin() {
    if(!press||saving)return;
    setEditing(true);suppressClick=true;
    const row=press.row,rect=row.getBoundingClientRect(),ghost=row.cloneNode(true);
    // 浮层只负责视觉跟随；移除导航标识与重复 ID，原节点仍保留占位。
    ghost.classList.add('sidebar-drag-ghost');ghost.setAttribute('aria-hidden','true');ghost.inert=true;
    for(const el of [ghost,...ghost.querySelectorAll('*')]){el.removeAttribute('id');el.removeAttribute('data-view');}
    ghost.style.cssText=`left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    sidebar.append(ghost);row.classList.add('sidebar-drag-placeholder');
    drag={row,ghost,id:row.dataset.menu,zone:layout.more.includes(row.dataset.menu)?'more':'visible',before:structuredClone(layout),startY:press.y,y:press.y,offset:press.y-rect.top,moved:false,pointer:press.pointer};
    // 捕获放在不会被重排的 nav 上，移动菜单 DOM 不会丢失拖动手势。
    nav.setPointerCapture(press.pointer);clearPress();frame=requestAnimationFrame(tick);
  }
  function tick() {
    if(!drag)return;
    const area=sidebar.getBoundingClientRect();
    if(drag.moved) {
      // 靠近侧栏边缘时自动滚动，长列表无需松手也能移动到首尾。
      const speed=drag.y<area.top+44?-8:drag.y>area.bottom-44?8:0;
      sidebar.scrollTop+=speed;
      drag.ghost.style.top=`${drag.y-drag.offset}px`;
      const list=drag.zone==='more'?more:visible,others=layout[drag.zone].filter(id=>id!==drag.id);
      // 用未带动画的布局坐标判定越过中线，避免滑动中的邻项反复交换。
      const top=list.getBoundingClientRect().top;
      let index=others.findIndex(id=>{const row=rows.get(id);return drag.y<top+row.offsetTop+row.offsetHeight/2;});
      if(index<0)index=others.length;
      others.splice(index,0,drag.id);
      if(others.join()!==layout[drag.zone].join()){layout[drag.zone]=others;rearrange();}
    }
    frame=requestAnimationFrame(tick);
  }
  function finish(commit) {
    clearPress();cancelAnimationFrame(frame);
    if(!drag)return;
    const ended=drag;drag=null;
    // 只有正常松手才保存；Esc、失焦、取消事件统一恢复本次拖动前的布局。
    if(!commit)layout=ended.before;
    ended.row.classList.remove('sidebar-drag-placeholder');rearrange();
    ended.ghost.remove();
    if(nav.hasPointerCapture(ended.pointer))nav.releasePointerCapture(ended.pointer);
    // pointerup 的 click 紧随其后；下一次真正按下再解除抑制。
    suppressClick=true;if(commit)void save();
  }
  nav.addEventListener('pointerdown',event=>{
    suppressClick=false;
    const button=event.target.closest('[data-view]');
    if(!button||event.button!==0||!event.isPrimary||!ready||saving||drag)return;
    clearPress();press={row:button.closest('.sidebar-row'),x:event.clientX,y:event.clientY,pointer:event.pointerId};
    // 首次长按区分整理与普通点击；进入整理后可直接拖动，提前移动则取消长按。
    press.timer=setTimeout(begin,editing?0:450);
  });
  window.addEventListener('pointermove',event=>{
    if(drag&&event.pointerId===drag.pointer){event.preventDefault();drag.y=event.clientY;if(Math.abs(drag.y-drag.startY)>5)drag.moved=true;}
    else if(press&&event.pointerId===press.pointer&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>7)clearPress();
  },{passive:false});
  window.addEventListener('pointerup',event=>{if(drag&&event.pointerId===drag.pointer)finish(true);else if(press?.pointer===event.pointerId)clearPress();});
  window.addEventListener('pointercancel',()=>finish(false));
  nav.addEventListener('lostpointercapture',()=>{if(drag)finish(false);});
  window.addEventListener('blur',()=>{finish(false);setEditing(false);});
  document.addEventListener('pointerdown',event=>{if(!sidebar.contains(event.target)){finish(false);setEditing(false);}},true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){if(drag){finish(false);}else {clearPress();setEditing(false);}return;}
    // 键盘用户可通过“整理”进入模式，再用 Alt + 上下键调整当前项。
    const button=event.target.closest?.('[data-view]');
    if(!editing||!button||!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key)||saving||drag)return;
    event.preventDefault();const id=button.dataset.view,zone=layout.more.includes(id)?'more':'visible',list=layout[zone],index=list.indexOf(id),next=index+(event.key==='ArrowUp'?-1:1);
    if(next<0||next>=list.length)return;
    [list[index],list[next]]=[list[next],list[index]];rearrange();button.focus();void save();
  });
  rearrange(false);
  // 读取内存快照，未打开功能页时也能显示已保存的开关；不会触发远端刷新。
  for(const id of ['mail','archery','quota','subscriptions'])window.whale[id]('snapshot').then(result=>{
    if(result.value)updateSidebarStatus(id,result.value);
  }).catch(()=>{});
  // 加载完成前保留普通导航，但禁止整理，避免默认布局覆盖已有自定义顺序。
  window.whale.sidebar().then(value=>{layout=value;saved=structuredClone(value);ready=true;organize.disabled=false;rearrange(false);}).catch(()=>{feedback.textContent='菜单布局读取失败，请重新打开小屋后重试。';});
}
