// 公共单选下拉：业务只提供选项和保存动作，展开、键盘、焦点与禁用行为保持一致。
export function createSelectView({picker,trigger,options,label,onChange}) {
  let items=[],buttons=[],selected='',disabled=false,key='';
  const close=(focus=false)=>{picker.open=false;if(focus)trigger.focus();};
  const available=()=>buttons.filter(button=>!button.disabled);
  function render({items:next,value,disabled:blocked=false}) {
    selected=value;disabled=blocked;items=next;
    trigger.setAttribute('aria-disabled',String(disabled));
    label.textContent=items.find(item=>item.value===selected)?.label||'请选择';
    trigger.title=items.find(item=>item.value===selected)?.description||label.textContent;
    if(disabled)close();
    const nextKey=JSON.stringify(items);
    // 高频状态刷新只更新选中和禁用属性；选项未变时保留 DOM，避免打断键盘焦点。
    if(key!==nextKey) {
      const focused=buttons.find(button=>button===document.activeElement)?.value;
      key=nextKey;options.replaceChildren();buttons=[];
      for(const item of items) {
        const button=document.createElement('button'),content=document.createElement('span'),name=document.createElement('span'),check=document.createElement('span');
        button.type='button';button.value=item.value;button.className='ui-menu-item';button.setAttribute('role','option');
        button.setAttribute('aria-label',item.label);content.className='ui-select-content';name.textContent=item.label;content.append(name);
        if(item.description){const detail=document.createElement('small');detail.className='ui-select-description';detail.textContent=item.description;content.append(detail);}
        check.className='ui-select-check';check.textContent='✓';check.setAttribute('aria-hidden','true');button.append(content,check);
        button.addEventListener('click',()=>{if(disabled||button.disabled)return;close(true);return onChange(item.value);});
        buttons.push(button);options.append(button);
      }
      if(picker.open&&focused)buttons.find(button=>button.value===focused)?.focus();
    }
    for(const [index,button] of buttons.entries()){button.disabled=disabled||Boolean(items[index].disabled);button.setAttribute('aria-selected',String(button.value===selected));}
  }
  trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-controls',options.id);trigger.setAttribute('aria-expanded','false');
  trigger.addEventListener('click',event=>{if(disabled)event.preventDefault();});
  picker.addEventListener('toggle',()=>{
    trigger.setAttribute('aria-expanded',String(picker.open));
    if(picker.open)(available().find(button=>button.value===selected)||available()[0])?.focus();
  });
  picker.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&picker.open){event.preventDefault();event.stopPropagation();close(true);return;}
    if(disabled||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();if(!picker.open){picker.open=true;return;}
    // 方向键只遍历可用选项；首尾循环，Home/End 定位两端。
    const list=available(),index=list.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?list.length-1:index<0?(event.key==='ArrowUp'?list.length-1:0):(index+(event.key==='ArrowDown'?1:-1)+list.length)%list.length;
    list[next]?.focus();
  });
  document.addEventListener('pointerdown',event=>{if(picker.open&&!picker.contains(event.target))close();});
  picker.addEventListener('focusout',event=>{if(event.relatedTarget&&!picker.contains(event.relatedTarget))close();});
  document.addEventListener('whale-view-changed',()=>{if(picker.closest('[hidden]'))close();});
  return {render,close};
}
