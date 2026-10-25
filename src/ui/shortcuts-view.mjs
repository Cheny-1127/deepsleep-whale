import {createSelectView} from './select-view.mjs';
const $=id=>document.getElementById('shortcuts-'+id);

export function createShortcutsView() {
  if(!$('view'))return {render(){}};
  let saved={tripleClick:'panel'},saving=false,pending='panel';
  const picker=createSelectView({picker:$('picker'),trigger:$('triple'),options:$('options'),label:$('selected'),onChange:choose});
  const items=Object.entries(SHORTCUT_ACTIONS).map(([value,label])=>({value,label}));
  function render(data) {
    if(data?.shortcuts)saved=data.shortcuts;
    const value=saving?pending:saved.tripleClick;
    picker.render({items,value,disabled:saving});
    $('status').textContent=saving?'正在保存':saved.tripleClick==='none'?'未启用':'已启用';
  }
  // 保存期间不让后台快照覆盖刚选的项；失败后恢复上一次已落盘的设置。
  async function choose(value) {
    if(saving)return;
    picker.close(true);
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
  render();
  return {render};
}
