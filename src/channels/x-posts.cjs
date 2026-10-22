'use strict';
const RESERVED = new Set(['home','explore','search','notifications','messages','i','settings','compose','tos','privacy','login','signup','intent','share','hashtag']);
function xUsername(value) {
  if (typeof value !== 'string' || value.length > 500) throw Error('请输入有效的 X 用户名或主页、帖子链接。');
  let name = value.trim();
  if (/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i.test(name)) {
    const url = new URL(name.includes('://') ? name : 'https://' + name);
    const match = /^\/([a-z0-9_]{1,15})(?:\/status\/\d{8,22})?\/?$/i.exec(url.pathname);
    if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname.toLowerCase()) ||
      url.protocol !== 'https:' || url.username || url.password || url.port || !match) throw Error('请使用有效的 X 主页或帖子链接。');
    name = match[1];
  } else name = name.replace(/^@/, '');
  if (!/^[a-z0-9_]{1,15}$/i.test(name) || RESERVED.has(name.toLowerCase())) throw Error('请输入有效的 X 用户名或主页、帖子链接。');
  return name.toLowerCase();
}
function validPostId(id) {return typeof id === 'string' && /^\d{8,22}$/.test(id);}
const compareIds = (a,b) => BigInt(a) > BigInt(b) ? 1 : BigInt(a) < BigInt(b) ? -1 : 0;
function projectPost(item, username, now = Date.now()) {
  if (!item || !validPostId(item.id) || xUsername(item.username) !== username || typeof item.text !== 'string') throw Error('动态格式无法识别。');
  const at = Number((BigInt(item.id) >> 22n) + 1288834974657n);
  if (!Number.isSafeInteger(at) || at < 1288834974657 || at > now + 86400000) throw Error('动态时间无法识别。');
  // 时间由帖子 ID 计算，链接由固定域名重建；不信任网页传来的地址或相对时间文案。
  return {id:item.id, username, text:item.text.slice(0, 10000), publishedAt:at, truncated:item.truncated === true || item.text.length > 10000,
    url:`https://x.com/${username}/status/${item.id}`};
}

// 该函数只读取 DOM，可序列化后在不带 preload 的远程隔离页面中执行。
function readXDocument() {
  const items = [];
  for (const article of Array.from(document.querySelectorAll('article')).slice(0, 100)) {
    if (article.parentElement?.closest('article')) continue;
    const link = Array.from(article.querySelectorAll('a[href*="/status/"]')).find(a =>
      /^\/[a-z0-9_]{1,15}\/status\/\d{8,22}\/?$/i.test(new URL(a.href, location.href).pathname));
    if (!link) continue;
    const url = new URL(link.href, location.href);
    if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname) || url.protocol !== 'https:') continue;
    const match = /^\/([a-z0-9_]{1,15})\/status\/(\d{8,22})\/?$/i.exec(url.pathname);
    const body = article.querySelector('[data-testid="tweetText"], [dir="auto"].whitespace-pre-wrap');
    const text = body?.innerText || body?.textContent || '（图片或视频动态，请查看原文）';
    items.push({id:match[2], username:match[1].toLowerCase(), text:text.slice(0, 10000),
      truncated:text.length > 10000 || Array.from(article.querySelectorAll('button')).some(button => /^(显示更多|Show more)$/i.test(button.textContent.trim()))});
  }
  const text = document.body?.innerText || '';
  return {items, empty:items.length === 0 && /hasn[’']t posted|hasn[’']t posted anything|尚未发布|还没有发布|还没有发帖/i.test(text)};
}
module.exports = {xUsername, validPostId, compareIds, projectPost, readXDocument};
