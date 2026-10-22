'use strict';
const {BrowserWindow, session} = require('electron');
const {xUsername, projectPost, readXDocument} = require('../channels/x-posts.cjs');
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
    let deadline, poll, settled = false;
    return new Promise((resolve,reject) => {
      function finish(error, posts) {
        if (settled) return;settled = true;
        clearTimeout(deadline);clearTimeout(poll);signal?.removeEventListener('abort',abort);
        // 每次读取结束都销毁网页，账号间串行执行，不常驻一组后台浏览器页面。
        if (!win.isDestroyed()) win.destroy();
        if (error) reject(error);else resolve(posts);
      }
      const abort = () => finish(signal.reason || Error('读取已取消。'));
      signal?.addEventListener('abort',abort,{once:true});
      win.on('closed', () => {if (!settled) finish(Error('读取页面已关闭。'));});
      deadline = setTimeout(() => finish(unavailable()),30000);
      const inspect = async () => {
        if (settled) return;
        try {
          const result = await win.webContents.executeJavaScript(`(${readXDocument.toString()})()`);
          if (settled) return;
          const posts = result.items.filter(item => item.username === username).map(item => projectPost(item,username));
          if (posts.length || result.empty) {finish(null,posts);return;}
          poll = setTimeout(inspect,1000);
        } catch (error) {finish(error);}
      };
      win.loadURL(`https://x.com/${username}`).then(inspect,error => finish(error));
    });
  };
}
module.exports = {createXSubscriptionReader, allowedRequest};
