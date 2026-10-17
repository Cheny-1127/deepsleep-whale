const test = require('node:test');
const assert = require('node:assert/strict');
const { merge } = require('../scripts/hooks/install.cjs');
const { createConfig } = require('../scripts/hooks/codex-config.cjs');
test('installation preserves existing hooks and is idempotent', () => {
  const original = { otherSetting:true, hooks:{ Stop:[{ hooks:[{ type:'command',command:'existing-command' }] }] } };
  const config = createConfig();
  const once = merge(original,config);
  assert.equal(once.otherSetting,true);
  assert.equal(once.hooks.Stop.length,2);
  assert.equal(once.hooks.Stop[0].hooks[0].command,'existing-command');
  assert.equal(original.hooks.Stop.length,1);
  assert.deepEqual(merge(once,config),once);
});
test('PostToolUse is added without changing the original six hook definitions',()=>{
 const config=createConfig();
 assert.equal(Object.keys(config.hooks).length,7);
 assert.equal(config.hooks.PostToolUse[0].matcher,'*');
 assert.deepEqual(config.hooks.PostToolUse[0],config.hooks.PreToolUse[0]);
 const {PostToolUse,...legacy}=config.hooks;
 assert.deepEqual(merge({hooks:legacy},config),config);
 assert.deepEqual(merge(config,config),config);
});
