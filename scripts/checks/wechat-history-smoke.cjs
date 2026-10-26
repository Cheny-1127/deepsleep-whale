'use strict';
// 使用真实页面和隐藏窗口，仅验证分页对话；不连接微信或模型。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-wechat-history-');
const fixture=path.join(dir,'history-render.mjs'),bootstrap=path.join(dir,'bootstrap.cjs');
const url=file=>pathToFileURL(file).href;
const avatar='data:image/png;base64,'+fs.readFileSync(path.join(root,'assets/icon.png')).toString('base64');
const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8').replace('href="style.css"',`href="${url(path.join(root,'src/ui/style.css'))}"`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script type="module" src="history-render.mjs"></script></body>');
fs.writeFileSync(path.join(dir,'index.html'),html);
fs.writeFileSync(fixture,`import {createWechatView} from ${JSON.stringify(url(path.join(root,'src/ui/wechat-view.mjs')))};
const chat={key:'one',name:'分页对话',project:'Architecture',clientName:'Ding Codex'};
const data={status:'connected',storageAvailable:true,enabled:true,selectedConnectionId:'work',account:{id:'fixture-bot',owner:'owner'},connectionName:'工作备注',profile:{nickname:'小鲸昵称',avatar:${JSON.stringify(avatar)}},connections:[{id:'work',name:'工作备注',remark:'工作备注',nickname:'小鲸昵称',avatar:${JSON.stringify(avatar)}}],contactNames:{},clients:[],allowed:[],pending:[],outbox:0,jobs:Array.from({length:24},(_,index)=>({id:'task-'+index,sender:'owner',state:'completed',canDelete:true,startedAt:1800000000000-index*1000,finishedAt:1800000000100-index*1000,delivery:'sent',chat}))};
const pending=[],requests=[];window.historyFixture={data,pending,requests,chat};
window.whale={snapshot:async()=>({wechat:data}),wechat:async(name,payload)=>{
  if(name==='delete-task'){data.jobs=data.jobs.filter(job=>job.id!==payload.value);return {value:{}};}
  if(name!=='task-detail')throw Error('Unexpected action');
  requests.push(payload);return new Promise(resolve=>pending.push({id:payload.value,resolve:(value={request:'提问 '+payload.value,response:'完整回复 '+payload.value+'\\n'+('保留阅读位置\\n'.repeat(18))})=>resolve({value}),reject:()=>resolve({error:'模拟读取失败'})}));
}};
for(const element of document.querySelector('main').children)element.hidden=element.id!=='wechat-view';
const view=createWechatView();view.render(data);window.historyFixture.render=()=>view.render(data);`);
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(root,'scripts/checks/test-window-policy.cjs'))}).installTestWindowPolicy();const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir)});app.whenReady().then(()=>new BrowserWindow({width:1060,height:850,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(dir,'index.html'))}));`);
let app;
(async()=>{
  app=await electron.launch({executablePath:require('electron'),args:[bootstrap]});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const tasks=()=>page.locator('.wechat-task').evaluateAll(nodes=>nodes.map(node=>node.dataset.taskId));
  const resolveAll=async()=>{await page.evaluate(()=>{for(const request of window.historyFixture.pending.splice(0).reverse())request.resolve();});await page.waitForFunction(()=>!document.querySelector('.wechat-task-content')?.textContent.includes('正在加载'));};
  const previous=page.locator('[data-history-page="previous"]'),next=page.locator('[data-history-page="next"]');
  await page.waitForSelector('button[data-chat-key="one"]');
  assert.equal(await page.locator('.wechat-task').count(),0,'收起的会话不读取正文');
  await page.locator('button[data-chat-key="one"]').click();
  assert.equal(await page.evaluate(()=>window.historyFixture.requests.length),10,'只加载第一页 10 组问答');
  assert.deepEqual(await tasks(),Array.from({length:10},(_,i)=>'task-'+(23-i)),'页内时间正序');
  assert.equal(await previous.isDisabled(),true);assert.equal(await next.isDisabled(),false);
  await resolveAll();
  assert.equal(await page.locator('[data-task-view]').count(),0,'无需逐条展开');
  assert.equal(await page.locator('[data-message-role="request"]').count(),10);assert.equal(await page.locator('[data-message-role="response"]').count(),10);
  for(const id of await tasks()){
    const row=page.locator(`[data-task-id="${id}"]`);
    assert.equal(await row.locator('[data-message-role="request"] pre').textContent(),'提问 '+id);
    assert.match(await row.locator('[data-message-role="response"] pre').textContent(),new RegExp('完整回复 '+id+'\\n'),'乱序加载仍按任务配对');
    const request=await row.locator('[data-message-role="request"] .wechat-message-bubble').boundingBox(),response=await row.locator('[data-message-role="response"] .wechat-message-bubble').boundingBox();
    assert.ok(request.x>response.x,'提问靠右、回复靠左');
  }
  const firstGroup=page.locator('[data-task-id="task-23"]'),secondGroup=page.locator('[data-task-id="task-22"]');
  const firstDelete=firstGroup.locator('[data-task-delete]'),secondDelete=secondGroup.locator('[data-task-delete]');
  assert.equal(await firstGroup.locator('.wechat-exchange-status').isHidden(),true,'正常完成只保留时间，不显示已完成');
  assert.equal(await firstDelete.isHidden(),true,'默认不显示删除图标');
  await firstGroup.locator('.wechat-exchange-meta').click();
  assert.equal(await firstDelete.isVisible(),true);assert.equal(await firstDelete.locator('svg').count(),1);assert.equal(await firstDelete.textContent(),'','使用垃圾桶图标');
  await page.evaluate(()=>window.historyFixture.render());
  assert.equal(await firstDelete.isVisible(),true,'后台刷新保留选中组');
  await secondGroup.locator('.wechat-exchange-meta').click();
  assert.equal(await firstDelete.isHidden(),true);assert.equal(await secondDelete.isVisible(),true,'同时只显示一组的删除操作');
  await secondGroup.press('Escape');assert.equal(await secondDelete.isHidden(),true);
  await firstGroup.focus();await firstGroup.press('Enter');assert.equal(await firstDelete.isVisible(),true,'支持键盘选中');
  await firstGroup.press('Escape');assert.equal(await firstDelete.isHidden(),true);
  await firstGroup.press(' ');assert.equal(await firstDelete.isVisible(),true);
  await page.locator('.wechat-history-pagination > span').first().click();assert.equal(await firstDelete.isHidden(),true,'点击组外收起图标');
  await firstGroup.locator('pre').first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);el.dispatchEvent(new MouseEvent('click',{bubbles:true}));selection.removeAllRanges();});
  assert.equal(await firstDelete.isHidden(),true,'拖选正文不选中分组');
  const firstMessage=page.locator('[data-task-id="task-23"] [data-message-role="request"]');
  assert.equal(await firstMessage.locator('.wechat-message-author').textContent(),'工作备注','备注名优先于昵称');
  assert.equal(await firstMessage.locator('.wechat-message-avatar img').getAttribute('src'),avatar,'复用保存的头像');
  await page.evaluate(()=>{const s=window.historyFixture;s.text=document.querySelector('[data-task-id="task-23"] pre');s.data.connections[0].remark='';s.data.connections[0].name=s.data.connectionName=s.data.profile.nickname;s.render();});
  assert.equal(await firstMessage.locator('.wechat-message-author').textContent(),'小鲸昵称','清空备注后使用昵称');
  await page.evaluate(()=>{const s=window.historyFixture;s.data.profile.avatar='';s.data.connections[0].avatar='';s.render();});
  assert.equal(await firstMessage.locator('.wechat-message-avatar img').count(),0,'清空头像后更新为名称占位');
  await page.evaluate(()=>{const s=window.historyFixture;s.data.contactNames.owner='联系人备注';s.render();});
  assert.equal(await firstMessage.locator('.wechat-message-author').textContent(),'联系人备注');
  await page.evaluate(value=>{const s=window.historyFixture;s.data.profile.avatar=s.data.connections[0].avatar=value;s.data.jobs.find(job=>job.id==='task-23').sender='friend';s.data.contactNames.friend='朋友备注';s.render();},avatar);
  assert.equal(await firstMessage.locator('.wechat-message-author').textContent(),'朋友备注');
  assert.equal(await firstMessage.locator('.wechat-message-avatar img').count(),0,'其他联系人不能套用扫码者头像');
  assert.equal(await page.evaluate(()=>window.historyFixture.text===document.querySelector('[data-task-id="task-23"] pre')),true,'资料刷新保留正文节点');
  assert.equal(await page.evaluate(()=>window.historyFixture.requests.length),10,'资料刷新不重新读取问答');
  await page.locator('.wechat-task-history').evaluate(el=>{el.scrollTop=650;window.historyFixture.history=el;window.historyFixture.content=el.querySelector('[data-task-content]');});
  const before=await page.locator('.wechat-task-history').evaluate(el=>({top:el.scrollTop,pageY:window.scrollY}));
  await page.evaluate(()=>{const s=window.historyFixture;s.data.jobs[0].delivery='pending';s.data.jobs.unshift({...s.data.jobs[0],id:'new-task',startedAt:1800000001000});s.render();});
  const after=await page.locator('.wechat-task-history').evaluate(el=>({top:el.scrollTop,pageY:window.scrollY,same:el===window.historyFixture.history,sameContent:el.querySelector('[data-task-content]')===window.historyFixture.content}));
  assert.equal(after.same,true);assert.equal(after.sameContent,true);assert.ok(Math.abs(after.top-before.top)<2);assert.ok(Math.abs(after.pageY-before.pageY)<2);
  assert.equal(await page.evaluate(()=>window.historyFixture.requests.length),10,'新增较晚任务不重复读取旧页或跳页');
  await next.click();assert.deepEqual(await tasks(),Array.from({length:10},(_,i)=>'task-'+(13-i)));await resolveAll();
  assert.equal(await page.locator('.wechat-task-history').evaluate(el=>el.scrollTop),0,'翻页从顶部开始');
  await previous.click();assert.equal(await page.evaluate(()=>window.historyFixture.requests.length),20,'返回已读页复用正文');
  await next.click();await next.click();assert.deepEqual(await tasks(),['task-3','task-2','task-1','task-0','new-task']);await resolveAll();
  assert.equal(await next.isDisabled(),true);assert.match(await page.locator('.wechat-history-pagination').textContent(),/第 3 \/ 3 页.*共 25 组问答/);
  await page.locator('button[data-chat-key="one"]').click();await page.locator('button[data-chat-key="one"]').click();
  assert.deepEqual(await tasks(),['task-3','task-2','task-1','task-0','new-task'],'重新展开保留页码');
  // 末页被删空时回到有效页，不能停在空页或越界。
  await page.evaluate(()=>{const s=window.historyFixture;s.data.jobs=s.data.jobs.filter(job=>!['task-3','task-2','task-1','task-0','new-task'].includes(job.id));s.render();});
  assert.match(await page.locator('.wechat-history-pagination').textContent(),/第 2 \/ 2 页/);assert.equal(await page.locator('.wechat-task').count(),10);
  // 删除单条问答后，仅移除它的提问和回答。
  await page.locator('[data-task-id="task-13"] .wechat-exchange-meta').click();
  await page.locator('[data-task-delete="task-13"]').click();await page.waitForFunction(()=>!document.querySelector('[data-task-id="task-13"]'));
  assert.equal(await page.locator('.wechat-task').count(),9);assert.equal(await page.locator('[data-message-role="request"]').count(),9);
  // 进行中的任务先展示提问与状态，结束时重新读取最终回复。
  await page.evaluate(()=>{const s=window.historyFixture;s.data.enabled=false;s.data.status='paused';s.data.jobs=[{id:'recovery',state:'recovering',startedAt:1800000002000,chat:s.chat}];s.render();});
  assert.equal(await page.locator('#wechat-add-codex').isDisabled(),true);assert.equal(await page.locator('[data-task-delete]').count(),0);
  await page.evaluate(()=>window.historyFixture.pending.shift().resolve({request:'继续原来的任务',response:null}));
  await page.waitForFunction(()=>document.querySelector('[data-message-role="response"]').textContent.includes('等待回复 · 恢复跟踪中'));
  await page.evaluate(()=>{const s=window.historyFixture;Object.assign(s.data.jobs[0],{state:'completed',canDelete:true,finishedAt:1800000003000});s.render();});
  await page.evaluate(()=>window.historyFixture.pending.shift().resolve({request:'继续原来的任务',response:'恢复后的完整回复'}));
  await page.waitForFunction(()=>document.querySelector('[data-message-role="response"]').textContent.includes('恢复后的完整回复'));assert.equal(await page.locator('#wechat-add-codex').isDisabled(),false);
  // 单条失败支持重试，旧记录缺失正文给出明确提示。
  await page.evaluate(()=>{const s=window.historyFixture;s.data.jobs=[{...s.data.jobs[0],id:'legacy'}];s.render();s.pending.shift().reject();});
  await page.locator('[data-task-retry="legacy"]').click();await page.evaluate(()=>window.historyFixture.pending.shift().resolve({request:null,response:null}));
  await page.waitForFunction(()=>document.querySelector('.wechat-task-content').textContent.includes('旧版记录未保留本次提问'));
  assert.match(await page.locator('.wechat-task-content').textContent(),/旧版记录未保留本次回复/);
  // 切换账号后，同 ID 的旧请求迟到不能写入新账号。
  await page.evaluate(()=>{const s=window.historyFixture;s.data.jobs=[{...s.data.jobs[0],id:'shared'}];s.render();s.data.selectedConnectionId='personal';s.data.connections=[];s.data.connectionName='个人微信';s.data.profile={nickname:'个人昵称',avatar:''};s.data.contactNames={};s.data.jobs[0].sender='owner';s.render();});
  assert.equal(await page.locator('.wechat-task').count(),0);
  await page.locator('button[data-chat-key="one"]').click();
  await page.evaluate(()=>{const s=window.historyFixture;s.pending.shift().resolve({request:'工作账号内容',response:'旧账号回复'});s.pending.shift().resolve({request:'个人账号提问',response:'个人账号回复'});});
  await page.waitForFunction(()=>document.querySelector('.wechat-task-content').textContent.includes('个人账号回复'));
  assert.ok(!(await page.locator('#wechat-jobs').textContent()).includes('工作账号内容'));
  assert.equal(await page.locator('[data-message-role="request"] .wechat-message-author').textContent(),'个人昵称','切换账号同步切换昵称');
  assert.equal(await page.locator('[data-message-role="request"] img').count(),0,'切换账号不残留原头像');
  // 删除记录后，迟到的响应也不能恢复消息。
  await page.evaluate(()=>{const s=window.historyFixture;s.data.jobs=[{...s.data.jobs[0],id:'removed'}];s.render();s.data.jobs=[];s.render();s.pending.shift().resolve();});
  assert.equal(await page.locator('.wechat-task').count(),0);
  // 短对话截图检查两个窗口宽度及长文本换行。
  await page.evaluate(()=>{const s=window.historyFixture;s.data.profile.nickname='小鲸';s.data.connectionName='工作微信';s.data.jobs=[1,0].map(i=>({id:'preview-'+i,sender:'owner',state:'completed',canDelete:true,startedAt:1800000000000+i*60000,chat:s.chat}));s.render();});
  await page.locator('button[data-chat-key="one"]').click();
  await page.evaluate(()=>{const s=window.historyFixture;for(const request of s.pending.splice(0))request.resolve({request:request.id==='preview-0'?'帮我看看这次修改的情况':'分页的时候，提问和回答会被拆开吗？',response:request.id==='preview-0'?'已经检查过了。现在展开会话，就可以直接阅读每次提问和对应的完整回复。':'不会。每页包含 10 组完整问答，按时间从早到晚排列。上一页查看更早的记录，下一页查看更晚的记录。\\n长内容也会自动换行：'+('long-text-'.repeat(24))});});
  await page.waitForSelector('[data-task-id="preview-0"] pre');
  await page.evaluate(value=>{const s=window.historyFixture;s.data.profile.avatar=value;s.render();},avatar);
  await page.waitForFunction(()=>[...document.querySelectorAll('.wechat-message-avatar img')].every(image=>image.complete&&image.naturalWidth>0));
  fs.mkdirSync(path.join(root,'out'),{recursive:true});
  for(const width of [1060,860]){
    await page.setViewportSize({width,height:850});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('.wechat-task-history').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'长文本不能撑出横向滚动');
    await page.locator('#wechat-task-card').screenshot({path:path.join(root,`out/wechat-conversation-${width}.png`)});
  }
  await page.locator('[data-task-id="preview-0"] .wechat-exchange-meta').click();
  await page.locator('#wechat-task-card').screenshot({path:path.join(root,'out/wechat-conversation-selected.png')});
  await page.locator('[data-task-id="preview-0"]').press('Escape');
  // 问答作为一个隐形分组；状态底色覆盖整组，中断和异常使用不同颜色。
  await page.evaluate(()=>{const s=window.historyFixture;s.data.jobs=[
    {id:'status-completed',state:'completed'},
    {id:'status-interrupted',state:'interrupted',failure:{message:'任务已中断，可以查看原对话后继续。'}},
    {id:'status-failed',state:'failed',failure:{message:'任务执行异常，请稍后重试。'}},
    {id:'status-cancelled',state:'cancelled'},
    {id:'status-delivery',state:'completed',delivery:'failed'},
    {id:'status-running',state:'running'}
  ].map((job,i)=>({...job,sender:'owner',canDelete:job.state!=='running',startedAt:1800000000000+i*60000,chat:s.chat})).reverse();s.render();});
  await page.evaluate(()=>{for(const request of window.historyFixture.pending.splice(0))request.resolve({request:'帮我检查这次任务的执行结果',response:['status-completed','status-delivery'].includes(request.id)?'检查已完成，结果已保存。':null});});
  await page.waitForSelector('[data-task-id="status-completed"] pre');
  const appearance=async id=>page.locator(`[data-task-id="${id}"]`).evaluate(el=>({
    background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderTopWidth,
    statusColor:getComputedStyle(el.querySelector('.wechat-exchange-status')).color,
    statusHidden:el.querySelector('.wechat-exchange-status').hidden,statusText:el.querySelector('.wechat-exchange-status').textContent,
    role:el.getAttribute('role'),messages:el.querySelectorAll('[data-message-role]').length
  }));
  const normal=await appearance('status-completed'),warning=await appearance('status-interrupted'),error=await appearance('status-failed');
  assert.equal(normal.background,'rgba(0, 0, 0, 0)');assert.equal(normal.border,'0px','正常问答不显示组框');
  assert.equal(normal.statusHidden,true);assert.equal(warning.statusHidden,false);assert.equal(error.statusHidden,false);
  assert.equal((await appearance('status-running')).statusHidden,true);
  assert.equal((await appearance('status-delivery')).statusText,'投递失败','异常完成记录也不显示已完成字样');
  assert.equal(normal.role,'group');assert.equal(normal.messages,2,'一组包括提问和回答');
  assert.notEqual(warning.background,normal.background);assert.notEqual(error.background,normal.background);assert.notEqual(warning.background,error.background,'黄色和红色有明确区分');
  assert.notEqual(warning.statusColor,normal.statusColor);assert.notEqual(error.statusColor,normal.statusColor);
  assert.equal((await appearance('status-cancelled')).background,warning.background);
  assert.equal((await appearance('status-delivery')).background,error.background,'已完成但投递失败仍提示异常');
  assert.equal((await appearance('status-running')).background,normal.background,'执行中不误报异常');
  await page.evaluate(()=>{const s=window.historyFixture;s.statusContent=document.querySelector('[data-task-id="status-delivery"] [data-task-content]');s.data.jobs.find(job=>job.id==='status-delivery').delivery='sent';s.render();});
  assert.equal((await appearance('status-delivery')).background,normal.background,'异常解除后清除底色');
  assert.equal((await appearance('status-delivery')).statusHidden,true,'恢复正常后隐藏状态');
  assert.equal(await page.evaluate(()=>window.historyFixture.statusContent===document.querySelector('[data-task-id="status-delivery"] [data-task-content]')),true,'状态着色不重建正文');
  for(const width of [1060,860]){
    await page.setViewportSize({width,height:850});
    await page.locator('.wechat-task-history').evaluate(el=>{const target=el.querySelector('[data-task-id="status-interrupted"]');el.scrollTop+=target.getBoundingClientRect().top-el.getBoundingClientRect().top-8;});
    assert.equal(await page.locator('.wechat-task-history').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.locator('#wechat-task-card').screenshot({path:path.join(root,`out/wechat-conversation-status-${width}.png`)});
  }
  assert.deepEqual(await app.evaluate(()=>global.testWindowPolicy.events),[],'测试窗口始终隐藏，不抢焦点');
  assert.deepEqual(errors,[]);console.log('WeChat conversation UI OK: chronological paired messages, 10-pair pagination/cache/bounds, stable reading, live completion, retry/legacy, account/deletion races, saved avatar/name priorities/live updates, invisible exchange groups/status colors/recovery, abnormal-only labels, click-to-reveal single-exchange delete/keyboard/text selection, 860/1060px; '+dir);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
