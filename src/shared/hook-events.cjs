'use strict';
// 统一事件协议供发送端、适配器和任务状态使用，不依赖 Electron 或客户端存储。
const CODEX_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const CURSOR_EVENTS = { beforeSubmitPrompt:'UserPromptSubmit', postToolUse:'PostToolUse', postToolUseFailure:'PostToolUse', stop:'Stop', sessionEnd:'SessionEnd' };
// Claude Code 没有独立的中断事件；接口报错结束本轮走 StopFailure。
const CLAUDE_EVENTS = { UserPromptSubmit:'UserPromptSubmit', PreToolUse:'PreToolUse', PermissionRequest:'PermissionRequest', PostToolUse:'PostToolUse', PostToolUseFailure:'PostToolUse', Stop:'Stop', StopFailure:'Interrupt', SessionEnd:'SessionEnd' };
const SOURCES = ['codex', 'cursor', 'claude'];
const SOURCE_NAMES = { codex:'Codex', cursor:'Cursor', claude:'Claude Code' };
const sourceOf = event => ['cursor','claude'].includes(event?.source) ? event.source : 'codex';
// Codex 沿用原始会话 ID，其他来源用前缀隔离，避免同名会话串到一起。
const sourceOfSession = id => typeof id === 'string' ? ['cursor','claude'].find(source => id.startsWith(source + ':')) || 'codex' : 'codex';

// 原始事件必须在白名单内，且与统一事件一致；中断类变体是仅有的例外。
function rawEventAllowed(source, raw, name) {
  const events = source === 'cursor' ? CURSOR_EVENTS : CLAUDE_EVENTS;
  if (!Object.hasOwn(events, raw)) return false;
  return events[raw] === name || (name === 'Interrupt' && raw === (source === 'cursor' ? 'stop' : 'PostToolUseFailure'));
}

function eventName(event) {
  const source = sourceOf(event);
  if (source === 'codex') return event.hook_event_name;
  if (event.raw_event) return event.raw_event;
  if (source === 'claude') return event.hook_event_name === 'Interrupt' ? 'StopFailure' : event.hook_event_name;
  // Cursor 的取消和失败也通过 stop 上报，共用本轮结束的接收开关。
  return event.hook_event_name === 'Interrupt' ? 'stop' : Object.keys(CURSOR_EVENTS).find(key => CURSOR_EVENTS[key] === event.hook_event_name);
}

module.exports = { CODEX_EVENTS, CURSOR_EVENTS, CLAUDE_EVENTS, SOURCES, SOURCE_NAMES, sourceOf, sourceOfSession, rawEventAllowed, eventName };
