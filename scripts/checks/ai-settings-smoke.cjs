'use strict';
// 真实页面、IPC、加密落盘；窗口及全部账号、请求、数据均隔离。
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-ai-ui-'));
const bootstrap=path.join(dir,'bootstrap.cjs'),output=path.join(root,'out/ai-settings');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({showPanelOnStartup:true,sources:{codex:false,cursor:false},notifications:false,sound:false}));
fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,false]))));
fs.writeFileSync(bootstrap,`
require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const electron=require('electron'),crypto=require('node:crypto'),key=Buffer.alloc(32,8);
electron.Notification.isSupported=()=>false;electron.shell.openExternal=async()=>{throw Error('测试不打开外部应用');};
const store=require(${JSON.stringify(path.join(root,'src/ai/store.cjs'))}),makeStore=store.createAiStore;
store.createAiStore=options=>makeStore({...options,safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',
 encryptString:text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()]);},
 decryptString:raw=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString();}}});
global.aiRequests=[];global.aiProbeMode='ok';
electron.net.fetch=async(raw,options)=>{
 const url=new URL(raw);if(url.origin!=='https://ai.example.test'||options.method!=='POST'||options.redirect!=='error')throw Error('测试不访问外部网络');
 global.aiRequests.push({url:raw,body:JSON.parse(options.body)});
 if(global.aiProbeMode==='deny')return new Response('fixture-secret-key',{status:401});
 if(global.aiProbeMode==='hang')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 const payload=url.pathname.endsWith('/responses')?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}:{choices:[{finish_reason:'stop',message:{content:'OK'}}]};
 if(global.aiProbeMode==='cached')payload.usage={input_tokens:1600,output_tokens:1,input_tokens_details:{cached_tokens:1280}};
 return Response.json(payload);
};
globalThis.fetch=async()=>{throw Error('测试不访问外部网络');};
require(${JSON.stringify(path.join(root,'src/clients/presence.cjs'))}).readClientPresence=async()=>({codex:false,cursor:false});
require(${JSON.stringify(path.join(root,'src/app/quota-config.cjs'))}).readQuotaConfig=()=>({tokenFile:${JSON.stringify(path.join(dir,'missing-token'))},baseUrl:'https://quota.example.test'});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let app,panel,pet;const errors=[];
async function launch(){
 app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_TEST_WINDOWS:'hidden',WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_CURSOR_HOME:dir,WHALE_CURSOR_STATE_DB:path.join(dir,'missing-state'),WHALE_QUOTA_API_KEY:'',WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing-token')}});
 app.context().setDefaultTimeout(10000);app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
 await app.firstWindow();for(let i=0;i<100;i++){panel=app.windows().find(p=>p.url().endsWith('/index.html'));pet=app.windows().find(p=>p.url().endsWith('/pet.html'));if(panel&&pet)break;await new Promise(resolve=>setTimeout(resolve,30));}
 assert.ok(panel&&pet);await panel.waitForFunction(()=>document.getElementById('ai-settings-open')?.title.length>0);
}
const openAi=async()=>{if(!await panel.locator('#nav-ai-sessions').isVisible())await panel.locator('#sidebar-more-toggle').click();await panel.locator('#nav-ai-sessions').click();};
const open=async()=>{if(!await panel.locator('#ai-sessions-view').isVisible())await openAi();await panel.locator('#ai-settings-open').click();await panel.waitForFunction(()=>document.getElementById('ai-settings-dialog').open);};
const closed=()=>panel.waitForFunction(()=>!document.getElementById('ai-settings-dialog').open);
async function input(){await panel.locator('#ai-base-url').fill('https://ai.example.test/gateway/v1');await panel.locator('#ai-api-key').fill('fixture-secret-key');await panel.locator('#ai-model').fill('sample-model');}
async function policy(){const result=await app.evaluate(({BrowserWindow})=>({events:global.testWindowPolicy.events,windows:BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused(),top:w.isAlwaysOnTop()}))}));assert.deepEqual(result.events,[]);assert.ok(result.windows.every(w=>!w.visible&&!w.focused&&!w.top));}
async function checkFeatures(){
 const entry=panel.locator('#nav-ai-sessions');
 assert.equal(await panel.locator('#ai-features-menu,#ai-features-open,.side-bottom [data-view]').count(),0);
 assert.equal(await entry.getAttribute('aria-haspopup'),null);
 await panel.waitForFunction(()=>!document.getElementById('sidebar-organize').disabled);
 const layout=await panel.evaluate(()=>window.whale.sidebar());assert.equal(layout.visible.includes('ai-sessions'),false);assert.ok(layout.more.includes('ai-sessions'));assert.equal(await panel.locator('#sidebar-more-list #nav-ai-sessions').count(),1);
 await openAi();await panel.locator('#ai-session-notice:not([hidden])').waitFor();
 assert.equal(await panel.locator('#ai-sessions-heading').innerText(),'AI 功能');
 assert.equal(await panel.locator('#ai-sessions-view > header #ai-settings-open').innerText(),'配置');
 assert.equal(await entry.getAttribute('aria-current'),'page');assert.equal(await panel.locator('#sidebar-more-toggle').evaluate(node=>node.classList.contains('contains-selected')),true);
 assert.equal(await panel.evaluate(()=>document.getElementById('ai-settings-dialog').open),false);
 assert.equal(await panel.locator('.sessions-history').isVisible(),true);assert.equal(await panel.locator('.sessions-chat').isVisible(),true);
 await open();await input();await panel.locator('#ai-settings-save').click();await closed();
 assert.equal(await panel.evaluate(()=>document.activeElement.id),'ai-settings-open');
 assert.equal(await panel.locator('#ai-settings-status').innerText(),'已配置');assert.equal(await entry.getAttribute('data-configured'),'true');
 await panel.locator('#nav-home').click();assert.equal(await panel.locator('#ai-sessions-view').isVisible(),false);assert.equal(await entry.getAttribute('aria-current'),null);
 await entry.focus();await panel.keyboard.press('Enter');await panel.waitForFunction(()=>!document.getElementById('ai-sessions-view').hidden);
 assert.equal(await entry.getAttribute('aria-current'),'page');
 await panel.locator('#ai-settings-open').focus();await panel.keyboard.press('Enter');await panel.waitForFunction(()=>document.getElementById('ai-settings-dialog').open);
 assert.equal(await panel.locator('#ai-model').inputValue(),'sample-model');await panel.keyboard.press('Escape');await closed();
 assert.equal(await panel.evaluate(()=>document.activeElement.id),'ai-settings-open');
 for(const [width,height] of [[1060,770],[860,680]]){
  await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,height),{width,height});
  await panel.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await panel.locator('#nav-ai-sessions').scrollIntoViewIfNeeded();
  const geometry=await panel.evaluate(()=>{
   const sidebar=document.querySelector('.sidebar'),entry=document.getElementById('nav-ai-sessions').getBoundingClientRect(),content=document.querySelector('.sessions-layout').getBoundingClientRect(),main=document.querySelector('main');
   return {scrollHeight:sidebar.scrollHeight,clientHeight:sidebar.clientHeight,scrollTop:sidebar.scrollTop,overflow:getComputedStyle(sidebar).overflowY,entryTop:entry.top,entryBottom:entry.bottom,right:content.right,bottom:content.bottom,width:innerWidth,height:innerHeight,mainOverflow:main.scrollWidth>main.clientWidth};
  });
  assert.equal(geometry.overflow,'auto','侧栏恢复原有独立滚动');assert.ok(geometry.entryTop>=0&&geometry.entryBottom<=geometry.height,'AI 入口可滚动到窗口内 '+JSON.stringify(geometry));
  assert.ok(geometry.right<=geometry.width&&geometry.bottom<=geometry.height&&!geometry.mainOverflow,'配置入口与会话完整显示 '+JSON.stringify(geometry));
  await panel.screenshot({path:path.join(output,`features-${width}.png`)});
 }
 assert.equal((await app.evaluate(()=>global.aiRequests)).length,0,'页面验证不请求模型');
}
(async()=>{try{
 if(process.env.WHALE_AI_FEATURES_ONLY==='1'){
  // 模拟旧版将 AI 会话收进更多的配置，检查升级后的整理与跳转。
  fs.writeFileSync(path.join(dir,'sidebar.json'),JSON.stringify({visible:['home','subscriptions','quota','shortcuts','planner','reports'],more:['hooks','wechat','mail','archery','ai-sessions']}));
  await launch();await checkFeatures();await policy();assert.deepEqual(errors,[]);
  console.log('AI features page UI OK: hidden isolated instance; direct navigation, header configuration, save/cancel/focus, keyboard navigation, AI inside More, original scrolling sidebar and 1060/860 layouts.');return;
 }
 await launch();
 assert.equal(await panel.locator('#ai-settings-status').innerText(),'未配置');await open();await input();assert.equal(await panel.locator('#ai-effort-selected').innerText(),'模型默认');
 await panel.locator('#ai-settings-test').click();await panel.locator('#ai-settings-feedback:not([hidden])').waitFor();assert.ok(!fs.existsSync(path.join(dir,'ai-config.enc')));
 assert.match(await panel.locator('#ai-settings-feedback').innerText(),/上游未返回缓存命中数据/);
 assert.equal((await app.evaluate(()=>global.aiRequests)).length,1);assert.deepEqual((await app.evaluate(()=>global.aiRequests))[0].body.messages,[{role:'user',content:'请只回复 OK。'}]);assert.equal(Object.hasOwn((await app.evaluate(()=>global.aiRequests))[0].body,'reasoning_effort'),false);
 await panel.locator('#ai-settings-save').click();await closed();assert.equal(await panel.locator('#ai-settings-status').innerText(),'已配置');
 const file=path.join(dir,'ai-config.enc');assert.ok(!fs.readFileSync(file).includes(Buffer.from('fixture-secret-key')));
 await open();assert.equal(await panel.locator('#ai-api-key').inputValue(),'');assert.equal(await panel.locator('#ai-api-key').getAttribute('type'),'password');assert.match(await panel.locator('#ai-api-key').getAttribute('placeholder'),/已保存/);
 await panel.locator('#ai-base-url').fill('https://other.example.test/v1');await panel.locator('#ai-settings-test').click();await panel.locator('#ai-settings-error:not([hidden])').waitFor();assert.match(await panel.locator('#ai-settings-error').innerText(),/更换.*地址.*密钥/);assert.equal((await app.evaluate(()=>global.aiRequests)).length,1);
 await panel.keyboard.press('Escape');await closed();await open();assert.equal(await panel.locator('#ai-base-url').inputValue(),'https://ai.example.test/gateway/v1');
 await app.evaluate(()=>global.aiProbeMode='deny');await panel.locator('#ai-settings-test').click();await panel.locator('#ai-settings-error:not([hidden])').waitFor();assert.ok(!(await panel.locator('#ai-settings-dialog').innerText()).includes('fixture-secret-key'));
 await app.evaluate(()=>global.aiProbeMode='cached');await panel.locator('#ai-protocol-trigger').focus();await panel.keyboard.press('ArrowDown');await panel.locator('#ai-protocol-options').getByRole('option',{name:'Responses',exact:true}).click();
 await panel.locator('#ai-effort-trigger').focus();await panel.keyboard.press('ArrowDown');await panel.locator('#ai-effort-options').getByRole('option',{name:'极高（xhigh）',exact:true}).click();
 await panel.locator('#ai-settings-test').click();await panel.locator('#ai-settings-feedback:not([hidden])').waitFor();const probe=(await app.evaluate(()=>global.aiRequests)).at(-1);assert.ok(probe.url.endsWith('/responses'));assert.deepEqual(probe.body.reasoning,{effort:'xhigh'});
 assert.match(probe.body.prompt_cache_key,/^whale-v1-[a-f0-9]+$/);assert.match(await panel.locator('#ai-settings-feedback').innerText(),/缓存读取 1280 tokens/);
 assert.equal((await panel.evaluate(()=>window.whale.ai('snapshot'))).value.reasoningEffort,'');
 await panel.locator('#ai-settings-save').click();await closed();
 await assert.rejects(pet.evaluate(()=>window.whale.ai('snapshot')),/仅允许在小屋/);
 const unsupported=await panel.evaluate(()=>window.whale.ai('generate',{prompt:'不得从页面调用'}));assert.match(unsupported.error,/不支持/);
 await open();for(const [width,height] of [[1060,770],[860,680]]){
  await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,height),{width,height});
  const bounds=await panel.locator('#ai-settings-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:el.scrollWidth>el.clientWidth};});
  assert.ok(bounds.left>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height&&!bounds.overflow);await panel.screenshot({path:path.join(output,`settings-${width}.png`)});
  await panel.locator('#ai-effort-trigger').click();await panel.locator('#ai-effort-options').getByRole('option',{name:'模型默认',exact:true}).waitFor();
  const menu=await panel.locator('#ai-effort-options').evaluate(el=>{const r=el.getBoundingClientRect();return {top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});assert.ok(menu.top>=0&&menu.right<=menu.width&&menu.bottom<=menu.height);await panel.screenshot({path:path.join(output,`effort-${width}.png`)});await panel.keyboard.press('Escape');
 }
 await panel.locator('#ai-effort-trigger').click();await panel.locator('#ai-effort-options').getByRole('option',{name:'低（low）',exact:true}).click();await panel.locator('#ai-settings-cancel').click();await closed();await open();assert.equal(await panel.locator('#ai-effort-selected').innerText(),'极高（xhigh）');
 await app.evaluate(()=>global.aiProbeMode='hang');await panel.locator('#ai-settings-test').click();await panel.waitForFunction(()=>document.getElementById('ai-settings-test').textContent==='测试中…');await panel.keyboard.press('Escape');await closed();
 await panel.waitForFunction(async()=>!(await window.whale.ai('snapshot')).value.busy);
 await policy();await app.close();app=null;await launch();assert.equal(await panel.locator('#ai-settings-status').innerText(),'已配置');await open();assert.equal(await panel.locator('#ai-api-key').inputValue(),'');assert.equal(await panel.locator('#ai-protocol-selected').innerText(),'Responses');assert.equal(await panel.locator('#ai-effort-selected').innerText(),'极高（xhigh）');
 await panel.locator('#ai-settings-clear').click();await panel.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();assert.ok(fs.existsSync(file));
 await panel.locator('#ai-settings-clear').click();await panel.getByRole('alertdialog').getByRole('button',{name:'清除配置',exact:true}).click();await closed();assert.ok(!fs.existsSync(file));assert.equal(await panel.locator('#ai-settings-status').innerText(),'未配置');
 await policy();assert.deepEqual(errors,[]);console.log('Global AI settings UI OK: isolated encryption, reasoning defaults/probe/save/cancel/restart, address binding, errors, shared protocols, cancellation, clear, IPC, 1060/860 hidden layouts.');
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
