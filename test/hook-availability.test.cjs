'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {adapterInfo}=require('../src/hooks/adapters.cjs');
const {matchCodex,readCursor,readCodex}=require('../src/hooks/availability.cjs');
const codex={...adapterInfo()[0],config:JSON.stringify(require('../scripts/hooks/codex-config.cjs').createConfig())};
const hooks=()=>Object.entries(JSON.parse(codex.config).hooks).map(([name,groups])=>({eventName:name[0].toLowerCase()+name.slice(1),handlerType:'command',command:groups[0].hooks[0].command,enabled:true,trustStatus:'trusted'}));
test('Codex availability requires exact pet command, enabled and trusted together',()=>{
 const entries=hooks();entries[0].trustStatus='untrusted';entries[1].enabled=false;entries[2].command='other-plugin';
 const result=matchCodex(codex,{data:[{hooks:entries,errors:[]}]});
 for(const name of ['UserPromptSubmit','PreToolUse','PermissionRequest'])assert.equal(result.events[name].available,false);
 assert.equal(result.events.Stop.available,true);
 assert.equal(matchCodex(codex,{data:[{hooks:entries,errors:['failure']}]}).state,'unknown');
 assert.equal(matchCodex(codex,{}).state,'unknown');
});
test('Cursor configuration detects only exact registered commands and never claims trust',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-hook-check-'));
 const adapter={...adapterInfo()[1],target:path.join(dir,'hooks.json'),config:JSON.stringify(require('../scripts/hooks/cursor-config.cjs').createConfig())};
 assert.equal(readCursor(adapter).events.stop.available,false);
 const config=JSON.parse(adapter.config);config.hooks.stop[0].command='other-plugin';fs.writeFileSync(adapter.target,JSON.stringify(config));
 const result=readCursor(adapter);assert.equal(result.events.stop.available,false);assert.equal(result.events.postToolUse.available,true);assert.match(result.events.postToolUse.reason,/等待事件验证/);
 fs.writeFileSync(adapter.target,'broken');assert.equal(readCursor(adapter).state,'unknown');
 fs.rmSync(dir,{recursive:true,force:true});
});
test('Codex client unavailable returns unknown instead of permitting events',async()=>{
 const result=await readCodex(codex,{binary:'/nonexistent/whale-codex',cwd:process.cwd(),timeout:200});
 assert.equal(result.state,'unknown');assert.equal(result.events.Stop.available,false);
});
test('Codex global feature and administrator policy override trusted individual hooks',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-hook-policy-'));
 const binary=path.join(dir,'codex');
 try {
  for(const [config,requirements] of [[{features:{hooks:false}},null],[{}, {featureRequirements:{hooks:false}}]]) {
   const results={1:{},2:{data:[{hooks:hooks(),errors:[]}]},3:{config},4:{requirements}};
   fs.writeFileSync(binary,'#!'+process.execPath+'\n'+`const results=${JSON.stringify(results)};require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id)process.stdout.write(JSON.stringify({id:message.id,result:results[message.id]})+'\\n');});`,{mode:0o700});
   const result=await readCodex(codex,{binary,cwd:dir});
   assert.equal(result.state,'checked');assert.equal(result.events.Stop.available,false);assert.match(result.message,/全局/);
  }
 }finally {fs.rmSync(dir,{recursive:true,force:true});}
});
