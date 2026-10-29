'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createArcheryConnection}=require('../src/app/archery-connection.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archery-source-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const home=path.join(dir,'codex');fs.mkdirSync(home);const other=path.join(dir,'other');fs.mkdirSync(other);
  const text='[mcp_servers.archery]\ncommand="/fixture/archery"\n[mcp_servers.archery.env]\nARCHERY_BASE_URL="https://archery.example.com"\nARCHERY_USERNAME="fixture-user"\nARCHERY_PASSWORD="fixture-secret"\n';
  const configFile=path.join(other,'config.toml');fs.writeFileSync(configFile,text);
  return {dir,home,configFile,text,create:()=>createArcheryConnection({dataDir:dir,home})};
}
test('missing default source is visible; chosen source persists without copying credentials',t=>{
  const f=fixture(t),source=f.create();assert.equal(source.snapshot().valid,false);assert.equal(source.snapshot().configFile,path.join(f.home,'config.toml'));
  const snapshot=source.save(f.configFile);assert.equal(snapshot.valid,true);assert.deepEqual(snapshot.permissions,{detail:true,approve:true,reject:true,execute:true});
  assert.equal(source.read().server.env.ARCHERY_PASSWORD,'fixture-secret');
  assert.equal(f.create().snapshot().configFile,f.configFile);assert.equal(f.create().read().server.env.ARCHERY_USERNAME,'fixture-user');
  assert.doesNotMatch(JSON.stringify(snapshot),/fixture-secret|fixture-user|command/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,'archery-connection.json'))),{configFile:f.configFile});
  assert.equal(fs.readFileSync(f.configFile,'utf8'),f.text,'用户的 Codex 文件不应被修改');
});
test('invalid files and persistence failure preserve the original source',t=>{
  const f=fixture(t),source=f.create();source.save(f.configFile);
  for(const value of ['relative/config.toml',path.join(f.home,'missing.toml'),null,path.join(f.home,'config.toml')])assert.throws(()=>source.save(value));
  assert.equal(source.snapshot().configFile,f.configFile);
  fs.writeFileSync(path.join(f.home,'config.toml'),f.text);fs.mkdirSync(path.join(f.dir,'archery-connection.json.tmp'));
  assert.throws(()=>source.save(path.join(f.home,'config.toml')),/保存失败/);assert.equal(source.snapshot().configFile,f.configFile);
});
test('reads revalidate current policy; corrupt source does not fall back to another account',t=>{
  const f=fixture(t),source=f.create();source.save(f.configFile);const previous=source.read().fingerprint;
  fs.writeFileSync(f.configFile,f.text.replace('command=', 'disabled_tools=["work_order_execute"]\ncommand='));
  assert.notEqual(source.read().fingerprint,previous);assert.equal(source.snapshot().permissions.execute,false);
  fs.writeFileSync(f.configFile,f.text.replaceAll('mcp_servers.archery','mcp_servers.other'));
  assert.equal(source.snapshot().valid,false);assert.throws(()=>source.read(),/尚未配置/);
  fs.writeFileSync(path.join(f.dir,'archery-connection.json'),'broken');fs.writeFileSync(path.join(f.home,'config.toml'),f.text);
  assert.throws(()=>f.create().read(),/来源无法读取/);
});
test('MCP owns credential loading; desktop accepts a launch entry without duplicated credentials',t=>{
  const f=fixture(t);fs.writeFileSync(f.configFile,f.text.replace('ARCHERY_PASSWORD="fixture-secret"\n',''));
  const source=f.create();assert.equal(source.save(f.configFile).valid,true);
  fs.writeFileSync(f.configFile,'[mcp_servers.archery]\ncommand="/fixture/archery-mcp"\n');
  assert.equal(source.snapshot().valid,true);assert.deepEqual(source.read().server.env,{});
  assert.equal(source.read().baseUrl,'');
});
