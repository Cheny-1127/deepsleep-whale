const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startBridge } = require('../src/hooks/bridge.cjs');
const hook = path.resolve(__dirname, '../scripts/codex-hook.cjs');
function runHook(dir, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { env: { ...process.env, WHALE_DATA_DIR: dir } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
test('hook delivers a stripped event over a private socket and returns neutral JSON', async t => {
  const dir = fs.mkdtempSync('/tmp/whale-test-');
  const events = [];
  const bridge = await startBridge(dir, e => events.push(e));
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true }); });
  assert.equal(fs.statSync(bridge.file).mode & 0o777, 0o600);
  const result = await runHook(dir, JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'session', turn_id: 'turn', tool_input: { password: 'must-not-leave-process' } }));
  assert.deepEqual(result, { code: 0, stdout: '{}\n', stderr: '' });
  assert.deepEqual(events, [{ hook_event_name: 'PermissionRequest', session_id: 'session', turn_id: 'turn' }]);
});
test('offline pet and malformed input cannot block Codex', async () => {
  const dir = fs.mkdtempSync('/tmp/whale-offline-');
  try {
    for (const input of ['not json', JSON.stringify({ hook_event_name: 'Stop', session_id: 'session' })]) {
      const result = await runHook(dir, input);
      assert.deepEqual(result, { code: 0, stdout: '{}\n', stderr: '' });
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('oversized socket payload is rejected without emitting events', async t => {
  const dir = fs.mkdtempSync('/tmp/whale-limit-');
  const events = [];
  const bridge = await startBridge(dir, e => events.push(e));
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true }); });
  await new Promise(resolve => {
    const client = net.createConnection(bridge.file, () => client.write('x'.repeat(5000)));
    client.on('error', () => {}); client.on('close', resolve);
  });
  assert.equal(events.length, 0);
});
test('PostToolUse transports only call identifiers and never tool output',async t=>{
 const dir=fs.mkdtempSync('/tmp/whale-post-');const events=[];
 const bridge=await startBridge(dir,e=>events.push(e));
 t.after(async()=>{await bridge.close();fs.rmSync(dir,{recursive:true});});
 const input={hook_event_name:'PostToolUse',session_id:'session',turn_id:'turn',tool_use_id:'call-a',tool_name:'Bash',tool_response:{secret:'never-send'},tool_input:{password:'never-send'}};
 assert.deepEqual(await runHook(dir,JSON.stringify(input)),{code:0,stdout:'{}\n',stderr:''});
 const {tool_response,tool_input,...expected}=input;assert.deepEqual(events,[expected]);
});

test('Cursor sender delivers only normalized metadata through the real socket',async t=>{
 const dir=fs.mkdtempSync('/tmp/whale-cursor-');const events=[];
 const bridge=await startBridge(dir,event=>events.push(event));
 t.after(async()=>{await bridge.close();fs.rmSync(dir,{recursive:true});});
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.resolve(__dirname,'../scripts/cursor-hook.cjs')],{env:{...process.env,WHALE_DATA_DIR:dir}});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  child.stdin.end(JSON.stringify({hook_event_name:'stop',conversation_id:'chat-a',generation_id:'round-a',status:'completed',prompt:'do-not-copy',user_email:'do-not-copy',text:'do-not-copy'}));
 });
 assert.deepEqual(result,{code:0,stdout:'{}\n',stderr:''});
 assert.deepEqual(events,[{source:'cursor',raw_event:'stop',hook_event_name:'Stop',session_id:'cursor:chat-a',turn_id:'round-a'}]);
});
