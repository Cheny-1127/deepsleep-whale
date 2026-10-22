const $=id=>document.getElementById('shortcuts-'+id);

export function createShortcutsView() {
  if(!$('view'))return {render(){}};
  let saved={tripleClick:'panel'},saving=false,pending='panel';
  const button=$('triple'),picker=$('picker'),options=[];
  for(const [value,label] of Object.entries(SHORTCUT_ACTIONS)) {
    const option=document.createElement('button'),name=document.createElement('span'),check=document.createElement('span');
    option.type='button';option.value=value;option.setAttribute('role','option');
    name.textContent=label;check.className='quota-group-check';check.textContent='✓';check.setAttribute('aria-hidden','true');
    option.append(name,check);options.push(option);$('options').append(option);
    option.addEventListener('click',()=>choose(value));
  }
  function render(data) {
    if(data?.shortcuts)saved=data.shortcuts;
    const value=saving?pending:saved.tripleClick;
    $('selected').textContent=SHORTCUT_ACTIONS[value];
    button.setAttribute('aria-disabled',String(saving));
    for(const option of options){option.disabled=saving;option.setAttribute('aria-selected',String(option.value===value));}
    $('status').textContent=saving?'正在保存':saved.tripleClick==='none'?'未启用':'已启用';
  }
  // 保存期间不让后台快照覆盖刚选的项；失败后恢复上一次已落盘的设置。
  async function choose(value) {
    if(saving)return;
    picker.open=false;button.focus();
    if(value===saved.tripleClick)return;
    pending=value;saving=true;render();
    $('feedback').textContent='';$('error').hidden=true;
    try {
      render(await window.whale.shortcuts(value));
      $('feedback').textContent='已保存，桌宠立即生效。';
    } catch {
      $('error').textContent='快捷操作未保存，已恢复原设置，请重试。';$('error').hidden=false;
    } finally {saving=false;render();}
  }
  button.addEventListener('click',event=>{if(saving)event.preventDefault();});
  picker.addEventListener('toggle',()=>{
    button.setAttribute('aria-expanded',String(picker.open));
    if(picker.open)options.find(option=>option.value===saved.tripleClick)?.focus();
  });
  picker.addEventListener('keydown',event=>{
    if(saving||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();
    if(!picker.open){picker.open=true;return;}
    const index=options.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?options.length-1:
      index<0?(event.key==='ArrowUp'?options.length-1:0):(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
    options[next]?.focus();
  });
  document.addEventListener('pointerdown',event=>{if(picker.open&&!picker.contains(event.target))picker.open=false;});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&picker.open){picker.open=false;button.focus();}
  });
  render();
  return {render};
}
