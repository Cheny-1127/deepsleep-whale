'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {discoverRunningClients}=require('../src/clients/discovery.cjs');
const app='/Applications/ChatGPT.app/Contents',bin=app+'/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const defaults={codexBinary:bin,codexHome:'/home/default',cursorBinary:'/bin/cursor-agent'};
function discover(processes,files='',extra={}) {
  return discoverRunningClients({platform:'darwin',listProcesses:async()=>processes,listOpenFiles:async()=>files,isExecutable:()=>true,canonical:file=>file,defaults,...extra});
}
test('maps each desktop to its own binary and open state directory, excluding helpers',async()=>{
  let inspected;
  const result=await discover(`10 1 ${app}/MacOS/ChatGPT\n11 10 ${bin}\n12 10 ${app}/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper\n20 1 /Apps/Second Codex.app/Contents/MacOS/Codex\n21 20 /Apps/Second Codex.app/Contents/Resources/codex\n30 1 /usr/bin/codex`, '',{
    listOpenFiles:async pids=>{inspected=pids;return 'p11\nn/home/one/state_5.sqlite\nn/home/one/state_5.sqlite-wal\np21\nn/home/two/state_6.sqlite\np12\nn/private/ignored/state_5.sqlite';}
  });
  assert.deepEqual(inspected,[10,11,20,21]);
  assert.deepEqual(result.clients.map(c=>[c.binary,c.configHome,c.available]),[[bin,'/home/one',true],['/Apps/Second Codex.app/Contents/Resources/codex','/home/two',true]]);
  assert.ok(!JSON.stringify(result).includes('ignored'));
});
test('deduplicates desktop windows sharing the same binary/home and accepts IPC home evidence',async()=>{
  const result=await discover(`10 1 ${app}/MacOS/ChatGPT\n20 1 ${app}/MacOS/ChatGPT`,'p10\nn/home/one/ipc/ipc.sock\np20\nn/home/one/ipc/ipc.sock');
  assert.equal(result.clients.length,1);assert.equal(result.clients[0].configHome,'/home/one');assert.equal(result.clients[0].binary,bin);
});
test('unknown or conflicting homes cannot silently fall back to default account',async()=>{
  for(const files of ['','p10\nn/home/one/ipc/ipc.sock\nn/home/two/ipc/ipc.sock']){
    const result=await discover(`10 1 ${app}/MacOS/ChatGPT`,files);
    assert.equal(result.clients.length,1);assert.equal(result.clients[0].available,false);assert.match(result.clients[0].reason,/配置目录/);assert.equal(result.clients[0].configHome,'');
  }
});
test('an unavailable app backend cannot be substituted with another installed Codex',async()=>{
  const result=await discover(`10 1 ${app}/MacOS/ChatGPT\n11 10 ${bin}`,'p11\nn/home/one/state_5.sqlite',{isExecutable:()=>false,defaults:{...defaults,codexBinary:'/other/codex'}});
  assert.equal(result.clients[0].available,false);assert.equal(result.clients[0].binary,'');assert.match(result.clients[0].reason,/可执行文件/);
});
test('Cursor requires an executable CLI and never claims to reuse editor chats',async()=>{
  const processes='10 1 /Applications/Cursor.app/Contents/MacOS/Cursor\n11 10 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper';
  const result=await discover(processes);assert.equal(result.clients.length,1);assert.equal(result.clients[0].backend,'cursor');assert.equal(result.clients[0].binary,defaults.cursorBinary);assert.match(result.clients[0].description,/CLI/);
  const missing=await discover(processes,'',{defaults:{...defaults,cursorBinary:''}});assert.equal(missing.clients[0].available,false);
});
test('uses an observed Cursor worker path if CLI is absent from app environment',async()=>{
  const binary='/home/user/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-agent-worker/agent-cli/.local/bin/cursor-agent';
  const result=await discover('10 1 /Applications/Cursor.app/Contents/MacOS/Cursor\n20 1 '+binary,'',{defaults:{...defaults,cursorBinary:''}});
  assert.equal(result.clients[0].binary,binary);assert.equal(result.clients[0].available,true);
});
test('discovery failure is explicit and never returns raw process/file output',async()=>{
  await assert.rejects(discover('', '',{listProcesses:async()=>{throw Error('secret args');}}),error=>!error.message.includes('secret')&&/检测/.test(error.message));
  const result=await discover(`10 1 ${app}/MacOS/ChatGPT`,'',{listOpenFiles:async()=>{throw Error('secret path');}});
  assert.equal(result.clients[0].available,false);assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal((await discover('10 1 /bin/codex\n11 1 /bin/cursor-agent')).clients.length,0);
});
