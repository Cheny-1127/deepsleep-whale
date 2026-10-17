'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sanitizeEvent } = require('../domain/activity.cjs');

function dataDirectory() {
  // 桌宠与 Hook 发送端共用路径规则；测试目录通过 WHALE_DATA_DIR 隔离。
  return process.env.WHALE_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'deepsleep-whale-pet');
}
function socketPath(dir = dataDirectory()) { return path.join(dir, 'events.sock'); }
async function startBridge(dir, onEvent, onMessage = () => false) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = socketPath(dir);
  if (Buffer.byteLength(file) > 100) throw new Error('数据目录路径过长，无法建立本地事件连接');
  // 调用前已取得应用单实例锁，才能清理上次退出遗留的 socket；普通文件绝不覆盖。
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isSocket()) throw new Error('事件路径已有其他文件，未覆盖');
    fs.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const clients = new Set();
  const server = net.createServer(client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.setTimeout(1000, () => client.destroy());
    let body = '';
    // 一条连接只接收一行 JSON；限制大小和等待时间，避免残缺输入占住连接。
    client.on('data', chunk => {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) { client.destroy(); return; }
      if (!body.includes('\n')) return;
      try {
        const packet = JSON.parse(body.split('\n')[0]);
        if(packet?.type==='cursor-chat-result') {
          client.end(JSON.stringify({accepted:Boolean(onMessage(packet))})+'\n');
          client.removeAllListeners('data');return;
        }
        const event = sanitizeEvent(packet);
        if (!event) { client.end('{"accepted":false}\n'); return; }
        onEvent(event);
        client.end('{"accepted":true}\n');
      } catch { client.end('{"accepted":false}\n'); }
      client.removeAllListeners('data');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 仅监听本机 Unix socket，并限制为当前用户读写，不开放 TCP 端口。
    server.listen(file, () => { fs.chmodSync(file, 0o600); resolve(); });
  });
  return { file, close: () => new Promise(resolve => { for (const client of clients) client.destroy(); server.close(resolve); }) };
}
module.exports = { startBridge, dataDirectory, socketPath };
