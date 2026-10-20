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
  }
  const elements=new Map();
  for(const [,id] of fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8').matchAll(/id="([^"]+)"/g))elements.set(id,new Element());
  let data={state:'connected',busy:false,canApprove:true,page:1,items:[],hasMore:true,sourceTotal:50,lastChecked:1000},fail=false;
  const calls=[],timers=[];
  const window={whale:{archery:async(name,value)=>{
    calls.push({name,value});if(fail)throw new Error('raw transport failure');
    if(name==='page')data={...data,page:value};
    if(name==='set-enabled')data={...data,enabled:value};return {value:data};
  }}};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/archery-view.mjs'),'utf8').replace('export function','function');
  vm.runInNewContext(source+'\ncreateArcheryView();',{window,document:{getElementById:id=>elements.get(id),createElement:()=>new Element()},Date,setInterval:fn=>timers.push(fn)});
  const get=id=>elements.get('archery-'+id);
  return {get,calls,timers,set:value=>data={...data,...value},fail:()=>fail=true,async sync(){elements.get('nav-archery').click();await tick();}};
}
test('filtered empty pages show next-page controls without claiming source total is matching count',async()=>{
  const f=fixture();await f.sync();assert.match(f.get('empty').textContent,/继续查看下一页/);
  assert.equal(f.get('next').disabled,false);assert.equal(f.get('previous').disabled,true);
  assert.equal(f.get('count').textContent,'本页 0 条');assert.ok(!f.get('count').textContent.includes('50'));
  assert.match(f.get('pagination').textContent,/匹配总数未知/);assert.match(f.get('checked').textContent,/每 5 分钟/);
});
test('titles render as text and row, page and refresh controls call only fixed IPC actions',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'<img src=x onerror=bad()>',submitter:'提交人',instance:'ossv',database:'test',createdAt:'今天'}]});await f.sync();
  const row=f.get('list').children[0];assert.equal(row.children[0].children[0].textContent,'#566 <img src=x onerror=bad()>');
  row.children[1].children[0].click();await tick();assert.ok(f.calls.some(c=>c.name==='open'&&c.value===566));
  f.get('next').click();await tick();assert.ok(f.calls.some(c=>c.name==='page'&&c.value===2));
  assert.equal(f.get('previous').disabled,false);f.get('previous').click();await tick();
  f.get('refresh').click();await tick();assert.ok(f.calls.some(c=>c.name==='refresh'));
  assert.ok(f.calls.every(c=>['snapshot','open','page','refresh'].includes(c.name)));
});
test('view polling reads only snapshots, preserves rows and hides raw transport errors',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'待审核'}]});await f.sync();const row=f.get('list').children[0];
  f.get('view').hidden=false;f.timers[0]();await tick();assert.equal(f.get('list').children[0],row);
  assert.ok(f.calls.every(c=>c.name==='snapshot'));
  f.fail();await f.sync();assert.equal(f.get('list').children[0],row);assert.equal(f.get('error').hidden,false);
  assert.ok(!f.get('error').textContent.includes('raw transport'));
  const count=f.calls.length;f.get('view').hidden=true;f.timers[0]();await tick();assert.equal(f.calls.length,count);
});

test('approval buttons send only the displayed ID, disable while busy and preserve unknown-result notices',async()=>{
  const f=fixture();f.set({items:[{id:566,title:'待审核'}]});await f.sync();
  const controls=f.get('list').children[0].children[1],button=controls.children[1];
  assert.equal(button.textContent,'审核通过');assert.equal(button.disabled,false);
  button.click();assert.equal(button.disabled,true);await tick();
  assert.ok(f.calls.some(call=>call.name==='approve'&&call.value===566));assert.equal(button.disabled,false);
  f.set({canApprove:false});await f.sync();assert.equal(button.disabled,true);
  f.set({canApprove:true,items:[{id:566,title:'待审核',approvalStatus:'unknown'}],notice:'工单 #566 审批结果未知，请打开工单核实。'});await f.sync();
  const blocked=f.get('list').children[0].children[1].children[1];
  assert.equal(blocked.disabled,true);assert.equal(blocked.textContent,'结果待核实');assert.match(f.get('feedback').textContent,/结果未知/);
  f.timers[0]();await tick();assert.match(f.get('feedback').textContent,/结果未知/);
});

test('the header switch shows 已连接 or 已暂停 and only toggles automatic refresh',async()=>{
  const f=fixture();await f.sync();
  assert.equal(f.get('status').textContent,'已连接');assert.equal(f.get('status').attributes['aria-checked'],'true');
  f.get('status').click();await tick();
  assert.ok(f.calls.some(call=>call.name==='set-enabled'&&call.value===false));
  assert.equal(f.get('status').textContent,'已暂停');assert.match(f.get('checked').textContent,/已暂停自动刷新/);
  f.get('status').click();await tick();
  assert.ok(f.calls.some(call=>call.name==='set-enabled'&&call.value===true));
  assert.equal(f.get('status').textContent,'已连接');
});

test('navigation names Archery exactly and places it immediately after home',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../src/ui/index.html'),'utf8');
  const nav=[...html.matchAll(/id="nav-([a-z]+)"[^>]*>([^<]+)<\/button>/g)];
  assert.deepEqual(nav.map(match=>match[1]),['home','archery','hooks','wechat','mail','shortcuts']);
  assert.match(nav[1][2],/Archery$/);assert.ok(!nav[1][2].includes('待审核'));
  assert.ok(html.includes('<h1 id="archery-heading">Archery</h1>'));
});
