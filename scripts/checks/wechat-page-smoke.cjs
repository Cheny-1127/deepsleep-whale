'use strict';
// 仅渲染页面状态：不连接微信或模型，检查首次接入与日常管理的信息层级和主操作。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {defaultClients}=require('../../src/agents/clients.cjs');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-wechat-page-'),url=file=>pathToFileURL(file).href;
const data={status:'connected',storageAvailable:true,enabled:true,account:{id:'work-bot',owner:'owner'},connectionName:'工作微信',selectedConnectionId:'work',contactNames:{owner:'我自己'},connections:[{id:'work',name:'工作微信',account:{id:'work-bot',owner:'owner'},enabled:true,status:'connected'},{id:'personal',name:'个人微信',account:{id:'personal-bot'},enabled:true,status:'connected'}],clients:[{...defaultClients()[0],name:'Ding Codex'}],allowed:['owner'],pending:[],jobs:[],outbox:0,active:null};
const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8').replace('href="style.css"',`href="${url(path.join(root,'src/ui/style.css'))}"`).replace('href="quota-key.css"',`href="${url(path.join(root,'src/ui/quota-key.css'))}"`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script type="module" src="fixture.mjs"></script></body>');
fs.writeFileSync(path.join(dir,'index.html'),html);
fs.writeFileSync(path.join(dir,'fixture.mjs'),`import {createWechatView} from ${JSON.stringify(url(path.join(root,'src/ui/wechat-view.mjs')))};
const data=${JSON.stringify(data)},dialogs=[],actions=[];let confirmResult=false;
window.confirm=message=>{dialogs.push(message);return confirmResult;};
const original=structuredClone(data),states=new Map([['work',structuredClone(data)],['personal',{...structuredClone(data),account:{id:'personal-bot',owner:'personal-owner'},connectionName:'个人微信',selectedConnectionId:'personal'}]]);
function select(id){const connections=data.connections;Object.assign(data,{qr:null},structuredClone(states.get(id)),{connections});}
window.whale={snapshot:async()=>({wechat:data}),wechat:async(name,payload)=>{
  actions.push({name,payload});
  if(name==='discover-clients')return {value:{clients:[],defaults:{},message:'Fixture'}};
  if(name==='select-connection'){states.set(data.selectedConnectionId,structuredClone(data));select(payload);}
  else if(name==='add-connection'){
    states.set(data.selectedConnectionId,structuredClone(data));const id='draft';
    states.set(id,{...structuredClone(original),account:null,enabled:false,status:'disconnected',selectedConnectionId:id,connectionName:'微信 3',jobs:[]});
    data.connections.push({id,name:'微信 3',account:null,status:'disconnected',enabled:false});select(id);
  }else if(name==='enable'){
    if(payload.connectionId!==data.selectedConnectionId)throw Error('wrong scope');
    data.enabled=payload.value;data.status=data.enabled?'connected':'paused';
    Object.assign(data.connections.find(item=>item.id===payload.connectionId),{enabled:data.enabled,status:data.status});
  }else if(name==='forget'){
    if(payload.connectionId!==data.selectedConnectionId)throw Error('wrong scope');
    data.connections=data.connections.filter(item=>item.id!==payload.connectionId);states.delete(payload.connectionId);select(data.connections[0].id);
  }else return {error:'Fixture does not execute this action'};
  return {value:{}};
}};
for(const el of document.querySelector('main').children)el.hidden=el.id!=='wechat-view';
for(const button of document.querySelectorAll('[data-view]')){const selected=button.dataset.view==='wechat';button.classList.toggle('selected',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
const view=createWechatView();window.pageFixture={data,dialogs,actions,confirm:value=>{confirmResult=value;},show:patch=>{Object.assign(data,patch);const current=data.connections.find(item=>item.id===data.selectedConnectionId);if(current)Object.assign(current,{account:data.account,enabled:data.enabled,status:data.status});view.render(data);}};view.render(data);`);
const bootstrap=path.join(dir,'bootstrap.cjs');fs.writeFileSync(bootstrap,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir)});app.whenReady().then(()=>new BrowserWindow({width:1060,height:770,webPreferences:{contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(dir,'index.html'))}));`);
fs.mkdirSync(path.join(root,'out'),{recursive:true});
let app;
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap]});const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>Boolean(window.pageFixture));
  assert.equal(await page.locator('#wechat-login').isHidden(),true);assert.equal(await page.locator('#wechat-forget').isVisible(),true);
  assert.equal(await page.locator('#wechat-toggle').isVisible(),true);
  assert.equal(await page.locator('#wechat-settings-dialog #wechat-account-settings').count(),0,'账号操作直接放在账号列表下面');
  assert.equal(await page.locator('#wechat-tab-account').count(),0,'设置不保留重复入口');
  assert.equal(await page.locator('#wechat-connections button').count(),2);
  assert.match(await page.locator('#wechat-connections').textContent(),/工作微信.*已连接.*个人微信.*已连接/);
  assert.equal(await page.locator('#wechat-settings-dialog').isVisible(),false);
  assert.equal(await page.locator('#wechat-connection-panel').isVisible(),false,'健康连接不重复占用说明区域');
  assert.match(await page.locator('#wechat-empty').textContent(),/发条微信试试.*\/projects.*\/chats/s);
  assert.equal(await page.locator('#wechat-activity').isVisible(),false,'空任务不再重复提示');
  assert.equal(await page.locator('#wechat-feedback').isHidden(),true,'空反馈不占布局空间');
  for(const width of [1060,860]){
    await page.setViewportSize({width,height:770});
    assert.ok(await page.locator('#wechat-task-card').evaluate(el=>el.getBoundingClientRect().bottom<innerHeight),'任务概览位于首屏');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(root,`out/wechat-daily-${width}.png`),fullPage:true});
    if(width===860)await page.locator('.wechat-account-card').screenshot({path:path.join(root,'out/wechat-account-controls.png')});
    await page.locator('#wechat-reconnect').click();assert.match((await page.evaluate(()=>window.pageFixture.dialogs)).at(-1),/工作微信.*停止当前任务/);
    await page.locator('#wechat-forget').click();assert.match((await page.evaluate(()=>window.pageFixture.dialogs)).at(-1),/工作微信.*其他微信/);
    assert.equal(await page.locator('#wechat-settings-dialog').isVisible(),false);
    await page.locator('#wechat-open-settings').click();
    const menu=await page.locator('#wechat-settings-dialog').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=width);
    assert.ok(Math.abs(menu.y-(770-menu.height)/2)<2,'设置窗口应居中，不能继承普通卡片的底部间距');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#wechat-settings-dialog').isVisible(),false);
    assert.equal(await page.locator('#wechat-open-settings').evaluate(el=>el===document.activeElement),true);
  }
  await page.locator('#wechat-toggle').click();
  await page.waitForFunction(()=>!document.getElementById('wechat-toggle').disabled);
  assert.equal(await page.locator('#wechat-toggle').textContent(),'恢复接收');
  assert.equal((await page.evaluate(()=>window.pageFixture.data.connections[1])).enabled,true,'暂停仅影响选中账号');
  assert.equal((await page.evaluate(()=>window.pageFixture.actions)).at(-1).payload.connectionId,'work');
  await page.screenshot({path:path.join(root,'out/wechat-account-paused.png'),fullPage:true});
  await page.locator('#wechat-toggle').click();assert.equal(await page.locator('#wechat-toggle').textContent(),'暂停接收');
  await page.waitForFunction(()=>!document.getElementById('wechat-toggle').disabled);
  await page.evaluate(()=>window.pageFixture.show({status:'disconnected',enabled:false}));
  assert.equal(await page.locator('#wechat-status').textContent(),'已暂停','重启后的停收账号与恢复操作保持一致');
  await page.evaluate(()=>window.pageFixture.show({status:'expired'}));
  assert.equal(await page.locator('#wechat-login').isVisible(),true);assert.equal(await page.locator('#wechat-login').textContent(),'重新扫码');assert.equal(await page.locator('#wechat-toggle').isHidden(),true);
  await page.evaluate(()=>window.pageFixture.show({enabled:true,status:'connected',clients:[]}));
  assert.match(await page.locator('#wechat-connection-state').textContent(),/尚未启用客户端/);
  assert.equal(await page.locator('#wechat-setup-client').isVisible(),true);
  await page.evaluate(clients=>{
    const fixture=window.pageFixture;fixture.data.connections[0].taskCount=2;fixture.data.connections[0].outboxCount=1;
    fixture.data.connections[1].status='expired';fixture.data.connections[1].pendingCount=1;
    fixture.show({clients,outbox:1,error:'结果投递失败，请重试。',active:{id:'active'},jobs:[{id:'active',state:'approval',sender:'owner',startedAt:Date.now(),chat:{key:'chat',name:'排查项目',project:'Architecture',clientName:'Ding Codex'}},{id:'queued',state:'queued',sender:'owner',chat:{key:'chat',name:'排查项目'}}]});
  },data.clients);
  assert.match(await page.locator('#wechat-connections').textContent(),/2 个任务.*1 条待投递.*个人微信.*登录失效.*1 位待授权/s);
  assert.match(await page.locator('#wechat-activity').textContent(),/等待审批.*我自己.*1 个任务排队中.*1 条消息待投递/);
  assert.equal(await page.locator('#wechat-retry').isVisible(),true);assert.equal(await page.locator('#wechat-login').isHidden(),true,'投递失败不建议重新扫码');
  await page.screenshot({path:path.join(root,'out/wechat-daily-attention.png'),fullPage:true});
  await page.evaluate(()=>{const fixture=window.pageFixture;fixture.data.connections[1].status='connected';fixture.data.connections[1].pendingCount=0;fixture.show({pending:['new-contact']});});
  await page.locator('#wechat-open-settings').click();assert.equal(await page.locator('#wechat-contacts').isVisible(),true,'待授权入口直接进入联系人');await page.keyboard.press('Escape');
  await page.evaluate(()=>window.pageFixture.show({active:null,jobs:[],outbox:0,error:'',status:'connected',pending:[]}));
  await page.locator('#wechat-add-connection').click();
  assert.equal(await page.locator('#wechat-login').isVisible(),true);assert.equal(await page.locator('#wechat-login').textContent(),'扫码连接');
  assert.equal(await page.locator('#wechat-remove-draft').isVisible(),true,'未扫码的试用连接必须有直接删除入口');
  assert.equal(await page.locator('#wechat-task-card').isVisible(),false);
  await page.locator('#wechat-remove-draft').click();
  assert.equal(await page.locator('#wechat-connections button').count(),3,'取消确认保留连接');
  assert.match((await page.evaluate(()=>window.pageFixture.dialogs)).at(-1),/尚未扫码.*微信 3.*其他微信/);
  await page.evaluate(()=>window.pageFixture.confirm(true));await page.locator('#wechat-remove-draft').click();
  await page.waitForFunction(()=>document.querySelectorAll('#wechat-connections button').length===2);
  assert.equal(await page.locator('#wechat-task-scope').textContent(),'工作微信');
  assert.equal((await page.evaluate(()=>window.pageFixture.data.connections)).every(item=>item.enabled),true);
  // 二维码展示中也可删除，且删除始终携带目标连接 ID。
  await page.locator('#wechat-add-connection').click();
  await page.evaluate(()=>window.pageFixture.show({status:'logging-in',qr:{image:'data:image/png;base64,iVBORw0KGgo=',status:'等待扫码'}}));
  assert.equal(await page.locator('#wechat-remove-draft').isVisible(),true);assert.equal(await page.locator('#wechat-toggle').isVisible(),false);
  await page.screenshot({path:path.join(root,'out/wechat-draft-removal.png'),fullPage:true});
  await page.locator('#wechat-remove-draft').click();await page.waitForFunction(()=>document.querySelectorAll('#wechat-connections button').length===2);
  assert.equal((await page.evaluate(()=>window.pageFixture.actions.filter(item=>item.name==='forget'))).at(-1).payload.connectionId,'draft');
  await page.locator('#wechat-open-settings').click();await page.locator('#wechat-tab-clients').click();
  await page.locator('#wechat-tab-clients').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#wechat-tab-contacts').getAttribute('aria-selected'),'true');
  await page.screenshot({path:path.join(root,'out/wechat-settings-contacts.png'),fullPage:true});await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);console.log('WeChat page UI OK: visible multi-account states, task-first guidance, settings dialog/focus/tabs, paused/expired/setup states, unscanned draft deletion/cancel/QR flow; 860/1060px');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
