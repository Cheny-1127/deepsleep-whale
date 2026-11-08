'use strict';
// 独立数据、合成对话与网络替身；不读取真实 AI 账号，不操作正式桌宠。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-sessions-ui-')),bootstrap=path.join(dir,'bootstrap.cjs'),output=path.join(root,'out/ai-sessions');
const {MODULE_IDS}=require('../../src/app/module-settings.cjs');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({showPanelOnStartup:true,sources:{codex:false,cursor:false},notifications:false,sound:false}));
fs.writeFileSync(path.join(dir,'modules.json'),JSON.stringify(Object.fromEntries(MODULE_IDS.map(id=>[id,false]))));
fs.writeFileSync(bootstrap,`
require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const electron=require('electron'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),key=Buffer.alloc(32,6);
electron.Notification.isSupported=()=>false;electron.shell.openExternal=async()=>{throw Error('测试不打开外部应用');};
electron.clipboard.writeText=text=>{global.copiedSessionId=text;};
const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:text=>{if(global.aiSessionSaveFailure)throw Error('fixture platform encryption failure');const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()]);},decryptString:raw=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString();}};
for(const [file,name] of [['store.cjs','createAiStore'],['session-store.cjs','createAiSessionStore']]){const module=require(path.join(${JSON.stringify(root)},'src/ai',file)),create=module[name];module[name]=options=>create({...options,safeStorage});}
global.aiRequests=[];global.aiProbeMode='ok';
electron.net.fetch=async(url,options)=>{
 if(url!=='https://ai.example.test/v1/responses'||options.method!=='POST'||options.redirect!=='error')throw Error('测试不访问外部网络');
 const body=JSON.parse(options.body);global.aiRequests.push(body);
 if(global.aiProbeMode==='hang')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 if(global.aiProbeMode==='save-failure')global.aiSessionSaveFailure=true;
 const last=body.input.at(-1).content;
 const text=global.aiProbeMode==='preview'?['可以，从左侧打开这段会话继续聊。','','1. 会话编号保持不变，标题也可以自己改。','2. 本机保存的历史会随下次请求一起发送。','3. 缓存是否命中，以下次请求返回的用量为准。'].join(String.fromCharCode(10)):last.includes('叫什么')?['项目名称是**鲸鱼**。','','1. 继续沿用这段会话。','2. 前面说过的内容会保留。'].join(String.fromCharCode(10)):last.includes('API')?'可以从这里继续讨论 API 接入。':['已记住：项目名称是**鲸鱼**。','','这是用于检查界面的示例对话。','','<script>window.__aiInjected=true</script>'].join(String.fromCharCode(10));
 return Response.json({status:'completed',output:[{type:'reasoning',encrypted_content:'opaque-fixture',summary:[]},{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}],usage:{input_tokens:1600,output_tokens:24,input_tokens_details:{cached_tokens:1280}}});
};
globalThis.fetch=async()=>{throw Error('测试不访问外部网络');};
require(${JSON.stringify(path.join(root,'src/clients/presence.cjs'))}).readClientPresence=async()=>({codex:false,cursor:false});
require(${JSON.stringify(path.join(root,'src/app/quota-config.cjs'))}).readQuotaConfig=()=>({tokenFile:${JSON.stringify(path.join(dir,'missing-token'))},baseUrl:'https://quota.example.test'});
require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
new (require('node:vm').Script)(fs.readFileSync(bootstrap,'utf8'),{filename:bootstrap});
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const config={baseUrl:'https://ai.example.test/v1',model:'fixture-model',protocol:'responses',reasoningEffort:'high',apiKey:'fixture-key'};
let app,panel,pet;const errors=[];
const api=(name,value)=>panel.evaluate(async({name,value})=>{const result=await window.whale.aiSessions(name,value);if(result.error)throw Error(result.error);return result.value;},{name,value});
async function launch(){
 app=await electron.launch({timeout:20000,executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_TEST_WINDOWS:'hidden',WHALE_DATA_DIR:dir,CODEX_HOME:dir,WHALE_CURSOR_HOME:dir,WHALE_CURSOR_STATE_DB:path.join(dir,'missing-state'),WHALE_QUOTA_API_KEY:'',WHALE_QUOTA_TOKEN_FILE:path.join(dir,'missing-token')}});
 app.context().setDefaultTimeout(10000);app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
 await app.firstWindow();for(let i=0;i<100;i++){panel=app.windows().find(p=>p.url().endsWith('/index.html'));pet=app.windows().find(p=>p.url().endsWith('/pet.html'));if(panel&&pet)break;await new Promise(resolve=>setTimeout(resolve,30));}
 assert.ok(panel&&pet);await panel.waitForFunction(()=>document.getElementById('sidebar-organize')?.disabled===false);if(!await panel.locator('#nav-ai-sessions').isVisible())await panel.locator('#sidebar-more-toggle').click();await panel.locator('#nav-ai-sessions').click();await panel.waitForFunction(()=>!document.getElementById('ai-sessions-view').hidden);
}
async function rename(title){await panel.locator('#ai-session-rename').click();await panel.locator('#ai-session-rename-input').fill(title);await panel.locator('#ai-session-rename-save').click();await panel.waitForFunction(()=>!document.getElementById('ai-session-rename-dialog').open);await panel.waitForFunction(title=>document.getElementById('ai-session-title').textContent===title,title);}
async function send(text){await panel.locator('#ai-session-input').fill(text);await panel.locator('#ai-session-send').click();await panel.waitForFunction(()=>document.getElementById('ai-session-stop').hidden&&document.getElementById('ai-session-send').hidden===false);}
async function policy(){const value=await app.evaluate(({BrowserWindow})=>({events:global.testWindowPolicy.events,windows:BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused(),top:w.isAlwaysOnTop()}))}));assert.deepEqual(value.events,[]);assert.ok(value.windows.every(w=>!w.visible&&!w.focused&&!w.top));}
(async()=>{try{
 await launch();await panel.locator('#ai-session-notice:not([hidden])').waitFor();assert.match(await panel.locator('#ai-session-notice').innerText(),/右上角「配置」/);
 await panel.locator('#ai-session-new').click();await panel.locator('#ai-session-id:not([hidden])').waitFor();const first=(await api('list')).sessions[0].id;assert.equal(await panel.locator('#ai-session-input').isDisabled(),true);
 await panel.locator('#ai-settings-open').click();await panel.waitForFunction(()=>document.getElementById('ai-settings-dialog').open);await panel.locator('#ai-settings-cancel').click();
 await panel.evaluate(config=>window.whale.ai('save',config),config);await panel.waitForFunction(()=>!document.getElementById('ai-session-input').disabled);
 await send('项目名称是鲸鱼，请帮我记住。');await panel.waitForFunction(()=>document.querySelectorAll('.session-message[data-role="assistant"]').length===1);
 assert.equal(await panel.evaluate(()=>window.__aiInjected),undefined);assert.equal(await panel.locator('#ai-session-messages script').count(),0);assert.ok(!(await panel.locator('#ai-session-messages').innerText()).includes('opaque-fixture'));
 await rename('鲸鱼项目讨论（示例）');await panel.locator('#ai-session-id').click();assert.equal(await app.evaluate(()=>global.copiedSessionId),first);
 const file=path.join(dir,'ai-sessions.enc');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.readFileSync(file).includes(Buffer.from('项目名称是鲸鱼')),false);
 await panel.locator('#ai-session-new').click();await panel.waitForFunction(()=>document.getElementById('ai-session-title').textContent==='新会话');const second=(await api('list')).sessions.find(s=>s.id!==first).id;
 await panel.locator('#ai-session-input').fill('保留未发送的草稿');await panel.locator('[data-session-id="'+first+'"]').click();await panel.waitForFunction(()=>document.getElementById('ai-session-title').textContent==='鲸鱼项目讨论（示例）');
 await panel.locator('[data-session-id="'+second+'"]').click();await panel.waitForFunction(()=>document.getElementById('ai-session-input').value==='保留未发送的草稿');await rename('API 接入（示例）');await send('讨论 API 接入');
 await panel.locator('#ai-session-search').fill('鲸鱼');assert.equal(await panel.locator('.sessions-history-item').count(),1);await panel.locator('#ai-session-search').fill('');
 await panel.locator('[data-session-id="'+first+'"]').click();await panel.waitForFunction(()=>document.getElementById('ai-session-title').textContent==='鲸鱼项目讨论（示例）');await send('这个项目叫什么？');
 const calls=await app.evaluate(()=>global.aiRequests);assert.equal(calls.length,3);assert.equal(calls[2].input[0].content,'项目名称是鲸鱼，请帮我记住。');assert.equal(calls[2].input[1].encrypted_content,'opaque-fixture');assert.equal(calls[0].prompt_cache_key,calls[2].prompt_cache_key);assert.notEqual(calls[0].prompt_cache_key,calls[1].prompt_cache_key);assert.equal(await panel.locator('.session-message-body ol li').count(),2);
 assert.match(await panel.locator('#ai-session-usage').innerText(),/缓存读取 1280 tokens/);assert.ok(!JSON.stringify(await panel.evaluate(()=>window.whale.snapshot())).includes('项目名称是鲸鱼，请帮我记住。'));
 await app.evaluate(()=>global.aiProbeMode='hang');await panel.locator('#ai-session-input').fill('停止测试');await panel.locator('#ai-session-send').click();await panel.locator('#ai-session-stop:not([hidden])').waitFor();
 await panel.waitForFunction(async()=>{const list=(await window.whale.aiSessions('list')).value;return list.sessions.some(s=>s.busy);});await panel.locator('#ai-session-stop').click();await panel.locator('[data-retry]').waitFor();
 assert.equal((await api('get',{id:first})).messages.length,5);await app.evaluate(()=>global.aiProbeMode='ok');await panel.locator('[data-retry]').click();await panel.waitForFunction(()=>document.getElementById('ai-session-stop').hidden);assert.equal((await api('get',{id:first})).messages.length,6);
 await app.evaluate(()=>global.aiProbeMode='save-failure');await send('验证收到回复后保存失败');await panel.locator('#ai-session-persist:not([hidden])').waitFor();const count=(await app.evaluate(()=>global.aiRequests)).length;assert.match(await panel.locator('#ai-session-error').innerText(),/不要重新请求/);
 await app.evaluate(()=>global.aiSessionSaveFailure=false);await panel.locator('#ai-session-persist').click();await panel.waitForFunction(()=>document.getElementById('ai-session-persist').hidden);assert.equal((await app.evaluate(()=>global.aiRequests)).length,count);await app.evaluate(()=>global.aiProbeMode='ok');
 await panel.evaluate(config=>window.whale.ai('save',{...config,model:'changed-model'}),config);await panel.waitForFunction(()=>document.getElementById('ai-session-notice').textContent.includes('不一致'));assert.equal(await panel.locator('#ai-session-input').isDisabled(),true);await panel.evaluate(config=>window.whale.ai('save',config),config);await panel.waitForFunction(()=>!document.getElementById('ai-session-input').disabled);
 await assert.rejects(pet.evaluate(()=>window.whale.aiSessions('list')),/仅允许在小屋/);
 await policy();await app.close();app=null;await launch();await panel.waitForFunction(()=>document.querySelectorAll('.session-message').length===8);assert.equal((await api('list')).sessions.length,2);assert.equal((await api('get',{id:first})).messages.length,8);assert.equal((await app.evaluate(()=>global.aiRequests)).length,0);
 for(const [width,height] of [[1060,770],[860,680]]){
  await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,height),{width,height});
  const geometry=await panel.locator('.sessions-layout').evaluate(el=>{const r=el.getBoundingClientRect();return {right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth};});
  assert.ok(geometry.right<=geometry.width&&geometry.bottom<=geometry.height&&!geometry.overflow,JSON.stringify(geometry));
 }
 await panel.locator('[data-session-id="'+second+'"]').click();await panel.waitForFunction(()=>document.getElementById('ai-session-title').textContent==='API 接入（示例）');await panel.locator('#ai-session-delete').click();await panel.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal((await api('list')).sessions.length,2);
 await panel.locator('#ai-session-delete').click();await panel.getByRole('alertdialog').getByRole('button',{name:'删除会话',exact:true}).click();await panel.waitForFunction(()=>document.querySelectorAll('.sessions-history-item').length===1);assert.equal((await api('get',{id:first})).messages.length,8);
 await app.evaluate(()=>global.aiProbeMode='preview');await panel.locator('#ai-session-new').click();await panel.waitForFunction(()=>document.getElementById('ai-session-title').textContent==='新会话');await send('过几天想接着聊 API 接入，怎么找回这段对话？');await panel.waitForFunction(()=>document.querySelectorAll('.session-message[data-role="assistant"]').length===1);await rename('API 接入讨论（示例）');
 for(const [width,height] of [[1060,770],[860,680]]){
  await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(width,height),{width,height});
  await panel.locator('#nav-ai-sessions').scrollIntoViewIfNeeded();await panel.screenshot({path:path.join(output,'sessions-'+width+'.png')});
 }
 await policy();assert.deepEqual(errors,[]);console.log('AI sessions UI OK: hidden isolated history, settings, send/replay, titles/IDs/search/drafts, stop/retry, save recovery, connection isolation, restart, delete, Markdown safety, IPC privacy, 1060/860 layouts.');
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
