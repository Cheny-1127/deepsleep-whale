'use strict';
// 真实 Electron 窗口和 IPC 使用合成数据验证，不读取或调用线上账号。
const {_electron:electron} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'../..'), dir = fs.mkdtempSync('/tmp/whale-keys-ui-');
const bootstrap = path.join(dir,'bootstrap.cjs'), tokenFile = path.join(dir,'token');
fs.writeFileSync(tokenFile,'synthetic-admin-secret',{mode:0o600});
fs.writeFileSync(bootstrap,`const {Notification}=require('electron');Notification.isSupported=()=>false;
const archery=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),createArchery=archery.createArcheryPending;
archery.createArcheryPending=options=>createArchery({...options,readConfig:()=>{throw Error('isolated');}});
const quota=require(${JSON.stringify(path.join(root,'src/channels/quota-accounts.cjs'))}),createQuota=quota.createQuotaPanel;
quota.createQuotaPanel=options=>createQuota({...options,fetchImpl:async()=>({ok:true,json:async()=>({data:{items:[],pages:1}})})});
const groups=require(${JSON.stringify(path.join(root,'src/channels/quota-group-usage.cjs'))}),createGroups=groups.createGroupUsage;
groups.createGroupUsage=options=>createGroups({...options,fetchImpl:async url=>({ok:true,json:async()=>({data:url.includes('/groups/all')?[{id:13,name:'订阅 A'},{id:14,name:'订阅 B'}]:{users:[{user_id:9,email:'one@example.com',actual_cost:0.7}]}})})});
global.keySmoke={calls:[],fail:false};
const keys=require(${JSON.stringify(path.join(root,'src/channels/quota-key-usage.cjs'))}),createKeys=keys.createKeyUsage;
keys.createKeyUsage=options=>createKeys({...options,fetchImpl:async(url,request)=>{
global.keySmoke.calls.push({path:new URL(url).pathname,body:request.body});
const endpoint=new URL(url);
if(endpoint.pathname.endsWith('/users'))return {ok:true,json:async()=>({data:{items:[{id:9,email:'one@example.com'},{id:10,email:'two@example.com'}],total:2}})};
if(endpoint.pathname.endsWith('/api-keys')){const owner=Number(endpoint.pathname.split('/').at(-2));return {ok:true,json:async()=>({data:{items:(owner===9?[1,2,3]:[4]).map(id=>({id,user_id:owner,name:id===1?'<img src=x onerror=alert(1)>':'Key '+id,group_id:id===3?14:13,group:{name:id===3?'订阅 B':'订阅 A'},status:id===2?'inactive':'active',key:'sk-secret-never-render'})),total:owner===9?3:1}})};}
if(global.keySmoke.fail)throw Error('synthetic-admin-secret');
return {ok:true,json:async()=>({data:{stats:Object.fromEntries(JSON.parse(request.body).api_key_ids.map(id=>[id,{today_actual_cost:id===3?0.4:id/10,total_actual_cost:999}]))}})};
}});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;
(async () => {
  const errors = [];
  async function launch() {
    app = await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_QUOTA_TOKEN_FILE:tokenFile}});
    app.on('window',page => page.on('pageerror',error => errors.push(error.message)));
    await app.firstWindow();let panel;
    for (let i=0;i<100;i++) {
      panel = app.windows().find(page => page.url().endsWith('/index.html'));if (panel) break;
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.ok(panel);
    await app.evaluate(({BrowserWindow}) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL().endsWith('/pet.html')) win.hide();
        if (win.webContents.getURL().endsWith('/index.html')) {win.show();win.focus();win.setSize(1060,1000);}
      }
    });
    await panel.locator('#nav-quota').click();return panel;
  }
  let panel = await launch();
  const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
  await assert.rejects(pet.evaluate(() => window.whale.quotaGroup('keys-search','')),/仅允许在小屋/);
  const batches = () => app.evaluate(() => global.keySmoke.calls.filter(call => call.path.endsWith('/api-keys-usage')));
  assert.equal((await batches()).length,0);
  await panel.locator('#quota-key-button').click();await panel.getByRole('option',{name:'one@example.com #9',exact:true}).click();
  await panel.waitForFunction(() => document.getElementById('quota-key-summary').textContent.includes('$0.7000'));
  assert.equal((await batches()).length,1);assert.deepEqual(JSON.parse((await batches())[0].body),{api_key_ids:[1,2,3]});
  assert.equal(await panel.locator('#quota-key-list tr').count(),5);
  assert.equal(await panel.locator('#quota-key-list img').count(),0);
  assert.ok((await panel.locator('#quota-key-list').textContent()).includes('<img src=x onerror=alert(1)>'));
  const groupA = () => panel.getByRole('button',{name:'订阅 A · 2 个 Key',exact:true});
  const groupB = () => panel.getByRole('button',{name:'订阅 B · 1 个 Key',exact:true});
  await groupA().click();
  assert.equal(await groupA().getAttribute('aria-expanded'),'false');
  assert.equal(await panel.locator('#quota-key-list .quota-key-item:visible').count(),1);
  assert.equal(await groupB().getAttribute('aria-expanded'),'true');
  assert.ok((await panel.locator('#quota-key-summary').textContent()).includes('$0.7000'));
  assert.ok((await groupA().locator('xpath=../..').textContent()).includes('$0.3000'));
  await groupA().press('Enter');
  assert.equal(await panel.locator('#quota-key-list .quota-key-item:visible').count(),3);
  await groupA().press('Space');
  assert.equal(await panel.locator('#quota-key-list .quota-key-item:visible').count(),1);
  assert.equal((await batches()).length,1,'分组折叠不请求接口');
  await panel.locator('#quota-key-toggle').click();
  assert.equal(await panel.locator('#quota-key-body').isVisible(),false);
  assert.equal(await panel.locator('#quota-key-tools').isVisible(),false);
  assert.ok((await panel.locator('#quota-key-collapsed-summary').textContent()).includes('$0.7000'));
  assert.equal(await panel.locator('#quota-key-collapsed-summary').isVisible(),true);
  assert.equal(await panel.locator('#quota-group-toggle').isVisible(),true);
  await panel.locator('.quota-key-card').screenshot({path:'/tmp/whale-keys-card-collapsed.png'});
  await panel.locator('#quota-key-toggle').press('Enter');
  assert.equal(await panel.locator('#quota-key-body').isVisible(),true);
  assert.equal(await groupA().getAttribute('aria-expanded'),'false','整个区块展开后保留组内折叠');
  assert.equal((await batches()).length,1,'整个消费区块折叠不请求接口');
  const snapshot = (await panel.evaluate(() => window.whale.quotaGroup('keys-snapshot'))).value;
  assert.ok(!JSON.stringify(snapshot).includes('secret'));assert.equal(snapshot.user.id,9);
  const ranking = (await panel.evaluate(() => window.whale.quotaGroup('snapshot'))).value;
  await panel.locator('#quota-key-button').click();await panel.locator('#quota-key-search').fill('two');
  await panel.getByRole('option',{name:'two@example.com #10',exact:true}).click();
  await panel.waitForFunction(() => document.getElementById('quota-key-summary').textContent.includes('1 个 Key'));
  assert.equal((await batches()).length,2);assert.ok(!(await panel.locator('#quota-key-list').textContent()).includes('Key 2'));
  assert.equal(await panel.locator('.quota-key-group-toggle').getAttribute('aria-expanded'),'true','不同账号折叠状态独立');
  assert.equal((await panel.evaluate(() => window.whale.quotaGroup('snapshot'))).value.groupId,ranking.groupId);
  await panel.locator('#quota-key-button').click();await panel.getByRole('option',{name:'one@example.com #9',exact:true}).click();
  await panel.waitForFunction(() => document.getElementById('quota-key-summary').textContent.includes('3 个 Key'));
  assert.equal((await batches()).length,2,'同账号重新选择命中缓存');
  assert.equal(await groupA().getAttribute('aria-expanded'),'false','切回账号保留折叠状态');
  await app.evaluate(() => {global.keySmoke.fail = true;});await panel.locator('#quota-key-refresh').click();
  await panel.waitForFunction(() => !document.getElementById('quota-key-refresh').disabled);
  assert.equal(await panel.locator('#quota-key-error').isVisible(),true);assert.equal(await panel.locator('#quota-key-list tr').count(),5);
  assert.ok(!(await panel.locator('#quota-key-error').textContent()).includes('secret'));
  await app.evaluate(() => {global.keySmoke.fail = false;});await panel.locator('#quota-key-refresh').click();
  await panel.waitForFunction(() => !document.getElementById('quota-key-refresh').disabled);
  assert.equal(await panel.locator('#quota-key-error').isVisible(),false);
  assert.equal(await groupA().getAttribute('aria-expanded'),'false','刷新保留折叠状态');
  await panel.locator('.quota-key-card').screenshot({path:'/tmp/whale-keys-groups-collapsed.png'});
  await groupA().click();
  await panel.locator('#quota-group-toggle').click();
  await panel.waitForFunction(() => document.getElementById('quota-group-body').hidden);
  assert.equal(await panel.locator('#quota-key-table').isVisible(),true,'独立列表不随用户排行折叠');
  assert.equal(await panel.locator('#quota-group-tools').isVisible(),false);
  for (const width of [860,1060]) {
    await app.evaluate(({BrowserWindow},width) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html')).setSize(width,1000),width);
    const card = panel.locator('.quota-key-card');await card.scrollIntoViewIfNeeded();
    await card.screenshot({path:`/tmp/whale-keys-${width}.png`});
    assert.equal(await card.evaluate(element => element.scrollWidth <= element.clientWidth),true);
  }
  await app.close();app = null;panel = await launch();
  await panel.waitForFunction(() => document.getElementById('quota-key-summary').textContent.includes('3 个 Key'));
  assert.equal((await batches()).length,0,'重启恢复缓存，不再次批量查询');
  assert.equal(await panel.locator('#quota-group-toggle').getAttribute('aria-expanded'),'false');
  await panel.locator('#quota-group-toggle').click();await panel.waitForFunction(() => !document.getElementById('quota-group-body').hidden);
  assert.deepEqual(errors,[]);
  console.log('Key usage UI OK: independent selector, batch costs, group subtotals, cached reopen/restart, failures, collapse and 860/1060px layouts');
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  if (app) await app.close();fs.rmSync(dir,{recursive:true,force:true});
});
