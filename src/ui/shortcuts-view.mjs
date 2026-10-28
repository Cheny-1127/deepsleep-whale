import {createSelectView} from './select-view.mjs';
const $=id=>document.getElementById('shortcuts-'+id);

export function createShortcutsView() {
  if(!$('view'))return {render(){}};
  let saved={tripleClick:'panel',reminderCollapseThreshold:3},saving=false,pending=saved,editingThreshold=false;
  const picker=createSelectView({picker:$('picker'),trigger:$('triple'),options:$('options'),label:$('selected'),onChange:choose});
  const items=Object.entries(SHORTCUT_ACTIONS).map(([value,label])=>({value,label}));
  function render(data) {
    if(data?.shortcuts)saved={...saved,...data.shortcuts};
    const current=saving?pending:saved;
    const value=current.tripleClick;
    if(!editingThreshold)$('threshold').value=String(current.reminderCollapseThreshold);
    $('threshold').disabled=saving;
    $('preview').textContent=`每类不超过 ${current.reminderCollapseThreshold} 条时逐条显示；从 ${current.reminderCollapseThreshold+1} 条起合并为「类别：数量」。`;
    picker.render({items,value,disabled:saving});
    $('status').textContent=saving?'正在保存':saved.tripleClick==='none'?'未启用':'已启用';
  }
  // 保存期间不让后台快照覆盖刚选的项；失败后恢复上一次已落盘的设置。
  async function choose(value) {
    if(saving)return;
    picker.close(true);
    if(value===saved.tripleClick)return;
    await save(value,{...saved,tripleClick:value});
  }
  async function save(value,next) {
    pending=next;saving=true;render();
    $('feedback').textContent='';$('error').hidden=true;
    try {
      render(await window.whale.shortcuts(value));
      $('feedback').textContent='已保存，桌宠立即生效。';
    } catch {
      $('error').textContent='快捷操作未保存，已恢复原设置，请重试。';$('error').hidden=false;
    } finally {saving=false;render();}
  }
  $('threshold').addEventListener('input',()=>{editingThreshold=true;});
  $('threshold').addEventListener('change',async()=>{
    editingThreshold=false;
    if(saving)return;
    const value=Number($('threshold').value);
    if(!Number.isInteger(value)||value<1||value>10) {
      $('error').textContent='合并阈值请输入 1–10 的整数。';$('error').hidden=false;render();return;
    }
    if(value!==saved.reminderCollapseThreshold)await save({reminderCollapseThreshold:value},{...saved,reminderCollapseThreshold:value});
  });
  render();
  return {render};
}
