'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createHookSettings} = require('../src/app/hook-settings.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-startup-settings-'));
  const previous = process.env.WHALE_CURSOR_HOME;
  process.env.WHALE_CURSOR_HOME = path.join(dir, 'cursor');
  t.after(() => {
    if (previous === undefined) delete process.env.WHALE_CURSOR_HOME;else process.env.WHALE_CURSOR_HOME = previous;
    fs.rmSync(dir, {recursive:true, force:true});
  });
  return {dir, create:() => createHookSettings({dataDir:dir, cwd:dir, onChange(){}})};
}

test('startup display defaults on for new and legacy settings, and an explicit choice survives reload', t => {
  const f = fixture(t);
  assert.equal(f.create().settings.showPanelOnStartup, true);
  fs.writeFileSync(path.join(f.dir, 'settings.json'), JSON.stringify({sound:true, notifications:false}));
  const settings = f.create();
  assert.equal(settings.settings.showPanelOnStartup, true);
  settings.setPreference('showPanelOnStartup', false);
  const restored = f.create();
  assert.equal(restored.settings.showPanelOnStartup, false);
  assert.equal(restored.settings.sound, true);assert.equal(restored.settings.notifications, false);
  restored.setPreference('showPanelOnStartup', true);
  assert.equal(f.create().settings.showPanelOnStartup, true);
});

test('failed or invalid startup preference saves preserve both memory and the existing file', t => {
  const f = fixture(t), settings = f.create();
  settings.setPreference('showPanelOnStartup', false);
  const file = path.join(f.dir, 'settings.json'), before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => settings.setPreference('showPanelOnStartup', true));
  assert.equal(settings.settings.showPanelOnStartup, false);assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => settings.setPreference('showPanelOnStartup', 'false'), /偏好设置/);
  assert.throws(() => settings.setPreference('unknown', false), /偏好设置/);
});
