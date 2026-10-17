'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function checkDirectory(dir) {
  // 按目录递归检查，新增功能子模块后不需要手动维护文件清单。
  for (const entry of fs.readdirSync(dir, { withFileTypes:true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) checkDirectory(file);
    else if (/\.(cjs|mjs|js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', file], { stdio:'inherit' });
  }
}
for (const dir of ['src', 'scripts', 'test', 'cursor-companion']) checkDirectory(path.join(root, dir));
console.log('JavaScript syntax OK');
