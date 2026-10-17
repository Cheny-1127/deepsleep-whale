'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {prepareCursorChange}=require('../src/hooks/cursor-settings.cjs');
const {createConfig}=require('../scripts/hooks/cursor-config.cjs');
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-cursor-settings-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,target:path.join(dir,'cursor','hooks.json'),config:JSON.stringify(createConfig())};
}
function write(adapter,text) {fs.mkdirSync(path.dirname(adapter.target),{recursive:true});fs.writeFileSync(adapter.target,text);}
const read=adapter=>JSON.parse(fs.readFileSync(adapter.target,'utf8'));
test('enable installs all five hooks, preserves other configuration and is idempotent',t=>{
 const adapter=fixture(t),change=prepareCursorChange(adapter);
 assert.equal(fs.existsSync(adapter.target),false);assert.equal(change.created,true);change.commit();assert.deepEqual(read(adapter),createConfig());
 const existing={version:1,custom:{value:'keep'},hooks:{stop:[{command:'other-plugin',timeout:20}],afterFileEdit:[{command:'format'}]}};
 const original=JSON.stringify(existing);write(adapter,original);
 prepareCursorChange(adapter).commit();
 const merged=read(adapter);assert.deepEqual(merged.custom,existing.custom);assert.deepEqual(merged.hooks.afterFileEdit,existing.hooks.afterFileEdit);
 assert.deepEqual(merged.hooks.stop[0],existing.hooks.stop[0]);assert.equal(merged.hooks.stop.length,2);
 for(const event of Object.keys(createConfig().hooks))assert.equal(merged.hooks[event].some(hook=>hook.command===createConfig().hooks[event][0].command),true);
 const backups=fs.readdirSync(path.dirname(adapter.target)).filter(file=>file.includes('.whale-backup-'));
 assert.equal(backups.length,1);assert.equal(fs.readFileSync(path.join(path.dirname(adapter.target),backups[0]),'utf8'),original);
 const complete=fs.readFileSync(adapter.target,'utf8');prepareCursorChange(adapter).commit();assert.equal(fs.readFileSync(adapter.target,'utf8'),complete);
});
test('malformed files and non-array event definitions are preserved',t=>{
 const adapter=fixture(t);
 for(const text of ['broken','{"version":2,"hooks":{}}','{"version":1,"hooks":{"stop":{}}}']) {
  write(adapter,text);assert.throws(()=>prepareCursorChange(adapter));assert.equal(fs.readFileSync(adapter.target,'utf8'),text);
 }
});
test('changed files and symlinks are not overwritten; successful edits can roll back',t=>{
 const adapter=fixture(t);write(adapter,JSON.stringify({version:1,hooks:{stop:[{command:'other-plugin'}]}}));
 const original=fs.readFileSync(adapter.target,'utf8');
 const pending=prepareCursorChange(adapter);write(adapter,original+'\n');
 assert.throws(()=>pending.commit(),/其他程序/);assert.equal(fs.readFileSync(adapter.target,'utf8'),original+'\n');
 const change=prepareCursorChange(adapter);change.commit();change.rollback();assert.equal(fs.readFileSync(adapter.target,'utf8'),original+'\n');
 const link={...adapter,target:path.join(adapter.dir,'link.json')};fs.symlinkSync(adapter.target,link.target);
 assert.throws(()=>prepareCursorChange(link),/普通文件/);
});
test('failed first-enable transaction removes only its own new file on rollback',t=>{
 const adapter=fixture(t),change=prepareCursorChange(adapter);change.commit();change.rollback();assert.equal(fs.existsSync(adapter.target),false);
});
