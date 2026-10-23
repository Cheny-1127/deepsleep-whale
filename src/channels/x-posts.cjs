'use strict';
const {avatarUrl} = require('./subscription-avatar.cjs');
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
const displayName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,100) : '';
function projectPost(item, username, now = Date.now()) {
  if (!item || !validPostId(item.id) || xUsername(item.username) !== username || typeof item.text !== 'string') throw Error('动态格式无法识别。');
  const at = Number((BigInt(item.id) >> 22n) + 1288834974657n);
  if (!Number.isSafeInteger(at) || at < 1288834974657 || at > now + 86400000) throw Error('动态时间无法识别。');
  // 时间由帖子 ID 计算，链接由固定域名重建；不信任网页传来的地址或相对时间文案。
  return {id:item.id, username, displayName:displayName(item.displayName), avatarUrl:avatarUrl(item.avatarUrl), text:item.text.slice(0, 10000), publishedAt:at, truncated:item.truncated === true || item.text.length > 10000,
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
    const more = Array.from(article.querySelectorAll('button, [role="button"], [data-testid="tweet-text-show-more-link"]')).filter(el=>
      el.closest('article') === article && /^(显示更多|Show more)$/i.test(el.textContent.trim()));
    const raw = body?.innerText || body?.textContent || '（图片或视频动态，请查看原文）';
    // 控件文案不属于正文，不能把“显示更多”送去翻译或当作全文保存。
    const text = more.some(el=>body?.contains(el)) ? raw.replace(/\s*(显示更多|Show more)\s*$/i,'') : raw;
    // 只从本条动态的作者主页链接读取昵称，排除正文提及和嵌套引用的作者。
    const profiles = Array.from(article.querySelectorAll('a[href]')).filter(a=>{
      const profile = new URL(a.href,location.href);
      return a.closest('article') === article && !body?.contains(a) && profile.origin === url.origin &&
        profile.pathname.toLowerCase() === '/'+match[1].toLowerCase();
    });
    const avatar = profiles.map(a=>a.querySelector('img')).find(Boolean);
    const author = profiles.find(a=>a.textContent.trim() && !a.textContent.trim().startsWith('@'));
    const name = (author?.innerText || author?.textContent || '').split('\n').map(part=>part.trim()).find(part=>part && !part.startsWith('@')) || '';
    items.push({id:match[2], username:match[1].toLowerCase(), displayName:name, avatarUrl:avatar?.getAttribute('src') || '', text:text.slice(0, 10000),
      truncated:text.length > 10000 || more.length > 0});
  }
  const text = document.body?.innerText || '';
  return {items, empty:items.length === 0 && /hasn[’']t posted|hasn[’']t posted anything|尚未发布|还没有发布|还没有发帖/i.test(text)};
}
// 只点击目标作者动态中的展开正文按钮，不操作引用帖、关注或登录按钮。
function expandXDocument(username) {
  let count = 0;
  for (const article of Array.from(document.querySelectorAll('article')).slice(0,100)) {
    if (article.parentElement?.closest('article')) continue;
    const own = Array.from(article.querySelectorAll('a[href*="/status/"]')).some(link=>{
      const url = new URL(link.href,location.href);
      return ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname) && url.protocol === 'https:' &&
        new RegExp('^/'+username+'/status/[0-9]{8,22}/?$','i').test(url.pathname) && link.closest('article') === article;
    });
    if (!own) continue;
    for (const button of article.querySelectorAll('button, [role="button"], [data-testid="tweet-text-show-more-link"]')) {
      if (button.closest('article') === article && /^(显示更多|Show more)$/i.test(button.textContent.trim())) {button.click();count++;}
    }
  }
  return count;
}
module.exports = {displayName, xUsername, validPostId, compareIds, projectPost, readXDocument, expandXDocument};
