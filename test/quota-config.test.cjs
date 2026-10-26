'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {readQuotaConfig} = require('../src/app/quota-config.cjs');
const {DEFAULT_BASE_URL,readQuotaToken} = require('../src/channels/quota-credentials.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-env-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  return {dir, write:value => fs.writeFileSync(path.join(dir,'.env'),value),
    read:env => readQuotaConfig({rootDir:dir,env:env || {}})};
}

test('missing .env preserves the default site and legacy token file', t => {
  const f = fixture(t), options = f.read();
  assert.deepEqual(options,{baseUrl:DEFAULT_BASE_URL,token:'',tokenFile:path.join(f.dir,'token')});
  fs.writeFileSync(options.tokenFile, 'legacy-fixture-key\n');
  assert.equal(readQuotaToken(options),'legacy-fixture-key');
  assert.equal(readQuotaToken({...options,token:'  inline-fixture-key  '}),'inline-fixture-key');
  fs.writeFileSync(options.tokenFile,'');assert.throws(() => readQuotaToken(options),/token 文件是空的/);
  fs.unlinkSync(options.tokenFile);assert.throws(() => readQuotaToken(options),/尚未配置管理 Key/);
});

test('native env parsing handles comments, quotes, export and equals without mutating process.env', t => {
  const f = fixture(t), before = {...process.env};
  f.write('# local configuration\nWHALE_QUOTA_BASE_URL="https://gateway.test/sub2api/"\nexport WHALE_QUOTA_API_KEY="fixture#key=123"\nWHALE_QUOTA_TOKEN_FILE=private/key # relative to project\nUNRELATED_SETTING=do-not-inject\n');
  const options = f.read();
  assert.deepEqual(options,{baseUrl:'https://gateway.test/sub2api',token:'fixture#key=123',tokenFile:path.join(f.dir,'private/key')});
  assert.ok(require('node:util').isDeepStrictEqual({...process.env},before),'project configuration must not mutate process.env');
  assert.equal(Object.hasOwn(options,'UNRELATED_SETTING'),false);
  fs.unlinkSync(path.join(f.dir,'.env'));assert.equal(f.read().token,'');
});

test('each process variable overrides .env, including explicitly empty values', t => {
  const f = fixture(t);
  f.write('WHALE_QUOTA_BASE_URL=https://local.test\nWHALE_QUOTA_API_KEY=local-fixture-key\nWHALE_QUOTA_TOKEN_FILE=local-token\n');
  assert.equal(f.read({WHALE_QUOTA_BASE_URL:'https://process.test/'}).baseUrl,'https://process.test');
  assert.equal(f.read({WHALE_QUOTA_BASE_URL:'https://process.test/'}).token,'local-fixture-key');
  const absolute = path.join(f.dir,'absolute-key');
  const options = f.read({WHALE_QUOTA_API_KEY:'process-fixture-key',WHALE_QUOTA_TOKEN_FILE:absolute});
  assert.equal(options.token,'process-fixture-key');assert.equal(options.tokenFile,absolute);
  const empty = f.read({WHALE_QUOTA_API_KEY:'',WHALE_QUOTA_BASE_URL:'',WHALE_QUOTA_TOKEN_FILE:''});
  assert.equal(empty.token,'');assert.equal(empty.baseUrl,DEFAULT_BASE_URL);assert.equal(empty.tokenFile,path.join(f.dir,'token'));
});

test('invalid target URLs fail without echoing credentials or falling back to the default site', t => {
  const f = fixture(t);
  for (const url of ['not-a-url','file:///private/key','https://user:fixture-secret@gateway.test',
    'https://gateway.test?key=fixture-secret','https://gateway.test/#fixture-secret','https://gateway.test/?','https://gateway.test/#']) {
    assert.throws(() => f.read({WHALE_QUOTA_BASE_URL:url}), error => {
      assert.match(error.message,/WHALE_QUOTA_BASE_URL/);assert.ok(!error.message.includes('fixture-secret'));return true;
    });
  }
  assert.equal(f.read({WHALE_QUOTA_BASE_URL:'http://127.0.0.1:8080/'}).baseUrl,'http://127.0.0.1:8080');
  fs.mkdirSync(path.join(f.dir,'.env'));
  assert.throws(() => f.read(),/无法读取项目 .env/);
});

test('example configuration is usable and contains no default Key', t => {
  const f = fixture(t);
  f.write(fs.readFileSync(path.join(__dirname,'../.env.example'),'utf8'));
  assert.equal(f.read().token,'');assert.equal(f.read().baseUrl,DEFAULT_BASE_URL);
});
