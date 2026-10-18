'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-wechat-ui-');
const bin=path.join(dir,'agent-fixture'),bootstrap=path.join(dir,'bootstrap.cjs');
fs.writeFileSync(bin,'#!'+process.execPath+'\n'+fs.readFileSync(path.join(root,'test/fixtures/wechat-agent.cjs'),'utf8'),{mode:0o700});
// Injection lives only in this isolated test bootstrap. Production has no test URLs or plaintext-storage switch.
fs.writeFileSync(bootstrap,`const {net,safeStorage}=require('electron');
safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=> 'test';
safeStorage.encryptString=s=>Buffer.from(Buffer.from(s).toString('base64'));safeStorage.decryptString=b=>Buffer.from(b.toString(),'base64').toString();
global.wechatSmoke={queue:[],sent:[],confirmed:false};
net.fetch=async(url,options)=>{const s=global.wechatSmoke;let data={};
if(url.includes('get_bot_qrcode'))data={qrcode:'hidden-poll-token',qrcode_img_content:'https://example.test/wechat-test-qr'};
else if(url.includes('get_qrcode_status'))data=s.confirmed?{status:'confirmed',ilink_bot_id:'fixture-bot',bot_token:'hidden-bot-token',ilink_user_id:'fixture-owner',baseurl:'https://ilinkai.weixin.qq.com'}:{status:'wait'};
else if(url.endsWith('getupdates'))data={msgs:s.queue.splice(0),get_updates_buf:'fixture-cursor'};
else if(url.endsWith('sendmessage'))s.sent.push(JSON.parse(options.body).msg);
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
  assert.equal(await panel.locator('#wechat-cwd').count(),0);assert.equal(await panel.locator('#wechat-client-options').getAttribute('open'),null);
  // No project/client setup is needed before scanning.
  await panel.locator('#wechat-login').click();await panel.waitForFunction(()=>document.querySelector('#wechat-qr').src.startsWith('data:image/png;base64,'));
  fs.mkdirSync(path.join(root,'out'),{recursive:true});await panel.screenshot({path:path.join(root,'out/wechat-login.png'),fullPage:true});
  await app.evaluate(()=>{global.wechatSmoke.confirmed=true;});await panel.waitForFunction(()=>document.querySelector('#wechat-status').textContent==='已连接');
  const snapshot=await panel.evaluate(()=>window.whale.snapshot());assert.ok(!JSON.stringify(snapshot).includes('hidden-bot-token'));assert.ok(snapshot.wechat.allowed.includes('fixture-owner'));
  await panel.locator('#wechat-client-options').evaluate(el=>{el.open=true;});
  await panel.locator('#wechat-add-codex').click();
  const clients=panel.locator('.wechat-client');assert.equal(await clients.count(),2);
  await clients.nth(1).locator('[data-field=name]').fill('备用 Codex');
  await clients.nth(1).locator('details').evaluate(el=>{el.open=true;});
  await clients.nth(1).locator('[data-field=profile]').fill('fixture-profile');
  await panel.waitForTimeout(400);assert.equal(await clients.nth(1).locator('[data-field=profile]').inputValue(),'fixture-profile');
  await clients.nth(1).locator('[data-field=enabled]').uncheck();
  await panel.locator('#wechat-save').click();await waitSnapshot(panel,s=>s.wechat.clients.length===2&&!s.wechat.clients[1].enabled);
  await clients.nth(1).locator('[data-field=enabled]').check();
  await clients.nth(1).getByRole('button',{name:'上移',exact:true}).click();
  await panel.locator('#wechat-save').click();await panel.waitForFunction(()=>document.querySelector('#wechat-feedback').textContent==='客户端已保存。');
  const configured=await panel.evaluate(()=>window.whale.snapshot());assert.deepEqual(configured.wechat.clients.map(c=>c.name),['备用 Codex','本机 Codex']);assert.ok(configured.wechat.clients.every(c=>c.enabled));
  await panel.locator('#wechat-check').click();await panel.waitForFunction(()=>document.querySelector('#wechat-feedback').textContent.includes('已找到客户端'));
  const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
  assert.equal(await pet.evaluate(async()=>{try{await window.whale.wechat('forget');return 'allowed';}catch{return 'denied';}}),'denied');
  await app.evaluate(()=>{const message=(id,text)=>({message_id:id,message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]});const task=message('one','检查项目');global.wechatSmoke.queue.push(message('projects','／projects\u200b'),message('project','1'),message('chats-sized','/chats 10'),message('chats','/chats'),message('chat','1'),task,task);});
  await panel.waitForFunction(()=>document.querySelector('#wechat-jobs').textContent.includes('已完成'));
  await panel.waitForFunction(()=>document.querySelector('#wechat-outbox').textContent==='待投递 0 条');
  const sent=await app.evaluate(()=>global.wechatSmoke.sent);assert.ok(sent.some(msg=>msg.item_list[0].text_item.text==='桌面回复😀'));assert.ok(sent.every(msg=>msg.context_token==='fixture-context'));
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
  const questionReplies=await app.evaluate(()=>global.wechatSmoke.sent.map(m=>m.item_list[0].text_item.text));assert.ok(questionReplies.some(text=>text.includes('桌面问答已继续：修复')));assert.ok(questionReplies.some(text=>text.includes('桌面异步问答已继续')));
  await app.evaluate(()=>{for(const [id,text]of [['new','/new'],['two','新的任务']])global.wechatSmoke.queue.push({message_id:id,message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]});});
  await waitSnapshot(panel,s=>s.wechat.jobs.filter(j=>j.state==='completed').length===4);
  wire=fs.readFileSync(path.join(dir,'agent-wire.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.equal(wire.filter(item=>item.method==='turn/start').length,1);assert.equal(wire.filter(item=>item.method==='thread/start').length,1);
  await app.evaluate(()=>global.wechatSmoke.queue.push({message_id:'failed-turn',message_type:1,from_user_id:'fixture-owner',to_user_id:'fixture-bot',context_token:'fixture-context',item_list:[{type:1,text_item:{text:'turn-rpc-failed'}}]}));
  await waitSnapshot(panel,s=>s.wechat.jobs.some(j=>j.state==='failed'&&j.failure?.rpcCode===-32602));
  await panel.waitForFunction(()=>document.querySelector('#wechat-jobs').textContent.includes('启动任务失败')&&document.querySelector('#wechat-jobs').textContent.includes('RPC -32602'));
  await panel.waitForFunction(()=>document.querySelector('#wechat-outbox').textContent==='待投递 0 条');await panel.screenshot({path:path.join(root,'out/wechat-connected.png'),fullPage:true});
  const failedReplies=JSON.stringify(await app.evaluate(()=>global.wechatSmoke.sent));assert.ok(failedReplies.includes('RPC -32602'));assert.ok(!failedReplies.includes('private-api-key'));
  await panel.locator('#wechat-toggle').click();await panel.waitForFunction(()=>document.querySelector('#wechat-status').textContent==='已暂停');
  await panel.locator('#nav-hooks').click();assert.ok(await panel.locator('#wechat-view').isHidden());await panel.locator('#nav-home').click();assert.ok(await panel.locator('#hooks-view').isHidden());
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks:['scan-without-setup','multiple-clients','priority','local-QR','scan-confirmation','readable-project-list','number-selection','desktop-owner-forwarding','verbatim-input','no-desktop-resume','blocking-question-answer','async-question-answer','answers-continue-original-turn','new-thread','dedup','Codex-result','safe-error-reporting','context','pause','dirty-form','IPC-sender','navigation','no-renderer-errors'],dataDir:dir}));
})().catch(async error=>{console.error(error);if(app)console.error(JSON.stringify(await app.evaluate(()=>({queue:global.wechatSmoke.queue,sent:global.wechatSmoke.sent.map(m=>m.item_list[0].text_item.text),wire:global.desktopSmoke.wire.map(m=>({method:m.method,input:m.params?.turnStart?.request?.input}))}))));process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
