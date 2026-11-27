'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {adaptClaude,adapterInfo}=require('../src/hooks/adapters.cjs');
const {Activity,sanitizeEvent}=require('../src/domain/activity.cjs');
const {eventName,sourceOfSession}=require('../src/shared/hook-events.cjs');
const {createConfig}=require('../scripts/hooks/claude-config.cjs');
const {prepareClaudeChange}=require('../src/hooks/claude-settings.cjs');
const {readClaude}=require('../src/hooks/availability.cjs');
const {socketPath}=require('../src/hooks/bridge.cjs');
const session='11111111-2222-3333-4444-555555555555';
const input=(name,extra={})=>({hook_event_name:name,session_id:session,prompt_id:'prompt-1',cwd:'/private/project',transcript_path:'/private/t.jsonl',...extra});
const send=(activity,name,extra)=>activity.accept(adaptClaude(input(name,extra)));

test('Claude events keep only identifiers and are isolated from other sources',()=>{
  const event=sanitizeEvent(adaptClaude(input('PostToolUse',{tool_name:'Bash',tool_use_id:'toolu_1',tool_input:{command:'secret'},tool_response:'secret',last_assistant_message:'secret',prompt:'secret'})));
  assert.deepEqual(event,{source:'claude',raw_event:'PostToolUse',hook_event_name:'PostToolUse',session_id:`claude:${session}`,turn_id:'prompt-1',tool_use_id:'toolu_1',tool_name:'Bash'});
  assert.equal(adaptClaude(input('Notification')),null);assert.equal(adaptClaude(input('Stop',{session_id:'../x'})),null);
  assert.equal(adaptClaude(input('SessionEnd',{prompt_id:undefined})).turn_id,'unknown');
  assert.equal(sanitizeEvent({...event,source:'cursor'}),null);assert.equal(sanitizeEvent({...event,source:undefined}),null);
  assert.equal(sanitizeEvent({...event,raw_event:'Stop'}),null);assert.equal(sanitizeEvent({...event,raw_event:'postToolUse'}),null);
  assert.equal(sourceOfSession(event.session_id),'claude');assert.equal(sourceOfSession('cursor:a'),'cursor');assert.equal(sourceOfSession('a'),'codex');
});

test('API failures and interrupted tools stop the round without a completion',()=>{
  for(const [name,extra] of [['StopFailure',{}],['PostToolUseFailure',{is_interrupt:true,tool_use_id:'t',tool_name:'Bash'}]]) {
    const event=sanitizeEvent(adaptClaude(input(name,extra)));
    assert.equal(event.hook_event_name,'Interrupt');assert.equal(eventName(event),name);
    const activity=new Activity();send(activity,'UserPromptSubmit');assert.equal(activity.snapshot().working,1);
    activity.accept(event);assert.equal(activity.snapshot().working,0);assert.equal(activity.snapshot().unread,0);
  }
  assert.equal(adaptClaude(input('PostToolUseFailure',{tool_use_id:'t'})).hook_event_name,'PostToolUse');
});

test('permission checks without call ids clear when the matching tool returns, and titles never read content',()=>{
  const activity=new Activity({resolveChat:()=>{throw Error('must not resolve Claude chats');}});
  send(activity,'UserPromptSubmit');send(activity,'PreToolUse',{tool_name:'Bash',tool_use_id:'a'});
  send(activity,'PermissionRequest',{tool_name:'Bash'});assert.equal(activity.snapshot().pending,1);
  send(activity,'PostToolUse',{tool_name:'Bash',tool_use_id:'a'});assert.equal(activity.snapshot().pending,0);
  assert.ok(send(activity,'Stop'));assert.equal(send(activity,'Stop'),null,'同一轮只完成一次');
  assert.equal(activity.snapshot().notices[0].title,'Claude · 55555555');
  activity.reconcile({updatedAt:9e15,unreadIds:new Set()},9e15);assert.equal(activity.snapshot().unread,1,'Codex 已读状态不能清除 Claude 提醒');
  const restored=new Activity({saved:activity.exportState()});assert.equal(restored.snapshot().unread,1);
});

test('subagent tools count toward the main chat but subagent endings do not finish it',()=>{
  const activity=new Activity(),agent={agent_id:'agent-1',agent_type:'Explore'};
  send(activity,'UserPromptSubmit');send(activity,'PreToolUse',{...agent,tool_name:'Bash',tool_use_id:'s1'});
  send(activity,'PermissionRequest',{...agent,tool_name:'Bash'});assert.equal(activity.snapshot().pending,1,'子代理的权限检查不能丢');
  for(const name of ['Stop','StopFailure','UserPromptSubmit','SessionEnd'])assert.equal(adaptClaude(input(name,agent)),null);
  assert.equal(adaptClaude(input('PostToolUseFailure',{...agent,is_interrupt:true,tool_use_id:'s1'})).hook_event_name,'PostToolUse');
  send(activity,'PostToolUse',{...agent,tool_name:'Bash',tool_use_id:'s1'});assert.equal(activity.snapshot().pending,0);assert.equal(activity.snapshot().working,1);
});

test('a resumed round with the same prompt id is reopened, and the next prompt clears leftovers of an interrupted one',()=>{
  const activity=new Activity();
  send(activity,'UserPromptSubmit');send(activity,'Stop');assert.equal(activity.snapshot().unread,1);
  send(activity,'UserPromptSubmit');assert.equal(activity.snapshot().unread,0);
  assert.ok(send(activity,'PreToolUse',{tool_name:'Bash',tool_use_id:'b'}));assert.ok(send(activity,'Stop'));assert.equal(activity.snapshot().unread,1);assert.equal(activity.snapshot().working,0);
  send(activity,'UserPromptSubmit',{prompt_id:'p2'});send(activity,'PreToolUse',{prompt_id:'p2',tool_name:'Bash',tool_use_id:'c'});send(activity,'PermissionRequest',{prompt_id:'p2',tool_name:'Bash'});
  assert.equal(activity.snapshot().pending,1);
  send(activity,'UserPromptSubmit',{prompt_id:'p3'});assert.equal(activity.snapshot().pending,0,'中断后的残留由下一次提问清理');
  send(activity,'SessionEnd',{prompt_id:undefined});assert.equal(activity.snapshot().working,0);
});

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-claude-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const info=adapterInfo().find(item=>item.id==='claude');
  return {...info,target:path.join(dir,'.claude','settings.json'),config:JSON.stringify(createConfig())};
}
const write=(adapter,value)=>{fs.mkdirSync(path.dirname(adapter.target),{recursive:true});fs.writeFileSync(adapter.target,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});};
const read=adapter=>JSON.parse(fs.readFileSync(adapter.target,'utf8'));
const available=adapter=>Object.values(readClaude(adapter).events).filter(item=>item.available).length;

test('enabling merges only this project hooks, keeps every other setting and backs up',t=>{
  const adapter=fixture(t);assert.equal(available(adapter),0);assert.equal(readClaude(adapter).state,'checked');
  const original={env:{TOKEN:'keep'},permissions:{allow:['Bash(ls)']},hooks:{Stop:[{hooks:[{type:'command',command:'other'}]}],Notification:[{hooks:[{type:'command',command:'n'}]}]}};
  write(adapter,original);assert.equal(available(adapter),0,'其他命令不能替代鲸鱼娘的接入');
  const change=prepareClaudeChange(adapter);assert.deepEqual(read(adapter),original,'准备阶段不写文件');change.commit();
  const merged=read(adapter);assert.deepEqual(merged.env,original.env);assert.deepEqual(merged.permissions,original.permissions);
  assert.deepEqual(merged.hooks.Notification,original.hooks.Notification);assert.deepEqual(merged.hooks.Stop[0],original.hooks.Stop[0]);
  assert.equal(available(adapter),8);assert.deepEqual(Object.keys(createConfig().hooks),adapter.mappings.map(item=>item.event));
  const files=fs.readdirSync(path.dirname(adapter.target)),backup=files.find(name=>name.includes('.whale-backup-'));
  assert.equal(fs.statSync(path.join(path.dirname(adapter.target),backup)).mode&0o777,0o600,'备份可能含凭据，仅本人可读');
  prepareClaudeChange(adapter).commit();assert.deepEqual(read(adapter),merged);assert.equal(fs.readdirSync(path.dirname(adapter.target)).length,files.length,'重复开启不再写入');
  change.rollback();assert.deepEqual(read(adapter),original);
});

test('unsafe or changed Claude settings are refused, narrowed matchers and disableAllHooks are unavailable',t=>{
  const adapter=fixture(t);
  for(const value of ['broken','[]',{hooks:[]},{hooks:{Stop:{}}}]) {
    write(adapter,value);const before=fs.readFileSync(adapter.target,'utf8');
    assert.throws(()=>prepareClaudeChange(adapter));assert.equal(fs.readFileSync(adapter.target,'utf8'),before);
  }
  write(adapter,'broken');assert.equal(readClaude(adapter).state,'unknown');
  write(adapter,{});const stale=prepareClaudeChange(adapter);write(adapter,{model:'x'});assert.throws(()=>stale.commit(),/其他程序修改/);assert.deepEqual(read(adapter),{model:'x'});
  const narrowed=createConfig();narrowed.hooks.PreToolUse[0].matcher='Bash';write(adapter,narrowed);assert.equal(readClaude(adapter).events.PreToolUse.available,false);assert.equal(available(adapter),7);
  write(adapter,{...createConfig(),disableAllHooks:true});assert.equal(available(adapter),0);assert.match(readClaude(adapter).message,/已关闭/);
  fs.rmSync(adapter.target);fs.symlinkSync('/nonexistent',adapter.target);assert.throws(()=>prepareClaudeChange(adapter),/不是普通文件/);
});

test('sender forwards one sanitized line, stays silent and exits cleanly when the pet is offline',async t=>{
  const dir=fs.mkdtempSync('/tmp/whale-claude-s-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const run=body=>new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join(__dirname,'../scripts/claude-hook.cjs')],{env:{...process.env,WHALE_DATA_DIR:dir}});let output='';
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});
    child.stdin.on('error',()=>{});child.on('close',code=>resolve({code,output}));child.stdin.end(body);
  });
  assert.deepEqual(await run(JSON.stringify(input('Stop'))),{code:0,output:''});
  assert.deepEqual(await run('not json'),{code:0,output:''});
  const lines=[],server=net.createServer(client=>{client.on('error',()=>{});client.on('data',chunk=>{lines.push(String(chunk));client.end('{"accepted":true}\n');});});
  await new Promise(resolve=>server.listen(socketPath(dir),resolve));t.after(()=>server.close());
  const large=input('PostToolUse',{tool_name:'Read',tool_use_id:'big',tool_response:'私'.repeat(900000)});
  assert.deepEqual(await run(JSON.stringify(large)),{code:0,output:''});
  assert.equal(lines.length,1);assert.ok(lines[0].length<400);assert.equal(JSON.parse(lines[0]).tool_use_id,'big','超过 1MB 的工具返回不丢事件');
});
