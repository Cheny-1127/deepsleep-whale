'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-archery-ui-');
const bootstrap=path.join(dir,'bootstrap.cjs');
// 仅隔离测试进程替换 Archery 适配器，不读取真实账号、不连接生产服务。
fs.writeFileSync(bootstrap,`const {shell,Notification,dialog}=require('electron');Notification.isSupported=()=>false;
global.archerySmoke={calls:[],opened:[],approvals:[],confirmations:[],confirm:false,fail:false,approved:false};shell.openExternal=async url=>global.archerySmoke.opened.push(url);
dialog.showMessageBox=async options=>{global.archerySmoke.confirmations.push(options);return {response:global.archerySmoke.confirm?1:0};};
const channel=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),create=channel.createArcheryPending;
channel.createArcheryPending=options=>create({...options,intervalMs:1000,
readConfig:()=>({fingerprint:'synthetic-account',baseUrl:'https://archery.example.com',canApprove:true}),
createClient:()=>({close(){},async pending(page){global.archerySmoke.calls.push(page);if(global.archerySmoke.fail)throw Error('fixture-secret');
return {structuredContent:{status:'success',data:{items:page===2||global.archerySmoke.approved?[]:[{order_id:566,order_type:'work_order',title:'测试工单 <img src=x onerror=alert(1)>',submitter:'测试人员',instance:'测试实例',database:'测试库',created_at:'2026-10-20 00:30'}],pagination:{page,page_size:20,total:null,source_total:42,has_more:page<3,next_page:page<3?page+1:null,scope:'source_page_filtered'}}}};},async approve(id){global.archerySmoke.approvals.push(id);global.archerySmoke.approved=true;return {structuredContent:{status:'success',data:{succeeded:[id],failed:[],unknown:[],remaining:[],results:[{order_id:id,status:'success'}]}}};}})});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir}});
  await app.firstWindow();const errors=[];
  for(const page of app.windows())page.on('pageerror',error=>errors.push(error.message));
  let panel;
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);await panel.locator('#nav-archery').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===1);
  assert.ok(await panel.locator('#home-view').isHidden());assert.ok(await panel.locator('#mail-view').isHidden());
  assert.equal(await panel.locator('.archery-order img').count(),0);assert.match(await panel.locator('#archery-count').textContent(),/本页 1 条/);
  await panel.getByRole('button',{name:'打开工单',exact:true}).click();
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.opened),['https://archery.example.com/detail/566/']);
  await panel.locator('#archery-next').click();await panel.waitForFunction(()=>document.querySelector('#archery-pagination').textContent.includes('第 2 页'));
  assert.match(await panel.locator('#archery-empty').textContent(),/继续查看下一页/);assert.equal(await panel.locator('#archery-next').isDisabled(),false);
  await panel.locator('#archery-previous').click();await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===1);
  await app.evaluate(()=>{global.archerySmoke.fail=true;});await panel.locator('#archery-refresh').click();
  await panel.waitForFunction(()=>!document.querySelector('#archery-error').hidden);
  assert.equal(await panel.locator('.archery-order').count(),1);assert.ok(!(await panel.locator('#archery-error').textContent()).includes('fixture-secret'));
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));assert.ok(pet);
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.archery('snapshot');return 'allowed';}catch{return 'denied';}}),'denied');
  assert.ok(!JSON.stringify(await panel.evaluate(()=>window.whale.snapshot())).includes('测试工单'));
  await app.evaluate(()=>{global.archerySmoke.fail=false;});await panel.locator('#archery-refresh').click();
  fs.mkdirSync(path.join(root,'out'),{recursive:true});await panel.screenshot({path:path.join(root,'out/archery-pending.png'),fullPage:true});
  await panel.getByRole('button',{name:'审核通过',exact:true}).click();
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[]);
  const confirmation=await app.evaluate(()=>global.archerySmoke.confirmations[0]);
  assert.equal(confirmation.defaultId,0);assert.equal(confirmation.cancelId,0);assert.match(confirmation.message,/#566/);
  await app.evaluate(()=>{global.archerySmoke.confirm=true;});
  await panel.getByRole('button',{name:'审核通过',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===0);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[566]);
  await panel.locator('#nav-home').click();assert.ok(await panel.locator('#archery-view').isHidden());
  const count=await app.evaluate(()=>global.archerySmoke.calls.length);
  await panel.waitForTimeout(1400);assert.ok((await app.evaluate(()=>global.archerySmoke.calls.length))>count,'polling continues with the page hidden');
  assert.deepEqual(errors,[]);console.log('Archery UI smoke OK: navigation, background polling, paging, links, per-order confirmation, approval, XSS, errors and IPC isolation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
