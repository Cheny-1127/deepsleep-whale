'use strict';
// 真实主进程与页面，隔离存储和所有外部服务；验证总开关而不操作用户账号。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-modules-ui-'),home=path.join(dir,'codex');fs.mkdirSync(home);
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');
const bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({sources:{codex:true,cursor:false},notifications:false,sound:false}));
fs.writeFileSync(bootstrap,`
require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {net,shell,safeStorage}=require('electron');global.moduleTrace={creates:{},starts:{},closes:{}};
net.fetch=async()=>{throw Error('外部网络已在模块测试中隔离');};shell.openExternal=async()=>{throw Error('测试不打开外部客户端');};
safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=>'test';safeStorage.encryptString=value=>Buffer.from(value);safeStorage.decryptString=value=>value.toString();
const hooks=require(${JSON.stringify(path.join(root,'src/app/hook-settings.cjs'))});
hooks.createHookSettings=()=>({settings:{sources:{codex:true,cursor:false},events:{codex:{},cursor:{}},notifications:false,sound:false,showPanelOnStartup:true},adapters:[],availability:{codex:{state:'checked',events:{}},cursor:{state:'checked',events:{}}},refresh:async()=>{},update:async()=>{},setPreference(){}});
const archery=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),createArchery=archery.createArcheryPending;
archery.createArcheryPending=options=>createArchery({...options,readConfig:()=>{throw Object.assign(Error('测试未配置 Archery'),{archeryConfig:true});}});
require(${JSON.stringify(path.join(root,'src/app/x-subscription-reader.cjs'))}).createXSubscriptionReader=()=>async()=>({posts:[],displayName:'测试订阅'});
for(const [file,name,id] of ${JSON.stringify([['channels/wechat-manager.cjs','createWechatManager','wechat'],['channels/imap-mail.cjs','createMailReceiver','mail'],['channels/message-subscriptions.cjs','createMessageSubscriptions','subscriptions'],['channels/quota-accounts.cjs','createQuotaPanel','quota'],['channels/quota-group-usage.cjs','createGroupUsage','groups'],['channels/quota-key-usage.cjs','createKeyUsage','keys'],['channels/pet-quota.cjs','createPetQuota','tracking']])}){
 const module=require(${JSON.stringify(path.join(root,'src'))}+'/'+file),create=module[name];
 module[name]=options=>{global.moduleTrace.creates[id]=(global.moduleTrace.creates[id]||0)+1;const api=create(options);
 for(const [method,field] of [['start','starts'],['close','closes']])if(api[method]){const original=api[method];api[method]=function(...args){global.moduleTrace[field][id]=(global.moduleTrace[field][id]||0)+1;return original.apply(this,args);};}return api;};
}
const cp=require('node:child_process'),exec=cp.execFile;cp.execFile=function(file,args,options,callback){if(file==='/bin/ps'){setImmediate(()=>callback(null,''));return;}return exec.apply(this,arguments);};
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app,panel,pet;const errors=[];
async function launch(){
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_TEST_WINDOWS:'hidden',WHALE_DATA_DIR:dir,CODEX_HOME:home,WHALE_CURSOR_HOME:path.join(dir,'cursor'),WHALE_QUOTA_TOKEN_FILE:path.join(dir,'no-token')}});
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));await app.firstWindow();
  await app.evaluate(async({BrowserWindow})=>{for(let i=0;i<100&&!BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().endsWith('/index.html'));i++)await new Promise(resolve=>setTimeout(resolve,30));});
  panel=app.windows().find(p=>p.url().endsWith('/index.html'));pet=app.windows().find(p=>p.url().endsWith('/pet.html'));
  await panel.waitForFunction(()=>document.querySelectorAll('.module-toggle:not(:disabled)').length===8);
}
async function toggle(id,enabled){
  await panel.locator('#nav-'+id).click();const button=panel.locator('#'+id+'-module-toggle');await button.click();
  await panel.waitForFunction(({id,enabled})=>document.getElementById(id+'-module-toggle').getAttribute('aria-checked')===String(enabled)&&!document.getElementById(id+'-module-toggle').disabled,{id,enabled});
}
(async()=>{try{
  await launch();assert.equal(await panel.locator('#home-module-toggle').count(),0);
  await panel.evaluate(()=>window.whale.shortcuts('pat'));
  const task=await panel.evaluate(()=>window.whale.planner('save-task',{title:'关闭模块也保留的待办',notes:'原备注',deadline:'none',category:'work'}));assert.ok(task.value,JSON.stringify(task));
  await panel.evaluate(()=>window.whale.subscriptions('add',{username:'test_account'}));
  await panel.evaluate(()=>window.whale.subscriptions('set-enabled',{username:'test_account',enabled:false}));
  for(const id of MODULE_IDS){
    await toggle(id,false);
    assert.equal(await panel.locator('#'+id+'-module-content').evaluate(el=>el.inert),true);
    assert.equal(await panel.locator('#nav-'+id).getAttribute('data-module-enabled'),'false');
    assert.equal(await panel.locator('#'+id+'-module-content').evaluate(el=>getComputedStyle(el).filter),'grayscale(1)');
    assert.equal(await panel.locator('#'+id+'-module-toggle').evaluate(el=>Boolean(el.closest('[inert]'))),false,'总开关不能随内容一起禁用');
  }
  const stopped=await app.evaluate(()=>global.moduleTrace);
  for(const id of ['wechat','mail','subscriptions','quota','groups','keys','tracking'])assert.equal(stopped.closes[id],1,id+' 停止运行');
  const guards=await panel.evaluate(async()=>({
    wechat:await window.whale.wechat('add-connection'),mail:await window.whale.mail('refresh'),subscriptions:await window.whale.subscriptions('refresh'),
    archery:await window.whale.archery('refresh'),quota:await window.whale.quota('refresh'),groups:await window.whale.quotaGroup('open'),tracking:await window.whale.petQuota('refresh'),planner:await window.whale.planner('save-task',{title:'不应新增'})
  }));assert.ok(Object.values(guards).every(result=>/已关闭/.test(result.error)));
  const cached=await panel.evaluate(async()=>({mail:await window.whale.mail('snapshot'),quota:await window.whale.quota('snapshot'),subscriptions:await window.whale.subscriptions('snapshot')}));
  assert.ok(Object.values(cached).every(result=>result.value&&!result.error),'关闭后仍可读取本地快照展示灰色页面');
  await assert.rejects(panel.evaluate(()=>window.whale.action('hook-source',{source:'codex',enabled:true})),/已关闭/);
  const shortcutBefore=await panel.evaluate(()=>window.whale.snapshot());
  await panel.evaluate(()=>window.whale.action('shortcut-triple'));assert.equal((await panel.evaluate(()=>window.whale.snapshot())).state,shortcutBefore.state);
  assert.deepEqual((await pet.evaluate(()=>window.whale.petQuota('snapshot'))).value,{tracking:null,extraTrackings:[]});
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).planner.active.length,0);
  await assert.rejects(pet.evaluate(()=>window.whale.modules({id:'mail',enabled:true})),/仅允许/);
  await panel.locator('#nav-wechat').click();await panel.setViewportSize({width:860,height:850});fs.mkdirSync(path.join(root,'out'),{recursive:true});
  await panel.screenshot({path:path.join(root,'out/modules-disabled.png'),fullPage:true});
  assert.equal(await panel.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'窄窗口不产生横向溢出');
  // 保存失败不能把界面或后台切换成尚未落盘的状态。
  fs.mkdirSync(path.join(dir,'modules.json.tmp'));
  await panel.locator('#nav-wechat').click();await panel.locator('#wechat-module-toggle').click();
  await panel.waitForFunction(()=>!document.querySelector('#wechat-view > .module-error').hidden);
  assert.equal(await panel.locator('#wechat-module-toggle').getAttribute('aria-checked'),'false');fs.rmdirSync(path.join(dir,'modules.json.tmp'));
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'modules.json'),'utf8'));assert.ok(MODULE_IDS.every(id=>saved[id]===false));
  await app.close();app=null;await launch();
  const restarted=await app.evaluate(()=>global.moduleTrace);for(const id of ['wechat','mail','subscriptions','tracking'])assert.equal(restarted.starts[id]||0,0,'关闭状态启动不运行 '+id);
  for(const id of MODULE_IDS){
    assert.equal(await panel.locator('#'+id+'-module-toggle').getAttribute('aria-checked'),'false');await toggle(id,true);
    assert.equal(await panel.locator('#'+id+'-module-content').evaluate(el=>el.inert),false);
  }
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).shortcuts.tripleClick,'pat');
  assert.equal((await panel.evaluate(()=>window.whale.planner('snapshot'))).value.tasks[0].title,'关闭模块也保留的待办');
  assert.equal((await panel.evaluate(()=>window.whale.subscriptions('snapshot'))).value.accounts[0].enabled,false,'总开关不恢复已暂停的订阅');
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).settings.sources.codex,true,'Hooks 来源偏好不变');
  assert.equal(await panel.locator('#nav-planner').getAttribute('data-module-enabled'),'true');
  await panel.locator('#nav-wechat').click();await panel.screenshot({path:path.join(root,'out/modules-enabled.png'),fullPage:true});
  assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[]);assert.deepEqual(errors,[]);
  console.log('PASS: eight module switches, home excluded, inert/gray content and navigation, runtime stop/restart, persisted disabled startup, IPC guards, save failure rollback, preserved data/account switches, 860px hidden UI');
}finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
