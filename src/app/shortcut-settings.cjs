'use strict';
const fs=require('node:fs'),path=require('node:path');
const actions=require('../shared/shortcut-actions.js');

function createShortcutSettings({dataDir}) {
  const file=path.join(dataDir,'shortcuts.json');
  let tripleClick='panel',reminderCollapseThreshold=3;
  const validThreshold=value=>Number.isInteger(value)&&value>=1&&value<=10;
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    const threshold=saved.reminderCollapseThreshold??saved.busyCollapseThreshold;
    if(validThreshold(threshold))reminderCollapseThreshold=threshold;
    if(typeof saved.tripleClick==='string'&&Object.hasOwn(actions,saved.tripleClick))tripleClick=saved.tripleClick;
  } catch {} // 首次使用或配置损坏时使用默认值，不自动覆盖原文件。
  return {
    snapshot:()=>({tripleClick,reminderCollapseThreshold}),
    update(value) {
      let nextAction=tripleClick,nextThreshold=reminderCollapseThreshold;
      if(typeof value==='string'&&Object.hasOwn(actions,value))nextAction=value;
      else if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&validThreshold(value.reminderCollapseThreshold))nextThreshold=value.reminderCollapseThreshold;
      else throw new Error('无效的快捷操作或合并阈值（1–10）');
      // 先落盘再更新运行态；写入失败时保留上一项有效设置。
      fs.writeFileSync(file+'.tmp',JSON.stringify({tripleClick:nextAction,reminderCollapseThreshold:nextThreshold}),{mode:0o600});
      fs.renameSync(file+'.tmp',file);
      tripleClick=nextAction;reminderCollapseThreshold=nextThreshold;
      return {tripleClick,reminderCollapseThreshold};
    }
  };
}
module.exports={createShortcutSettings};
