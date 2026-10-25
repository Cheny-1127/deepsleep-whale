'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createCodexChatOpener,scrollLatest}=require('../src/clients/codex-chat.cjs');
const id='11111111-1111-4111-8111-111111111110';

test('every Codex task open locates latest content after opening, regardless of task state',async()=>{
  const calls=[];
  const opener=createCodexChatOpener({openExternal:async url=>calls.push(url),locateLatest:async value=>calls.push(value)});
  await opener.open(id,{title:'等待授权'});
  await opener.open(id);
  assert.deepEqual(calls,[`codex://threads/${id}`,{sessionId:id,title:'等待授权'},`codex://threads/${id}`,{sessionId:id,title:''}]);
});
test('invalid targets and failed opens never invoke native positioning',async()=>{
  let located=0,opened=0;
  const opener=createCodexChatOpener({openExternal:async()=>{opened++;throw Error('open failed');},locateLatest:()=>located++});
  await assert.rejects(opener.open(id+'?prompt=send'),/无法定位/);
  assert.equal(opened,0);
  await assert.rejects(opener.open(id),/open failed/);assert.equal(located,0);
});
test('concurrent clicks cannot redirect an in-progress locator; a failed location unlocks retry',async()=>{
  let release,count=0;
  const opener=createCodexChatOpener({openExternal:async()=>{},locateLatest:()=>{if(count++===0)return new Promise((_,reject)=>{release=()=>reject(Error('permission required'));});}});
  const first=opener.open(id);await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(opener.open('11111111-1111-4111-8111-111111111111'),/正在打开/);
  release();await assert.rejects(first,/permission required/);await opener.open(id);assert.equal(count,2);
});
test('native adapter uses a static script and separate arguments, and reports incomplete positioning',async()=>{
  const title='标题 " $(do-not-execute)';
  await scrollLatest({sessionId:id,title},{platform:'darwin',execute(file,args,options,callback){
    assert.equal(file,'/usr/bin/osascript');assert.deepEqual(args.slice(0,2),['-l','JavaScript']);
    assert.equal(path.basename(args[2]),'codex-scroll-latest.js');assert.deepEqual(args.slice(3),[id,title]);assert.equal(options.timeout,6000);
    callback(null,JSON.stringify({status:'scrolled'}));
  }});
  for(const [status,message] of [['permission-required',/辅助功能/],['focus-changed',/切换/],['not-found',/未能确认/],['unknown',/未能确认/]])
    await assert.rejects(scrollLatest({sessionId:id,title},{platform:'darwin',execute(_file,_args,_options,callback){callback(null,JSON.stringify({status}));}}),message);
  await assert.rejects(scrollLatest({sessionId:id},{platform:'linux'}),/当前平台/);
  await assert.rejects(scrollLatest({sessionId:id},{platform:'darwin',execute(_file,_args,_options,callback){callback(Error('timeout'));}}),/权限/);
  await assert.rejects(scrollLatest({sessionId:id},{platform:'darwin',execute(_file,_args,_options,callback){callback(null,'not json');}}),/未能确认/);
});

const script=fs.readFileSync(path.join(__dirname,'../src/clients/codex-scroll-latest.js'),'utf8');
function nativeFixture({trusted=true,title='等待授权 — Codex',url='',duplicate=false,foreground=true,leave=false,changedTitle=false}={}) {
  const pressed=[];let polls=0,frontChecks=0;
  function element(role,name='',children=[],attributes={}) {
    return {role:()=>role,name:()=>name,description:()=>name,enabled:()=>true,uiElements:()=>children,
      attributes:{byName:key=>({value:()=>attributes[key]??null})},actions:{byName:action=>({perform:()=>pressed.push({name,action})})}};
  }
  const scroll=()=>element('AXButton','Scroll to bottom');
  const content=[scroll(),element('AXButton','Allow once'),element('AXWebArea','',[],{AXURL:url})];
  if(duplicate)content.push(scroll());
  const window=element('AXWindow',title,content,{AXMain:true});
  if(changedTitle){let reads=0;window.name=()=>reads++===0?title:'另一个任务 — Codex';}
  const process={bundleIdentifier:()=>'com.openai.codex',frontmost:()=>!leave||++frontChecks<1,windows:()=>[window]};
  const context={ObjC:{import(){}},$:{AXIsProcessTrusted:()=>trusted},delay(){},Application(){assert.equal(trusted,true);return {applicationProcesses:{whose(){return ()=>{polls++;return foreground?[process]:[];};}}};}};
  vm.runInNewContext(script,context);
  return {run:()=>JSON.parse(context.run([id,'等待授权'])),pressed,get polls(){return polls;}};
}
test('native locator only presses the unique scroll control in the target window, never approval controls',()=>{
  const fixture=nativeFixture();assert.equal(fixture.run().status,'scrolled');
  assert.deepEqual(fixture.pressed,[{name:'Scroll to bottom',action:'AXPress'}]);
  const byURL=nativeFixture({title:'Codex',url:`file:///app/index.html#/local/${id}`});assert.equal(byURL.run().status,'scrolled');
});
test('native locator stops on permission, wrong target, ambiguous controls, or lost foreground',()=>{
  for(const [options,status] of [[{trusted:false},'permission-required'],[{title:'另一个任务'},'not-found'],[{duplicate:true},'not-found'],[{foreground:false},'not-found'],[{leave:true},'focus-changed'],[{changedTitle:true},'not-found']]) {
    const fixture=nativeFixture(options);assert.equal(fixture.run().status,status);assert.deepEqual(fixture.pressed,[]);
  }
});
