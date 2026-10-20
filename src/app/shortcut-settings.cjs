'use strict';
const fs=require('node:fs'),path=require('node:path');
const actions=require('../shared/shortcut-actions.js');

function createShortcutSettings({dataDir}) {
  const file=path.join(dataDir,'shortcuts.json');
  let tripleClick='panel';
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(typeof saved.tripleClick==='string'&&Object.hasOwn(actions,saved.tripleClick))tripleClick=saved.tripleClick;
  } catch {} // 首次使用或配置损坏时使用默认值，不自动覆盖原文件。
  return {
    snapshot:()=>({tripleClick}),
    update(value) {
      if(typeof value!=='string'||!Object.hasOwn(actions,value))throw new Error('无效的快捷操作');
      // 先落盘再更新运行态；写入失败时保留上一项有效设置。
      fs.writeFileSync(file+'.tmp',JSON.stringify({tripleClick:value}),{mode:0o600});
      fs.renameSync(file+'.tmp',file);
      tripleClick=value;
      return {tripleClick};
    }
  };
}
module.exports={createShortcutSettings};
