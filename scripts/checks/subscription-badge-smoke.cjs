'use strict';
// 真实桌宠、小屋、IPC 和缓存；网络与用户数据隔离，窗口从创建起隐藏。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-subscription-badge-');
const bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({showPanelOnStartup:false,sources:{codex:false,cursor:false},notifications:false,sound:false}));
fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,id==='subscriptions']))));
fs.writeFileSync(path.join(dir,'message-subscriptions.json'),JSON.stringify({version:2,accounts:[{
  username:'test_account',enabled:true,initialized:false,latestId:null,unreadIds:[],posts:[],attemptedAt:null,checkedAt:null
}]}));
fs.writeFileSync(bootstrap,`
require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {net,shell,Notification}=require('electron');
net.fetch=async()=>{throw Error('角标测试不访问外部网络');};shell.openExternal=async()=>{throw Error('角标测试不打开外部客户端');};Notification.isSupported=()=>false;
global.badgeFixture={count:3,calls:0,base:String((BigInt(Date.now()-600000)-1288834974657n)<<22n)};
require(${JSON.stringify(path.join(root,'src/app/x-subscription-reader.cjs'))}).createXSubscriptionReader=()=>async username=>{
  const f=global.badgeFixture;f.calls++;
  return Array.from({length:f.count},(_,i)=>({username,id:String(BigInt(f.base)+BigInt(i+1)),text:'测试动态 '+(i+1)}));
};
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;const errors=[];
async function page(suffix) {
  for(let i=0;i<200;i++) {
    const found=app.windows().find(p=>p.url().endsWith(suffix));if(found)return found;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('未创建测试窗口：'+suffix);
}
async function launch() {
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_TEST_WINDOWS:'hidden',WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_CURSOR_HOME:dir,WHALE_QUOTA_TOKEN_FILE:path.join(dir,'no-token')}});
  app.on('window',win=>win.on('pageerror',error=>errors.push(error.message)));
  await app.firstWindow();return page('/pet.html');
}
async function badgeCount(pet,count) {
  await pet.waitForFunction(count=>{
    const badge=document.getElementById('pet-subscriptions-badge');
    return badge && badge.hidden===(count===0) && (badge.textContent===(count>99?'99+':String(count))||badge.textContent===`有 ${count} 条未读消息`);
  },count);
}
async function hiddenWindows() {
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>({events:global.testWindowPolicy.events,
    visible:BrowserWindow.getAllWindows().some(w=>w.isVisible()||w.isFocused()||w.isAlwaysOnTop())})),{events:[],visible:false});
}
(async()=>{
  let pet=await launch();await badgeCount(pet,3);
  assert.equal(app.windows().some(p=>p.url().endsWith('/index.html')),false,'小屋未创建时仍能显示后台采集的未读数');
  const badge=pet.locator('#pet-subscriptions-badge');
  await pet.waitForFunction(()=>!document.getElementById('pet-subscriptions-badge').classList.contains('expanded'));
  const geometry=await badge.evaluate(el=>{
    const r=el.getBoundingClientRect(),art=document.getElementById('pet-art').getBoundingClientRect();
    return {top:r.top-art.top,right:art.right-r.right,height:r.height,color:getComputedStyle(el).backgroundColor,inArt:Boolean(el.closest('#pet-art'))};
  });
  assert.deepEqual(geometry,{top:32,right:28,height:24,color:'rgb(255, 250, 244)',inArt:false});
  await pet.screenshot({path:'/tmp/whale-subscription-badge.png'});
  const nurture=(await pet.evaluate(()=>window.whale.snapshot())).nurture;
  // 从没有小屋窗口的状态点击，验证导航事件会等新页面加载完成。
  await badge.click();let panel=await page('/index.html');
  await panel.waitForFunction(()=>!document.getElementById('subscriptions-view').hidden && document.querySelectorAll('.subscriptions-post').length===3);
  assert.equal(await panel.locator('#subscriptions-tab-feed').getAttribute('aria-selected'),'true');
  assert.equal(await panel.locator('#subscriptions-unread').isChecked(),true);
  assert.equal(await panel.locator('#subscriptions-selected').textContent(),'全部账号');
  await badgeCount(pet,3);
  assert.deepEqual((await pet.evaluate(()=>window.whale.snapshot())).nurture,nurture,'点击角标不会误触摸摸或拖动');
  await panel.locator('.subscriptions-post-body').first().click();await badgeCount(pet,2);
  await panel.locator('.subscriptions-delete').first().click();await badgeCount(pet,1);
  await pet.evaluate(()=>window.whale.action('demo','thinking'));
  await pet.waitForFunction(()=>document.getElementById('pet-art').dataset.state==='thinking' && document.getElementById('rice-image').complete);
  await pet.screenshot({path:'/tmp/whale-subscription-badge-thinking.png'});
  await panel.locator('#subscriptions-read-all').click();await badgeCount(pet,0);
  // 两个账号合计 197 条未读，角标截断展示但可访问名称保留完整数字。
  await app.evaluate(()=>{global.badgeFixture.count=100;});
  await panel.evaluate(()=>window.whale.subscriptions('add','second_account'));
  await panel.evaluate(()=>window.whale.subscriptions('refresh'));await badgeCount(pet,197);
  assert.match(await badge.getAttribute('aria-label'),/197 条未读/);
  assert.equal(await badge.evaluate(el=>el.classList.contains('expanded')),true);
  assert.equal(await pet.locator('#speech').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  await pet.screenshot({path:'/tmp/whale-subscription-card.png'});
  const cardBounds=await badge.boundingBox();
  const viewport=pet.viewportSize()||await pet.evaluate(()=>({width:innerWidth,height:innerHeight}));
  assert.ok(cardBounds.x>=0&&cardBounds.y>=0&&cardBounds.x+cardBounds.width<=viewport.width,'展开卡片不裁切');
  await pet.waitForFunction(()=>!document.getElementById('pet-subscriptions-badge').classList.contains('expanded'),{},{timeout:4500});
  assert.equal(await badge.textContent(),'99+');
  await pet.screenshot({path:'/tmp/whale-subscription-badge-99.png'});
  await panel.locator('#subscriptions-module-toggle').click();
  await pet.waitForFunction(()=>document.getElementById('pet-subscriptions-badge').hidden);
  await assert.rejects(pet.evaluate(()=>window.whale.action('subscriptions-unread')),/消息订阅已关闭/);
  await panel.locator('#subscriptions-module-toggle').click();await badgeCount(pet,197);
  // 已存在的小屋切到其他分区和筛选后，角标仍打开全部账号的未读动态。
  await panel.locator('#subscriptions-picker-button').click();
  await panel.locator('button.subscriptions-account[data-username="test_account"]').click();
  await panel.locator('#subscriptions-unread').uncheck();await panel.locator('#subscriptions-tab-manage').click();
  await badge.press('Enter');
  await panel.waitForFunction(()=>document.getElementById('subscriptions-selected').textContent==='全部账号' && document.getElementById('subscriptions-unread').checked && !document.getElementById('subscriptions-panel-feed').hidden);
  await badgeCount(pet,197);await hiddenWindows();
  await app.close();app=null;pet=await launch();await badgeCount(pet,197);
  assert.equal(app.windows().some(p=>p.url().endsWith('/index.html')),false,'重启仍不必打开小屋');
  assert.equal(await app.evaluate(()=>global.badgeFixture.calls),0,'重启从本地缓存恢复未读数，不增加采集');
  await hiddenWindows();assert.deepEqual(errors,[]);
  console.log('Subscription badge UI OK: background count, blue speech bubble, timed message card, click/keyboard navigation, read/delete/zero/99+, module toggle, cache restart; all windows hidden');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
