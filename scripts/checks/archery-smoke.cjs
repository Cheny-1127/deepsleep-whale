'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-archery-ui-');
const bootstrap=path.join(dir,'bootstrap.cjs');
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,id==='archery']))));
fs.writeFileSync(path.join(dir,'config.toml'),'[mcp_servers.archery]\ncommand="/synthetic/archery-mcp"\n');
// 仅隔离测试进程替换 Archery 适配器，不读取真实账号、不连接生产服务。
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {shell,Notification,dialog}=require('electron');Notification.isSupported=()=>false;
// 测试专用密钥只用于合成 SQL，跨隔离进程重启验证密文缓存，不访问系统钥匙串。
const crypto=require('node:crypto'),cacheModule=require(${JSON.stringify(path.join(root,'src/channels/archery-cache.cjs'))}),createCache=cacheModule.createArcheryCache;
const testStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'test',encryptString(text){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.alloc(32,7),iv),body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,body,cipher.getAuthTag()]);},decryptString(bytes){const cipher=crypto.createDecipheriv('aes-256-gcm',Buffer.alloc(32,7),bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString('utf8');}};
cacheModule.createArcheryCache=options=>createCache({...options,safeStorage:testStorage});
global.archerySmoke={calls:[],details:[],opened:[],approvals:[],rejections:[],orderId:566,rejected:false,executions:[],executed:false,extraReady:false,confirmations:[],largeConfirmations:[],largeConfirm:false,largeDetail:false,failDetail:false,deferDetail:false,status:'workflow_manreviewing',confirm:false,fail:false,approved:false};shell.openExternal=async url=>global.archerySmoke.opened.push(url);
dialog.showMessageBox=async options=>{if(options.title==='展开完整工单详情'){global.archerySmoke.largeConfirmations.push(options);return {response:global.archerySmoke.largeConfirm?1:0};}global.archerySmoke.confirmations.push(options);return {response:global.archerySmoke.confirm?1:0};};
const channel=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),create=channel.createArcheryPending;
channel.createArcheryPending=options=>create({...options,intervalMs:1000,
readConfig:()=>({fingerprint:'synthetic-account',baseUrl:'https://archery.example.com',canApprove:true,canReject:true,canDetail:true,canExecute:true,canList:true}),
createClient:()=>({close(){},async pending(page,{mode='approve'}={}){global.archerySmoke.calls.push(page);if(global.archerySmoke.fail)throw Error('fixture-secret');
const items=page===2||global.archerySmoke.rejected||global.archerySmoke.executed||(mode==='approve'?global.archerySmoke.approved:global.archerySmoke.status!=='workflow_review_pass')?[]:[{order_id:global.archerySmoke.orderId,order_type:'work_order',title:'测试工单 <img src=x onerror=alert(1)>',submitter:'测试人员',instance:'测试实例',database:'测试库',status:global.archerySmoke.status,created_at:'2026-10-20 00:30'}];if(mode==='execute'&&global.archerySmoke.extraReady)items.push({order_id:567,order_type:'work_order',title:'同时待执行的另一笔工单',status:'workflow_review_pass'});return {structuredContent:{status:'success',data:{items,pagination:{page,page_size:20,total:mode==='execute'?42:null,source_total:42,has_more:page<3,next_page:page<3?page+1:null,scope:mode==='execute'?'matching_orders':'source_page_filtered'}}}};},async detail(id,{allowLarge}){
global.archerySmoke.details.push({id,allowLarge});if(global.archerySmoke.deferDetail)await new Promise(resolve=>global.archerySmoke.releaseDetail=resolve);if(global.archerySmoke.failDetail)throw Error('fixture-secret');
if(global.archerySmoke.largeDetail&&!allowLarge)return {structuredContent:{status:'needs_confirmation',data:{order_id:id,order_type:'work_order',response_bytes:40000}}};
return {structuredContent:{status:'success',data:{workflow_id:id,workflow:{id,is_offline_export:0,status:'workflow_manreviewing',group_name:'测试组',db_name:'测试库'},sql_content:'SELECT * FROM fixture_table; -- <img src=x onerror=alert(1)>'+String.fromCharCode(10)+('SELECT '+ 'fixture_value,'.repeat(40)+'1;'+String.fromCharCode(10)).repeat(30),review_content:[{message:'审核检查完成'}],execute_result:'尚未执行'}}};
},async approve(id){global.archerySmoke.approvals.push(id);global.archerySmoke.approved=true;global.archerySmoke.status='workflow_review_pass';return {structuredContent:{status:'success',data:{succeeded:[id],failed:[],unknown:[],remaining:[],results:[{order_id:id,status:'success'}]}}};},async reject(id,{remark}){global.archerySmoke.rejections.push({id,remark});global.archerySmoke.rejected=true;global.archerySmoke.status='workflow_abort';return {structuredContent:{status:'success',data:{succeeded:[id],failed:[],unknown:[],remaining:[],results:[{order_id:id,status:'success'}]}}};},async execute(id){global.archerySmoke.executions.push(id);global.archerySmoke.executed=true;return {structuredContent:{status:'success',data:{succeeded:[id],failed:[],unknown:[],remaining:[],results:[{order_id:id,status:'success'}]}}};}})});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;
const launch=()=>electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir}});
(async()=>{
  app=await launch();
  await app.firstWindow();const errors=[];
  for(const page of app.windows())page.on('pageerror',error=>errors.push(error.message));
  let panel;
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);await panel.locator('#nav-archery').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===1);
  assert.ok(await panel.locator('#home-view').isHidden());assert.ok(await panel.locator('#mail-view').isHidden());
  assert.equal(await panel.locator('.archery-order img').count(),0);assert.match(await panel.locator('#archery-count').textContent(),/本页 1 条/);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.details),[]);
  const reject=panel.locator('.archery-actions').getByRole('button',{name:'审核拒绝',exact:true});
  for(const width of [760,1060]){
    await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(640,600);win.setSize(width,900);},width);
    const layout=await panel.locator('.archery-order').evaluate(row=>{
      const buttons=[...row.querySelectorAll('.archery-actions button')].map(b=>b.getBoundingClientRect());
      return {sameHeight:buttons[0].height===buttons[1].height,aligned:buttons[0].top===buttons[1].top,separate:buttons[0].right<=buttons[1].left,overflow:document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth};
    });
    assert.deepEqual(layout,{sameHeight:true,aligned:true,separate:true,overflow:false});
    await panel.locator('.archery-message').hover();
    assert.equal(await panel.locator('.archery-order').evaluate(row=>getComputedStyle(row).backgroundColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(row.querySelector('.archery-message')).backgroundColor==='rgba(0, 0, 0, 0)'),true,'整行统一高亮，摘要不再形成独立色块');
    await panel.screenshot({path:path.join(root,`out/archery-review-actions-${width}.png`),fullPage:true});
  }
  if(process.env.WHALE_ARCHERY_LAYOUT_ONLY==='1'){
    await panel.locator('.archery-message').click();await panel.locator('.archery-detail pre').first().waitFor();
    await panel.locator('#archery-heading').hover();
    assert.equal(await panel.locator('.archery-order').evaluate(row=>getComputedStyle(row).backgroundColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(row.querySelector('.archery-message')).backgroundColor==='rgba(0, 0, 0, 0)'),true,'展开后摘要与审核按钮继续共用整行底色');
    await panel.screenshot({path:path.join(root,'out/archery-unified-order-expanded.png'),fullPage:true});
    await panel.locator('.archery-message').click();assert.equal(await panel.locator('.archery-detail').isHidden(),true);
    assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[]);assert.deepEqual(await app.evaluate(()=>global.archerySmoke.rejections),[]);
    assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[]);assert.deepEqual(errors,[]);
    console.log('Archery layout OK: unified row background on hover and expansion, 760/1060 widths, aligned actions, no overflow, expand/collapse, hidden isolated window');return;
  }
  await reject.click();const rejection=panel.locator('.ui-confirm-dialog');await rejection.waitFor({state:'visible'});
  const rejectConfirm=rejection.getByRole('button',{name:'审核拒绝',exact:true});
  await rejectConfirm.click();assert.equal(await rejection.isVisible(),true,'未填原因不能提交');
  await rejection.getByRole('textbox',{name:'拒绝原因',exact:true}).fill('   ');await rejectConfirm.click();
  assert.equal(await rejection.isVisible(),true,'空白原因不能提交');assert.deepEqual(await app.evaluate(()=>global.archerySmoke.rejections),[]);
  await rejection.getByRole('textbox',{name:'拒绝原因',exact:true}).fill('请补充回滚方案');
  await rejection.getByRole('button',{name:'取消',exact:true}).click();await rejection.waitFor({state:'detached'});
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.rejections),[],'取消拒绝不调用 MCP');
  await panel.waitForFunction(()=>!document.querySelector('.archery-actions button').disabled);
  await panel.locator('.archery-actions').getByRole('button',{name:'审核通过',exact:true}).click();
  const initialConfirmation=panel.locator('.ui-confirm-dialog');await initialConfirmation.waitFor({state:'visible'});
  assert.equal(await initialConfirmation.locator('pre').count(),0);assert.deepEqual(await app.evaluate(()=>global.archerySmoke.details),[],'未点击获取详情，不调用接口');
  assert.equal(await initialConfirmation.locator('.ui-confirm-actions .outline').evaluate(el=>el===document.activeElement),true);
  await app.evaluate(()=>{global.archerySmoke.deferDetail=true;});
  await initialConfirmation.getByRole('button',{name:'获取详情',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelector('.ui-confirm-actions .primary').disabled);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[],'读取详情不触发审核');
  assert.equal(await initialConfirmation.locator('.ui-confirm-actions .outline').isEnabled(),true);
  await app.evaluate(()=>{global.archerySmoke.deferDetail=false;global.archerySmoke.releaseDetail();});
  await panel.waitForFunction(()=>document.querySelector('.archery-approval-detail pre')?.textContent.includes('fixture_table'));
  assert.equal(await initialConfirmation.locator('pre').count(),2);assert.equal(await initialConfirmation.locator('img').count(),0);
  await initialConfirmation.locator('.ui-confirm-actions .outline').click();await initialConfirmation.waitFor({state:'detached'});
  await panel.waitForFunction(()=>!document.querySelector('.archery-actions button').disabled);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.details),[{id:566,allowLarge:false}]);
  await panel.locator('.archery-message').click();await panel.waitForFunction(()=>document.querySelector('.archery-detail pre')?.textContent.includes('fixture_table'));
  assert.equal(await panel.locator('.archery-detail pre').count(),2);assert.equal(await panel.locator('.archery-detail img').count(),0);
  assert.doesNotMatch(await panel.locator('.archery-detail').textContent(),/审核信息|审核检查完成/);assert.match(await panel.locator('.archery-detail').textContent(),/尚未执行/);
  await panel.locator('.archery-message').click();assert.equal(await panel.locator('.archery-detail').isHidden(),true);
  await panel.locator('.archery-message').click();assert.equal((await app.evaluate(()=>global.archerySmoke.details)).length,1,'收起后展开不重复请求');
  assert.equal(await panel.getByRole('button',{name:/在浏览器打开|查看详情|打开工单/}).count(),0);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.opened),[]);
  await panel.locator('#archery-next').click();await panel.waitForFunction(()=>document.querySelector('#archery-pagination').textContent.includes('第 2 页'));
  assert.match(await panel.locator('#archery-empty').textContent(),/继续查看下一页/);assert.equal(await panel.locator('#archery-next').isDisabled(),false);
  await panel.locator('#archery-previous').click();await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===1);
  await panel.locator('.archery-message').click();await panel.waitForFunction(()=>document.querySelector('.archery-detail pre'));
  assert.equal((await app.evaluate(()=>global.archerySmoke.details)).length,1,'翻页后复用详情缓存');
  await app.evaluate(()=>{global.archerySmoke.status='workflow_review_pass';});await panel.locator('#archery-refresh').click();
  await panel.waitForFunction(()=>document.querySelector('.archery-detail-meta').textContent.includes('审核通过'));
  assert.equal(await panel.locator('.archery-detail').isHidden(),false);assert.equal((await app.evaluate(()=>global.archerySmoke.details)).length,1,'更新状态不重复读取 SQL');
  await app.evaluate(()=>{global.archerySmoke.failDetail=true;});await panel.getByRole('button',{name:'重新加载详情',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelector('.archery-detail').textContent.includes('读取工单详情失败'));
  assert.equal(await panel.locator('.archery-detail pre').count(),2,'重载失败保留缓存 SQL');
  assert.ok(!(await panel.locator('.archery-detail').textContent()).includes('fixture-secret'));
  await app.evaluate(()=>{global.archerySmoke.failDetail=false;global.archerySmoke.largeDetail=true;});await panel.getByRole('button',{name:'重新加载详情',exact:true}).click();
  await panel.getByRole('button',{name:'加载完整详情',exact:true}).waitFor();
  await panel.getByRole('button',{name:'加载完整详情',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelector('.archery-detail').textContent.includes('完整加载前'));
  assert.equal((await app.evaluate(()=>global.archerySmoke.details)).some(call=>call.allowLarge),false,'取消确认不能请求完整内容');
  await app.evaluate(()=>{global.archerySmoke.largeConfirm=true;});await panel.getByRole('button',{name:'加载完整详情',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelector('.archery-detail pre')?.textContent.includes('fixture_table'));
  assert.deepEqual((await app.evaluate(()=>global.archerySmoke.details)).at(-1),{id:566,allowLarge:true});
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[],'展开详情不触发审批');
  await app.evaluate(()=>{global.archerySmoke.fail=true;});await panel.locator('#archery-refresh').click();
  await panel.waitForFunction(()=>!document.querySelector('#archery-error').hidden);
  assert.equal(await panel.locator('.archery-order').count(),1);assert.ok(!(await panel.locator('#archery-error').textContent()).includes('fixture-secret'));
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));assert.ok(pet);
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.archery('snapshot');return 'allowed';}catch{return 'denied';}}),'denied');
  assert.ok(!JSON.stringify(await panel.evaluate(()=>window.whale.snapshot())).includes('测试工单'));
  await app.evaluate(()=>{global.archerySmoke.fail=false;global.archerySmoke.largeDetail=false;});await panel.locator('#archery-refresh').click();
  await panel.waitForFunction(()=>!document.querySelector('.archery-message').disabled);
  if(await panel.locator('.archery-detail').isHidden())await panel.locator('.archery-message').click();
  await panel.waitForFunction(()=>document.querySelector('.archery-detail pre')?.textContent.includes('fixture_table'));
  fs.mkdirSync(path.join(root,'out'),{recursive:true});
  for(const width of [760,1060]){
    await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(640,600);win.setSize(width,1000);},width);
    assert.equal(await panel.evaluate(()=>document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth),false);
    await panel.screenshot({path:path.join(root,`out/archery-detail-${width}.png`),fullPage:true});
  }
  const cacheFile=path.join(dir,'archery-details.enc');assert.ok(fs.existsSync(cacheFile));assert.equal(fs.readFileSync(cacheFile).includes(Buffer.from('fixture_table')),false);
  await app.close();app=await launch();await app.firstWindow();panel=null;
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);panel.on('pageerror',error=>errors.push(error.message));await panel.locator('#nav-archery').click();
  await panel.waitForFunction(()=>document.querySelector('.archery-message')&&!document.querySelector('.archery-message').disabled);
  await panel.locator('.archery-message').click();await panel.waitForFunction(()=>document.querySelector('.archery-detail pre')?.textContent.includes('fixture_table'));
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.details),[],'重启后直接显示加密缓存，不调用详情工具');
  const approve=panel.locator('.archery-actions').getByRole('button',{name:'审核通过',exact:true});
  await approve.click();const confirmation=panel.locator('.ui-confirm-dialog');await confirmation.waitFor({state:'visible'});
  assert.match(await confirmation.textContent(),/#566.*测试工单/s);assert.match(await confirmation.textContent(),/提交人：测试人员.*实例：测试实例.*数据库：测试库/s);
  assert.doesNotMatch(await confirmation.textContent(),/仅审核这一笔工单，不请求执行 SQL/);assert.equal(await confirmation.locator('img').count(),0);
  assert.match(await confirmation.locator('.archery-approval-detail').textContent(),/fixture_table/);assert.equal(await confirmation.locator('pre').count(),2);
  assert.equal(await confirmation.getByRole('button',{name:'获取详情',exact:true}).count(),0);assert.deepEqual(await app.evaluate(()=>global.archerySmoke.details),[],'重启后的缓存直接进入审核弹窗，不请求详情');
  assert.equal(await confirmation.locator('.ui-confirm-actions .outline').evaluate(el=>el===document.activeElement),true,'默认聚焦取消');
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[],'弹窗展示不审批');
  for(const width of [760,1060]){
    await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(640,600);win.setSize(width,900);},width);
    assert.equal(await confirmation.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),true);
    assert.equal(await confirmation.locator('pre').first().evaluate(el=>el.scrollHeight>el.clientHeight),true,'长 SQL 在详情区内滚动');
    assert.equal(await confirmation.locator('.ui-confirm-actions .primary').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true,'审核按钮保持可见');
    await panel.screenshot({path:path.join(root,`out/archery-confirmation-${width}.png`),fullPage:true});
  }
  await panel.keyboard.press('Enter');await confirmation.waitFor({state:'detached'});await panel.waitForFunction(()=>!document.querySelector('.archery-actions button').disabled);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[],'默认 Enter 取消');
  assert.equal(await panel.locator('.archery-detail').isHidden(),false,'取消审核不收起详情');
  await approve.click();await confirmation.waitFor({state:'visible'});await panel.keyboard.press('Escape');await confirmation.waitFor({state:'detached'});
  await panel.waitForFunction(()=>!document.querySelector('.archery-actions button').disabled);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[],'Esc 取消');
  await approve.click();await confirmation.waitFor({state:'visible'});
  await panel.evaluate(()=>document.querySelector('#nav-home').click());await confirmation.waitFor({state:'detached'});
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[],'切页取消');
  await panel.locator('#nav-archery').click();await panel.waitForFunction(()=>!document.querySelector('.archery-actions button').disabled);
  await approve.click();await confirmation.waitFor({state:'visible'});await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  await confirmation.waitFor({state:'detached'});await panel.waitForFunction(()=>!document.querySelector('.archery-actions button').disabled);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[],'点击取消不审批');
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.confirmations),[],'审核不使用系统对话框');
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.opened),[]);
  // 同一屏直接同时显示审核与执行，用户无需先选择操作类型。
  await app.evaluate(()=>{global.archerySmoke.extraReady=true;});await panel.locator('#archery-refresh').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===2);
  assert.equal(await panel.locator('.archery-actions').getByRole('button',{name:'审核通过',exact:true}).count(),1);
  assert.equal(await panel.locator('.archery-actions').getByRole('button',{name:'执行',exact:true}).count(),1);
  assert.equal(await panel.locator('[id^="archery-mode-"]').count(),0);
  for(const width of [760,1060]){
    await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html'));win.setSize(width,900);},width);
    assert.equal(await panel.evaluate(()=>document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth),false);
    await panel.screenshot({path:path.join(root,`out/archery-unified-${width}.png`),fullPage:true});
  }
  await app.evaluate(()=>{global.archerySmoke.extraReady=false;});await panel.locator('#archery-refresh').click();
  await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===1);
  await panel.locator('.archery-message').click();await panel.waitForFunction(()=>document.querySelector('.archery-detail pre'));
  await panel.evaluate(()=>{window.originalPendingRow=document.querySelector('.archery-order');});
  await approve.click();await confirmation.waitFor({state:'visible'});
  await confirmation.getByRole('button',{name:'审核通过',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelector('.archery-actions button')?.textContent==='执行'&&!document.querySelector('.archery-actions button').disabled);
  assert.equal(await panel.evaluate(()=>document.querySelector('.archery-order')===window.originalPendingRow),true,'状态变化保留原行');
  assert.equal(await panel.locator('.archery-detail').isHidden(),false,'审核后保留已展开详情');
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[566]);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.executions),[],'审核通过绝不连带执行');
  await panel.waitForFunction(()=>document.querySelector('.archery-actions button')?.textContent==='执行'&&!document.querySelector('.archery-actions button').disabled);
  assert.equal(await panel.getByRole('button',{name:'审核通过',exact:true}).count(),0);
  assert.match(await panel.locator('#archery-pagination').textContent(),/合并展示/);
  await panel.waitForFunction(()=>document.querySelector('.archery-detail-meta')?.textContent.includes('审核通过'));
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.details),[],'审核后原行继续复用详情缓存');
  const execute=panel.locator('.archery-actions').getByRole('button',{name:'执行',exact:true});
  await execute.click();await confirmation.waitFor({state:'visible'});
  assert.match(await confirmation.locator('h2').textContent(),/执行工单 #566/);
  assert.match(await confirmation.textContent(),/请求执行这一笔工单的 SQL/);
  assert.match(await confirmation.locator('.archery-approval-detail').textContent(),/fixture_table/);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.executions),[],'执行弹窗展示不提交');
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();await confirmation.waitFor({state:'detached'});
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.executions),[],'取消执行不调用 MCP');
  await panel.waitForFunction(()=>!document.querySelector('.archery-actions button').disabled);
  for(const width of [760,1060]){
    await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html'));win.setSize(width,900);},width);
    assert.equal(await panel.evaluate(()=>document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth),false);
    await panel.screenshot({path:path.join(root,`out/archery-processing-${width}.png`),fullPage:true});
  }
  await execute.click();await confirmation.waitFor({state:'visible'});
  await confirmation.getByRole('button',{name:'执行',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===0);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.executions),[566]);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[566]);
  assert.match(await panel.locator('#archery-feedback').textContent(),/执行请求已受理.*最终结果/);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.confirmations),[],'审核和执行都使用应用内弹窗');

  await app.evaluate(()=>{global.archerySmoke.orderId=568;global.archerySmoke.executed=false;global.archerySmoke.approved=false;global.archerySmoke.status='workflow_manreviewing';});
  const currentReject=panel.locator('.archery-actions').getByRole('button',{name:'审核拒绝',exact:true});
  await panel.locator('#archery-refresh').click();await currentReject.waitFor({state:'visible'});
  await currentReject.click();await confirmation.waitFor({state:'visible'});
  assert.match(await confirmation.locator('h2').textContent(),/审核拒绝工单 #568/);
  await confirmation.getByRole('textbox',{name:'拒绝原因',exact:true}).fill('  请补充回滚方案  ');
  await panel.screenshot({path:path.join(root,'out/archery-reject-confirmation.png'),fullPage:true});
  await confirmation.getByRole('button',{name:'审核拒绝',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelectorAll('.archery-order').length===0);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.rejections),[{id:568,remark:'请补充回滚方案'}]);
  assert.deepEqual(await app.evaluate(()=>global.archerySmoke.approvals),[566]);assert.deepEqual(await app.evaluate(()=>global.archerySmoke.executions),[566]);
  assert.match(await panel.locator('#archery-feedback').textContent(),/已审核拒绝/);
  await panel.locator('#nav-home').click();assert.ok(await panel.locator('#archery-view').isHidden());
  const count=await app.evaluate(()=>global.archerySmoke.calls.length);
  await panel.waitForTimeout(1400);assert.ok((await app.evaluate(()=>global.archerySmoke.calls.length))>count,'polling continues with the page hidden');
  assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[]);
  assert.deepEqual(errors,[]);console.log('Archery UI smoke OK: SQL/results without review, cached paging and restart, status-only refresh, explicit reload, large-content consent, hidden layouts, in-app approval with on-demand details and cached preview, Enter/Esc/navigation cancellation, unified review/execution list with mixed actions and automatic verified status transition, one-order approval, reason-required rejection and execution with separate confirmation, cancellation, cached SQL and IPC isolation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
