'use strict';
const fs=require('node:fs'),path=require('node:path');
const actions=require('../shared/shortcut-actions.js');

function createShortcutSettings({dataDir}) {
  const file=path.join(dataDir,'shortcuts.json');
  // 旧配置没有双击字段时保持普通互动，升级不会悄悄新增一个手势动作。
  let settings={doubleClick:'none',tripleClick:'panel',reminderCollapseThreshold:3};
  const validThreshold=value=>Number.isInteger(value)&&value>=1&&value<=10;
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    const threshold=saved.reminderCollapseThreshold??saved.busyCollapseThreshold;
    if(validThreshold(threshold))settings.reminderCollapseThreshold=threshold;
    for(const key of ['doubleClick','tripleClick'])if(typeof saved[key]==='string'&&Object.hasOwn(actions,saved[key]))settings[key]=saved[key];
  } catch {} // 首次使用或配置损坏时使用默认值，不自动覆盖原文件。
  return {
    snapshot:()=>({...settings}),
    update(value) {
      // 兼容原来的字符串三连击配置，新界面按字段更新，互不覆盖另一种手势。
      const patch=typeof value==='string'?{tripleClick:value}:value;
      if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||
        !Object.entries(patch).every(([key,item])=>key==='reminderCollapseThreshold'?validThreshold(item):
          ['doubleClick','tripleClick'].includes(key)&&typeof item==='string'&&Object.hasOwn(actions,item)))throw new Error('无效的快捷操作或合并阈值（1–10）');
      const next={...settings,...patch};
      // 先落盘再更新运行态；写入失败时保留上一项有效设置。
      fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});
      fs.renameSync(file+'.tmp',file);
      settings=next;
      return {...settings};
    }
  };
}
module.exports={createShortcutSettings};
