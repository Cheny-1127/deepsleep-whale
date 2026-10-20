const $=id=>document.getElementById('shortcuts-'+id);

export function createShortcutsView() {
  if(!$('view'))return {render(){}};
  let saved={tripleClick:'panel'},saving=false;
  const select=$('triple');
  for(const [value,label] of Object.entries(SHORTCUT_ACTIONS)) {
    const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);
  }
  function render(data) {
    if(data?.shortcuts)saved=data.shortcuts;
    if(!saving)select.value=saved.tripleClick;
    select.disabled=saving;
    $('status').textContent=saving?'正在保存':saved.tripleClick==='none'?'未启用':'已启用';
  }
  // 保存期间不让后台快照覆盖刚选的项；失败后恢复上一次已落盘的设置。
  select.addEventListener('change',async()=>{
    if(saving)return;
    const value=select.value;saving=true;render();
    $('feedback').textContent='';$('error').hidden=true;
    try {
      render(await window.whale.shortcuts(value));
      $('feedback').textContent='已保存，桌宠立即生效。';
    } catch {
      $('error').textContent='快捷操作未保存，已恢复原设置，请重试。';$('error').hidden=false;
    } finally {saving=false;render();}
  });
  render();
  return {render};
}
