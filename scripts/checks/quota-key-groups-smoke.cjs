'use strict';
// 隐藏的独立应用实例，真实 IPC + 渲染器，所有管理 API 都替换为合成数据。
const {_electron:electron} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'../..'), dir = fs.mkdtempSync('/tmp/whale-key-groups-ui-'), bootstrap = path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`
require(${JSON.stringify(path.join(root,'scripts/checks/test-window-policy.cjs'))}).installTestWindowPolicy();
const {Notification}=require('electron');Notification.isSupported=()=>false;
const archery=require(${JSON.stringify(path.join(root,'src/channels/archery-pending.cjs'))}),createArchery=archery.createArcheryPending;
archery.createArcheryPending=options=>createArchery({...options,readConfig:()=>{throw Error('isolated');}});
const quota=require(${JSON.stringify(path.join(root,'src/channels/quota-accounts.cjs'))}),createQuota=quota.createQuotaPanel;
quota.createQuotaPanel=options=>createQuota({...options,fetchImpl:async()=>({ok:true,json:async()=>({data:{items:[],pages:1}})})});
const ranking=require(${JSON.stringify(path.join(root,'src/channels/quota-group-usage.cjs'))}),createRanking=ranking.createGroupUsage;
ranking.createGroupUsage=options=>createRanking({...options,fetchImpl:async url=>({ok:true,json:async()=>({data:url.includes('/groups/all')?[{id:13,name:'标准分组'},{id:14,name:'备用分组'}]:{users:[]}})})});
global.groupSmoke={calls:[],mode:'success',blocked:false,keys:new Map([[9,[{id:1,user_id:9,name:'<img src=x onerror=alert(1)>',group_id:13,status:'active'},{id:2,user_id:9,name:'Claude Code',group_id:14,status:'inactive'}]],[10,[{id:101,user_id:10,name:'临时开发',group_id:13,status:'active'}]]])};
const response=data=>({ok:true,json:async()=>({code:0,data})});
async function fetchFixture(url,request){
  const endpoint=new URL(url).pathname.replace('/api/v1/admin/','');groupSmoke.calls.push({endpoint,method:request.method,body:request.body});
  if(endpoint==='users'){
    const query=new URL(url).searchParams.get('search')||'';
    const items=[{id:9,email:'one@example.com'},{id:10,email:'two@example.com'}].filter(user=>user.email.includes(query));
    return response({items,total:items.length});
  }
  if(endpoint==='groups/all')return response([{id:13,name:'标准分组',is_exclusive:false,subscription_type:'standard',status:'active'},{id:14,name:'备用分组',is_exclusive:true,subscription_type:'standard',status:'active'},{id:15,name:'无权限分组',is_exclusive:true,subscription_type:'standard',status:'active'}]);
  if(/^users\\/\\d+$/.test(endpoint))return response({id:Number(endpoint.split('/')[1]),status:'active',allowed_groups:groupSmoke.deniedGroup?[]:[14],restrict_public_groups:false});
  if(endpoint.endsWith('/subscriptions'))return response([]);
  if(endpoint.endsWith('/api-keys')){
    if(groupSmoke.blocked)throw Error('synthetic-admin-secret');
    const items=groupSmoke.keys.get(Number(endpoint.split('/')[1])).map(key=>({...key,group:{name:key.group_id===13?'标准分组':'备用分组'},key:'sk-never-render'}));return response({items,total:items.length});
  }
  if(endpoint==='dashboard/api-keys-usage')return response({stats:Object.fromEntries(JSON.parse(request.body).api_key_ids.map(id=>[id,{today_actual_cost:id/10}]))});
  if(endpoint.startsWith('api-keys/')&&request.method==='PUT'){
    if(groupSmoke.mode==='deny')return {ok:false,status:403};
    if(groupSmoke.mode==='delayed')await new Promise(resolve=>{groupSmoke.release=resolve;});
    const key=[...groupSmoke.keys.values()].flat().find(key=>key.id===Number(endpoint.split('/')[1]));key.group_id=JSON.parse(request.body).group_id;
    if(groupSmoke.mode==='unknown')groupSmoke.blocked=true;
    return response({api_key:{...key,key:'sk-never-render'}});
  }
  throw Error('Unexpected fixture route '+endpoint);
}
const keys=require(${JSON.stringify(path.join(root,'src/channels/quota-key-usage.cjs'))}),createKeys=keys.createKeyUsage;
keys.createKeyUsage=options=>createKeys({...options,fetchImpl:fetchFixture});
const switching=require(${JSON.stringify(path.join(root,'src/channels/quota-key-groups.cjs'))}),createSwitching=switching.createKeyGroups;
switching.createKeyGroups=options=>createSwitching({...options,fetchImpl:fetchFixture});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});
`);
let app;
(async () => {
  const errors = [];
  async function launch() {
    app = await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir,
      WHALE_TEST_WINDOWS:'hidden',WHALE_QUOTA_BASE_URL:'https://quota-fixture.invalid',WHALE_QUOTA_API_KEY:'synthetic-admin-secret'}});
    app.on('window',page => page.on('pageerror',error => errors.push(error.message)));
    await app.firstWindow();let panel;
    for (let attempt = 0;attempt < 100;attempt++) {
      panel = app.windows().find(page => page.url().endsWith('/index.html'));if (panel) break;
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.ok(panel);panel.setDefaultTimeout(10000);
    await panel.locator('#nav-quota').click();return panel;
  }
  let panel = await launch();
  const writes = () => app.evaluate(() => groupSmoke.calls.filter(call => call.method === 'PUT'));
  const keyReads = () => app.evaluate(() => groupSmoke.calls.filter(call => call.endpoint.endsWith('/api-keys')).length);
  assert.equal(await panel.locator('#quota-switch-tab-favorites').getAttribute('aria-selected'),'true','默认打开常用 Tab');
  assert.equal(await panel.locator('#quota-switch-favorites-empty').isVisible(),true);
  assert.equal(await panel.locator('#quota-switch-picker').isVisible(),false);
  assert.equal(await keyReads(),0,'打开常用 Tab 不自动查询');
  await panel.locator('#quota-switch-tab-search').click();
  await panel.locator('#quota-switch-button').click();await panel.locator('#quota-switch-options').getByRole('option',{name:'one@example.com #9',exact:true}).click();
  await panel.waitForFunction(() => document.querySelectorAll('#quota-switch-list .quota-switch-row').length === 2);
  const userSearch = panel.locator('#quota-switch-search');
  async function searchUser(query,email) {
    await userSearch.fill(query);
    await panel.waitForFunction(email => {
      const options = document.querySelectorAll('#quota-switch-options [role="option"]');
      return options.length === 1 && options[0].textContent === email;
    },email);
  }
  await panel.locator('#quota-switch-button').click();
  await searchUser('two','two@example.com #10');
  await searchUser('one','one@example.com #9');
  await userSearch.press('Escape');
  assert.equal((await panel.evaluate(() => window.whale.quotaGroup('key-groups-snapshot'))).value.user.id,9,'未选择搜索结果保留原用户');
  assert.equal(await userSearch.isVisible(),true,'搜索应直接位于已选用户框，收起后仍可继续输入');
  assert.equal(await userSearch.inputValue(),'one@example.com #9');
  await userSearch.click();await searchUser('two','two@example.com #10');
  await panel.locator('#quota-switch-note').click();
  assert.equal(await userSearch.inputValue(),'one@example.com #9','点击外部恢复原选择');
  assert.equal(await panel.locator('#quota-switch-menu').isVisible(),false);
  await userSearch.click();await userSearch.fill('nobody');
  await panel.waitForFunction(() => document.getElementById('quota-switch-search-status').textContent === '没有匹配的用户。');
  await userSearch.press('Enter');
  assert.equal((await panel.evaluate(() => window.whale.quotaGroup('key-groups-snapshot'))).value.user.id,9,'无匹配时回车不切换用户');
  await userSearch.fill('');await panel.waitForFunction(() => document.querySelectorAll('#quota-switch-options [role="option"]').length === 2);
  await userSearch.press('Tab');
  assert.equal(await userSearch.inputValue(),'one@example.com #9','清空搜索后移开焦点仍保留原选择');
  assert.equal(await panel.locator('#quota-switch-menu').isVisible(),false);
  const first = () => panel.locator('#quota-switch-list .quota-switch-row[data-key-id="1"]');
  const groupTrigger = () => first().locator('.ui-select-trigger');
  const save = () => first().getByRole('button',{name:/^保存 /});
  async function chooseGroup(name) {
    await groupTrigger().click();await first().getByRole('option',{name,exact:true}).click();
  }
  const savedGroup = async () => (await panel.evaluate(() => window.whale.quotaGroup('key-groups-snapshot'))).value.keys.find(key => key.id === 1).groupId;
  assert.deepEqual(await panel.locator('#quota-switch-table thead th').allTextContents(),['API Key','所属分组','启用状态','操作'],'所属分组在启用状态前，直接选择并保存');
  assert.equal(await first().locator('.quota-switch-status').textContent(),'启用');
  assert.equal(await panel.locator('#quota-switch-list .quota-switch-row[data-key-id="2"] .quota-switch-status').textContent(),'停用');
  assert.equal(await panel.locator('#quota-switch-list img').count(),0);
  const readsBeforeReopen = await keyReads();
  await app.evaluate(() => {groupSmoke.keys.get(9)[0].name='外部更新 Key';});
  await panel.locator('#quota-switch-toggle').click();await panel.locator('#quota-switch-body').waitFor({state:'hidden'});
  await panel.locator('#quota-switch-toggle').click();await panel.locator('#quota-switch-body').waitFor({state:'visible'});
  await panel.locator('#nav-quota').click();await panel.locator('#quota-switch-refresh:enabled').waitFor({state:'visible'});
  assert.equal(await keyReads(),readsBeforeReopen,'展开和返回页面不自动刷新');
  assert.ok(!(await first().textContent()).includes('外部更新 Key'),'沿用已加载的结果');
  await panel.locator('#quota-switch-refresh').click();
  await panel.waitForFunction(() => document.querySelector('#quota-switch-list .quota-switch-row')?.textContent.includes('外部更新 Key'));
  assert.ok(await keyReads() > readsBeforeReopen,'立即刷新读取远端变化');
  assert.equal(await first().locator('select').count(),0,'分组使用项目配套组件，不弹出系统菜单');
  assert.equal(await groupTrigger().textContent(),'标准分组');
  await groupTrigger().click();
  assert.equal(await first().getByRole('option').count(),2);
  assert.equal(await first().getByRole('option',{name:'标准分组',exact:true}).getAttribute('aria-selected'),'true');
  await first().getByRole('option',{name:'标准分组',exact:true}).press('Escape');
  await first().locator('.ui-select-trigger[aria-expanded="false"]').waitFor({state:'visible'});
  assert.equal(await save().isDisabled(),true);
  assert.equal((await writes()).length,0);
  await groupTrigger().press('ArrowDown');
  await first().getByRole('option',{name:'标准分组',exact:true}).press('ArrowDown');
  await first().getByRole('option',{name:'备用分组',exact:true}).press('Enter');
  assert.equal((await writes()).length,0,'选择不提交');
  assert.equal(await savedGroup(),13,'保存前实际分组不变');
  assert.match(await first().textContent(),/未保存/);
  await app.evaluate(() => {groupSmoke.mode='delayed';});
  await save().click();await panel.waitForFunction(() => document.querySelector('#quota-switch-list button[data-key-id="1"]').textContent === '保存中…');
  await app.evaluate(() => groupSmoke.release());
  await first().locator('.quota-switch-saved').waitFor({state:'visible'});
  assert.equal((await writes()).length,1);assert.deepEqual(JSON.parse((await writes())[0].body),{group_id:14});
  assert.equal(await groupTrigger().textContent(),'备用分组');assert.equal(await savedGroup(),14);
  assert.equal(await save().isDisabled(),true,'保存成功后展示新分组并清除待保存状态');
  assert.ok(!(await first().textContent()).includes('未保存'));
  await app.evaluate(() => {groupSmoke.mode='deny';});await chooseGroup('标准分组');await save().click();
  await panel.waitForFunction(() => document.querySelector('.quota-switch-notice p')?.dataset.kind === 'error');
  assert.equal(await savedGroup(),14,'保存失败保留原实际分组');
  assert.equal(await groupTrigger().textContent(),'标准分组','保存失败保留草稿供重试');
  await app.evaluate(() => {groupSmoke.mode='unknown';});await save().click();
  await first().locator('.quota-switch-status[data-state="uncertain"]').waitFor({state:'visible'});
  assert.equal(await groupTrigger().getAttribute('aria-disabled'),'true');assert.equal((await writes()).length,3);
  await groupTrigger().click();assert.equal(await first().locator('.ui-select').getAttribute('open'),null,'禁用时不展开分组菜单');
  await app.evaluate(() => {groupSmoke.blocked=false;groupSmoke.mode='success';});await panel.locator('#quota-switch-refresh').click();
  await first().locator('.quota-switch-status[data-state="active"]').waitFor({state:'visible'});
  assert.equal(await groupTrigger().textContent(),'标准分组');assert.equal(await savedGroup(),13);
  const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
  await assert.rejects(pet.evaluate(() => window.whale.quotaGroup('key-groups-switch',{userId:9,keyId:1,expectedGroupId:13,groupId:14})),/仅允许在小屋/);
  fs.mkdirSync(path.join(root,'out'),{recursive:true});
  for (const width of [1060,860]) {
    await app.evaluate(({BrowserWindow},width) => {for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().endsWith('/index.html')) win.setSize(width,1000);},width);
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`页面适配 ${width}`);
    assert.ok(await panel.locator('#quota-switch-table').evaluate(element => element.scrollWidth <= element.clientWidth),`列表适配 ${width}`);
    const operationHeader = await panel.locator('#quota-switch-table thead th').last().boundingBox(), operationButton = await save().boundingBox();
    assert.ok(Math.abs(operationHeader.x+operationHeader.width/2-operationButton.x-operationButton.width/2)<1,'搜索列表操作标题与保存按钮居中对齐');
    await panel.locator('.quota-switch-card').screenshot({path:path.join(root,`out/quota-key-groups-${width}.png`)});
    if (width <= 950) {
      const groupBox = await groupTrigger().boundingBox(), saveBox = await save().boundingBox();
      assert.ok(Math.abs(groupBox.y-saveBox.y) <= 2,`窄窗口分组选择与保存按钮对齐：${JSON.stringify({groupBox,saveBox})}`);
    }
    await groupTrigger().click();
    await first().getByRole('option',{name:'标准分组',exact:true}).waitFor({state:'visible'});
    await panel.locator('.quota-switch-card').screenshot({path:path.join(root,`out/quota-key-groups-menu-${width}.png`)});
    await first().getByRole('option',{name:'标准分组',exact:true}).press('Escape');
    await userSearch.click();await searchUser('two','two@example.com #10');
    const inputBox = await userSearch.boundingBox(), menuBox = await panel.locator('#quota-switch-menu').boundingBox();
    assert.ok(inputBox.y+inputBox.height <= menuBox.y,'搜索输入位于已选用户框，结果显示在下方');
    await panel.locator('.quota-switch-card').screenshot({path:path.join(root,`out/quota-key-groups-search-${width}.png`)});
    await userSearch.press('Escape');
  }
  const readsBeforePin = await keyReads();
  const second = () => panel.locator('#quota-switch-list .quota-switch-row[data-key-id="2"]');
  await second().locator('.quota-switch-pin').click();
  await panel.waitForFunction(() => document.querySelector('#quota-switch-list .quota-switch-row')?.dataset.keyId === '2');
  await second().locator('.quota-switch-pin').click();
  await panel.waitForFunction(() => document.querySelector('#quota-switch-list .quota-switch-row')?.dataset.keyId === '1');
  await first().locator('.quota-switch-pin').click();
  await first().locator('.quota-switch-pin[aria-pressed="true"]').waitFor({state:'visible'});
  assert.equal(await keyReads(),readsBeforePin,'设为常用仅保存偏好，不刷新 Key');
  await userSearch.click();await searchUser('two','two@example.com #10');
  await userSearch.press('ArrowDown');await userSearch.press('Enter');
  await panel.waitForFunction(() => document.getElementById('quota-switch-count').textContent === '1 个 Key');
  assert.equal(await userSearch.inputValue(),'two@example.com #10');
  await userSearch.click();await searchUser('one','one@example.com #9');await userSearch.press('Escape');
  assert.equal(await userSearch.inputValue(),'two@example.com #10','选择新用户后可以再次搜索，取消保留新选择');
  assert.ok(!(await panel.locator('#quota-switch-list').textContent()).includes('Claude Code'));
  await panel.locator('#quota-switch-list .quota-switch-pin').click();
  await panel.waitForFunction(() => document.querySelectorAll('#quota-switch-favorites-list .quota-switch-row').length === 2);
  const favorite = id => panel.locator(`#quota-switch-favorites-list .quota-switch-row[data-key-id="${id}"]`);
  async function chooseFavorite(id,name) {
    await favorite(id).locator('.ui-select-trigger').click();await favorite(id).getByRole('option',{name,exact:true}).click();
  }
  const readsBeforeTabs = await keyReads();
  await panel.locator('#quota-switch-tab-favorites').click();
  assert.deepEqual(await panel.locator('#quota-switch-favorites-table thead th').allTextContents(),['API Key','所属分组','启用状态','刷新','操作']);
  assert.deepEqual(await favorite(1).locator('.quota-switch-key-detail').allTextContents(),['Key 编号#1','所属账号one@example.com #9']);
  assert.deepEqual(await favorite(101).locator('.quota-switch-key-detail').allTextContents(),['Key 编号#101','所属账号two@example.com #10']);
  for (const id of [1,101]) {
    assert.equal(await favorite(id).locator('.quota-switch-key-name').getAttribute('title'),null,'移除系统原生提示');
    assert.equal(await favorite(id).locator('.quota-switch-key-info').getAttribute('aria-describedby'),await favorite(id).getByRole('tooltip',{includeHidden:true}).getAttribute('id'));
    assert.equal(await favorite(id).getByRole('tooltip',{includeHidden:true}).isVisible(),false,'未悬停时隐藏详情');
    assert.doesNotMatch(await favorite(id).locator('th').innerText(),/#\d|@|启用|停用/,'名称列只展示名称，编号和账号放在悬停提示');
    assert.equal(await favorite(id).locator(':scope > td').count(),4,'状态、分组、刷新、保存各占一列');
    assert.ok(await favorite(id).evaluate(row => {
      const status = row.querySelector('.quota-switch-status'), refresh = row.querySelector('.quota-switch-row-refresh').closest('td'), save = row.querySelector('.quota-switch-save').closest('td');
      return status !== refresh && refresh !== save && status !== save;
    }),'启用状态与刷新、保存互不挤占单元格');
  }
  assert.equal(await panel.locator('#quota-switch-picker').isVisible(),false,'常用 Tab 不占用搜索空间');
  assert.equal(await panel.locator('#quota-switch-table').isVisible(),false,'搜索完整列表只在另一个 Tab');
  assert.equal(await panel.locator('#quota-switch-refresh').isVisible(),false,'常用 Tab 只有行内刷新');
  assert.equal(await panel.locator('#quota-switch-favorites-list .quota-switch-row-refresh').count(),2);
  await panel.locator('#quota-switch-tab-favorites').press('ArrowRight');
  assert.equal(await panel.locator('#quota-switch-picker').isVisible(),true);
  await panel.locator('#quota-switch-tab-search').press('ArrowLeft');
  assert.equal(await keyReads(),readsBeforeTabs,'切换 Tab 不自动刷新');
  await chooseFavorite(1,'备用分组');await chooseFavorite(101,'备用分组');
  const writesBeforeFavorites = (await writes()).length;
  await app.evaluate(() => {groupSmoke.mode='delayed';});
  await favorite(1).locator('.quota-switch-save').click();
  await panel.waitForFunction(() => document.querySelector('#quota-switch-favorites-list .quota-switch-row[data-key-id="1"] .quota-switch-save')?.textContent === '保存中…');
  assert.equal(await favorite(101).locator('.quota-switch-save').isEnabled(),true,'另一把常用 Key 可以分别保存');
  await app.evaluate(() => {groupSmoke.mode='success';groupSmoke.release();});
  await panel.waitForFunction(() => !document.querySelector('#quota-switch-favorites-list .quota-switch-row[data-key-id="1"]')?.textContent.includes('保存中'));
  assert.equal((await writes()).length,writesBeforeFavorites+1);
  assert.equal((await writes()).at(-1).endpoint,'api-keys/1');
  assert.match(await favorite(101).textContent(),/未保存/,'保存一把 Key 保留另一把的草稿');
  assert.equal(await favorite(1).locator('.quota-switch-save').isDisabled(),true);
  await favorite(101).locator('.quota-switch-save').click();
  await panel.waitForFunction(() => document.querySelector('#quota-switch-list .ui-select-trigger')?.textContent === '备用分组' && document.querySelector('#quota-switch-list .quota-switch-save')?.disabled);
  assert.equal((await writes()).length,writesBeforeFavorites+2);
  assert.equal((await writes()).at(-1).endpoint,'api-keys/101');
  assert.equal(await userSearch.inputValue(),'two@example.com #10','从常用区保存不改变选中的用户');
  await chooseFavorite(1,'标准分组');await app.evaluate(() => {groupSmoke.mode='delayed';groupSmoke.release=null;});
  await favorite(1).locator('.quota-switch-save').click();
  await app.evaluate(async () => {
    for (let attempt = 0;attempt < 100;attempt++) {if (groupSmoke.release) return;await new Promise(resolve => setTimeout(resolve,10));}
    throw Error('delayed fixture write did not start');
  });
  await panel.locator('#quota-switch-tab-search').click();
  await userSearch.click();await searchUser('one','one@example.com #9');
  await panel.locator('#quota-switch-options').getByRole('option',{name:'one@example.com #9',exact:true}).click();
  await panel.waitForFunction(() => document.getElementById('quota-switch-count').textContent === '2 个 Key');
  await app.evaluate(() => {groupSmoke.mode='success';groupSmoke.release();});
  await first().locator('.ui-select-trigger[aria-disabled="false"]').waitFor({state:'visible'});
  assert.equal(await groupTrigger().textContent(),'标准分组','换用户期间完成的常用保存也同步原列表');
  assert.equal(await userSearch.inputValue(),'one@example.com #9','迟到的保存结果不改用户选择');
  await userSearch.click();await searchUser('two','two@example.com #10');
  await panel.locator('#quota-switch-options').getByRole('option',{name:'two@example.com #10',exact:true}).click();
  await panel.waitForFunction(() => document.getElementById('quota-switch-count').textContent === '1 个 Key');
  await panel.locator('#quota-switch-tab-favorites').click();
  // 同一个用户的其他行和草稿也不应被单行刷新覆盖。
  await chooseFavorite(101,'标准分组');
  const readsBeforeFavorite = await keyReads();
  await favorite(1).locator('.quota-switch-row-refresh').click();
  await favorite(1).locator('.quota-switch-row-refresh[aria-busy="false"]').waitFor({state:'visible'});
  assert.equal(await keyReads(),readsBeforeFavorite+1,'一个刷新图标只读取它所属用户');
  assert.match(await favorite(101).textContent(),/未保存/,'单行刷新保留另一把常用 Key 的草稿');
  for (const width of [1060,860]) {
    await app.evaluate(({BrowserWindow},width) => {for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().endsWith('/index.html')) win.setSize(width,1000);},width);
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`常用区页面适配 ${width}`);
    assert.ok(await panel.locator('#quota-switch-favorites table').evaluate(element => element.scrollWidth <= element.clientWidth),`常用区列表适配 ${width}`);
    for (const id of [1,101]) {
      const layout = await favorite(id).evaluate(row => {
        const rect = node => {const {x,y,width,height} = node.getBoundingClientRect();return {x,y,width,height};};
        return {row:rect(row),title:rect(row.querySelector('th')),pin:rect(row.querySelector('.quota-switch-pin')),name:rect(row.querySelector('.quota-switch-key-name')),status:rect(row.querySelector('.quota-switch-status')),group:rect(row.querySelector('.ui-select-trigger')),refresh:rect(row.querySelector('.quota-switch-row-refresh')),save:rect(row.querySelector('.quota-switch-save')),
          color:getComputedStyle(row.querySelector('.quota-switch-pin')).color,fill:getComputedStyle(row.querySelector('.quota-switch-pin polygon')).fill};
      });
      assert.ok(layout.pin.x < layout.name.x,'收藏图标放在每行最前面');
      assert.equal(layout.color,'rgb(212, 155, 37)');assert.equal(layout.fill,'rgb(246, 196, 83)','选中收藏使用金黄色');
      assert.ok(layout.title.width/layout.row.width > .36 && layout.title.width/layout.row.width < .40,'名称列宽生效，为状态和刷新留出独立空间');
      assert.ok(layout.name.width >= 100,'名称仍有可读空间');
      assert.ok(layout.name.x+layout.name.width <= layout.group.x && layout.group.x+layout.group.width <= layout.status.x,'名称、分组和状态按顺序排列且不重叠');
      assert.ok(layout.status.x+layout.status.width <= layout.refresh.x && layout.refresh.x+layout.refresh.width <= layout.save.x,'状态、刷新和保存不重叠');
      assert.ok(layout.row.height <= 56,`常用 Key 为紧凑单行 ${width}: ${JSON.stringify(layout)}`);
      const header = await panel.locator('#quota-switch-favorites-table thead th').last().boundingBox();
      assert.ok(Math.abs(header.x+header.width/2-layout.save.x-layout.save.width/2)<1,'常用列表操作标题与保存按钮居中对齐');
      for (const item of [layout.pin,layout.name,layout.status,layout.group,layout.refresh,layout.save]) assert.ok(Math.abs(item.y+item.height/2-layout.row.y-layout.row.height/2) <= 2,'名称、状态、分组、刷新和保存同排对齐');
    }
    await panel.locator('.quota-switch-card').screenshot({path:path.join(root,`out/quota-key-groups-favorites-${width}.png`)});
    const info = favorite(1).locator('.quota-switch-key-info'), tooltip = info.getByRole('tooltip',{includeHidden:true});
    await info.hover();await tooltip.waitFor({state:'visible'});
    const box = await tooltip.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x+box.width <= width,'提示卡完整位于窗口内');
    assert.equal(await tooltip.evaluate(node => getComputedStyle(node).backgroundColor),await panel.locator('.quota-switch-card').evaluate(node => getComputedStyle(node).backgroundColor),'提示卡沿用页面卡片底色');
    await panel.locator('.quota-switch-card').screenshot({path:path.join(root,`out/quota-key-groups-tooltip-${width}.png`)});
    await panel.locator('#quota-switch-tab-favorites').hover();await tooltip.waitFor({state:'hidden'});
  }
  await favorite(1).locator('.quota-switch-pin').focus();await panel.keyboard.press('Tab');
  assert.equal(await favorite(1).locator('.quota-switch-key-info').evaluate(node => node.matches(':focus-visible')),true,'键盘可聚焦名称');
  await favorite(1).getByRole('tooltip').waitFor({state:'visible'});
  await favorite(1).locator('.quota-switch-row-refresh').focus();
  await favorite(1).getByRole('tooltip',{includeHidden:true}).waitFor({state:'hidden'});
  const state = (await panel.evaluate(() => window.whale.quotaGroup('key-groups-snapshot'))).value;
  assert.ok(!JSON.stringify(state).includes('secret'));assert.ok(!JSON.stringify(state).includes('sk-never-render'));
  await panel.locator('#quota-switch-toggle').click();await panel.waitForFunction(() => document.getElementById('quota-switch-body').hidden);
  await app.close();panel = await launch();
  assert.equal(await panel.locator('#quota-switch-toggle').getAttribute('aria-expanded'),'false');
  await panel.locator('#quota-switch-toggle').click();await panel.locator('#quota-switch-body').waitFor({state:'visible'});
  assert.equal(await keyReads(),0,'重启和展开不自动查询 Key');
  assert.equal(await panel.locator('#quota-switch-count').textContent(),'2 个 Key','标题显示常用数量');
  assert.equal(await panel.locator('#quota-switch-favorites-list .quota-switch-row').count(),2,'重启恢复常用 Key');
  assert.equal(await favorite(1).locator('.quota-switch-key-detail').last().textContent(),'所属账号one@example.com #9','重启恢复悬停归属提示');
  assert.equal(await favorite(1).locator('.ui-select-trigger').textContent(),'标准分组','重启直接恢复常用分组');
  assert.equal(await favorite(1).locator('.ui-select-trigger').getAttribute('aria-disabled'),'false','重启直接允许选组');
  assert.equal(await favorite(101).locator('.ui-select-trigger').textContent(),'备用分组');
  assert.equal(await panel.locator('#quota-switch-favorites-list .quota-switch-placeholder').count(),0);
  assert.equal(await favorite(1).locator('.quota-switch-save').isDisabled(),true);
  await chooseFavorite(1,'备用分组');assert.equal(await keyReads(),0,'从恢复的可选分组中选择不需要先刷新');
  assert.equal(await panel.locator('#quota-switch-error').isVisible(),false,'正常缓存不提示刷新');
  await app.evaluate(() => {groupSmoke.deniedGroup=true;});
  await favorite(1).locator('.quota-switch-save').click();
  await panel.waitForFunction(() => document.querySelector('#quota-switch-favorites-list .quota-switch-notice p')?.textContent.includes('刷新'));
  assert.equal((await writes()).length,0,'已失去授权的缓存目标不会写入');
  assert.match(await favorite(1).textContent(),/未保存/,'失败保留草稿与原记录');
  await favorite(1).locator('.quota-switch-row-refresh').click();
  await favorite(1).locator('.quota-switch-row-refresh[aria-busy="false"]').waitFor({state:'visible'});
  assert.equal(await favorite(1).locator('.ui-select-trigger').textContent(),'标准分组');
  await favorite(1).locator('.ui-select-trigger').click();
  assert.equal(await favorite(1).getByRole('option').count(),1,'刷新后去掉失效授权');
  await favorite(1).getByRole('option',{name:'标准分组',exact:true}).press('Escape');
  await app.evaluate(() => {groupSmoke.deniedGroup=false;});
  await favorite(1).locator('.quota-switch-row-refresh').click();
  await favorite(1).locator('.ui-select-trigger[aria-disabled="false"]').waitFor({state:'visible'});
  await chooseFavorite(1,'备用分组');await favorite(1).locator('.quota-switch-save').click();
  await favorite(1).locator('.quota-switch-saved').waitFor({state:'visible'});
  assert.equal((await writes()).length,1,'无需整体刷新，常用 Key 可独立保存');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'quota-key-groups.json'),'utf8')).favorites[0].cached.key.groupId,14,'新分组同步记录到本地');
  const readsBeforeUnpin = await keyReads();
  await favorite(101).locator('.quota-switch-pin').click();
  await panel.waitForFunction(() => document.querySelectorAll('#quota-switch-favorites-list .quota-switch-row').length === 1);
  assert.equal(await keyReads(),readsBeforeUnpin,'取消常用不修改远端 Key');
  await panel.locator('#quota-switch-tab-search').click();
  assert.equal(await panel.locator('#quota-switch-count').textContent(),'0 个 Key','单个常用刷新不会把部分结果显示成完整列表');
  await panel.locator('#quota-switch-refresh').click();await panel.locator('#quota-switch-refresh:enabled').waitFor({state:'visible'});
  assert.equal(await panel.locator('#quota-switch-table').isVisible(),true);
  assert.equal(await panel.locator('#quota-switch-list .quota-switch-pin').getAttribute('aria-pressed'),'false');
  await panel.evaluate(() => window.whale.modules({id:'quota',enabled:false}));
  const denied = await panel.evaluate(() => window.whale.quotaGroup('key-groups-switch',{userId:10,keyId:101,expectedGroupId:13,groupId:14}));
  assert.match(denied.error,/已关闭/);assert.equal((await writes()).length,1,'模块关闭不增加提交');
  const favoriteDenied = await panel.evaluate(() => window.whale.quotaGroup('key-groups-set-favorite',{userId:10,keyId:101,favorite:true}));
  assert.match(favoriteDenied.error,/已关闭/);
  const refreshDenied = await panel.evaluate(() => window.whale.quotaGroup('key-groups-refresh-favorite',{userId:9,keyId:1}));
  assert.match(refreshDenied.error,/已关闭/);
  await panel.evaluate(() => window.whale.modules({id:'quota',enabled:true}));
  await app.close();
  const legacyFile = path.join(dir,'quota-key-groups.json'), legacy = JSON.parse(fs.readFileSync(legacyFile,'utf8'));
  for (const item of legacy.favorites) delete item.cached;
  fs.writeFileSync(legacyFile,JSON.stringify(legacy));panel = await launch();
  await favorite(1).locator('.ui-select-trigger[aria-disabled="false"]').waitFor({state:'visible'});
  assert.equal(await keyReads(),1,'旧版本只有收藏引用时首次补读一次');
  assert.equal(await favorite(1).locator('.ui-select-trigger').textContent(),'标准分组');
  await panel.locator('#nav-quota').click();await panel.locator('#quota-switch-tab-favorites[aria-selected="true"]').waitFor({state:'visible'});
  assert.equal(await keyReads(),1,'补读成功后返回页面不重复刷新');
  await panel.locator('.quota-switch-card').screenshot({path:path.join(root,'out/quota-key-groups-restored.png')});
  assert.deepEqual(await app.evaluate(() => testWindowPolicy.events),[],'测试窗口从创建起保持隐藏');
  assert.deepEqual(errors,[]);console.log('API Key groups UI smoke OK: restored group/options, save without refresh, stale permission feedback, legacy hydration, compact rows, independent actions, IPC and 1060/860 layout');
})().catch(error => {console.error(error);process.exitCode=1;}).finally(async () => {if (app) await app.close();fs.rmSync(dir,{recursive:true,force:true});});
