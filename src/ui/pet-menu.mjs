// 参考 dsh-pet：主菜单和子菜单平级挂载，实测尺寸后贴边定位，避免滚动裁切。
const root=document.getElementById('pet-menu');
const gap=6,padding=12;
let current,rootPanel,branch,subPanel;
const children=new Map();
const buttons=panel=>[...panel.querySelectorAll('button:not(:disabled)')];
const clamp=(value,min,max)=>Math.max(min,Math.min(value,max));
function close(){if(current)window.petMenu.close(current.id);}
function panelFor(items,label) {
  const panel=document.createElement('div');
  panel.className='pet-menu-panel';panel.setAttribute('role','menu');panel.setAttribute('aria-label',label);panel.tabIndex=-1;
  panel.style.maxHeight=`${Math.max(1,current.area.height-padding*2)}px`;
  panel.style.width=`${Math.min(168,current.area.width-padding*2)}px`;
  for(const item of items) {
    if(item.separator){const line=document.createElement('div');line.className='menu-separator';line.setAttribute('role','separator');panel.append(line);continue;}
    const button=document.createElement('button');
    button.className='ui-menu-item';button.type='button';button.dataset.id=item.id;button.setAttribute('role','menuitem');button.tabIndex=-1;
    // 鼠标与键盘共用一处焦点，避免悬停新选项时旧选项仍保留聚焦边框。
    button.addEventListener('mouseenter',()=>{if(!button.disabled)button.focus({preventScroll:true});});
    if(item.icon){const icon=document.createElement('span');icon.className='menu-icon';icon.textContent=item.icon;icon.setAttribute('aria-hidden','true');button.append(icon);}
    const label=document.createElement('span');label.textContent=item.label;button.append(label);
    if(item.children) {
      button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');
      const arrow=document.createElement('span');arrow.className='menu-arrow';arrow.textContent='›';arrow.setAttribute('aria-hidden','true');button.append(arrow);
      button.addEventListener('mouseenter',()=>openBranch(button,item));
      button.addEventListener('click',()=>openBranch(button,item,true));
    } else {
      if(items!==current.items)button.disabled=!current.enabled;
      button.addEventListener('mouseenter',()=>{if(panel===rootPanel)hideBranch();});
      button.addEventListener('click',()=>window.petMenu.choose(current.id,item.id));
    }
    panel.append(button);
  }
  root.append(panel);return panel;
}
function hideBranch() {
  if(!subPanel)return;
  const hadFocus=subPanel.contains(document.activeElement),previous=branch;
  subPanel.hidden=true;subPanel=null;branch=null;previous.setAttribute('aria-expanded','false');
  if(hadFocus)previous.focus({preventScroll:true});
}
function placeRoot() {
  const {area,anchor}=current,w=rootPanel.offsetWidth,h=rootPanel.offsetHeight;
  const right=anchor.right+8;
  current.rootX=clamp(right+w+padding<=area.x+area.width?right:anchor.left-w-8,area.x+padding,area.x+area.width-w-padding);
  current.rootY=clamp(anchor.top,area.y+padding,area.y+area.height-h-padding);
}
function openBranch(button,item,focus=false) {
  if(branch!==button) {
    if(branch)branch.setAttribute('aria-expanded','false');
    if(subPanel)subPanel.hidden=true;
    branch=button;subPanel=children.get(item.id).panel;subPanel.hidden=false;
    branch.setAttribute('aria-expanded','true');
  }
  if(focus)(buttons(subPanel)[0]||subPanel).focus({preventScroll:true});
}
function placeSubmenu(panel,button) {
  const {area,rootX,rootY}=current,w=panel.offsetWidth,h=panel.offsetHeight;
  // 基于主菜单的屏幕位置计算，不受透明承载窗口的缩放和移动影响。
  let x=rootX+rootPanel.offsetWidth+gap;
  if(x+w+padding>area.x+area.width)x=rootX-w-gap;
  const row=button.getBoundingClientRect(),parent=rootPanel.getBoundingClientRect();
  return {panel,x:clamp(x,area.x+padding,area.x+area.width-w-padding),
    y:clamp(rootY+row.top-parent.top,area.y+padding,area.y+area.height-h-padding),width:w,height:h};
}
function fitWindow() {
  // 打开时一次预留所有分支的紧凑包围盒；悬停只切换显隐，窗口不动，鼠标不会误入另一行。
  const entries=[{panel:rootPanel,x:current.rootX,y:current.rootY,width:rootPanel.offsetWidth,height:rootPanel.offsetHeight},...children.values()];
  const x=Math.floor(Math.min(...entries.map(entry=>entry.x))-padding),y=Math.floor(Math.min(...entries.map(entry=>entry.y))-padding);
  const right=Math.ceil(Math.max(...entries.map(entry=>entry.x+entry.width))+padding);
  const bottom=Math.ceil(Math.max(...entries.map(entry=>entry.y+entry.height))+padding);
  for(const entry of entries){entry.panel.style.left=`${entry.x-x}px`;entry.panel.style.top=`${entry.y-y}px`;}
  window.petMenu.layout(current.id,{x,y,width:right-x,height:bottom-y});
}
root.addEventListener('keydown',event=>{
  const panel=event.target.closest('[role="menu"]');
  if(!panel)return;
  const options=buttons(panel),index=options.indexOf(document.activeElement);
  let next;
  if(event.key==='ArrowDown')next=options[(index+1)%options.length];
  else if(event.key==='ArrowUp')next=index<0?options.at(-1):options[(index-1+options.length)%options.length];
  else if(event.key==='Home')next=options[0];
  else if(event.key==='End')next=options.at(-1);
  else if(event.key==='ArrowRight'&&panel===rootPanel) {
    const item=current.items.find(item=>item.id===event.target.dataset.id);
    if(item?.children)openBranch(event.target,item,true);
  } else if(event.key==='ArrowLeft'&&panel===subPanel)hideBranch();
  else return;
  event.preventDefault();
  if(next) {
    if(panel===rootPanel&&subPanel) {
      const item=current.items.find(item=>item.id===next.dataset.id);
      if(item?.children)openBranch(next,item);else hideBranch();
    }
    next.focus({preventScroll:true});
  }
});
root.addEventListener('contextmenu',event=>event.preventDefault());
document.addEventListener('keydown',event=>{if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();close();}});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.pet-menu-panel'))close();});
window.petMenu.onOpen(data=>{
  current=data;branch=null;subPanel=null;children.clear();root.replaceChildren();
  root.dataset.request=String(data.id);
  rootPanel=panelFor(data.items,'桌宠菜单');
  for(const item of data.items.filter(item=>item.children)) {
    const panel=panelFor(item.children,item.label),button=rootPanel.querySelector(`[data-id="${item.id}"]`);
    // 先参与测量，再隐藏；子菜单与主菜单平级，不受主菜单滚动容器裁切。
    children.set(item.id,{panel,button});
  }
  placeRoot();
  for(const [id,entry] of children) {
    children.set(id,{...placeSubmenu(entry.panel,entry.button),button:entry.button});entry.panel.hidden=true;
  }
  fitWindow();
  buttons(rootPanel)[0]?.focus({preventScroll:true});
});
window.petMenu.onState(enabled=>{
  if(!current)return;
  current.enabled=enabled;
  for(const {panel} of children.values())for(const button of panel.querySelectorAll('button'))button.disabled=!enabled;
});
