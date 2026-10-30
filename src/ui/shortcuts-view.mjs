import {createSelectView} from './select-view.mjs';
const $=id=>document.getElementById('shortcuts-'+id);

export function createShortcutsView() {
  if(!$('view'))return {render(){}};
  let saved={doubleClick:'none',tripleClick:'panel',reminderCollapseThreshold:3},saving=false,pending=saved,editingThreshold=false;
  const pickers=new Map([
    ['doubleClick',createSelectView({picker:$('double-picker'),trigger:$('double'),options:$('double-options'),label:$('double-selected'),onChange:value=>choose('doubleClick',value)})],
    ['tripleClick',createSelectView({picker:$('picker'),trigger:$('triple'),options:$('options'),label:$('selected'),onChange:value=>choose('tripleClick',value)})]
  ]);
  const items=Object.entries(SHORTCUT_ACTIONS).map(([value,label])=>({value,label}));
  function render(data) {
    if(data?.shortcuts)saved={...saved,...data.shortcuts};
    const current=saving?pending:saved;
    if(!editingThreshold)$('threshold').value=String(current.reminderCollapseThreshold);
    $('threshold').disabled=saving;
    $('preview').textContent=`每类不超过 ${current.reminderCollapseThreshold} 条时逐条显示；从 ${current.reminderCollapseThreshold+1} 条起合并为「类别：数量」。`;
    for(const [key,picker] of pickers)picker.render({items,value:current[key],disabled:saving});
    // 重复动作只作提醒，仍可保存；两项都不启用时不算冲突。
    const duplicate=current.doubleClick!=='none'&&current.doubleClick===current.tripleClick;
    // 提示跟随对应配置行；只更新变化的文案，避免后台快照重复播报。
    for(const [id,other] of [['double-hint','三连击'],['triple-hint','双击']]) {
      const element=$(id),hint=duplicate?`与${other}的动作相同`:'';
      if(element.textContent!==hint)element.textContent=hint;
      element.hidden=!duplicate;
    }
    $('status').textContent=saving?'正在保存':saved.doubleClick==='none'&&saved.tripleClick==='none'?'未启用':'已启用';
  }
  // 保存期间不让后台快照覆盖刚选的项；失败后恢复上一次已落盘的设置。
  async function choose(key,value) {
    if(saving)return;
    pickers.get(key).close(true);
    if(value===saved[key])return;
    await save({[key]:value},{...saved,[key]:value});
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
