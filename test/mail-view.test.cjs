'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

// 使用最小 DOM 替身验证界面交互，不启动 Electron，也不访问真实邮箱。
function fixture() {
  class Element {
    constructor(id=''){this.id=id;this.hidden=false;this.children=[];this.parentElement=null;this.handlers={};this.dataset={};this.attributes={};this.textContent='';this.value='';}
    get nextSibling(){const siblings=this.parentElement?.children||[];return siblings[siblings.indexOf(this)+1]||null;}
    remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}}
    append(...items){for(const item of items){item.remove();item.parentElement=this;this.children.push(item);}}
    after(item){const parent=this.parentElement;item.remove();item.parentElement=parent;parent.children.splice(parent.children.indexOf(this)+1,0,item);}
    replaceChildren(...items){for(const child of [...this.children])child.remove();this.append(...items);}
    addEventListener(name,handler){this.handlers[name]=handler;}
    setAttribute(name,value){this.attributes[name]=value;}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='.'+child.className?[child]:[]),...child.querySelectorAll(selector)]);}
    scrollIntoView(){}
    click(){return this.handlers.click?.({preventDefault(){}});}
  }
  const elements=new Map(),html=fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8');
  for(const [,id] of html.matchAll(/id="([^"]+)"/g)){const element=new Element(id);if(id.startsWith('nav-'))element.dataset.view=id.slice(4);elements.set(id,element);}
  const get=id=>elements.get('mail-'+id),detail=get('detail');detail.hidden=true;
  detail.append(get('body'),get('attachments'));get('view').append(get('delete'));get('delete').hidden=true;
  get('view').append(get('list'),detail);
  const data={state:'connected',enabled:true,config:null,messages:[{id:'10:2',subject:'最新邮件'},{id:'10:1',subject:'上一封邮件'}]},reads=[],calls=[];
  let reveal=async()=>({value:{password:'saved-fixture-password'}}),confirmation=true,deleteError='';
  const pending=[],body='完整正文\n'+'长 SQL 行\n'.repeat(300)+'正文结束标记';let defer=false;
  const window={whale:{mail:async(name,id)=>{
    calls.push({name,value:id});
    if(name==='reveal-password')return reveal();
    if(name==='pause'){data.enabled=false;data.state='paused';}
    if(name==='connect'){data.enabled=true;data.state='connected';}
    if(name==='delete-message'){
      if(deleteError)return {error:deleteError};
      data.messages=data.messages.filter(item=>item.id!==id.id);
    }
    if(name!=='read')return {value:data};
    reads.push(id);const result={value:{body,attachments:[]}};
    return defer?new Promise(resolve=>pending.push(()=>resolve(result))):result;
  }}};
  const document={getElementById:id=>elements.get(id),createElement:()=>new Element(),querySelectorAll:()=>[...elements.values()].filter(element=>element.dataset.view)};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/mail-view.mjs'),'utf8').replace(/^import .*;\n/gm,'').replace('export function','function');
  vm.runInNewContext(source+'\ncreateMailView();',{document,window,setInterval:()=>{},Date,updateSidebarStatus:()=>{},confirmAction:async()=>confirmation});
  const tick=async()=>{elements.get('nav-mail').click();await new Promise(setImmediate);};
  const buttons=()=>get('list').querySelectorAll('.mail-message');
  return {get,data,calls,detail,body,reads,pending,tick,buttons,leave:()=>elements.get('nav-home').click(),defer:()=>defer=true,setReveal:fn=>reveal=fn,setConfirmation:value=>confirmation=value,setDeleteError:value=>deleteError=value};
}

test('selected mail deletion requires confirmation and removes only the chosen message',async()=>{
  const f=fixture();f.data.config={type:'feishu',email:'owner@example.com',host:'imap.feishu.cn',port:993,limit:20,hasPassword:true};
  await f.tick();f.buttons()[1].click();await new Promise(setImmediate);f.setConfirmation(false);
  await f.get('delete').click();assert.equal(f.calls.some(call=>call.name==='delete-message'),false);assert.equal(f.detail.hidden,false);
  f.setConfirmation(true);await f.get('delete').click();
  assert.deepEqual(f.data.messages.map(item=>item.id),['10:2']);assert.equal(f.detail.hidden,true);assert.equal(f.get('body').textContent,'');
  assert.equal(f.calls.find(call=>call.name==='delete-message').value.id,'10:1');
});
test('failed deletion leaves the selected mail and its body available',async()=>{
  const f=fixture();f.data.config={type:'feishu',email:'owner@example.com',host:'imap.feishu.cn',port:993,limit:20,hasPassword:true};
  await f.tick();f.buttons()[0].click();await new Promise(setImmediate);f.setDeleteError('磁盘保存失败');
  await f.get('delete').click();assert.equal(f.data.messages.length,2);assert.equal(f.detail.hidden,false);
  assert.equal(f.get('body').textContent,f.body);assert.match(f.get('feedback').textContent,/磁盘保存失败/);
});

test('mail expands immediately below its row, keeps the whole body and preserves rows during polling',async()=>{
  const f=fixture();await f.tick();const [first,second]=f.buttons();
  second.click();await new Promise(setImmediate);
  assert.equal(second.parentElement.nextSibling,f.detail,'details must follow the clicked email');
  assert.equal(f.get('delete').parentElement,second.parentElement,'删除图标与选中邮件同一行');
  assert.equal(f.detail.attributes['aria-labelledby'],second.dataset.subjectId,'正文使用列表标题作为无障碍名称');
  assert.equal(f.get('body').textContent,f.body,'long mail must retain its ending');
  assert.equal(second.attributes['aria-expanded'],'true');
  await f.tick();assert.equal(f.buttons()[1],second,'polling must preserve the clicked row');
  assert.equal(second.parentElement.nextSibling,f.detail);
  second.click();await new Promise(setImmediate);assert.equal(f.detail.hidden,true);
  assert.equal(f.get('delete').hidden,true);
  assert.equal(second.attributes['aria-expanded'],'false');assert.equal(f.reads.length,1,'collapse must not read the email again');
  first.click();await new Promise(setImmediate);assert.equal(first.parentElement.nextSibling,f.detail);
  assert.equal(f.detail.hidden,false);
});

test('collapsing while the body loads ignores the late response',async()=>{
  const f=fixture();await f.tick();f.defer();const button=f.buttons()[0];
  button.click();await new Promise(setImmediate);assert.equal(f.pending.length,1);
  button.click();f.pending.shift()();await new Promise(setImmediate);
  assert.equal(f.detail.hidden,true);assert.equal(f.get('body').textContent,'');
});

test('saved password status survives connection errors and follows the account being edited',async()=>{
  const f=fixture();await f.tick();assert.equal(f.get('config-state').textContent,'未配置');
  assert.match(f.get('password-state').textContent,/尚未配置/);
  f.data.config={type:'feishu',email:'owner@example.com',host:'imap.feishu.cn',port:993,limit:20,hasPassword:true};
  f.data.state='error';await f.tick();
  assert.equal(f.get('config-state').textContent,'已配置');assert.equal(f.get('config-card').dataset.paused,'false');
  assert.match(f.get('password-state').textContent,/已加密保存/);assert.equal(f.get('password').value,'');
  assert.equal(f.get('password').placeholder,'********');
  f.get('email').value='other@example.com';f.get('settings').handlers.input();
  assert.match(f.get('password-state').textContent,/当前邮箱或服务器未配置/);
  assert.notEqual(f.get('password').placeholder,'********');
  await f.tick();assert.match(f.get('password-state').textContent,/未配置/,'polling must not claim an edited account can reuse the saved password');
  f.get('email').value='owner@example.com';f.get('settings').handlers.input();
  assert.match(f.get('password-state').textContent,/已加密保存/);
  f.get('password').value='replacement-not-saved';f.get('settings').handlers.input();
  assert.match(f.get('password-state').textContent,/保存并接收后替换/);
  assert.ok(!f.get('password-state').textContent.includes('replacement-not-saved'));
  f.get('password').value='';f.get('type').value='custom';f.get('type').handlers.change();
  f.get('host').value='other.example.com';f.get('settings').handlers.input();
  assert.match(f.get('password-state').textContent,/未配置/);
});

test('eye reveals the saved password only on click, hides it, and submits unchanged credentials by reuse',async()=>{
  const f=fixture();f.data.config={type:'feishu',email:'owner@example.com',host:'imap.feishu.cn',port:993,limit:20,hasPassword:true};
  await f.tick();assert.equal(f.calls.filter(call=>call.name==='reveal-password').length,0);
  f.get('password-toggle').click();await new Promise(setImmediate);
  assert.equal(f.get('password').type,'text');assert.equal(f.get('password').value,'saved-fixture-password');
  assert.equal(f.get('password-toggle').attributes['aria-label'],'隐藏密码');
  await f.tick();assert.equal(f.get('password').value,'saved-fixture-password','polling must preserve the deliberate reveal');
  f.get('password-toggle').click();assert.equal(f.get('password').type,'password');assert.equal(f.get('password').value,'');
  f.get('password-toggle').click();await new Promise(setImmediate);
  f.get('message-limit').value='21';f.get('settings').handlers.input();
  f.get('settings').handlers.submit({preventDefault(){}});await new Promise(setImmediate);
  assert.equal(f.calls.find(call=>call.name==='connect').value.password,'','viewing must not submit a password replacement');
  assert.equal(f.get('password').type,'password');assert.equal(f.get('password').value,'');
});

test('eye toggles a newly entered password without retrieving or losing it',async()=>{
  const f=fixture();await f.tick();f.get('password').value='new-fixture-password';f.get('password').handlers.input();f.get('settings').handlers.input();
  f.get('password-toggle').click();assert.equal(f.get('password').type,'text');
  f.get('password-toggle').click();assert.equal(f.get('password').type,'password');assert.equal(f.get('password').value,'new-fixture-password');
  assert.equal(f.calls.filter(call=>call.name==='reveal-password').length,0);
  f.get('settings').handlers.submit({preventDefault(){}});await new Promise(setImmediate);
  assert.equal(f.calls.find(call=>call.name==='connect').value.password,'new-fixture-password');
});

test('changing accounts or collapsing settings clears saved plaintext and rejects late reveal responses',async()=>{
  const f=fixture();f.data.config={type:'feishu',email:'owner@example.com',host:'imap.feishu.cn',port:993,limit:20,hasPassword:true};await f.tick();
  f.get('password-toggle').click();await new Promise(setImmediate);
  f.get('email').value='other@example.com';f.get('settings').handlers.input();
  assert.equal(f.get('password').value,'');assert.equal(f.get('password').type,'password');
  f.get('email').value='owner@example.com';f.get('settings').handlers.input();
  f.get('password-toggle').click();await new Promise(setImmediate);f.leave();
  assert.equal(f.get('password').value,'');assert.equal(f.get('password').type,'password');
  let resolve;f.setReveal(()=>new Promise(done=>resolve=done));f.get('password-toggle').click();
  f.get('options').open=false;f.get('options').handlers.toggle();resolve({value:{password:'late-fixture-secret'}});await new Promise(setImmediate);
  assert.equal(f.get('password').value,'');assert.equal(f.get('password').type,'password');
  f.get('password-toggle').click();f.get('email').value='other@example.com';f.get('settings').handlers.input();
  resolve({value:{password:'another-late-secret'}});await new Promise(setImmediate);
  assert.equal(f.get('password').value,'');assert.equal(f.get('password').type,'password');
});


test('one control starts and pauses mail, while real configuration edits save and resume reception',async()=>{
  const f=fixture();f.data.enabled=false;f.data.state='disconnected';await f.tick();
  assert.equal(f.get('connect').textContent,'开始接收');assert.equal(f.get('connect').type,'submit');
  f.data.config={type:'feishu',email:'owner@example.com',host:'imap.feishu.cn',port:993,limit:20,hasPassword:true};
  f.data.enabled=true;f.data.state='connected';await f.tick();
  assert.equal(f.get('connect').textContent,'暂停接收');assert.equal(f.get('connect').type,'button');
  f.data.busy=true;await f.tick();assert.equal(f.get('connect').disabled,false,'background synchronization must remain pausable');
  f.get('connect').click();await new Promise(setImmediate);
  assert.equal(f.calls.filter(call=>call.name==='pause').length,1);
  assert.equal(f.get('connect').textContent,'开始接收');assert.equal(f.get('connect').type,'submit');
  f.data.busy=false;await f.tick();f.get('settings').handlers.submit({preventDefault(){}});await new Promise(setImmediate);
  assert.equal(f.calls.filter(call=>call.name==='connect').length,1);assert.equal(f.get('connect').textContent,'暂停接收');
  f.get('message-limit').value='10';f.get('settings').handlers.input();
  assert.equal(f.get('connect').textContent,'保存并接收');assert.equal(f.get('connect').type,'submit');
  f.get('message-limit').value='20';f.get('settings').handlers.input();
  assert.equal(f.get('connect').textContent,'暂停接收','reverting an edit must restore the pause action');
  f.get('password').value='changed-password';f.get('password').handlers.input();f.get('settings').handlers.input();
  assert.equal(f.get('connect').textContent,'保存并接收');
  f.get('settings').handlers.submit({preventDefault(){}});await new Promise(setImmediate);
  assert.equal(f.calls.filter(call=>call.name==='connect').length,2);
  assert.equal(f.calls.filter(call=>call.name==='pause').length,1,'saving changes must never pause instead');
  assert.equal(f.calls.filter(call=>call.name==='connect').at(-1).value.password,'changed-password');
});

test('SQL notification emails behave as regular messages without order operations',async()=>{
  const f=fixture();f.data.messages[0].subject='[SQL上线申请]新的工单申请#578';
  await f.tick();assert.equal(f.get('list').querySelectorAll('.mail-order-actions').length,0);
  f.buttons()[0].click();await new Promise(setImmediate);assert.equal(f.get('body').textContent,f.body);
  assert.equal(f.get('delete').hidden,false);assert.equal(f.calls.some(call=>call.name.includes('order')),false);
});

test('mail header has no connection badge and paused configuration is gray but remains editable',async()=>{
  const f=fixture();f.data.config={type:'feishu',email:'owner@example.com',host:'imap.feishu.cn',port:993,limit:20,hasPassword:true};
  await f.tick();assert.equal(f.get('status'),undefined);assert.equal(f.get('config-card').dataset.paused,'false');
  f.data.enabled=false;f.data.state='paused';await f.tick();assert.equal(f.get('config-card').dataset.paused,'true');
  assert.equal(f.get('config-state').textContent,'已配置');assert.equal(f.get('connect').disabled,false);assert.equal(f.get('connect').textContent,'开始接收');
  f.data.enabled=true;await f.tick();assert.equal(f.get('config-card').dataset.paused,'false');
});
