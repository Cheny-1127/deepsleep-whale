'use strict';
// 统一事件协议供发送端、适配器和任务状态使用，不依赖 Electron 或客户端存储。
const CODEX_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const CURSOR_EVENTS = { beforeSubmitPrompt:'UserPromptSubmit', postToolUse:'PostToolUse', postToolUseFailure:'PostToolUse', stop:'Stop', sessionEnd:'SessionEnd' };
const SOURCES = ['codex', 'cursor'];
const sourceOf = event => event?.source === 'cursor' ? 'cursor' : 'codex';

function eventName(event) {
  if (sourceOf(event) === 'codex') return event.hook_event_name;
  // Cursor 的取消和失败也通过 stop 上报，共用本轮结束的接收开关。
  return event.raw_event || (event.hook_event_name === 'Interrupt' ? 'stop' : Object.keys(CURSOR_EVENTS).find(key => CURSOR_EVENTS[key] === event.hook_event_name));
}

module.exports = { CODEX_EVENTS, CURSOR_EVENTS, SOURCES, sourceOf, eventName };
