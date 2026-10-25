'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-wechat-ui-');
const bin=path.join(dir,'agent-fixture'),bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bin,'#!'+process.execPath+'\n'+fs.readFileSync(path.join(root,'test/fixtures/wechat-agent.cjs'),'utf8'),{mode:0o700});
const secondHome=path.join(dir,'second-home');fs.mkdirSync(secondHome);
const discovered={defaults:{codexBinary:bin,codexHome:dir,cursorBinary:bin},message:'发现 4 个运行中的客户端。',clients:[
  {key:'default',name:'Codex',backend:'codex',binary:bin,configHome:dir,profile:'',available:true,description:'沿用默认配置'},
  {key:'second',name:'第二个 Codex',backend:'codex',binary:bin,configHome:secondHome,profile:'',available:true,description:'沿用另一个目录'},
  {key:'cursor',name:'Cursor CLI',backend:'cursor',binary:bin,configHome:'',profile:'',available:true,description:'通过 CLI 接入，不读取编辑器已有对话'},
  {key:'unknown',name:'未知 Codex',backend:'codex',binary:'',configHome:'',profile:'',available:false,reason:'无法确定配置目录，请自定义添加'}
]};
// Injection lives only in this isolated test bootstrap. Production has no test URLs or plaintext-storage switch.
fs.writeFileSync(bootstrap,`const {net,safeStorage}=require('electron');
safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=> 'test';
safeStorage.encryptString=s=>Buffer.from(Buffer.from(s).toString('base64'));safeStorage.decryptString=b=>Buffer.from(b.toString(),'base64').toString();
global.wechatSmoke={queue:[],sent:[],typing:[],confirmed:false,failSend:false,loginBot:'fixture-bot'};
require(${JSON.stringify(path.join(root,'src/clients/discovery.cjs'))}).discoverRunningClients=async()=>{if(global.wechatSmoke.failDiscovery)throw Error('检测失败，请重试');return ${JSON.stringify(discovered)};};
net.fetch=async(url,options)=>{const s=global.wechatSmoke;let data={};
if(url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/download?')){if(options.headers)throw Error('CDN must not receive bot credentials');const cipher=require('node:crypto').createCipheriv('aes-128-ecb',Buffer.from('00112233445566778899aabbccddeeff','hex'),null),png=require('node:fs').readFileSync(${JSON.stringify(path.join(root,'assets/icon.png'))});s.imageRequests=(s.imageRequests||0)+1;return new Response(Buffer.concat([cipher.update(png),cipher.final()]));}
else if(url.endsWith('getuploadurl')){s.avatarUploadRequest=JSON.parse(options.body);data={upload_param:'fixture-preview-upload'};}
else if(url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/upload?')){if(options.headers.Authorization||options.redirect!=='error')throw Error('unsafe avatar upload');const decipher=require('node:crypto').createDecipheriv('aes-128-ecb',Buffer.from(s.avatarUploadRequest.aeskey,'hex'),null);s.previewBytes=Buffer.concat([decipher.update(options.body),decipher.final()]).toString('base64');s.previewUploads=(s.previewUploads||0)+1;return new Response('',{headers:{'x-encrypted-param':'fixture-preview-download'}});}
else if(url.includes('get_bot_qrcode'))data={qrcode:'hidden-poll-token',qrcode_img_content:'https://example.test/wechat-test-qr'};
else if(url.includes('get_qrcode_status'))data=s.confirmed?{status:'confirmed',ilink_bot_id:s.loginBot,bot_token:s.loginToken||(s.loginBot==='fixture-bot'?'hidden-bot-token':'hidden-bot-token-2'),ilink_user_id:'fixture-owner',baseurl:'https://ilinkai.weixin.qq.com'}:{status:'wait'};
else if(url.endsWith('getupdates')){s.lastPollToken=options.headers.Authorization;const bot=s.lastPollToken==='Bearer hidden-bot-token-2'?'fixture-bot-2':'fixture-bot';if(s.lastPollToken==='Bearer '+s.invalidToken)data={ret:-14};else{data={msgs:s.queue.filter(m=>m.to_user_id===bot),get_updates_buf:'fixture-cursor'};s.queue=s.queue.filter(m=>m.to_user_id!==bot);}}
else if(url.endsWith('getconfig'))data={typing_ticket:'fixture-typing-ticket'};
else if(url.endsWith('sendtyping'))s.typing.push(JSON.parse(options.body));
else if(url.endsWith('sendmessage')){if(s.failSend)throw Error('fixture offline');s.lastSendToken=options.headers.Authorization;s.sent.push(JSON.parse(options.body).msg);}
else throw Error('Unexpected network call in fixture');return {ok:true,text:async()=>JSON.stringify(data)};};
require(${JSON.stringify(path.join(root,'test/fixtures/codex-desktop.cjs'))}).desktopFixture({home:${JSON.stringify(dir)},cwd:require('node:fs').realpathSync(${JSON.stringify(dir)}),autoComplete:true}).then(desktop=>{global.desktopSmoke=desktop;require(${JSON.stringify(path.join(root,'src/main.cjs'))});});`);
let app;
async function waitSnapshot(panel,check) {
  for(let i=0;i<600;i++){const snapshot=await panel.evaluate(()=>window.whale.snapshot());if(check(snapshot))return snapshot;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.fail('snapshot condition timed out: '+JSON.stringify((await panel.evaluate(()=>window.whale.snapshot())).wechat));
}
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,WHALE_DATA_DIR:dir,WHALE_CODEX_BIN:bin,CODEX_HOME:dir,WHALE_CURSOR_HOME:dir,WHALE_AGENT_FIXTURE_LOG:path.join(dir,'agent-wire.jsonl'),WHALE_AGENT_FIXTURE_CWD:dir}});
  const errors=[];app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  await app.firstWindow();let panel;
  for(let i=0;i<100;i++){panel=app.windows().find(page=>page.url().endsWith('/index.html'));if(panel)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(panel);await panel.locator('#nav-wechat').click();await waitSnapshot(panel,s=>Boolean(s.wechat));
  assert.ok(await panel.locator('#home-view').isHidden());assert.ok(await panel.locator('#hooks-view').isHidden());
  assert.equal(await panel.locator('#wechat-cwd').count(),0);assert.equal(await panel.locator('#wechat-client-options').isVisible(),false);
  assert.equal(await panel.locator('#wechat-settings-dialog').isVisible(),false);
  // No project/client setup is needed before scanning.
  await panel.locator('#wechat-login').click();await panel.waitForFunction(()=>document.querySelector('#wechat-qr').src.startsWith('data:image/png;base64,'));
  fs.mkdirSync(path.join(root,'out'),{recursive:true});await panel.screenshot({path:path.join(root,'out/wechat-login.png'),fullPage:true});
  await app.evaluate(()=>{global.wechatSmoke.confirmed=true;});await panel.waitForFunction(()=>document.querySelector('#wechat-status').textContent==='已连接');
  const snapshot=await panel.evaluate(()=>window.whale.snapshot());assert.ok(!JSON.stringify(snapshot).includes('hidden-bot-token'));assert.ok(snapshot.wechat.allowed.includes('fixture-owner'));
  // 微信本人通过文字菜单修改资料，头像走实际 CDN 解密与 Electron 缩放，电脑端即时同步。
  let profileMessage=0;
  async function profileSend(text,image){
    const count=await app.evaluate(()=>global.wechatSmoke.sent.filter(item=>item.item_list?.[0]?.type===1).length);
    await app.evaluate((_electron,{text,image,id})=>global.wechatSmoke.queue.push({message_id:id,message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text}},...(image?[{type:2,image_item:image}]:[])]}),{text,image,id:'profile-'+(++profileMessage)});
    for(let i=0;i<200;i++){if(await app.evaluate((_electron,count)=>global.wechatSmoke.sent.filter(item=>item.item_list?.[0]?.type===1).length>count,count))return;await panel.waitForTimeout(25);}
    assert.fail('profile reply timed out');
  }
  await profileSend('/settings');await profileSend('1');await profileSend('1');await profileSend('小鲸');
  await profileSend('2');await profileSend('我的工作微信');await profileSend('3');
  await profileSend('',{aeskey:'00112233445566778899aabbccddeeff',media:{encrypt_query_param:'fixture-avatar',encrypt_type:1}});
  const profileSnapshot=await waitSnapshot(panel,s=>s.wechat.profile?.avatar&&s.wechat.connectionName==='我的工作微信');
  const storedProfile=await app.evaluate(({safeStorage},encrypted)=>JSON.parse(safeStorage.decryptString(Buffer.from(encrypted,'base64'))).connections[0].profile,fs.readFileSync(path.join(dir,'wechat.enc')).toString('base64'));
  assert.deepEqual(storedProfile,profileSnapshot.wechat.profile);
  assert.equal(profileSnapshot.wechat.profile.nickname,'小鲸');assert.match(profileSnapshot.wechat.profile.avatar,/^data:image\/png;base64,/);
  const avatar=panel.locator('#wechat-connections .ui-avatar');await avatar.waitFor();
  await panel.waitForFunction(()=>document.querySelector('#wechat-connections .ui-avatar').naturalWidth>0);
  assert.deepEqual(await avatar.evaluate(image=>[image.naturalWidth,image.naturalHeight]),[128,128]);
  assert.match(await panel.locator('#wechat-connections').textContent(),/我的工作微信[\s\S]*小鲸/);
  const previousViewport=panel.viewportSize()||{width:1060,height:770};
  for(const width of [1060,860]){await panel.setViewportSize({width,height:770});assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await panel.locator('.wechat-account-card').screenshot({path:path.join(root,`out/wechat-user-profile-${width}.png`)});}
  await panel.setViewportSize(previousViewport);
  assert.equal(await app.evaluate(()=>global.wechatSmoke.imageRequests),1);
  await profileSend('4');
  const preview=await app.evaluate(()=>({uploads:global.wechatSmoke.previewUploads,bytes:global.wechatSmoke.previewBytes,message:global.wechatSmoke.sent.find(item=>item.item_list?.[0]?.type===2)}));
  assert.equal(preview.uploads,1);assert.equal(preview.bytes,profileSnapshot.wechat.profile.avatar.split(',')[1]);
  assert.equal(preview.message.to_user_id,'fixture-owner');assert.equal(preview.message.item_list[0].image_item.media.encrypt_query_param,'fixture-preview-download');
  await profileSend('',{aeskey:'00112233445566778899aabbccddeeff',media:{encrypt_query_param:'fixture-avatar',encrypt_type:1}});
  assert.equal(await app.evaluate(()=>global.wechatSmoke.imageRequests),2);
  assert.match(await app.evaluate(()=>global.wechatSmoke.sent.at(-1).item_list[0].text_item.text),/头像已保存/);
  await profileSend('1');await profileSend('清空');await profileSend('2');await profileSend('清空');await profileSend('3');await profileSend('清空');await profileSend('0');
  await waitSnapshot(panel,s=>s.wechat.connectionName==='微信 1'&&!s.wechat.profile.avatar&&!s.wechat.profile.nickname);
  assert.equal(await panel.locator('#wechat-login').isHidden(),true,'正常连接不突出重新扫码');
  assert.equal(await panel.locator('#wechat-empty').isVisible(),true,'扫码成功后显示第一条任务的操作引导');
  assert.equal(await panel.locator('#wechat-settings-dialog').isVisible(),false);
  assert.equal(await panel.locator('#wechat-toggle').isVisible(),true,'常用账号操作直接显示在账号列表下面');
  assert.ok(await panel.locator('#wechat-task-card').evaluate(el=>el.getBoundingClientRect().top<innerHeight),'最近任务进入首屏');
  assert.ok(await panel.locator('#wechat-task-card').evaluate(el=>Boolean(el.compareDocumentPosition(document.querySelector('#wechat-client-options'))&Node.DOCUMENT_POSITION_FOLLOWING)));
  await panel.locator('#wechat-open-settings').click();await panel.locator('#wechat-tab-clients').click();
  await panel.waitForFunction(()=>document.querySelectorAll('#wechat-discovered button').length===4&&!document.querySelector('#wechat-check').disabled);
  const candidates=panel.locator('#wechat-discovered button');
  assert.equal(await candidates.nth(0).textContent(),'已添加 · 优先级 1');assert.ok(await candidates.nth(0).isDisabled());assert.ok(await candidates.nth(3).isDisabled());
  assert.equal(await candidates.nth(3).textContent(),'需自定义添加','unidentified instances must not match the default account');
  assert.match(await panel.locator('#wechat-discovered').textContent(),/通过 CLI 接入/);
  await candidates.nth(1).click();assert.equal(await panel.locator('.wechat-client').count(),2);
  assert.equal(await panel.locator('.wechat-client').nth(1).locator('[data-field=configHome]').inputValue(),secondHome);
  await panel.locator('.wechat-client').nth(1).getByRole('button',{name:'上移',exact:true}).click();
  await panel.locator('#wechat-save').click();await waitSnapshot(panel,s=>s.wechat.clients.length===2&&s.wechat.clients[0].configHome===secondHome);
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).wechat.clients[0].binary,bin);
  await panel.locator('#wechat-check').click();await panel.waitForFunction(()=>!document.querySelector('#wechat-check').disabled);
  assert.equal(await candidates.nth(1).textContent(),'已添加 · 优先级 1');assert.equal(await panel.locator('.wechat-client').count(),2);
  await panel.locator('.wechat-client').nth(0).getByRole('button',{name:'移除',exact:true}).click();
  await panel.locator('.wechat-client [data-field=name]').fill('未保存名称');
  await app.evaluate(()=>{global.wechatSmoke.failDiscovery=true;});
  await panel.locator('#wechat-check').click();await panel.waitForFunction(()=>document.querySelector('#wechat-discovery-status').textContent.includes('检测失败'));
  assert.equal(await panel.locator('.wechat-client [data-field=name]').inputValue(),'未保存名称');
  await app.evaluate(()=>{global.wechatSmoke.failDiscovery=false;});
  await panel.locator('#wechat-check').click();await panel.waitForFunction(()=>!document.querySelector('#wechat-check').disabled);
  assert.equal(await panel.locator('.wechat-client [data-field=name]').inputValue(),'未保存名称');
  await panel.locator('.wechat-client [data-field=name]').fill('本机 Codex');
  await panel.locator('#wechat-save').click();await waitSnapshot(panel,s=>s.wechat.clients.length===1);
  const discoveryWire=fs.existsSync(path.join(dir,'agent-wire.jsonl'))?fs.readFileSync(path.join(dir,'agent-wire.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
  assert.ok(!discoveryWire.some(item=>['thread/list','thread/start','thread/resume','turn/start'].includes(item.method)),'discovery must not query chats or launch model tasks');
  await panel.locator('.wechat-discovery').screenshot({path:path.join(root,'out/wechat-client-discovery.png')});
  await panel.locator('#wechat-add-codex').click();
  const clients=panel.locator('.wechat-client');assert.equal(await clients.count(),2);
  await clients.nth(1).locator('[data-field=name]').fill('备用 Codex');
  assert.equal(await clients.nth(1).locator('.wechat-client-title').textContent(),'备用 Codex（优先级 2）');
  assert.equal(await clients.nth(1).locator('[data-field=name]').evaluate(input=>document.activeElement===input),true,'updating the title must preserve input focus');
  await clients.nth(1).locator('details').evaluate(el=>{el.open=true;});
  await clients.nth(1).locator('[data-field=profile]').fill('fixture-profile');
  await panel.waitForTimeout(400);assert.equal(await clients.nth(1).locator('[data-field=profile]').inputValue(),'fixture-profile');
  await clients.nth(1).locator('[data-field=enabled]').uncheck();
  await panel.locator('#wechat-save').click();await waitSnapshot(panel,s=>s.wechat.clients.length===2&&!s.wechat.clients[1].enabled);
  await clients.nth(1).locator('[data-field=enabled]').check();
  await clients.nth(1).getByRole('button',{name:'上移',exact:true}).click();
  assert.deepEqual(await clients.locator('.wechat-client-title').allTextContents(),['备用 Codex（优先级 1）','本机 Codex（优先级 2）']);
  await panel.locator('#wechat-save').click();await panel.waitForFunction(()=>document.querySelector('#wechat-feedback').textContent==='客户端已保存。');
  const configured=await panel.evaluate(()=>window.whale.snapshot());assert.deepEqual(configured.wechat.clients.map(c=>c.name),['备用 Codex','本机 Codex']);assert.ok(configured.wechat.clients.every(c=>c.enabled));
  await clients.nth(0).screenshot({path:path.join(root,'out/wechat-client-priority.png')});
  await panel.locator('#wechat-check').click();await panel.waitForFunction(()=>document.querySelector('#wechat-discovery-status').textContent.includes('发现 4 个')&&!document.querySelector('#wechat-check').disabled);
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.wechat('forget');return 'allowed';}catch{return 'denied';}}),'denied');
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.wechat('discover-clients');return 'allowed';}catch{return 'denied';}}),'denied');
  await panel.locator('#wechat-close-settings').click();
  await app.evaluate(()=>{const message=(id,text)=>({message_id:id,message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]});const task=message('one','检查项目');global.wechatSmoke.queue.push(message('projects','／projects\u200b'),message('project','1'),message('chats-sized','/chats 10'),message('chats','/chats'),message('chat','1'),task,task);});
  await panel.waitForFunction(()=>document.querySelector('#wechat-jobs').textContent.includes('已完成'));
  await panel.waitForFunction(()=>document.querySelector('#wechat-outbox').textContent==='待投递 0 条');
  const sent=await app.evaluate(()=>global.wechatSmoke.sent.filter(msg=>msg.item_list[0].type===1));assert.ok(sent.some(msg=>msg.item_list[0].text_item.text==='桌面回复😀'));assert.ok(sent.every(msg=>msg.context_token==='fixture-context'));
  await app.evaluate(async()=>{for(let i=0;i<100;i++){if(global.wechatSmoke.typing.at(-1)?.status===2)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('typing stop not sent');});
  const typing=await app.evaluate(()=>global.wechatSmoke.typing);assert.ok(typing.some(x=>x.status===1));assert.ok(typing.every(x=>x.ilink_user_id==='fixture-owner'&&x.typing_ticket==='fixture-typing-ticket'));
  assert.ok(!sent.some(msg=>msg.item_list[0].text_item.text.startsWith('收到，')));
  assert.equal(await panel.locator('#wechat-jobs .wechat-chat-button').count(),0);
  assert.equal(await panel.locator('#wechat-jobs .wechat-chat-heading strong').textContent(),'桌面对话');
  assert.equal(await panel.locator('#wechat-jobs .wechat-task').count(),1);
  assert.ok(!(await panel.locator('#wechat-jobs').textContent()).includes('fixture-owner'));
  async function inlineIdentity(selector){const line=panel.locator(selector).first(),title=await line.locator('strong').boundingBox(),meta=await line.locator('.wechat-chat-meta').boundingBox();assert.ok(Math.abs(title.y-meta.y)<5,'chat and metadata must stay on one line');assert.ok(meta.x>=title.x+title.width-1);}
  await inlineIdentity('#wechat-jobs .wechat-chat-heading .wechat-chat-copy');
  await panel.locator('#wechat-jobs [data-task-view]').click();
  await panel.waitForFunction(()=>document.querySelectorAll('#wechat-jobs .wechat-task-text').length===2);
  assert.deepEqual(await panel.locator('#wechat-jobs .wechat-task-text').allTextContents(),['检查项目','桌面回复😀']);
  assert.ok(!JSON.stringify((await panel.evaluate(()=>window.whale.snapshot())).wechat).includes('桌面回复😀'));
  await panel.locator('#wechat-jobs [data-task-view]').click();assert.equal(await panel.locator('#wechat-jobs [data-task-content]').count(),0);
  await panel.locator('#wechat-jobs').locator('..').screenshot({path:path.join(root,'out/wechat-single-chat.png')});
  const projects=sent.map(msg=>msg.item_list[0].text_item.text).find(text=>text.startsWith('最近项目：'));assert.ok(projects?.includes('1. '+path.basename(dir)));assert.match(projects,/回复数字选择项目/);assert.ok(!projects.includes('/allow'));
  const tables=sent.map(msg=>msg.item_list[0].text_item.text).filter(text=>text.startsWith('已有对话'));assert.equal(tables.length,2);assert.match(tables[0],/第 1 页，每页 10 条/);assert.match(tables[1],/第 1 页，每页 5 条/);assert.ok(tables.every(text=>!text.includes('| 0 |')));const chats=tables[0];
  assert.match(chats,/\| 编号 \| 对话 \| 项目 \/ 客户端 \|/);assert.match(chats,/\| 1 \| 桌面对话 \|/);assert.ok(!chats.includes(dir));assert.match(chats,/回复编号/);
  let wire=fs.readFileSync(path.join(dir,'agent-wire.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.equal(wire.filter(item=>item.method==='turn/start'||item.method==='thread/resume').length,0);assert.ok(wire.some(item=>item.args?.includes('fixture-profile')));assert.ok(!JSON.stringify(sent).includes('private-history'));
  assert.deepEqual(wire.filter(item=>item.method==='thread/list').map(item=>item.params.limit),[20,20,10,10,5,5]);
  const desktopWire=await app.evaluate(()=>global.desktopSmoke.wire),forwarded=desktopWire.filter(item=>item.method==='thread-follower-start-turn');
  assert.equal(forwarded.length,1);assert.equal(forwarded[0].params.conversationId,'desktop-fixture');assert.equal(forwarded[0].params.turnStart.request.input[0].text,'检查项目');assert.deepEqual(forwarded[0].params.turnStart.context,{inheritThreadSettings:true});
  for(const [taskText,answer]of [['desktop-question','2'],['desktop-async-question','我的要求：保留现有配置']]) {
    await app.evaluate((_electron,text)=>global.wechatSmoke.queue.push({message_id:'task-'+text,message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]}),taskText);
    await waitSnapshot(panel,s=>s.wechat.jobs.some(job=>job.state==='question'));
    await panel.waitForFunction(()=>document.querySelector('#wechat-jobs').textContent.includes('等待回答'));
    await app.evaluate((_electron,text)=>global.wechatSmoke.queue.push({message_id:'answer-'+text,message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]}),answer);
    await waitSnapshot(panel,s=>!s.wechat.active);
    await panel.waitForFunction(()=>document.querySelector('#wechat-outbox').textContent==='待投递 0 条');
  }
  const questionWire=await app.evaluate(()=>global.desktopSmoke.wire);
  assert.equal(questionWire.filter(m=>m.method==='thread-follower-start-turn').length,3,'answers must not start another turn');
  const submitted=questionWire.find(m=>m.method==='thread-follower-submit-user-input');assert.deepEqual(submitted.params.response,{answers:{mode:{answers:['修复']}}});
  const steered=questionWire.find(m=>m.method==='thread-follower-steer-turn');assert.ok(steered.params.input[0].text.includes('我的要求：保留现有配置'));assert.match(steered.params.input[0].text,/<send_user_message_question_reply>/);
  const questionReplies=await app.evaluate(()=>global.wechatSmoke.sent.map(m=>(m.item_list[0].text_item?.text||'[图片]')));assert.ok(questionReplies.some(text=>text.includes('桌面问答已继续：修复')));assert.ok(questionReplies.some(text=>text.includes('桌面异步问答已继续')));
  assert.ok(!questionReplies.some(text=>text.includes('已收到答案')));
  await app.evaluate(()=>{for(const [id,text]of [['new','/new'],['two','新的任务']])global.wechatSmoke.queue.push({message_id:id,message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]});});
  await waitSnapshot(panel,s=>s.wechat.jobs.filter(j=>j.state==='completed').length===4);
  await panel.waitForFunction(()=>document.querySelectorAll('#wechat-jobs .wechat-chat-button').length===2);
  assert.equal(await panel.locator('#wechat-jobs .wechat-task-history').count(),0,'multiple chats start with a chat list');
  await inlineIdentity('#wechat-jobs .wechat-chat-button .wechat-chat-copy');
  await panel.locator('#wechat-jobs').locator('..').screenshot({path:path.join(root,'out/wechat-task-chats.png')});
  await panel.locator('#wechat-jobs .wechat-chat-button').filter({hasText:'桌面对话'}).click();
  assert.equal(await panel.locator('#wechat-jobs .wechat-task').count(),3,'details contain only the selected chat');
  wire=fs.readFileSync(path.join(dir,'agent-wire.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.equal(wire.filter(item=>item.method==='turn/start').length,1);assert.equal(wire.filter(item=>item.method==='thread/start').length,1);
  await app.evaluate(()=>global.wechatSmoke.queue.push({message_id:'failed-turn',message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text:'turn-rpc-failed'}}]}));
  await waitSnapshot(panel,s=>s.wechat.jobs.some(j=>j.state==='failed'&&j.failure?.rpcCode===-32602));
  assert.equal(await panel.locator('#wechat-jobs .wechat-chat-heading strong').textContent(),'桌面对话','updates in another chat must not change the open details');
  assert.ok(!(await panel.locator('#wechat-jobs').textContent()).includes('RPC -32602'));
  await panel.locator('#wechat-jobs [data-chat-back]').click();
  assert.equal(await panel.locator('#wechat-jobs .wechat-chat-button').count(),2);
  assert.equal(await panel.locator('#wechat-jobs .wechat-task-history').count(),0);
  await panel.locator('#wechat-jobs .wechat-chat-button').filter({hasText:'未完成'}).click();
  await panel.waitForFunction(()=>document.querySelector('#wechat-jobs').textContent.includes('启动任务失败')&&document.querySelector('#wechat-jobs').textContent.includes('RPC -32602'));
  assert.equal(await panel.locator('#wechat-jobs .wechat-task').count(),2);
  await panel.locator('#wechat-jobs').locator('..').screenshot({path:path.join(root,'out/wechat-task-details.png')});
  await panel.locator('#wechat-jobs [data-task-view]').first().click();
  await panel.waitForFunction(()=>document.querySelector('#wechat-jobs .wechat-task-text')?.textContent==='turn-rpc-failed');
  await panel.locator('#wechat-jobs [data-task-delete]').click();
  await panel.waitForFunction(()=>document.querySelectorAll('#wechat-jobs .wechat-task').length===1);
  assert.ok(!(await panel.locator('#wechat-jobs').textContent()).includes('RPC -32602'));assert.equal(await panel.locator('#wechat-jobs [data-task-content]').count(),0);
  await panel.locator('#wechat-jobs [data-task-view]').click();
  await panel.waitForFunction(()=>document.querySelectorAll('#wechat-jobs .wechat-task-text').length===2);
  const keptContents=await panel.locator('#wechat-jobs .wechat-task-text').allTextContents();assert.equal(keptContents[0],'新的任务');assert.ok(keptContents[1].length>0);
  await panel.locator('#wechat-jobs').locator('..').screenshot({path:path.join(root,'out/wechat-task-content.png')});
  await panel.waitForFunction(()=>document.querySelector('#wechat-outbox').textContent==='待投递 0 条');
  // A completed model task with failed WeChat delivery is independently deletable, without replaying it.
  const sentBeforeFailure=await app.evaluate(()=>global.wechatSmoke.sent.length);
  await app.evaluate(()=>{global.wechatSmoke.failSend=true;global.wechatSmoke.queue.push({message_id:'delivery-failed',message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text:'无法投递的任务'}}]});});
  await waitSnapshot(panel,s=>s.wechat.jobs.some(job=>job.state==='completed'&&job.delivery==='failed'));
  await panel.waitForFunction(()=>document.querySelector('#wechat-jobs').textContent.includes('投递失败'));
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).wechat.outbox,1);
  await panel.locator('#wechat-jobs [data-task-delete]').click();
  await panel.waitForFunction(()=>document.querySelectorAll('#wechat-jobs .wechat-task').length===1&&document.querySelector('#wechat-outbox').textContent==='待投递 0 条');
  assert.equal(await panel.locator('#wechat-jobs [data-task-content]').count(),1,'deleting another task preserves the open successful result');
  assert.equal(await app.evaluate(()=>global.wechatSmoke.sent.length),sentBeforeFailure);
  await app.evaluate(()=>{global.wechatSmoke.failSend=false;});
  wire=fs.readFileSync(path.join(dir,'agent-wire.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.equal(wire.filter(item=>item.method==='turn/start').length,3,'view and delete must not run model tasks');
  await panel.screenshot({path:path.join(root,'out/wechat-connected.png'),fullPage:true});
  const failedReplies=JSON.stringify(await app.evaluate(()=>global.wechatSmoke.sent));assert.ok(failedReplies.includes('RPC -32602'));assert.ok(!failedReplies.includes('private-api-key'));
  // 第二个微信独立扫码、切换管理对象和解绑，不触碰旧微信的任务、配置或连接状态。
  const firstConnection=(await panel.evaluate(()=>window.whale.snapshot())).wechat.selectedConnectionId;
  // 试着添加的空连接可直接删除；正在扫码时删除也必须终止旧扫码流程。
  await panel.locator('#wechat-add-connection').click();
  await waitSnapshot(panel,s=>s.wechat.connections.length===2&&!s.wechat.account);
  assert.equal(await panel.locator('#wechat-remove-draft').isVisible(),true);
  panel.once('dialog',dialog=>dialog.dismiss());await panel.locator('#wechat-remove-draft').click();
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).wechat.connections.length,2);
  panel.once('dialog',dialog=>dialog.accept());await panel.locator('#wechat-remove-draft').click();
  await waitSnapshot(panel,s=>s.wechat.connections.length===1&&s.wechat.selectedConnectionId===firstConnection);
  await panel.locator('#wechat-add-connection').click();await waitSnapshot(panel,s=>s.wechat.connections.length===2);
  await app.evaluate(()=>{global.wechatSmoke.confirmed=false;});
  await panel.locator('#wechat-login').click();await panel.waitForFunction(()=>Boolean(document.querySelector('#wechat-qr').getAttribute('src')));
  panel.once('dialog',dialog=>dialog.accept());await panel.locator('#wechat-remove-draft').click();
  await waitSnapshot(panel,s=>s.wechat.connections.length===1&&s.wechat.enabled);
  await app.evaluate(()=>{global.wechatSmoke.confirmed=true;});
  await panel.locator('#wechat-add-connection').click();
  let multi=await waitSnapshot(panel,s=>s.wechat.connections.length===2);
  const secondConnection=multi.wechat.selectedConnectionId;
  assert.notEqual(firstConnection,secondConnection);assert.equal(multi.wechat.connections[0].enabled,true);
  assert.equal(await panel.locator('#wechat-jobs .wechat-task').count(),0);
  await app.evaluate(()=>{global.wechatSmoke.loginBot='fixture-bot-2';});
  await panel.locator('#wechat-login').click();
  multi=await waitSnapshot(panel,s=>s.wechat.connections.every(c=>c.account));
  assert.deepEqual(multi.wechat.connections.map(c=>c.account.id),['fixture-bot','fixture-bot-2']);
  assert.ok(multi.wechat.connections.every(c=>c.enabled));
  await panel.locator('#wechat-open-settings').click();await panel.locator('#wechat-tab-clients').click();
  await panel.locator('.wechat-client [data-field=name]').first().fill('第二个微信的未保存配置');
  await panel.locator('#wechat-close-settings').click();
  await panel.locator('#wechat-connections button').filter({hasText:'微信 1'}).click();
  await waitSnapshot(panel,s=>s.wechat.selectedConnectionId===firstConnection);
  await panel.locator('#wechat-open-settings').click();await panel.locator('#wechat-tab-clients').click();
  assert.notEqual(await panel.locator('.wechat-client [data-field=name]').first().inputValue(),'第二个微信的未保存配置');
  await panel.locator('#wechat-close-settings').click();
  await panel.waitForFunction(()=>document.querySelectorAll('#wechat-jobs .wechat-task,#wechat-jobs .wechat-chat-button').length>0);
  await panel.locator('#wechat-connections button').filter({hasText:'微信 2'}).click();
  await waitSnapshot(panel,s=>s.wechat.selectedConnectionId===secondConnection);
  await panel.locator('#wechat-open-settings').click();await panel.locator('#wechat-tab-clients').click();
  assert.equal(await panel.locator('.wechat-client [data-field=name]').first().inputValue(),'第二个微信的未保存配置');
  await panel.locator('#wechat-close-settings').click();await panel.locator('#wechat-rename').click();
  await panel.locator('#wechat-name').fill('个人微信');await panel.locator('#wechat-name-form').getByRole('button',{name:'保存备注名',exact:true}).click();
  await waitSnapshot(panel,s=>s.wechat.connectionName==='个人微信');
  assert.equal(await panel.locator('#wechat-task-scope').textContent(),'个人微信');
  await panel.locator('#wechat-open-settings').click();await panel.locator('#wechat-tab-contacts').click();
  assert.match(await panel.locator('#wechat-users').textContent(),/我自己（扫码账号）/);
  await panel.locator('#wechat-users').getByRole('button',{name:'备注名',exact:true}).click();
  await panel.locator('#wechat-users input').fill('我自己的另一个号');
  await panel.locator('#wechat-users').getByRole('button',{name:'保存备注名',exact:true}).click();
  await waitSnapshot(panel,s=>s.wechat.contactNames['fixture-owner']==='我自己的另一个号');
  await panel.locator('#wechat-close-settings').click();await panel.locator('#wechat-toggle').click();
  multi=await waitSnapshot(panel,s=>s.wechat.status==='paused');
  assert.equal(multi.wechat.connections[0].enabled,true);
  assert.equal(await panel.locator('#nav-wechat').getAttribute('data-status'),'');
  await panel.screenshot({path:path.join(root,'out/wechat-multiple-connections.png'),fullPage:true});
  await panel.setViewportSize({width:760,height:900});
  await panel.locator('.wechat-connections').screenshot({path:path.join(root,'out/wechat-multiple-connections-narrow.png')});
  assert.ok(await panel.locator('.wechat-connections').evaluate(el=>el.scrollWidth<=el.clientWidth));
  assert.equal(await panel.locator('#wechat-connections button').count(),2);
  await panel.screenshot({path:path.join(root,'out/wechat-connections-open.png'),fullPage:true});
  const encrypted=fs.readFileSync(path.join(dir,'wechat.enc'));
  const stored=JSON.parse(Buffer.from(encrypted.toString(),'base64').toString());
  assert.equal(stored.version,3);assert.equal(stored.connections.length,2);
  assert.deepEqual(stored.connections.map(c=>c.state.account.id),['fixture-bot','fixture-bot-2']);
  panel.once('dialog',dialog=>{assert.match(dialog.message(),/个人微信/);return dialog.accept();});await panel.locator('#wechat-forget').click();
  multi=await waitSnapshot(panel,s=>s.wechat.connections.length===1);
  assert.equal(multi.wechat.selectedConnectionId,firstConnection);assert.equal(multi.wechat.enabled,true);
  // 模拟测试扫码使旧 token 失效：手机正常确认后，应用须换用新 token，并保留原来的历史记录。
  const beforeRenewal=multi.wechat.jobs.map(job=>job.id),sentBeforeRenewal=await app.evaluate(()=>global.wechatSmoke.sent.length);
  await app.evaluate(()=>{global.wechatSmoke.invalidToken='hidden-bot-token';});
  await waitSnapshot(panel,s=>s.wechat.status==='expired');
  await panel.waitForFunction(()=>document.querySelector('#wechat-login').textContent==='重新扫码'&&!document.querySelector('#wechat-login').hidden);
  await app.evaluate(()=>{global.wechatSmoke.loginBot='fixture-bot';global.wechatSmoke.loginToken='renewed-token';});
  await panel.locator('#wechat-login').click();
  multi=await waitSnapshot(panel,s=>s.wechat.status==='connected'&&s.wechat.enabled);
  assert.deepEqual(multi.wechat.jobs.map(job=>job.id),beforeRenewal);
  assert.equal(await panel.locator('#wechat-error').isHidden(),true);
  await app.evaluate(()=>global.wechatSmoke.queue.push({message_id:'after-token-renewal',message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'renewed-context',item_list:[{type:1,text_item:{text:'/status'}}]}));
  for(let i=0;i<100;i++){if(await app.evaluate((_electron,count)=>global.wechatSmoke.sent.length>count,sentBeforeRenewal))break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(await app.evaluate((_electron,count)=>global.wechatSmoke.sent.length>count,sentBeforeRenewal));
  assert.deepEqual(await app.evaluate(()=>[global.wechatSmoke.lastPollToken,global.wechatSmoke.lastSendToken]),['Bearer renewed-token','Bearer renewed-token']);
  assert.equal((await panel.evaluate(()=>window.whale.snapshot())).wechat.status,'connected');
  await panel.locator('#wechat-toggle').click();await panel.waitForFunction(()=>document.querySelector('#wechat-status').textContent==='已暂停');
  await panel.locator('#nav-hooks').click();assert.ok(await panel.locator('#wechat-view').isHidden());await panel.locator('#nav-home').click();assert.ok(await panel.locator('#hooks-view').isHidden());
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks:['scan-without-setup','two-independent-scans','connection-switch','per-account-drafts-and-history','pause-one-connection','forget-one-connection','encrypted-multiple-state','visible-connection-cards','delete-unscanned-connection','cancel-draft-deletion','delete-connection-during-scan','multiple-clients','priority','local-QR','scan-confirmation','readable-project-list','number-selection','desktop-owner-forwarding','verbatim-input','no-desktop-resume','native-typing-start-stop','no-receipt-messages','blocking-question-answer','async-question-answer','answers-continue-original-turn','single-chat-inline-history','multiple-chat-list','selected-chat-history','back-to-chat-list','stable-chat-selection','inline-chat-metadata','task-question-and-reply','details-outside-broadcast','delete-failed-task','delete-failed-delivery','preserve-other-task-content','no-task-replay','new-thread','dedup','Codex-result','safe-error-reporting','context','pause','dirty-form','IPC-sender','navigation','no-renderer-errors'],dataDir:dir}));
})().catch(async error=>{console.error(error);if(app)console.error(JSON.stringify(await app.evaluate(()=>({queue:global.wechatSmoke.queue,sent:global.wechatSmoke.sent.map(m=>(m.item_list[0].text_item?.text||'[图片]')),wire:global.desktopSmoke.wire.map(m=>({method:m.method,input:m.params?.turnStart?.request?.input}))}))));process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
