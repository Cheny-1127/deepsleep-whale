'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const vm = require('node:vm');

function fixture() {
  class Element {
    constructor() {
      this.children = []; this.handlers = {}; this.attributes = {};
      this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; this.value = '';
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    click() { return this.handlers.click?.(); }
  }
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
  const elements = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element());
  elements.get('quota-view').hidden = true;
  let data = {
    settings: {accountId: null, yellowBelow: 30, redBelow: 10, accountsExpanded: true, configExpanded: true},
    accounts: [{id: 5, name: 'yuchao'}, {id: 6, name: 'zzz'}],
    ranking: {groupName: 'yuchao-group'}
  };
  const calls = [], intervals = [];
  let save = async patch => ({value: data = {...data, settings: {...data.settings, ...patch}}});
  const tick = () => new Promise(setImmediate);
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/pet-quota-settings-view.mjs'), 'utf8').replace('export function', 'function');
  vm.runInNewContext(source + '\ncreatePetQuotaSettingsView();', {
    document: {getElementById: id => elements.get(id), createElement: () => new Element(), addEventListener() {}},
    window: {whale: {petQuota: async (name, patch) => { calls.push([name, patch]); return name === 'snapshot' ? {value:data} : save(name === 'update-config' ? patch.patch : patch); }}},
    setInterval(callback) { intervals.push(callback); }
  });
  const get = id => elements.get('quota-pet-' + id);
  const radio = name => get('accounts').children.find(label => label.children[1].textContent === name).children[0];
  return {get, calls, html, tick, radio,
    setSave(fn) { save = fn; },
    set(patch) { data = {...data, ...patch}; },
    async ready() { await tick(); },
    async poll() { elements.get('quota-view').hidden = false; intervals.forEach(callback => callback()); await tick(); },
    async choose(name) { const input = radio(name); input.checked = true; input.handlers.change(); },
    edit(id, value) { get(id).value = value; get(id).handlers.input(); },
    async apply() { await get('apply').click(); await tick(); }};
}

test('apply stays hidden until the account or thresholds change, then saves both together', async () => {
  const view = fixture();
  assert.match(view.html, /id="quota-pet-actions"[^>]*hidden/);
  const thresholds = view.html.slice(view.html.indexOf('id="quota-pet-thresholds"'), view.html.indexOf('id="quota-pet-actions"'));
  assert.doesNotMatch(thresholds, /保存/);
  await view.ready();
  assert.equal(view.get('actions').hidden, true);
  assert.equal(view.calls.filter(([name]) => name === 'update').length, 0);
  await view.choose('yuchao');
  view.edit('yellow', '40'); view.edit('red', '20');
  assert.equal(view.get('actions').hidden, false);
  assert.equal(view.calls.filter(([name]) => name === 'update').length, 0);
  await view.apply();
  assert.equal(JSON.stringify(view.calls.at(-1)), JSON.stringify(['update-config', {id:'primary',patch:{accountId: 5, yellowBelow: 40, redBelow: 20}}]));
  assert.equal(view.get('actions').hidden, true);
  assert.equal(view.radio('yuchao').checked, true);
});

test('returning both fields to the saved values hides apply without writing', async () => {
  const view = fixture();
  await view.ready();
  await view.choose('yuchao');
  view.edit('yellow', '40');
  assert.equal(view.get('actions').hidden, false);
  await view.choose('暂不跟踪');
  view.edit('yellow', '30');
  assert.equal(view.get('actions').hidden, true);
  assert.equal(view.calls.filter(([name]) => name === 'update').length, 0);
});

test('invalid thresholds keep the draft visible and do not save', async () => {
  const view = fixture();
  await view.ready();
  view.edit('red', '40');
  await view.apply();
  assert.equal(view.get('actions').hidden, false);
  assert.equal(view.get('error').hidden, false);
  assert.match(view.get('error').textContent, /淡红色阈值须小于淡黄色阈值/);
  assert.equal(view.calls.filter(([name]) => name === 'update').length, 0);
});

test('a failed apply keeps the unsaved account and thresholds', async () => {
  const view = fixture();
  await view.ready();
  view.setSave(async () => ({error: '桌宠配置保存失败，请重试'}));
  await view.choose('yuchao');
  view.edit('yellow', '45');
  await view.apply();
  assert.equal(view.get('actions').hidden, false);
  assert.match(view.get('error').textContent, /保存失败/);
  view.set({accounts: [{id: 5, name: 'yuchao'}, {id: 7, name: 'new'}], settings: {yellowBelow: 15, redBelow: 5, accountId: 6}});
  await view.poll();
  assert.equal(view.get('yellow').value, '45');
  assert.equal(view.radio('yuchao').checked, true);
  assert.equal(view.radio('暂不跟踪').checked, false);
});

test('collapsing still saves immediately and does not count as an edit', async () => {
  const view = fixture();
  await view.ready();
  await view.get('toggle').click();
  await view.tick();
  assert.equal(JSON.stringify(view.calls.at(-1)), JSON.stringify(['update-config', {id:'primary',patch:{configExpanded: false}}]));
  assert.equal(view.get('actions').hidden, true);
});


test('copy targets the selected config and does not apply primary drafts', async () => {
  const view=fixture();await view.ready();await view.choose('yuchao');view.edit('yellow','45');
  view.setSave(async()=>({error:'保存失败'}));
  await view.get('copy').click();await view.tick();
  assert.equal(JSON.stringify(view.calls.at(-1)),JSON.stringify(['copy-config','primary']));
  assert.equal(view.get('actions').hidden,false);assert.equal(view.get('yellow').value,'45');
  assert.equal(view.get('title').textContent,'');
});
