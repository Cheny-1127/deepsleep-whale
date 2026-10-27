'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(setImmediate);
function fixture() {
  class Element {
    constructor(){this.children=[];this.handlers={};this.attributes={};this.textContent='';this.hidden=false;}
    setAttribute(name,value){this.attributes[name]=String(value);}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    addEventListener(name,handler){this.handlers[name]=handler;}
    click(){this.handlers.click?.();}
    closest(){return null;}
  }
  const elements=new Map();
  for(const [,id] of fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8').matchAll(/id="([^"]+)"/g))elements.set(id,new Element());
  let data={state:'connected',busy:false,canApprove:true,canDetail:true,canListExecute:true,canExecute:true,mode:'approve',page:1,items:[],hasMore:true,sourceTotal:50,lastChecked:1000},fail=false;
  let detail=async id=>({id,sql:'SELECT 1; <img src=x onerror=bad()>',review:'审核结果',execution:'尚未执行'});
  let connection={valid:true,configFile:'/fixture/config.toml',defaultFile:'/default/config.toml',permissions:{detail:true,approve:true,execute:false}};
  const calls=[],timers=[],confirmations=[];let onConfirmation,confirmed=false,confirmImpl=async()=>confirmed;
  const window={whale:{onArcheryConfirmation:callback=>onConfirmation=callback,archery:async(name,value)=>{
    calls.push({name,value});if(fail)throw new Error('raw transport failure');
    if(name==='connection')return {value:connection};
    if(name==='choose-config')return {value:'/chosen/config.toml'};
    if(name==='save-config'){connection={...connection,valid:true,configFile:value};return {value:connection};}
    if(name==='detail'||name==='detail-large'||name==='approval-detail')return {value:await detail(value,name)};
    if(name==='set-mode')data={...data,mode:value,page:1};
    if(name==='page')data={...data,page:value};
    if(name==='set-enabled')data={...data,enabled:value};return {value:data};
  }}};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/archery-view.mjs'),'utf8').replace(/^import .*;\n/gm,'').replace('export function','function');
  vm.runInNewContext(source+'\ncreateArcheryView();',{window,document:{getElementById:id=>elements.get(id),createElement:tag=>Object.assign(new Element(),{tagName:tag})},Date,updateSidebarStatus:()=>{},confirmAction:async options=>{confirmations.push(options);return confirmImpl();},setInterval:fn=>timers.push(fn)});
  const get=id=>elements.get('archery-'+id);
  return {get,calls,timers,confirmations,confirmation:request=>onConfirmation(request),setConfirmed:value=>confirmed=value,setConfirm:fn=>confirmImpl=fn,set:value=>data={...data,...value,...(value.items?{items:value.items.map(item=>({status:'workflow_manreviewing',...item}))}:{})},setConnection:value=>connection={...connection,...value},setDetail:fn=>detail=fn,fail:()=>fail=true,async sync(){elements.get('nav-archery').click();await tick();}};
}
test('approval confirmation renders the main-process item and replies only with the issued token and explicit choice',async()=>{
  const f=fixture(),request={token:'main-request',item:{id:566,title:'<img src=x>',submitter:'测试人',instance:'实例',database:'数据库'}};
  await f.confirmation(request);assert.equal(f.confirmations[0].owner,f.get('view'));
  assert.match(f.confirmations[0].title,/#566/);assert.match(f.confirmations[0].message,/<img src=x>.*\n提交人：测试人/);
  assert.doesNotMatch(f.confirmations[0].message,/仅审核这一笔|不请求执行 SQL/);
  assert.equal(f.calls.at(-1).name,'confirm-approval');assert.equal(f.calls.at(-1).value.token,'main-request');assert.equal(f.calls.at(-1).value.confirmed,false);
  f.setConfirmed(true);await f.confirmation({...request,token:'next-request'});
  assert.equal(f.calls.at(-1).value.token,'next-request');assert.equal(f.calls.at(-1).value.confirmed,true);
  assert.equal(f.calls.some(c=>c.name==='approve'),false,'确认回复不能另行指定工单或直接发起审批');
});
test('approval directly displays provided cached SQL without another detail request',async()=>{
  const f=fixture();await f.confirmation({token:'cached',canDetail:true,item:{id:566,title:'缓存工单'},cachedDetail:{id:566,sql:'SELECT cached;',execution:'未执行',cached:true}});
  const box=f.confirmations[0].content;
  assert.deepEqual(box.children.filter(c=>c.tagName==='pre').map(c=>c.textContent),['SELECT cached;','未执行']);
  assert.equal(f.calls.some(c=>c.name==='approval-detail'),false);
  assert.equal(box.children.some(c=>c.textContent==='获取详情'),false);
});
test('uncached approval details load only on click and failed reads offer retry',async()=>{
  const f=fixture();let finish;f.setConfirm(()=>new Promise(resolve=>finish=resolve));
  const waiting=f.confirmation({token:'uncached',canDetail:true,item:{id:566,title:'待获取'}});await tick();
  const box=f.confirmations[0].content;assert.equal(f.calls.length,0);
  f.setDetail(async()=>{throw Error('读取失败');});box.children.find(c=>c.textContent==='获取详情').click();await tick();
  assert.equal(box.children[0].textContent,'读取失败');
  f.setDetail(async()=>({id:566,sql:'SELECT loaded;',execution:''}));box.children.find(c=>c.textContent==='重试获取详情').click();await tick();
  assert.equal(box.children.find(c=>c.tagName==='pre').textContent,'SELECT loaded;');
  const reads=f.calls.filter(c=>c.name==='approval-detail');assert.equal(reads.length,2);assert.equal(reads[0].value.token,'uncached');assert.equal(reads[0].value.allowLarge,false);
  finish(false);await waiting;
});
test('closing an approval dialog discards late detail content',async()=>{
  const f=fixture();let finish,release;f.setConfirm(()=>new Promise(resolve=>finish=resolve));f.setDetail(()=>new Promise(resolve=>release=resolve));
  const waiting=f.confirmation({token:'closing',canDetail:true,item:{id:566,title:'取消'}});await tick();
  const box=f.confirmations[0].content;box.children.find(c=>c.textContent==='获取详情').click();await tick();
  finish(false);await waiting;release({id:566,sql:'late-private-sql'});await tick();
  assert.equal(box.children.some(c=>c.textContent.includes('late-private-sql')),false);
});
test('repeated clicks on the old preview button cannot start duplicate detail reads',async()=>{
  const f=fixture();let finish,release;f.setConfirm(()=>new Promise(resolve=>finish=resolve));f.setDetail(()=>new Promise(resolve=>release=resolve));
  const waiting=f.confirmation({token:'single-read',canDetail:true,item:{id:566,title:'只读一次'}});await tick();
  const box=f.confirmations[0].content,button=box.children.find(c=>c.textContent==='获取详情');button.click();button.click();await tick();
  assert.equal(f.calls.filter(c=>c.name==='approval-detail').length,1);release({id:566,sql:'SELECT once;'});await tick();
  finish(false);await waiting;
});
test('connected configuration shows connected, editing enables save, and successful save collapses settings',async()=>{
  const f=fixture();await f.sync();assert.equal(f.get('save-config').textContent,'已连接');assert.equal(f.get('save-config').disabled,true);
  assert.equal(f.get('connection-state').textContent,'已连接');assert.equal(Boolean(f.get('connection-options').open),false);
  f.get('config-file').value='/chosen/config.toml';f.get('config-file').handlers.input();
  assert.equal(f.get('save-config').textContent,'保存并连接');assert.equal(f.get('save-config').disabled,false);
  f.get('connection-options').open=true;await f.get('connection-form').handlers.submit({preventDefault(){}});
  assert.equal(f.get('save-config').textContent,'已连接');assert.equal(f.get('save-config').disabled,true);assert.equal(f.get('connection-options').open,false);
  f.set({state:'error'});await f.sync();assert.equal(f.get('save-config').textContent,'重新连接');assert.equal(f.get('save-config').disabled,false);
  const writes=f.calls.filter(c=>c.name==='save-config').length;
  await f.get('connection-form').handlers.submit({preventDefault(){}});
  assert.ok(f.calls.some(c=>c.name==='refresh'));assert.equal(f.calls.filter(c=>c.name==='save-config').length,writes);
});
test('whole record opens one detail at a time without browser or separate detail buttons',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'第一条'},{id:567,title:'第二条'}]});await f.sync();
  const [first,second]=f.get('list').children;first.children[0].click();await tick();assert.equal(first.children[2].hidden,false);
  second.children[0].click();await tick();assert.equal(first.children[2].hidden,true);assert.equal(second.children[2].hidden,false);
  second.children[0].click();assert.equal(second.children[2].hidden,true);
  assert.ok(first.children[1].children.every(c=>!['查看详情','打开工单','在浏览器打开'].includes(c.textContent)));
  assert.ok(first.children[2].children.every(c=>c.textContent!=='在浏览器打开'));
});
test('filtered empty pages show next-page controls without claiming source total is matching count',async()=>{
  const f=fixture();await f.sync();assert.match(f.get('empty').textContent,/继续查看下一页/);
  assert.equal(f.get('next').disabled,false);assert.equal(f.get('previous').disabled,true);
  assert.equal(f.get('count').textContent,'本页 0 条');assert.ok(!f.get('count').textContent.includes('50'));
  assert.match(f.get('pagination').textContent,/匹配总数未知/);assert.match(f.get('checked').textContent,/每 5 分钟/);
});
test('titles render as text and row, page and refresh controls call only fixed IPC actions',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'<img src=x onerror=bad()>',submitter:'提交人',instance:'ossv',database:'test',createdAt:'今天'}]});await f.sync();
  const row=f.get('list').children[0];assert.equal(row.children[0].children[0].textContent,'#566 <img src=x onerror=bad()>');
  row.children[0].click();await tick();assert.ok(f.calls.some(c=>c.name==='detail'&&c.value===566));
  f.get('next').click();await tick();assert.ok(f.calls.some(c=>c.name==='page'&&c.value===2));
  assert.equal(f.get('previous').disabled,false);f.get('previous').click();await tick();
  f.get('refresh').click();await tick();assert.ok(f.calls.some(c=>c.name==='refresh'));
  assert.ok(f.calls.every(c=>['snapshot','connection','detail','page','refresh'].includes(c.name)));
});
test('view polling reads only snapshots, preserves rows and hides raw transport errors',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'待审核'}]});await f.sync();const row=f.get('list').children[0];
  f.get('view').hidden=false;f.timers[0]();await tick();assert.equal(f.get('list').children[0],row);
  assert.ok(f.calls.every(c=>['snapshot','connection'].includes(c.name)));
  f.fail();await f.sync();assert.equal(f.get('list').children[0],row);assert.equal(f.get('error').hidden,false);
  assert.ok(!f.get('error').textContent.includes('raw transport'));
  const count=f.calls.length;f.get('view').hidden=true;f.timers[0]();await tick();assert.equal(f.calls.length,count);
});

test('approval buttons send only the displayed ID, disable while busy and preserve unknown-result notices',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'待审核'}]});await f.sync();
  const controls=f.get('list').children[0].children[1],button=controls.children[0];
  assert.equal(button.textContent,'审核通过');assert.equal(button.disabled,false);
  button.click();assert.equal(button.disabled,true);await tick();
  assert.ok(f.calls.some(call=>call.name==='approve'&&call.value===566));assert.equal(button.disabled,false);
  f.set({canApprove:false});await f.sync();assert.equal(button.disabled,true);
  f.set({canApprove:true,items:[{id:566,title:'待审核',approvalStatus:'unknown'}],notice:'工单 #566 审批结果未知，请打开工单核实。'});await f.sync();
  const blocked=f.get('list').children[0].children[1].children[0];
  assert.equal(blocked.disabled,true);assert.equal(blocked.textContent,'结果待核实');assert.match(f.get('feedback').textContent,/结果未知/);
  f.timers[0]();await tick();assert.match(f.get('feedback').textContent,/结果未知/);
});

test('the header reports connection failures accurately and only toggles automatic refresh',async()=>{
  const f=fixture();await f.sync();
  assert.equal(f.get('status').textContent,'已连接');assert.equal(f.get('status').attributes['aria-checked'],'true');
  f.get('status').click();await tick();
  assert.ok(f.calls.some(call=>call.name==='set-enabled'&&call.value===false));
  assert.equal(f.get('status').textContent,'已暂停');assert.match(f.get('checked').textContent,/已暂停自动刷新/);
  f.get('status').click();await tick();
  assert.ok(f.calls.some(call=>call.name==='set-enabled'&&call.value===true));
  assert.equal(f.get('status').textContent,'已连接');
  f.set({state:'error'});await f.sync();assert.equal(f.get('status').textContent,'连接失败');
  assert.equal(f.get('status').attributes['aria-checked'],'true');
  f.set({state:'checking'});await f.sync();assert.equal(f.get('status').textContent,'连接中');
});

test('MCP detail and approval do not require an external browser action',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'待审核'}]});await f.sync();
  const controls=f.get('list').children[0].children[1];
  assert.equal(controls.children.length,1);assert.equal(controls.children[0].disabled,false);
  f.get('list').children[0].children[0].click();await tick();
  const box=f.get('list').children[0].children[2];assert.equal(box.hidden,false);
  assert.ok(!box.children.some(child=>child.textContent==='在浏览器打开'));
});

test('record opens SQL and execution without review; collapse and reopening reuse only the current row',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'可点击的工单'}],contentRevision:1});await f.sync();
  const row=f.get('list').children[0],trigger=row.children[0],box=row.children[2];
  assert.equal(box.hidden,true);trigger.click();await tick();assert.equal(box.hidden,false);
  assert.equal(trigger.attributes['aria-expanded'],'true');assert.equal(trigger.attributes['aria-pressed'],'true');
  assert.deepEqual(box.children.filter(c=>c.tagName==='pre').map(c=>c.textContent),['SELECT 1; <img src=x onerror=bad()>','尚未执行']);
  assert.ok(!box.children.some(c=>c.textContent==='审核信息'));
  trigger.click();assert.equal(box.hidden,true);trigger.click();await tick();assert.equal(box.hidden,false);
  assert.equal(f.calls.filter(c=>c.name==='detail').length,1);
  f.set({contentRevision:2});await f.sync();assert.notEqual(f.get('list').children[0],row);assert.equal(f.get('list').children[0].children[2].hidden,true);
});

test('list status refresh preserves expanded cached SQL and manual reload is separate',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'详情',status:'workflow_manreviewing'}],contentRevision:1});await f.sync();
  const row=f.get('list').children[0];row.children[0].click();await tick();
  const box=row.children[2],sql=box.children.find(c=>c.tagName==='pre');f.set({items:[{id:566,title:'详情',status:'workflow_review_pass'}]});await f.sync();
  assert.equal(f.get('list').children[0],row);assert.equal(box.hidden,false);
  assert.match(box.children[0].textContent,/状态：审核通过/);assert.equal(f.calls.filter(c=>c.name==='detail').length,1);
  assert.equal(box.children.find(c=>c.tagName==='pre'),sql,'只改状态文字，SQL 节点及滚动位置保留');
  f.get('refresh').click();await tick();assert.equal(box.hidden,false);assert.equal(f.calls.filter(c=>c.name==='detail').length,1);
  box.children.find(c=>c.textContent==='重新加载详情').click();await tick();assert.ok(f.calls.some(c=>c.name==='detail-refresh'));
});

test('detail failure offers retry and large results need a separate explicit action',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'详情'}]});await f.sync();
  f.setDetail(async()=>{throw Error('详情读取失败');});const row=f.get('list').children[0];row.children[0].click();await tick();
  const box=row.children[2];assert.equal(box.children[0].textContent,'详情读取失败');
  f.setDetail(async()=>({id:566,needsConfirmation:true,bytes:40000}));box.children.find(c=>c.textContent==='重试').click();await tick();
  assert.equal(f.calls.filter(c=>c.name==='detail-large').length,0);
  f.setDetail(async()=>({id:566,sql:'SELECT 2;'}));box.children.find(c=>c.textContent==='加载完整详情').click();await tick();
  assert.ok(f.calls.some(c=>c.name==='detail-large'&&c.value===566));assert.equal(box.children.find(c=>c.tagName==='pre').textContent,'SELECT 2;');
});

test('late detail content is discarded when the account revision changes during the request',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'详情'}],contentRevision:1});await f.sync();let release;
  f.setDetail(()=>new Promise(resolve=>release=resolve));const old=f.get('list').children[0];old.children[0].click();await tick();
  f.set({contentRevision:2});release({id:566,sql:'old-account-sql'});await tick();
  const current=f.get('list').children[0];assert.notEqual(current,old);assert.equal(current.children[2].hidden,true);
  assert.ok(!current.children[2].children.some(c=>c.textContent.includes('old-account-sql')));
});

test('navigation preserves menu order and Archery name with decorative SVG icons',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8');
  const nav=[...html.matchAll(/id="nav-([a-z]+)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(nav.map(match=>match[1]),['home','subscriptions','archery','hooks','wechat','mail','quota','shortcuts','planner','reports']);
  assert.equal(nav[2][2].replace(/<[^>]*>/g,'').trim(),'Archery');
  assert.ok(html.includes('<h1 id="archery-heading">Archery</h1>'));
});

test('connection settings preserve draft across polling and save only the chosen path',async()=>{
  const f=fixture();await f.sync();assert.equal(f.get('config-file').value,'/fixture/config.toml');
  f.get('config-file').value='/draft/config.toml';f.get('config-file').handlers.input();await f.sync();assert.equal(f.get('config-file').value,'/draft/config.toml');
  await f.get('choose-config').handlers.click();assert.equal(f.get('config-file').value,'/chosen/config.toml');
  assert.match(f.get('connection-feedback').textContent,/路径尚未保存/);
  await f.get('connection-form').handlers.submit({preventDefault(){}});
  assert.ok(f.calls.some(call=>call.name==='save-config'&&call.value==='/chosen/config.toml'));
  f.get('default-config').click();assert.equal(f.get('config-file').value,'/default/config.toml');
});

test('one processing list shows both actions and updates the original button when status changes',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'待审核'},{id:567,title:'已审核',status:'workflow_review_pass'}]});await f.sync();
  const [review,execution]=f.get('list').children;
  const reviewButton=review.children[1].children[0],executeButton=execution.children[1].children[0];
  assert.equal(reviewButton.textContent,'审核通过');assert.equal(executeButton.textContent,'执行');
  reviewButton.click();await tick();executeButton.click();await tick();
  assert.ok(f.calls.some(c=>c.name==='approve'&&c.value===566));assert.ok(f.calls.some(c=>c.name==='execute'&&c.value===567));
  f.set({items:[{id:566,title:'已审核',status:'workflow_review_pass'},{id:567,title:'已结束',status:'workflow_finish'}]});await f.sync();
  assert.equal(f.get('list').children[0],review);assert.equal(reviewButton.textContent,'执行');assert.equal(reviewButton.disabled,false);
  reviewButton.click();await tick();assert.ok(f.calls.some(c=>c.name==='execute'&&c.value===566));
  assert.equal(executeButton.hidden,true);executeButton.click();await tick();assert.equal(f.calls.filter(c=>c.name==='execute'&&c.value===567).length,1);
  f.set({items:[{id:566,title:'未知',status:'workflow_review_pass',executionStatus:'unknown'}]});await f.sync();
  const blocked=f.get('list').children[0].children[1].children[0];assert.equal(blocked.disabled,true);assert.equal(blocked.textContent,'结果待核实');
  const html=fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8');assert.doesNotMatch(html,/archery-mode-/);
});
test('execution has a distinct confirmation and reuses the same cached SQL without a new read',async()=>{
  const f=fixture();f.setConfirmed(true);await f.confirmation({operation:'execute',token:'execute-one',item:{id:566,title:'待执行'},canDetail:true,cachedDetail:{id:566,sql:'SELECT cached;',status:'workflow_review_pass'}});
  assert.equal(f.confirmations[0].title,'执行工单 #566？');assert.equal(f.confirmations[0].confirmLabel,'执行');assert.match(f.confirmations[0].message,/请求执行这一笔工单的 SQL/);
  assert.equal(f.calls.filter(c=>c.name==='approval-detail').length,0);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'confirm-approval');assert.equal(f.calls[0].value.token,'execute-one');assert.equal(f.calls[0].value.confirmed,true);
});
