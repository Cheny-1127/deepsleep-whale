'use strict';
// 隔离 Hook/客户端状态，验证真正的 Electron 主进程只观察而不处理审批决定。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createCodexConfig}=require('../../src/hooks/config.cjs');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-approval-'),home=path.join(dir,'codex');
fs.mkdirSync(home);fs.mkdirSync(path.join(home,'ipc'),{mode:0o700});
const ids=['11111111-1111-4111-8111-111111111110','11111111-1111-4111-8111-111111111111'];
const db=new DatabaseSync(path.join(home,'state_5.sqlite'));
db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,thread_source TEXT)');
for(const [i,id] of ids.entries())db.prepare('INSERT INTO threads VALUES (?,?,?)').run(id,'授权测试 '+i,'user');db.close();
const hooks=Object.entries(createCodexConfig().hooks).map(([event,groups])=>({eventName:event[0].toLowerCase()+event.slice(1),handlerType:'command',command:groups[0].hooks[0].command,enabled:true,trustStatus:'trusted'}));
const bin=path.join(dir,'codex-fixture');
fs.writeFileSync(bin,'#!'+process.execPath+'\n'+`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.id===1?{}:m.id===3?{config:{}}:m.id===4?{requirements:null}:{data:[{hooks:${JSON.stringify(hooks)},errors:[]}]}})+'\\n');});`,{mode:0o700});
const bootstrap=path.join(dir,'bootstrap.cjs');
// 隐藏窗口，并隔离外部跳转和辅助功能操作；回归测试不能把用户的 Codex 拉到前台。
fs.writeFileSync(bootstrap,`require(${JSON.stringify(path.join(__dirname,'test-window-policy.cjs'))}).installTestWindowPolicy();
const {shell}=require('electron');global.openedChatURLs=[];global.failChatOpen=false;
shell.openExternal=async url=>{if(global.failChatOpen)throw Error('测试打开失败，提醒已保留');global.openedChatURLs.push(url);};
const cp=require('node:child_process'),original=cp.execFile;cp.execFile=function(file,args,options,callback){if(file==='/bin/ps'&&args.join(' ')==='-axo comm='){setImmediate(()=>callback(null,'/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'));return;}return original.apply(this,arguments);};require(${JSON.stringify(path.join(root,'src/main.cjs'))});`);
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({sources:{codex:true},notifications:false,sound:false}));
const frame=m=>{const b=Buffer.from(JSON.stringify(m)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);};
const clients=new Set(),received=[],revisions=new Map(),watched=new Set(),runtimeStates=new Map(ids.map(id=>[id,true]));let app,panel,pet;
function state(id,waiting){return {id,requests:waiting?[{id:'r',params:{turnId:'round',itemId:'long-command'}}]:[],threadRuntimeStatus:{type:'active',activeFlags:waiting?['waitingOnApproval']:[]},turnHistory:{kind:'canonical',history:{entitiesByKey:{current:{turnId:'round',status:'inProgress'}}}}};}
function sendRuntime(id,waiting){runtimeStates.set(id,waiting);const revision=(revisions.get(id)||0)+1;revisions.set(id,revision);for(const c of clients)c.write(frame({type:'broadcast',version:11,method:'thread-stream-state-changed',sourceClientId:'codex-owner',params:{hostId:'local',conversationId:id,change:{type:'snapshot',revision,conversationState:state(id,waiting)}}}));}
const server=net.createServer(c=>{clients.add(c);c.on('close',()=>clients.delete(c));let b=Buffer.alloc(0);c.on('data',chunk=>{b=Buffer.concat([b,chunk]);while(b.length>=4&&b.length>=b.readUInt32LE(0)+4){const n=b.readUInt32LE(0),m=JSON.parse(b.subarray(4,n+4));b=b.subarray(n+4);received.push(m);if(m.method==='initialize')c.write(frame({type:'response',method:'initialize',requestId:m.requestId,resultType:'success',result:{clientId:'pet-observer'}}));if(m.method==='thread-stream-following-changed'){if(m.params.following){watched.add(m.params.conversationId);sendRuntime(m.params.conversationId,runtimeStates.get(m.params.conversationId));}else watched.delete(m.params.conversationId);}}});});
const snapshot=()=>panel.evaluate(()=>window.whale.snapshot());
async function wait(predicate){const deadline=Date.now()+12000;while(!await predicate()){if(Date.now()>deadline)throw Error('状态等待超时 '+JSON.stringify(await snapshot()));await new Promise(r=>setTimeout(r,50));}}
async function hook(name,id){const before=(await snapshot()).activity.count;await new Promise((resolve,reject)=>{const c=net.createConnection(path.join(dir,'events.sock'),()=>c.write(JSON.stringify({hook_event_name:name,session_id:id,turn_id:'round',tool_name:'Bash',tool_use_id:name==='PermissionRequest'?undefined:'long-command'})+'\n'));c.on('data',()=>{});c.on('close',resolve);c.on('error',reject);});await wait(async()=> (await snapshot()).activity.count>before);}
(async()=>{try{
 const file=path.join(home,'ipc','ipc.sock');server.listen(file);await once(server,'listening');fs.chmodSync(file,0o600);
 app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,CODEX_HOME:home,WHALE_CODEX_BIN:bin,WHALE_DATA_DIR:dir}});
 const errors=[];app.on('window',p=>p.on('pageerror',e=>errors.push(e.message)));
 await app.firstWindow();await wait(async()=>{panel=app.windows().find(p=>p.url().endsWith('/index.html'));pet=app.windows().find(p=>p.url().endsWith('/pet.html'));return panel&&pet;});
 await wait(async()=>{const s=await snapshot();return s.bridge&&s.hookAvailability.codex.state==='checked';});
 for(const id of ids){await hook('PreToolUse',id);await hook('PermissionRequest',id);}
 await wait(async()=>watched.size===2&&(await snapshot()).activity.pending===2&&(await snapshot()).codexApprovalSync.lastSyncedAt>0);
 // 桌宠使用独立入口打开聊天；打开失败保留待处理状态。
 await pet.getByRole('button',{name:'授权测试 0',exact:true}).click();
 assert.deepEqual(await app.evaluate(()=>global.openedChatURLs),[`codex://threads/${ids[0]}`]);
 assert.equal((await snapshot()).activity.pending,2);
 await app.evaluate(()=>{global.failChatOpen=true;});
 await pet.getByRole('button',{name:'授权测试 1',exact:true}).click();
 await pet.waitForFunction(()=>!document.getElementById('completion-error').hidden&&document.getElementById('completion-error').textContent.includes('测试打开失败'));
 assert.equal((await snapshot()).activity.pending,2);
 await app.evaluate(()=>{global.failChatOpen=false;});
 const before=await snapshot();
 sendRuntime(ids[0],false);
 await wait(async()=>{const s=await snapshot();return s.activity.pending===1&&s.activity.working===1;});
 await wait(async()=>await pet.locator('#pending-alert').textContent()==='待处理：1');
 assert.equal((await snapshot()).activity.unread,0);
 assert.equal((await snapshot()).activity.count,before.activity.count);
 assert.equal((await snapshot()).nurture.totalWorkSessions,before.nurture.totalWorkSessions);
 // 执行中的聊天也能通过独立入口打开。
 assert.ok((await panel.evaluate(id=>window.whale.openChat({sessionId:id}),ids[0])).value);
 assert.equal((await app.evaluate(()=>global.openedChatURLs)).at(-1),`codex://threads/${ids[0]}`);
 // 另一聊天仍待处理；断线后仅收到“执行中”快照不能凭空认定它已经批准。
 runtimeStates.set(ids[1],false);
 for(const c of clients)c.destroy();
 await wait(async()=> (await snapshot()).codexApprovalSync.state==='disconnected');
 await wait(async()=> (await snapshot()).codexApprovalSync.state==='connected');
 assert.equal((await snapshot()).activity.pending,1,'断线后没有观察到等待过程时不能误清');
 sendRuntime(ids[1],true);sendRuntime(ids[1],false);
 await wait(async()=> (await snapshot()).activity.pending===0);
 assert.equal((await snapshot()).activity.working,2);
 await panel.evaluate(()=>window.whale.action('hook-event',{source:'codex',event:'PermissionRequest',enabled:false}));
 await wait(async()=>watched.size===0);
 assert.equal((await snapshot()).activity.working,2,'关闭单项接收只停止状态订阅');
 // 完成通知打开失败保留未读，成功后才标为已读。
 await hook('Stop',ids[0]);
 await wait(async()=>(await snapshot()).activity.unread===1);
 const notice=(await snapshot()).activity.notices[0];
 await app.evaluate(()=>{global.failChatOpen=true;});
 assert.match((await panel.evaluate(value=>window.whale.openChat(value),{sessionId:ids[0],noticeId:notice.id})).error,/测试打开失败/);
 assert.equal((await snapshot()).activity.unread,1);
 await app.evaluate(()=>{global.failChatOpen=false;});
 await panel.locator('#unread-list').getByRole('button',{name:'打开聊天',exact:true}).click();
 await wait(async()=>(await snapshot()).activity.unread===0);
 assert.equal((await snapshot()).activity.unread,0);
 await panel.evaluate(()=>window.whale.action('hook-source',{source:'codex',enabled:false}));
 await wait(async()=>watched.size===0&&(await snapshot()).activity.working===0);
 assert.ok(received.filter(m=>m.type==='request').every(m=>m.method==='initialize'));
 assert.ok(received.filter(m=>m.type==='broadcast').every(m=>m.method==='thread-stream-following-changed'));
 assert.deepEqual(errors,[]);
 const policy=await app.evaluate(({BrowserWindow})=>({events:global.testWindowPolicy.events,windows:BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused(),top:w.isAlwaysOnTop()}))}));
 assert.deepEqual(policy.events,[]);assert.ok(policy.windows.every(w=>!w.visible&&!w.focused&&!w.top));
 console.log('PASS: pending/working/completed chats open via dedicated IPC without scrolling, failed open retains reminders, live IPC approval resolution, parallel pending preserved, no completion/growth/count replay, reconnect, event/source switches, no approval decisions, hidden windows');
}finally{if(app)await app.close();for(const c of clients)c.destroy();server.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
