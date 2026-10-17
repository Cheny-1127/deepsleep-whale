'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { CODEX_EVENTS, CURSOR_EVENTS } = require('../shared/hook-events.cjs');

// Hook 命令由 shell 解析，单引号转义必须兼容项目路径中的空格和引号。
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function senderCommand(source, runtime) {
  const root = path.resolve(__dirname, '../..');
  const legacy = path.join(path.dirname(root), 'deepsleep-whale-pet');
  let commandRoot = root;
  // 改名兼容链接必须指回当前项目，才能沿用已信任的绝对路径；新克隆使用自身路径。
  try {
    if (fs.lstatSync(legacy).isSymbolicLink() && fs.realpathSync(legacy) === fs.realpathSync(root)) commandRoot = legacy;
  } catch {}
  const sender = path.join(commandRoot, 'scripts', `${source}-hook.cjs`);
  return `${quote(runtime)} ${quote(sender)}`;
}

function createCodexConfig(runtime = process.execPath) {
  const command = senderCommand('codex', runtime);
  const hooks = {};
  for (const event of CODEX_EVENTS) {
    const group = { hooks:[{ type:'command', command, timeout:2 }] };
    if (['PreToolUse', 'PermissionRequest', 'PostToolUse'].includes(event)) group.matcher = '*';
    hooks[event] = [group];
  }
  return { hooks };
}

function createCursorConfig(runtime = process.execPath) {
  const command = senderCommand('cursor', runtime);
  return { version:1, hooks:Object.fromEntries(Object.keys(CURSOR_EVENTS).map(name => [name, [{ command:`${command} ${name}`, timeout:2 }]])) };
}

module.exports = { createCodexConfig, createCursorConfig };
