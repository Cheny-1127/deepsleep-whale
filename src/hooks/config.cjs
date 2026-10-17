'use strict';
const path = require('node:path');
const { CODEX_EVENTS, CURSOR_EVENTS } = require('../shared/hook-events.cjs');

// Hook 命令由 shell 解析，单引号转义必须兼容项目路径中的空格和引号。
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function senderCommand(source, runtime) {
  // 配置始终使用当前项目目录，移动后需在客户端重新审核变更后的命令。
  const sender = path.resolve(__dirname, '../../scripts', `${source}-hook.cjs`);
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
