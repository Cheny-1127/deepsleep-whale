'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {parseEnv} = require('node:util');
const {DEFAULT_BASE_URL} = require('../channels/quota-credentials.cjs');

function readQuotaConfig({rootDir = path.resolve(__dirname, '../..'), env = process.env} = {}) {
  let local = {};
  // 按代码所在项目定位配置，保证终端和 Finder 双击启动读取同一份文件。
  try { local = parseEnv(fs.readFileSync(path.join(rootDir, '.env'), 'utf8')); }
  catch (error) {
    // 未创建配置时沿用旧行为；读取失败则停止，避免误用默认站点发送管理凭据。
    if (error.code !== 'ENOENT') throw Error('无法读取项目 .env，请检查文件权限与格式。');
  }
  // 只读取额度配置，不把管理 Key 注入 process.env 或传给执行任务的子进程。
  // 使用 ?? 保留进程中显式设置的空值，允许覆盖 .env 中的旧配置。
  const value = name => (env[name] ?? local[name] ?? '').trim();
  const baseUrl = value('WHALE_QUOTA_BASE_URL') || DEFAULT_BASE_URL;
  try {
    const url = new URL(baseUrl);
    // 后续会追加管理接口路径；提前拒绝会改变 URL 含义的认证、查询和片段。
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(baseUrl)) throw Error();
  } catch { throw Error('WHALE_QUOTA_BASE_URL 须为 HTTP(S) 站点地址，不能包含账号、密码、查询参数或片段。'); }
  // 旧凭据文件的相对路径也以项目为基准，不受启动时工作目录影响。
  return {baseUrl:baseUrl.replace(/\/+$/, ''), token:value('WHALE_QUOTA_API_KEY'),
    tokenFile:path.resolve(rootDir, value('WHALE_QUOTA_TOKEN_FILE') || 'token')};
}

module.exports = {readQuotaConfig};
