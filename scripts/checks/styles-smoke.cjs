'use strict';
// 真实 Chromium 检查公共样式的最终计算结果；页面使用静态夹具，不启动业务服务或读取凭据。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),ui=path.join(root,'src/ui');
const dir=fs.mkdtempSync('/tmp/whale-styles-ui-'),screenshots=process.env.WHALE_STYLE_SCREENSHOTS;
if(screenshots)fs.mkdirSync(screenshots,{recursive:true});
for(const name of ['index','pet','pet-ranking','pet-accounts','pet-menu']) {
  const html=fs.readFileSync(path.join(ui,name+'.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')
    .replace(/href="([^\"]+\.css)"/g,(_,file)=>`href="${pathToFileURL(path.join(ui,file)).href}"`);
  fs.writeFileSync(path.join(dir,name+'.html'),html);
}
const bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir)});app.whenReady().then(()=>{new BrowserWindow({width:1060,height:770,webPreferences:{contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(dir,'index.html'))});});`);
let app;
const appearance=(page,selector,properties)=>page.locator(selector).first().evaluate((el,keys)=>{
  const style=getComputedStyle(el);return Object.fromEntries(keys.map(key=>[key,style[key]]));
},properties);
const capture=async(page,name)=>{if(screenshots)await page.screenshot({path:path.join(screenshots,name+'.png'),fullPage:true});};
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap]});
  const panel=await app.firstWindow(),errors=[];panel.on('pageerror',error=>errors.push(error.message));
  await panel.waitForSelector('.ui-card');
  const controlKeys=['minHeight','fontFamily','fontSize','borderRadius','borderColor','borderWidth'];
  const expectedControl=await appearance(panel,'#quota-group-button',controlKeys);
  for(const selector of ['#shortcuts-triple','#quota-columns-button','#mail-email','#mail-type','#quota-pet-yellow','#subscriptions-input']) {
    assert.deepEqual(await appearance(panel,selector,controlKeys),expectedControl,selector+' shares control appearance');
  }
  const expectedButton=await appearance(panel,'#quota-refresh',controlKeys);
  for(const selector of ['#archery-refresh','#mail-connect','#wechat-login','#quota-pet-apply','#subscriptions-refresh']) {
    const actual=await appearance(panel,selector,controlKeys);
    if(selector==='#mail-connect'||selector==='#wechat-login')actual.borderColor=expectedButton.borderColor;
    assert.deepEqual(actual,expectedButton,selector+' shares button sizing');
  }
  const cardKeys=['padding','borderRadius','borderColor','backgroundColor'];
  const expectedCard=await appearance(panel,'.care',cardKeys);
  for(const selector of ['#quota-view .ui-card','#mail-view .ui-card','.hook-event-panel','#shortcuts-view .ui-card','#subscriptions-view .ui-card'])assert.deepEqual(await appearance(panel,selector,cardKeys),expectedCard);
  const alertKeys=['padding','borderRadius','backgroundColor','color','fontSize'];
  const expectedAlert=await appearance(panel,'#mail-error',alertKeys);
  for(const selector of ['#wechat-error','#archery-error','#quota-error','#quota-pet-error','#shortcuts-error','#subscriptions-error'])assert.deepEqual(await appearance(panel,selector,alertKeys),expectedAlert);
  await panel.evaluate(()=>{
    const box=document.getElementById('quota-group-options');
    const option=document.createElement('button');option.setAttribute('role','option');option.setAttribute('aria-selected','true');option.textContent='测试分组';box.append(option);
    const template=document.getElementById('quota-pet-config-template');document.getElementById('quota-pet-extra-configs').append(template.content.cloneNode(true));
  });
  const selectionKeys=['backgroundColor','color','borderRadius'];
  const expectedSelection=await appearance(panel,'#quota-group-options button',selectionKeys);
  for(const width of [1060,860]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,770),width);
    for(const view of ['home','hooks','wechat','mail','subscriptions','archery','quota','shortcuts']) {
      await panel.evaluate(view=>{
        for(const name of ['home','hooks','wechat','mail','subscriptions','archery','quota','shortcuts'])document.getElementById(name+'-view').hidden=name!==view;
        for(const id of ['mail-options','wechat-client-options'])document.getElementById(id).open=true;
        document.getElementById('mail-settings').hidden=false;
      },view);
      await panel.waitForTimeout(30);
      assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${view} fits ${width}px`);
      await capture(panel,view+'-'+width);
    }
  }
  await panel.evaluate(()=>{document.getElementById('shortcuts-picker').open=true;});
  await capture(panel,'shortcuts-picker');
  await panel.evaluate(()=>{document.getElementById('shortcuts-picker').open=false;document.getElementById('shortcuts-triple').focus();});
  const focus=await appearance(panel,'#shortcuts-triple',['outlineColor','outlineWidth']);
  assert.equal(focus.outlineWidth,'2px');
  for(const name of ['pet-ranking','pet-accounts','pet-menu','pet']) {
    const opened=app.waitForEvent('window');
    await app.evaluate(async({BrowserWindow},{file,name})=>{
      for(const window of BrowserWindow.getAllWindows())window.hide();
      const window=new BrowserWindow({width:name==='pet-menu'?400:name==='pet'?260:306,height:name==='pet'?440:340,transparent:true,frame:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});await window.loadFile(file);
    },{file:path.join(dir,name+'.html'),name});
    const page=await opened;await page.waitForLoadState('load');
    if(name==='pet-ranking') {
      await page.evaluate(()=>{document.getElementById('group').textContent='测试分组';const button=document.createElement('button');button.textContent='测试分组';button.setAttribute('aria-selected','true');document.getElementById('group-options').append(button);document.getElementById('group-picker').open=true;});
      assert.deepEqual(await appearance(page,'#group-options button',selectionKeys),expectedSelection);
      const compact=await appearance(page,'#group-button',controlKeys);assert.equal(compact.minHeight,'24px');assert.equal(compact.borderRadius,expectedControl.borderRadius);
      assert.deepEqual(await appearance(page,'#group-button',['outlineColor','outlineWidth']),focus);
    } else if(name==='pet-accounts') {
      await page.evaluate(()=>{const button=document.createElement('button');button.className='ui-menu-item';button.setAttribute('aria-checked','true');button.textContent='测试账号 · 7d 剩余 70%';document.getElementById('accounts').append(button);});
      assert.deepEqual(await appearance(page,'#accounts button',selectionKeys),expectedSelection);
    } else if(name==='pet-menu') {
      await page.evaluate(()=>{const menu=document.createElement('div');menu.className='pet-menu-panel';const button=document.createElement('button');button.className='ui-menu-item';button.textContent='打开小屋';menu.append(button);document.getElementById('pet-menu').append(menu);});
      assert.equal((await appearance(page,'.ui-menu-item',['borderRadius'])).borderRadius,expectedSelection.borderRadius);
      await page.locator('button').focus();assert.deepEqual(await appearance(page,'button',['outlineColor','outlineWidth']),focus);
    } else {
      await page.evaluate(()=>{document.getElementById('pet-quota-extra-bars').append(document.getElementById('pet-quota-bar-template').content.cloneNode(true));});
      for(const selector of ['#pet-ranking-button','#pet-quota-refresh','.pet-quota-secondary [data-field="refresh"]'])assert.equal((await appearance(page,selector,['width','height'])).height,'23px');
    }
    await capture(page,name);
  }
  assert.deepEqual(errors,[]);
  console.log('Shared styles UI OK: controls, cards, alerts, selection and focus across windows; eight views at 860/1060px; compact pet controls');
  if(screenshots)console.log('Screenshots: '+screenshots);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
