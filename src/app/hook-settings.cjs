'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SOURCES, adapterInfo } = require('../hooks/adapters.cjs');
const { createCodexConfig, createCursorConfig } = require('../hooks/config.cjs');
const { unknown, readCodex, readCursor, findCodex } = require('../hooks/availability.cjs');
const { prepareCursorChange } = require('../hooks/cursor-settings.cjs');

// 应用层协调“客户端可用能力”和“桌宠接收偏好”，不把本地开关当作客户端授权。
function createHookSettings({ dataDir, cwd, onChange }) {
  let settings = { sound:false, notifications:true, sources:{ codex:true, cursor:false }, events:{} };
  const settingsFile = path.join(dataDir, 'settings.json');
  const hookNode = [process.env.npm_node_execpath, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'node'))]
    .find(file => { try { return file && fs.statSync(file).isFile() && fs.accessSync(file, fs.constants.X_OK) === undefined && fs.realpathSync(file) !== fs.realpathSync(process.execPath); } catch { return false; } });
  const adapters = adapterInfo().map(item => ({ ...item,
    config:hookNode ? JSON.stringify(item.id === 'codex' ? createCodexConfig(hookNode) : createCursorConfig(hookNode), null, 2) : '未找到 Node.js，请从终端生成接入配置。',
    target:path.join(item.id === 'codex' ? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) : (process.env.WHALE_CURSOR_HOME || path.join(os.homedir(), '.cursor')), 'hooks.json')
  }));
  const availability = Object.fromEntries(adapters.map(adapter => [adapter.id, unknown(adapter, '尚未检测')]));
  let savedCursorEnabled;
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    savedCursorEnabled = saved.sources?.cursor;
    // 白名单读取偏好，忽略旧版外观字段，避免历史配置覆盖当前界面协议。
    for (const key of ['sound', 'notifications']) if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    for (const source of SOURCES) if (typeof saved.sources?.[source] === 'boolean') settings.sources[source] = saved.sources[source];
    for (const adapter of adapters) settings.events[adapter.id] = Object.fromEntries(adapter.mappings.map(item => [item.event, saved.events?.[adapter.id]?.[item.event] !== false]));
  } catch {} // 首次启动或偏好文件不可读时使用默认值，不在启动时覆盖原文件。
  const initialCursor = readCursor(adapters.find(item => item.id === 'cursor'));
  availability.cursor = initialCursor;
  // 启动只读：没有本项目命令时必须关闭，旧版保存的开启值不能触发自动安装。
  settings.sources.cursor = initialCursor.state === 'checked' && Object.values(initialCursor.events).some(item => item.available) && savedCursorEnabled !== false;

  const checks = new Map();
  function refresh(source) {
    if (checks.has(source)) return checks.get(source);
    const adapter = adapters.find(item => item.id === source);
    availability[source] = { ...availability[source], state:'checking' };
    onChange();
    const checking = Promise.resolve()
      .then(() => source === 'codex' ? readCodex(adapter, { binary:findCodex(), cwd }) : readCursor(adapter))
      .catch(() => unknown(adapter, '检测失败，请重试'))
      .then(result => { availability[source] = result; return result; })
      .finally(() => { checks.delete(source); onChange(); });
    checks.set(source, checking);
    return checking;
  }
  async function update(value, perEvent) {
    if (!SOURCES.includes(value?.source) || typeof value.enabled !== 'boolean') throw new Error('无效的来源设置');
    const { source, enabled, event } = value;
    const adapter = adapters.find(item => item.id === source);
    if (perEvent && !adapter.mappings.some(item => item.event === event)) throw new Error('无效的事件设置');
    const cursor = source === 'cursor';
    // 只有用户主动开启 Cursor 总开关才补齐外部配置；逐项开关只决定本地接收。
    const change = cursor && !perEvent && enabled ? prepareCursorChange(adapter) : null;
    if (enabled && (!cursor || perEvent)) {
      const available = await refresh(source);
      if (perEvent && !available.events[event]?.available) throw new Error('对应 Hook 尚不可用');
    }
    let next = perEvent
      ? { ...settings, events:{ ...settings.events, [source]:{ ...settings.events[source], [event]:enabled } } }
      : { ...settings, sources:{ ...settings.sources, [source]:enabled } };
    if (cursor && !perEvent && change?.created) next = { ...next, events:{ ...next.events, cursor:Object.fromEntries(adapter.mappings.map(item => [item.event, true])) } };
    const temp = settingsFile + '.tmp';
    try {
      // 先验证本地偏好可写，再提交客户端配置；本地保存失败时撤回自己的客户端修改。
      fs.writeFileSync(temp, JSON.stringify(next), { mode:0o600 });
      change?.commit();
      fs.renameSync(temp, settingsFile);
      settings = next;
    } catch (error) { change?.rollback(); throw error; }
    finally { if (cursor && change) await refresh('cursor'); }
  }
  return {
    get settings() { return settings; },
    adapters, availability, refresh, update,
    setPreference(key, value) {
      settings[key] = value;
      fs.writeFileSync(settingsFile, JSON.stringify(settings));
    }
  };
}

module.exports = { createHookSettings };
