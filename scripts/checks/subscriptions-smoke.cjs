'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-subscriptions-ui-'),bootstrap=path.join(dir,'bootstrap.cjs');
// 隔离主进程保留真实 IPC/持久化，只替换网络采集并拦截外部跳转。
fs.writeFileSync(bootstrap,`const {shell,Notification}=require('electron');Notification.isSupported=()=>false;
global.subscriptionsFixture={step:1,base:String((BigInt(Date.now()-600000)-1288834974657n)<<22n),calls:[],opened:[],fail:false,hold:false};shell.openExternal=async url=>global.subscriptionsFixture.opened.push(url);
const archery=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),createArchery=archery.createArcheryPending;
archery.createArcheryPending=options=>createArchery({...options,readConfig:()=>{throw Error('isolated');}});
require(${JSON.stringify(path.join(root,'src/app/x-subscription-reader.cjs'))}).createXSubscriptionReader=()=>async(username,{signal})=>{
 const f=global.subscriptionsFixture;f.calls.push(username);if(f.hold)await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
 if(f.fail)throw Object.assign(Error('secret diagnostics'),{code:'X_PUBLIC_UNAVAILABLE'});
 return Array.from({length:f.step},(_,i)=>({username,id:String(BigInt(f.base)+BigInt(i+1)),text:'动态 '+(i+1)+' <img src=x onerror=alert(1)>'}));
};
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;
async function launch() {
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_CURSOR_HOME:dir,WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing-token')}});
  await app.firstWindow();
  let panel;
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);await panel.locator('#nav-subscriptions').click();return panel;
}
(async()=>{
  let panel=await launch();const errors=[];panel.on('pageerror',error=>errors.push(error.message));
  await panel.waitForFunction(()=>document.querySelector('#subscriptions-status').textContent.includes('0 个订阅'));
  assert.ok(await panel.locator('#home-view').isHidden());
  assert.equal(await panel.locator('#nav-home').evaluate(el=>el.nextElementSibling.id),'nav-subscriptions');
  assert.equal(await app.evaluate(()=>global.subscriptionsFixture.calls.length),0,'recommendations do not auto-subscribe or fetch');
  assert.ok(await panel.locator('#subscriptions-recommend-tibo').isEnabled());
  fs.mkdirSync(path.join(root,'out'),{recursive:true});await panel.screenshot({path:path.join(root,'out','subscriptions-recommendations.png'),fullPage:true});
  await panel.locator('#subscriptions-input').fill('https://x.com/thsottiaux/status/2113162277688070445');await panel.locator('#subscriptions-add').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.subscriptions-post').length===1);
  assert.equal(await panel.locator('#subscriptions-badge').isHidden(),true);
  assert.equal(await panel.locator('#subscriptions-recommend-tibo').textContent(),'已订阅');assert.ok(await panel.locator('#subscriptions-recommend-tibo').isDisabled());
  assert.equal(await panel.locator('.subscriptions-post img').count(),0);
  assert.ok(!(JSON.stringify(await panel.evaluate(()=>window.whale.snapshot()))).includes('onerror=alert'));
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));assert.ok(pet);
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.subscriptions('snapshot');return 'allowed';}catch{return 'denied';}}),'denied');
  const bad=await panel.evaluate(()=>window.whale.subscriptions('open-profile','https://evil.test'));assert.ok(bad.error);
  await panel.locator('#subscriptions-input').fill('@THSOTTIAUX');await panel.locator('#subscriptions-add').click();await panel.waitForFunction(()=>document.querySelector('#subscriptions-error').textContent.includes('已在订阅'));
  // 使用稳定的 ID 基点，避免两次测试请求因当前时间变化制造额外新帖。
  await app.evaluate(()=>{const f=global.subscriptionsFixture;f.step=3;});
  await panel.locator('#subscriptions-refresh').click();await panel.waitForFunction(()=>document.querySelectorAll('.subscriptions-post').length===3);
  assert.ok(await panel.locator('#subscriptions-badge').isVisible());
  await panel.locator('#subscriptions-unread').check();assert.equal(await panel.locator('.subscriptions-post').count(),2);
  await panel.getByRole('button',{name:'标为已读',exact:true}).first().click();assert.equal(await panel.locator('.subscriptions-post').count(),1);
  await panel.locator('#subscriptions-unread').uncheck();
  await panel.getByRole('button',{name:'查看原文 ↗',exact:true}).first().click();
  const opened=await app.evaluate(()=>global.subscriptionsFixture.opened);assert.match(opened[0],/^https:\/\/x\.com\/thsottiaux\/status\/\d+$/);
  await panel.locator('#subscriptions-read-all').click();await panel.waitForFunction(()=>document.querySelector('#subscriptions-badge').hidden);
  await panel.getByRole('button',{name:'暂停 @thsottiaux',exact:true}).click();assert.ok(await panel.locator('#subscriptions-refresh').isDisabled());
  await panel.getByRole('button',{name:'启用 @thsottiaux',exact:true}).click();
  await app.evaluate(()=>{global.subscriptionsFixture.fail=true;});await panel.locator('#subscriptions-refresh').click();
  await panel.waitForFunction(()=>document.querySelector('#subscriptions-account-status').textContent.includes('公开页面'));
  assert.equal(await panel.locator('.subscriptions-post').count(),3);assert.ok(!(await panel.locator('#subscriptions-account-status').textContent()).includes('secret diagnostics'));
  await panel.getByRole('button',{name:'打开主页',exact:true}).click();assert.equal((await app.evaluate(()=>global.subscriptionsFixture.opened)).at(-1),'https://x.com/thsottiaux');
  for(const width of [1060,860]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,770),width);
    assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    fs.mkdirSync(path.join(root,'out'),{recursive:true});await panel.screenshot({path:path.join(root,'out',`subscriptions-${width}.png`),fullPage:true});
  }
  await panel.locator('#subscriptions-clear').click();assert.equal(await panel.locator('.subscriptions-post').count(),0);assert.equal(await panel.locator('.subscriptions-account').count(),1);
  await app.close();app=null;panel=await launch();
  await panel.waitForFunction(()=>document.querySelector('#subscriptions-status').textContent.includes('1 个订阅'));
  assert.equal(await panel.locator('.subscriptions-post').count(),0);assert.equal(await app.evaluate(()=>global.subscriptionsFixture.calls.length),0,'restart does not refetch before hourly deadline');
  await panel.locator('#subscriptions-input').fill('@OpenAI');await panel.locator('#subscriptions-add').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.subscriptions-post').length===1);
  assert.equal(await panel.locator('.subscriptions-account').count(),2);
  await panel.locator('[data-username="thsottiaux"] .ui-menu-item').click();assert.equal(await panel.locator('.subscriptions-post').count(),0);
  await panel.locator('[data-username="openai"] .ui-menu-item').click();assert.equal(await panel.locator('.subscriptions-post').count(),1);
  await panel.locator('#subscriptions-all').click();assert.equal(await panel.locator('.subscriptions-post').count(),1);
  await panel.getByRole('button',{name:'删除 @openai',exact:true}).click();
  await panel.getByRole('button',{name:'删除 @thsottiaux',exact:true}).click();assert.equal(await panel.locator('.subscriptions-account').count(),0);
  assert.ok(await panel.locator('#subscriptions-recommend-tibo').isEnabled());
  await panel.locator('#subscriptions-recommend-tibo').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.subscriptions-post').length===1);
  assert.equal(await panel.locator('.subscriptions-account').count(),1);assert.ok(await panel.locator('#subscriptions-recommend-tibo').isDisabled());
  await panel.getByRole('button',{name:'删除 @thsottiaux',exact:true}).click();assert.ok(await panel.locator('#subscriptions-recommend-tibo').isEnabled());
  assert.deepEqual(errors,[]);console.log('Subscriptions UI OK: link input, baseline, unread/read, filtering, pause, safe links/text, failure cache, clear/restart, delete, IPC and 860/1060px layout');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
