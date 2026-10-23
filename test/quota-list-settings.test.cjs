'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createQuotaPanel} = require('../src/channels/quota-accounts.cjs');
const defaults = {showName: true, showPlatform: true, showRemaining: true, showCredits: true, showSyncedAt: true, showRefresh: true, showFiveHour: true};

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-list-'));
  t.after(() => fs.rmSync(dataDir, {recursive: true, force: true}));
  const tokenFile = path.join(dataDir, 'token');
  fs.writeFileSync(tokenFile, 'synthetic-token');
  let calls = 0;
  const open = () => {
    const panel = createQuotaPanel({dataDir, tokenFile, fetchImpl: async () => {
      calls++;
      return {ok: true, json: async () => ({items: [{id: 5, codex_7d_used_percent: 20}]})};
    }});
    t.after(() => panel.close());
    return panel;
  };
  return {dataDir, open, calls: () => calls};
}

test('list preferences survive restart independently of refresh choices and leave the refresh schedule unchanged', async t => {
  const f = fixture(t), panel = f.open();
  assert.deepEqual(panel.snapshot().listSettings, defaults);
  const synced = await panel.refresh();
  const hidden = panel.setListSettings({showFiveHour: false});
  assert.deepEqual(hidden.accounts, synced.accounts);
  assert.equal(hidden.nextRefreshAt, synced.nextRefreshAt);
  panel.setRefreshEnabled({id: 5, enabled: false});
  panel.close();
  const restored = f.open();
  assert.deepEqual(restored.snapshot().listSettings, {...defaults, showFiveHour: false});
  assert.equal(restored.snapshot().accounts[0].refreshEnabled, false);
  restored.setListSettings({showFiveHour: true});
  assert.equal(restored.snapshot().nextRefreshAt, null);
  assert.equal(f.calls(), 1, '显示设置不发网络请求');
  assert.deepEqual(f.open().snapshot().listSettings, defaults);
});

test('invalid or unwritable list settings keep the last confirmed preference', t => {
  const f = fixture(t), panel = f.open();
  for (const value of [null, {}, {showFiveHour: 'false'}]) assert.throws(() => panel.setListSettings(value), /无效的列表配置/);
  fs.mkdirSync(path.join(f.dataDir, 'quota-list.json.tmp'));
  assert.throws(() => panel.setListSettings({showFiveHour: false}), /列表配置保存失败/);
  assert.deepEqual(panel.snapshot().listSettings, defaults);
  panel.close();
  assert.throws(() => panel.setListSettings({showFiveHour: false}), /已关闭/);
});

test('column choices merge with legacy settings and prevent hiding the final visible column', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'quota-list.json'), '{"showFiveHour":false}');
  const panel = f.open();
  panel.setListSettings({showPlatform: false});
  panel.setListSettings({showRemaining: false});
  panel.setListSettings({showRefresh: false});
  panel.setListSettings({showCredits: false});
  panel.setListSettings({showSyncedAt: false});
  assert.throws(() => panel.setListSettings({showName: false}), /至少保留一列/);
  assert.deepEqual(f.open().snapshot().listSettings, {...defaults, showFiveHour: false, showPlatform: false, showRemaining: false, showCredits: false, showSyncedAt: false, showRefresh: false});
});

test('damaged or mistyped preferences use the default without overwriting the original file', t => {
  const f = fixture(t), file = path.join(f.dataDir, 'quota-list.json');
  for (const value of ['{broken', '{"showFiveHour":"false"}']) {
    fs.writeFileSync(file, value);
    const panel = f.open();
    assert.deepEqual(panel.snapshot().listSettings, defaults);
    assert.equal(fs.readFileSync(file, 'utf8'), value);
    panel.close();
  }
});
