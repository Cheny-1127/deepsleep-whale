const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('feeding is bounded and growth persists after reload', () => {
  const dir = fs.mkdtempSync('/tmp/whale-care-');
  const file = require.resolve('../vendor/nurture.cjs');
  try {
    let nurture = require(file);
    nurture.setSaveDir(dir);
    for (let i = 0; i < 6; i++) nurture.feed();
    assert.equal(nurture.snapshot().satiety, 100);
    nurture.pat(); nurture.workCompleted();
    delete require.cache[file]; nurture = require(file); nurture.setSaveDir(dir);
    assert.equal(nurture.snapshot().totalWorkSessions, 1);
    assert.equal(nurture.snapshot().totalPats, 1);
    nurture.tick(1000);
    assert.equal(nurture.snapshot().satiety, 0);
  } finally { delete require.cache[file]; fs.rmSync(dir, { recursive: true }); }
});
