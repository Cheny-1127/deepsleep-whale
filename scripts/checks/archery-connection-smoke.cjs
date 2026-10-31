'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-archery-source-ui-'),bootstrap=path.join(dir,'bootstrap.cjs');
const codexDir=path.join(dir,'chosen-codex');fs.mkdirSync(codexDir);const configFile=path.join(codexDir,'config.toml');
const install=path.join(dir,'archery'),bin=path.join(install,'bin');fs.mkdirSync(bin,{recursive:true});
fs.writeFileSync(path.join(install,'pyvenv.cfg'),'home = /synthetic/python\n');
fs.writeFileSync(path.join(install,'.env'),'ARCHERY_BASE_URL=https://fixture.example.com\nARCHERY_USERNAME=fixture-user\nARCHERY_PASSWORD=fixture-secret\n');
const command=path.join(bin,'archery-mcp');
const toml=`[mcp_servers.archery]\ncommand=${JSON.stringify(command)}\n`;fs.writeFileSync(configFile,toml);
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,id==='archery']))));
// 隔离窗口仅使用合成配置与本地 MCP 替身，不读取正式账号或执行工单。
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {Notification,dialog,shell}=require('electron');shell.showItemInFolder=file=>{global.connectionSmoke.opened.push(file);};shell.openPath=()=>{throw Error('不得启动默认编辑器');};Notification.isSupported=()=>false;
global.connectionSmoke={accounts:[],selected:[],opened:[],closed:0};
dialog.showOpenDialog=async options=>{global.connectionSmoke.selected.push(options);return {canceled:false,filePaths:[${JSON.stringify(configFile)}]};};
// 内置实现会分别读取待审核与待执行列表，合成分页也必须符合各自的协议。
require(${JSON.stringify(path.join(root,'src/channels/archery-mcp.cjs'))}).createArcheryMcp=config=>({close(){global.connectionSmoke.closed++;},async pending(page,{mode='approve'}={}){global.connectionSmoke.accounts.push({command:config.server.command,env:config.server.env,mode});return {structuredContent:{status:'success',data:{items:[],pagination:{page,page_size:20,total:mode==='execute'?0:null,source_total:0,has_more:false,next_page:null,scope:mode==='execute'?'matching_orders':'source_page_filtered'}}}};}});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
let app;
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,CODEX_HOME:dir}});
  await app.firstWindow();let panel;
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);const errors=[];panel.on('pageerror',error=>errors.push(error.message));await panel.locator('#nav-archery').click();
  assert.equal(await panel.locator('#nav-plugins,#plugins-view,#plugin-view').count(),0,'正式小屋不接入插件管理或子页面');
  assert.equal(await panel.evaluate(()=>typeof window.whale.plugins),'undefined','正式 preload 不暴露插件管理通道');
  const loaded=await app.evaluate((_electron,file)=>Object.keys(process.getBuiltinModule('node:module').createRequire(file).cache),path.join(root,'src/main.cjs'));
  assert.equal(loaded.some(file=>file.endsWith('/plugin-host.cjs')||file.endsWith('/plugin-store.cjs')),false,'正式启动不加载插件宿主');
  assert.equal(loaded.some(file=>file.endsWith('/archery-pending.cjs')),true,'Archery 使用随应用携带的内置实现');
  await panel.waitForFunction(()=>document.querySelector('#archery-connection-options').open);
  assert.equal(await panel.locator('#archery-connection-state').textContent(),'未配置');
  assert.deepEqual(await app.evaluate(()=>global.connectionSmoke.accounts),[]);
  await panel.locator('#archery-choose-config').click();assert.equal(await panel.locator('#archery-config-file').inputValue(),configFile);
  await panel.locator('#archery-save-config').click();await panel.waitForFunction(()=>document.querySelector('#archery-connection-state').textContent==='已连接'&&document.querySelector('#archery-save-config').disabled&&!document.querySelector('#archery-connection-options').open);
  assert.deepEqual(await app.evaluate(()=>global.connectionSmoke.accounts),[{command,env:{},mode:'approve'},{command,env:{},mode:'execute'}]);
  assert.equal(await panel.locator('#archery-status').textContent(),'已连接');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'archery-connection.json'))),{configFile});assert.equal(fs.readFileSync(configFile,'utf8'),toml);
  const connection=(await panel.evaluate(()=>window.whale.archery('connection'))).value;assert.equal(connection.configFile,configFile);assert.doesNotMatch(JSON.stringify(connection),/fixture-secret|fixture-user/);
  assert.equal(await panel.locator('#archery-save-config').textContent(),'已连接');
  await panel.locator('#archery-connection-options summary').click();
  assert.equal(await panel.locator('#archery-open-config').textContent(),'在文件夹中显示');
  await panel.locator('#archery-open-config').click();assert.deepEqual(await app.evaluate(()=>global.connectionSmoke.opened),[configFile]);
  await panel.locator('#archery-config-file').fill(path.join(dir,'missing','config.toml'));
  assert.equal(await panel.locator('#archery-save-config').textContent(),'保存并连接');assert.equal(await panel.locator('#archery-save-config').isEnabled(),true);
  await panel.locator('#archery-save-config').click();
  await panel.waitForFunction(()=>document.querySelector('#archery-connection-feedback').textContent.includes('无法读取'));
  assert.equal((await panel.evaluate(()=>window.whale.archery('connection'))).value.configFile,configFile);
  assert.equal(await panel.locator('#archery-config-file').inputValue(),path.join(dir,'missing','config.toml'),'校验失败保留草稿');
  await panel.locator('#archery-choose-config').click();
  assert.equal(await panel.locator('#archery-save-config').textContent(),'已连接');assert.equal(await panel.locator('#archery-save-config').isDisabled(),true);
  assert.doesNotMatch(await panel.locator('#archery-connection-feedback').textContent(),/无法读取|路径尚未保存/);
  for(const width of [760,1060]){
    await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/index.html'));win.setMinimumSize(640,600);win.setSize(width,900);},width);
    assert.equal(await panel.evaluate(()=>document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth),false);
    fs.mkdirSync(path.join(root,'out'),{recursive:true});await panel.screenshot({path:path.join(root,'out/archery-connection-'+width+'.png'),fullPage:true});
  }
  await panel.locator('#archery-default-config').click();assert.equal(await panel.locator('#archery-config-file').inputValue(),path.join(dir,'config.toml'));
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));assert.equal(await pet.evaluate(async()=>{try{await window.whale.archery('connection');return 'allowed';}catch{return 'denied';}}),'denied');
  assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[]);assert.deepEqual(errors,[]);
  console.log('Archery connection UI OK: existing MCP launch without duplicate credentials, file reveal without editor, accurate state, rejected-save preservation, IPC isolation, hidden layouts');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await app?.close();fs.rmSync(dir,{recursive:true,force:true});});
