'use strict';
// 用隔离的 Electron 会话承载合成 X 页面，不登录、不连接真实 X 或桌宠。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-x-reader-');
const bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`const {app,session}=require('electron');app.setPath('userData',${JSON.stringify(dir)});app.on('window-all-closed',()=>{});
const reader=require(${JSON.stringify(path.join(root,'src/app/x-subscription-reader.cjs'))});
global.readerWindows=()=>require('electron').BrowserWindow.getAllWindows().length;global.readX=reader.createXSubscriptionReader();global.allowedX=reader.allowedRequest;global.readerMode='posts';global.readerPrefs=[];global.readerRequests=[];
app.on('browser-window-created',(_event,win)=>{global.readerPrefs.push(win.webContents.getLastWebPreferences());});
app.whenReady().then(()=>session.fromPartition('message-subscriptions-x').protocol.handle('https',request=>{
 global.readerRequests.push(request.url);const fixture=global.readerMode==='detail'?(new URL(request.url).pathname.includes('/status/')?'<article><a href="/thsottiaux/status/2113162277688070445">post</a><div data-testid="tweetText">完整详情正文</div></article>':'<article><a href="/thsottiaux/status/2113162277688070445">post</a><div data-testid="tweetText">摘要<button>显示更多</button></div></article>'):global.readerMode==='empty'?"<p>@thsottiaux hasn't posted</p>":global.readerMode==='login'?'<p>Log in to X</p>':
 '<img src="https://x.com/fixture-image.png"><article><a href="/thsottiaux/status/2113162277688070445">7h</a><div dir="auto" class="whitespace-pre-wrap">正文 &lt;img onerror=alert(1)&gt;</div><button onclick="this.previousElementSibling.textContent+=String.fromCharCode(32,102,117,108,108,32,116,101,120,116);this.remove()">Show more</button><article><a href="/stranger/status/2113029655095836957">quote</a><div data-testid="tweetText">引用正文</div></article></article><article><a href="/thsottiaux/status/2113029655095836957">8h</a><div data-testid="tweetText">classic text</div></article><article><a href="/stranger/status/2112712984644784534">other author</a><div data-testid="tweetText">not own post</div></article>';
 return new Response('<!doctype html><html><body>'+fixture+'</body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
}));`);
let app;
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap]});
  const result=await app.evaluate(async()=>{
    const posts=await global.readX('thsottiaux');
    return {posts,prefs:global.readerPrefs.at(-1),windows:global.readerWindows(),requests:global.readerRequests};
  });
  assert.deepEqual(result.posts.map(p=>p.id),['2113162277688070445','2113029655095836957']);
  assert.equal(result.posts[0].text,'正文 <img onerror=alert(1)> full text');assert.equal(result.posts[0].truncated,false);
  assert.equal(result.posts[0].url,'https://x.com/thsottiaux/status/2113162277688070445');
  for(const [key,value] of Object.entries({sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false}))assert.equal(result.prefs[key],value,key);
  assert.ok(!result.prefs.preload);assert.equal(result.windows,0);assert.ok(!result.requests.some(url=>url.includes('fixture-image.png')),'images do not load');
  const urls=await app.evaluate(()=>({
    good:['https://x.com/thsottiaux','https://abs.twimg.com/script.js'].map(global.allowedX),
    bad:['http://x.com/thsottiaux','https://x.com.evil.test/','https://evil.test/','file:///etc/passwd','https://x.com:444/','https://user:pass@x.com/','https://twimg.com.evil.test/'].map(global.allowedX)
  }));assert.ok(urls.good.every(Boolean));assert.ok(urls.bad.every(v=>!v));
  const detail=await app.evaluate(async()=>{global.readerMode='detail';return global.readX('thsottiaux');});
  assert.equal(detail[0].text,'完整详情正文');assert.equal(detail[0].truncated,false);
  assert.deepEqual(await app.evaluate(async()=>{global.readerMode='empty';return global.readX('thsottiaux');}),[]);
  const abort=await app.evaluate(async()=>{
    global.readerMode='login';const controller=new AbortController();setTimeout(()=>controller.abort(),150);
    try{await global.readX('thsottiaux',{signal:controller.signal});return false;}catch{return global.readerWindows()===0;}
  });assert.equal(abort,true,'login page is not silently accepted and abort destroys the window');
  const timeout=await app.evaluate(async()=>{
    try{await global.readX('thsottiaux');return 'accepted';}catch(error){return {code:error.code,windows:global.readerWindows()};}
  });assert.deepEqual(timeout,{code:'X_PUBLIC_UNAVAILABLE',windows:0});
  console.log('X reader OK: classic/new DOM, own-author filter, HTTPS allowlist, sandbox/no preload, explicit empty, login timeout, abort and window cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
