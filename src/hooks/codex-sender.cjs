#!/usr/bin/env node
'use strict';
// 提醒脚本不作批准或拒绝决定；桌宠离线或输入异常时也以中性结果退出。
const net = require('node:net');
const { sanitizeEvent } = require('../domain/activity.cjs');
const { socketPath } = require('./bridge.cjs');
let body = '';
let finished = false;
let socket;
const done = () => {
  // 超时、断连和正常回执可能先后触发，只允许输出一次结果。
  if (finished) return;
  finished = true;
  socket?.destroy();
  process.stdout.write('{}\n', () => process.exit(0));
};
// 800 毫秒兜底短于 Hooks 配置的 2 秒超时，避免离线桌宠拖住 Codex。
setTimeout(done, 800);
process.stdin.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) done(); });
process.stdin.on('error', done);
process.stdin.on('end', () => {
  try {
    const event = sanitizeEvent(JSON.parse(body));
    if (!event) return done();
    socket = net.createConnection(socketPath());
    socket.on('connect', () => socket.write(JSON.stringify(event) + '\n'));
    socket.on('data', done);
    socket.on('error', done);
    socket.on('end', done);
  } catch { done(); }
});
