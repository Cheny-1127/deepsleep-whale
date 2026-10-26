'use strict';
const fs = require('node:fs');
const DEFAULT_BASE_URL = 'https://openai.minitvclub.com';

function readQuotaToken({token, tokenFile}) {
  // 新 Key 非空时不再访问旧文件；留空则兼容原有 token 配置。
  if (typeof token === 'string' && token.trim()) return token.trim();
  let value;
  // 保留旧文件在每次请求时重新读取的行为，更新文件后无需重建额度实例。
  try { value = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch { throw Error('尚未配置管理 Key，请填写 .env 或配置 token 文件'); }
  if (!value) throw Error('token 文件是空的');
  return value;
}

module.exports = {DEFAULT_BASE_URL, readQuotaToken};
