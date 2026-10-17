'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfig } = require('./codex-config.cjs');
function merge(existing, addition) {
  // 保留用户其他 Hooks；同一事件下按命令去重，重复安装不会追加相同处理器。
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Existing hooks config is not an object');
  const result = { ...existing, hooks: { ...existing.hooks } };
  for (const [event, groups] of Object.entries(addition.hooks)) {
    const old = result.hooks[event] || [];
    if (!Array.isArray(old)) throw new Error(`Unexpected hook shape for ${event}`);
    result.hooks[event] = [...old];
    for (const group of groups) {
      if (!old.some(item => item.hooks?.some(hook => hook.command === group.hooks[0].command))) result.hooks[event].push(group);
    }
  }
  return result;
}
if (require.main === module) {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
  let existing = {}, backup;
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('hooks.json is a symlink; please merge the generated config manually');
    existing = JSON.parse(fs.readFileSync(file,'utf8'));
  }
  const result = merge(existing,createConfig());
  if (!process.argv.includes('--install')) {
    // 默认仅预览；安装配置不会代替用户信任 Hooks，也不修改信任记录。
    console.log(JSON.stringify({ target:file, config:result },null,2));
  } else {
    fs.mkdirSync(path.dirname(file),{ recursive:true });
    if (fs.existsSync(file)) {
      backup = file + '.before-whale-' + Date.now();
      fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
    }
    // 备份后先写同目录临时文件，再重命名替换，避免写入中断留下半份 JSON。
    const temp = file + '.whale-' + process.pid;
    fs.writeFileSync(temp,JSON.stringify(result,null,2)+'\n',{ mode:0o600,flag:'wx' });
    fs.renameSync(temp,file);
    console.log(JSON.stringify({ installed:file, backup:backup || null, next:'Review and trust these hooks in Codex /hooks. No trust settings were changed.' }));
  }
}
module.exports = { merge };
