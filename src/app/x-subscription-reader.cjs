'use strict';
const {BrowserWindow, session} = require('electron');
const {xUsername, projectPost, readXDocument, expandXDocument} = require('../channels/x-posts.cjs');
const PARTITION = 'message-subscriptions-x';
const unavailable = () => Object.assign(Error('公开页面暂未提供可读取的动态。'), {code:'X_PUBLIC_UNAVAILABLE'});
function allowedRequest(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname) ||
      url.hostname === 'twimg.com' || url.hostname.endsWith('.twimg.com'));
  } catch {return false;}
}
function createXSubscriptionReader() {
  let configured = false;
  return async function readPosts(value, {signal} = {}) {
    const username = xUsername(value);signal?.throwIfAborted();
    const isolated = session.fromPartition(PARTITION);
    if (!configured) {
      configured = true;
      // 使用独立的内存会话，不接触用户浏览器登录态；远程页面无文件、通知和弹窗权限。
      isolated.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.on('will-download', event => event.preventDefault());
      isolated.webRequest.onBeforeRequest({urls:['<all_urls>']}, (details,callback) => callback({cancel:
        !allowedRequest(details.url) || ['image','media','font'].includes(details.resourceType)}));
    }
    const win = new BrowserWindow({width:1000, height:900, show:false, skipTaskbar:true,
      webPreferences:{partition:PARTITION, sandbox:true, contextIsolation:true, nodeIntegration:false,
        webviewTag:false, images:false, backgroundThrottling:true}});
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-redirect', (event,url) => {if (!allowedRequest(url)) event.preventDefault();});
    let deadline, poll, settled = false, expansionAttempts = 0, collected = null, detailTimer;
    return new Promise((resolve,reject) => {
      function finish(error, posts) {
        if (settled) return;settled = true;
        clearTimeout(deadline);clearTimeout(poll);clearTimeout(detailTimer);signal?.removeEventListener('abort',abort);
        // 每次读取结束都销毁网页，账号间串行执行，不常驻一组后台浏览器页面。
        if (!win.isDestroyed()) win.destroy();
        if (error) reject(error);else resolve(posts);
      }
      const abort = () => finish(signal.reason || Error('读取已取消。'));
      signal?.addEventListener('abort',abort,{once:true});
      win.on('closed', () => {if (!settled) finish(Error('读取页面已关闭。'));});
      // 有摘要时，详情页超时仍保留本轮结果；不能让一条长帖阻断整个账号。
      deadline = setTimeout(() => collected ? finish(null,collected) : finish(unavailable()),30000);
      const completeLongPosts = async posts => {
        collected = posts;
        for (let index=0;index<collected.length;index++) {
          if (settled) return;
          const post = collected[index];if (!post.truncated) continue;
          const until = Date.now()+5000;
          const loaded = await Promise.race([
            win.loadURL(post.url).then(()=>true,()=>false),
            new Promise(resolve=>{detailTimer=setTimeout(()=>resolve(false),5000);})
          ]);
          clearTimeout(detailTimer);if (settled) return;
          if (!loaded) {win.webContents.stop();continue;}
          // 只接受同一作者、同一帖子 ID 的详情正文，不能把回复或引用当成全文。
          while (!settled && Date.now()<until) {
            try {
              const detail = await win.webContents.executeJavaScript(`(${readXDocument.toString()})()`);
              if (settled) return;
              const full = detail.items.find(item=>item.username===username && item.id===post.id && !item.truncated);
              if (full) {collected[index]=projectPost(full,username);break;}
              if (detail.empty) break;
            } catch {break;}
            await new Promise(resolve=>setTimeout(resolve,200));
          }
        }
        if (!settled) finish(null,collected);
      };
      const inspect = async () => {
        if (settled) return;
        try {
          const result = await win.webContents.executeJavaScript(`(${readXDocument.toString()})()`);
          if (settled) return;
          const posts = result.items.filter(item => item.username === username).map(item => projectPost(item,username));
          // 等展开后的 DOM 更新再采集；最多重试三次，避免无效按钮拖住整轮检查。
          if (posts.some(post=>post.truncated) && expansionAttempts < 3) {
            const expanded = await win.webContents.executeJavaScript(`(${expandXDocument.toString()})(${JSON.stringify(username)})`);
            if (settled) return;
            if (expanded) {expansionAttempts++;poll = setTimeout(inspect,200);return;}
          }
          if (posts.length) {
            collected = posts;
            if (posts.some(post=>post.truncated)) await completeLongPosts(posts);else finish(null,posts);
            return;
          }
          if (result.empty) {finish(null,posts);return;}
          poll = setTimeout(inspect,1000);
        } catch (error) {finish(error);}
      };
      win.loadURL(`https://x.com/${username}`).then(inspect,error => finish(error));
    });
  };
}
module.exports = {createXSubscriptionReader, allowedRequest};
