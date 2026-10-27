'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-mail-ui-');
const bootstrap=path.join(dir,'bootstrap.cjs'),bin=path.join(dir,'agent-fixture');
fs.writeFileSync(bin,'#!'+process.execPath+'\n'+fs.readFileSync(path.join(root,'test/fixtures/wechat-agent.cjs'),'utf8'),{mode:0o700});
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');
fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,id==='mail']))));
// 仅隔离的测试进程替换 IMAP；使用合成邮件和凭据，不连接真实邮箱服务器。
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {Notification,safeStorage}=require('electron');Notification.isSupported=()=>false;
safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=> 'test';
safeStorage.encryptString=value=>Buffer.from(Buffer.from(value).toString('base64'));safeStorage.decryptString=value=>Buffer.from(value.toString(),'base64').toString();
const mail=require(${JSON.stringify(path.join(root,'src/channels/imap-mail.cjs'))}),create=mail.createMailReceiver;
global.mailSmoke={emails:[{id:'10:1',subject:'项目会议通知',from:'团队 <team@example.com>',date:'2026-10-19 10:30'}],reads:[],accounts:[],fail:false};
mail.createMailReceiver=options=>create({...options,imap:{
list:async config=>{if(config.password!=='fixture-app-password')throw Error('请检查客户端专用密码');global.mailSmoke.accounts.push({email:config.email,type:config.type,host:config.host,port:config.port});if(global.mailSmoke.fail)throw Error('连接失败，请检查网络');return {messages:global.mailSmoke.emails,hasMore:false,uidValidity:'10'};},
read:async(config,id)=>{global.mailSmoke.reads.push(id);return {id,body:'邮件原文 <script>window.mailExecuted=true</script>\\n会议时间：下午三点。',attachments:['议程.pdf']};}
}});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_CODEX_BIN:bin,WHALE_CURSOR_HOME:dir}});
  const errors=[];app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  await app.firstWindow();let panel;
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);await panel.locator('#nav-mail').click();
  assert.ok(await panel.locator('#home-view').isHidden());assert.ok(await panel.locator('#wechat-view').isHidden());
  assert.equal(await panel.locator('#mail-authorize').count(),0,'Open Platform app authorization must be removed');
  assert.ok(await panel.locator('#mail-settings').isHidden());
  assert.ok(await panel.locator('#mail-delete').isHidden(),'未选中邮件时不显示删除图标');
  // 空列表容器本来就是零高度；用用户能看到的空状态判断收件箱是否展开。
  assert.ok(await panel.locator('#mail-empty').isVisible());
  await panel.locator('#mail-inbox > summary').click();
  assert.ok(await panel.locator('#mail-empty').isHidden());
  await panel.locator('#mail-inbox > summary').click();
  assert.ok(await panel.locator('#mail-empty').isVisible());
  await panel.locator('#mail-options > summary').click();
  assert.equal(await panel.locator('#mail-message-limit').inputValue(),'20');
  assert.ok(await panel.locator('#mail-settings').isVisible());
  await panel.locator('#mail-options > summary').click();
  assert.ok(await panel.locator('#mail-settings').isHidden());
  await panel.locator('#mail-options > summary').click();
  await panel.locator('#mail-email').fill('owner@example.com');await panel.locator('#mail-password').fill('fixture-app-password');
  await panel.locator('#mail-connect').click();await panel.waitForFunction(async()=>(await window.whale.mail('snapshot')).value.state==='connected');
  assert.equal(await panel.locator('#mail-password').inputValue(),'');
  await panel.locator('#mail-password-toggle').click();
  await panel.waitForFunction(()=>document.querySelector('#mail-password').type==='text');
  assert.equal(await panel.locator('#mail-password').inputValue(),'fixture-app-password');
  await panel.locator('#mail-password-toggle').click();
  assert.equal(await panel.locator('#mail-password').getAttribute('type'),'password');
  assert.equal(await panel.locator('#mail-password').inputValue(),'');
  assert.equal((await panel.evaluate(async()=>window.whale.mail('snapshot'))).value.config.limit,20);
  assert.match(await panel.locator('#mail-account').textContent(),/owner@example.com/);
  assert.deepEqual((await app.evaluate(()=>global.mailSmoke.accounts))[0],{email:'owner@example.com',type:'feishu',host:'imap.feishu.cn',port:993});
  fs.mkdirSync(path.join(root,'out'),{recursive:true});
  // 仅检查邮箱配置的尺寸和展开交互，账号和密码仍使用隔离夹具。
  for(const width of [760,860,1060]){
    await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(640,600);win.setSize(width,900);},width);
    const layout=await panel.evaluate(()=>{
      const rect=id=>document.getElementById(id).getBoundingClientRect(),card=document.querySelector('.mail-config-card').getBoundingClientRect();
      return {width:innerWidth,height:card.height,tops:['mail-email','mail-type','mail-message-limit'].map(id=>rect(id).top),limitWidth:rect('mail-message-limit').width,overflow:document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth};
    });
    assert.equal(layout.width,width);assert.ok(layout.height<350,`邮箱配置在 ${width}px 下不应撑满页面：${layout.height}`);
    assert.ok(Math.max(...layout.tops)-Math.min(...layout.tops)<1,'邮箱、类型和数量应位于同一行');
    assert.ok(layout.limitWidth<=112);assert.equal(layout.overflow,false);
    assert.equal(await panel.locator('.mail-help').getAttribute('open'),null);
    await panel.screenshot({path:path.join(root,`out/mail-settings-${width}.png`),fullPage:true});
  }
  await panel.locator('.mail-help > summary').click();assert.ok(await panel.locator('.mail-help p').first().isVisible());
  await panel.locator('.mail-help > summary').click();
  await panel.locator('#mail-options > summary').click();
  assert.ok(await panel.locator('#mail-account').isVisible());assert.ok(await panel.locator('#mail-settings').isHidden());
  assert.ok((await panel.locator('.mail-config-card').boundingBox()).height<90);
  await panel.screenshot({path:path.join(root,'out/mail-settings-collapsed.png'),fullPage:true});
  await panel.locator('#mail-options > summary').click();
  assert.equal(await panel.locator('.mail-message').count(),1);
  await panel.locator('.mail-message').click();await panel.waitForFunction(()=>document.querySelector('#mail-body').textContent.includes('下午三点'));
  assert.ok(await panel.locator('.mail-message').evaluate(el=>el.parentElement.nextElementSibling===document.querySelector('#mail-detail')),'details must expand below the clicked email');
  await panel.locator('.mail-message').click();assert.ok(await panel.locator('#mail-detail').isHidden());
  await panel.locator('.mail-message').click();await panel.waitForFunction(()=>document.querySelector('#mail-body').textContent.includes('下午三点'));
  assert.equal(await panel.evaluate(()=>window.mailExecuted),undefined);assert.match(await panel.locator('#mail-attachments').textContent(),/议程.pdf/);
  const shared=await panel.evaluate(()=>window.whale.snapshot());assert.ok(!JSON.stringify(shared).includes('团队'));
  assert.ok(!JSON.stringify(await panel.evaluate(async()=>window.whale.mail('snapshot'))).includes('fixture-app-password'));
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));assert.ok(pet);
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.mail('snapshot');return 'allowed';}catch{return 'denied';}}),'denied');
  fs.mkdirSync(path.join(root,'out'),{recursive:true});await panel.screenshot({path:path.join(root,'out/mail-inbox.png'),fullPage:true});
  await app.evaluate(()=>global.mailSmoke.emails.unshift({id:'10:2',subject:'新邮件 <img src=x onerror=alert(1)>',from:'sender@example.com',date:'2026-10-19 11:00'}));
  await panel.locator('#mail-refresh').click();await panel.waitForFunction(()=>document.querySelectorAll('.mail-message').length===2);
  assert.equal(await panel.locator('.mail-message img').count(),0);
  await panel.locator('#mail-type').selectOption('custom');assert.ok(await panel.locator('#mail-server-fields').isVisible());
  await panel.locator('#mail-host').fill('imap.example.com');await panel.locator('#mail-port').fill('1993');
  await panel.locator('#mail-message-limit').fill('7');
  await panel.locator('#mail-password').fill('fixture-app-password');await panel.locator('#mail-connect').click();
  await panel.waitForFunction(async()=>(await window.whale.mail('snapshot')).value.state==='connected');
  assert.deepEqual((await app.evaluate(()=>global.mailSmoke.accounts)).at(-1),{email:'owner@example.com',type:'custom',host:'imap.example.com',port:1993});
  assert.equal((await panel.evaluate(async()=>window.whale.mail('snapshot'))).value.config.limit,7);
  assert.ok((await panel.locator('.mail-config-card').boundingBox()).height<420);
  await panel.screenshot({path:path.join(root,'out/mail-settings.png'),fullPage:true});
  await app.evaluate(()=>{global.mailSmoke.fail=true;});await panel.locator('#mail-refresh').click();
  await panel.waitForFunction(()=>document.querySelector('#mail-error').textContent.includes('连接失败'));
  await panel.locator('#mail-connect').click();await panel.waitForFunction(async()=>(await window.whale.mail('snapshot')).value.state==='paused');
  await panel.waitForFunction(()=>document.querySelector('#mail-config-card').dataset.paused==='true');
  assert.equal(await panel.locator('#mail-status').count(),0);
  assert.equal(await panel.locator('#mail-config-card').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(240, 242, 239)');
  assert.ok(await panel.locator('#mail-connect').isEnabled());
  assert.equal(await panel.locator('.mail-message').count(),2);assert.ok(await panel.locator('#mail-detail').isHidden());
  const readCount=(await app.evaluate(()=>global.mailSmoke.reads)).length;
  await panel.locator('.mail-message').first().click();await panel.waitForFunction(()=>document.querySelector('#mail-body').textContent.includes('下午三点'));
  assert.equal((await app.evaluate(()=>global.mailSmoke.reads)).length,readCount,'paused mail must read the local cache');
  const stored=fs.readFileSync(path.join(dir,'mail.enc'),'utf8');assert.ok(!stored.includes('fixture-app-password'));assert.ok(!stored.includes('会议时间'));
  assert.ok(await panel.getByRole('button',{name:'删除邮件',exact:true}).isVisible());
  assert.equal(await panel.locator('#mail-detail h2').count(),0,'正文不重复显示邮件标题');
  assert.equal(await panel.locator('.mail-message-row[data-selected="true"] > #mail-delete').count(),1,'删除图标属于选中的邮件行');
  for(const width of [760,1060]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,900),width);
    const heading=await panel.locator('.mail-message-row[data-selected="true"]').boundingBox(),trash=await panel.locator('#mail-delete').boundingBox();
    assert.ok(trash.x+trash.width<=heading.x+heading.width+1);assert.ok(trash.y>=heading.y);
    await panel.screenshot({path:path.join(root,`out/mail-delete-${width}.png`),fullPage:true});
  }
  await panel.locator('#mail-delete').click();const confirmation=panel.getByRole('alertdialog');
  assert.match(await confirmation.innerText(),/原邮箱中的邮件保留/);
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await panel.locator('.mail-message').count(),2);
  assert.ok(await panel.locator('#mail-detail').isVisible());
  await panel.locator('#mail-delete').click();await panel.getByRole('alertdialog').getByRole('button',{name:'删除邮件',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelectorAll('.mail-message').length===1);
  assert.ok(await panel.locator('#mail-detail').isHidden());assert.ok(await panel.locator('#mail-delete').isHidden());
  assert.equal((await app.evaluate(()=>global.mailSmoke.emails)).length,2,'本地删除不改动原邮箱夹具');
  await app.evaluate(()=>{global.mailSmoke.fail=false;});await panel.locator('#mail-connect').click();
  await panel.waitForFunction(async()=>(await window.whale.mail('snapshot')).value.state==='connected');
  await panel.locator('#mail-refresh').click();
  await panel.waitForFunction(()=>!document.querySelector('#mail-refresh').disabled);
  assert.equal(await panel.locator('.mail-message').count(),1,'恢复接收和刷新后不重新显示已删除邮件');
  await panel.waitForFunction(()=>document.querySelector('#mail-config-card').dataset.paused==='false');
  assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[]);
  assert.deepEqual(errors,[]);console.log('mail UI smoke OK: compact settings, selected-mail delete icon, confirmation/cancel, cache removal and refresh persistence, address/type/password, custom IMAP, plaintext view, pause, IPC isolation, hidden windows');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await app?.close();fs.rmSync(dir,{recursive:true,force:true});});
