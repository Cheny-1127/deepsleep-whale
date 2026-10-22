'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.textContent = ''; this.hidden = false; this.disabled = false; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    click() { this.handlers.click?.(); }
  }
  const elements = new Map();
  for (const [, id] of fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) elements.set(id, new Element());
  let data = {accounts: [], error: '', checkedAt: null, attemptedAt: null, failedAt: null, nextRefreshAt: null, busy: false};
  let now = 1000;
  class TestDate extends Date { static now() { return now; } }
  const calls = [], intervals = [], saves = [];
  let save = async value => {
    if (value.unit) {const ms=value.value*({seconds:1000,minutes:60000,hours:3600000}[value.unit]);data={...data,refreshInterval:value,refreshIntervalMs:ms,refreshIntervalLabel:value.value+' '+({seconds:'秒',minutes:'分钟',hours:'小时'}[value.unit]),nextRefreshAt:now+ms};return {value:data};}
    if (Object.keys(value).some(key => key.startsWith('show'))) {data = {...data, listSettings: {...data.listSettings, ...value}};return {value: data};}
    data = {...data, accounts: data.accounts.map(account => account.id === value.id ? {...account, refreshEnabled: value.enabled} : account)};
    return {value: data};
  };
  const tick = () => new Promise(setImmediate);
  elements.get('quota-view').hidden = true;
  const window = {whale: {quota: async (name, value) => { calls.push(name); if (name === 'set-refresh' || name === 'set-list' || name === 'set-interval') {saves.push(value);return save(value);} if (name === 'refresh') data = {...data, checkedAt: now, attemptedAt: now, failedAt: null, error: '', nextRefreshAt: now + 300000, busy: false}; return {value: data}; }}};
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/quota-view.mjs'), 'utf8').replace('export function', 'function');
  vm.runInNewContext(source + '\ncreateQuotaView();', {window, document: {addEventListener() {}, getElementById: id => elements.get(id), createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag)}, Date: TestDate, setInterval(callback) { intervals.push(callback); }});
  const get = id => elements.get('quota-' + id);
  return {get, calls, saves, setSave: fn => {save = fn;}, setNow: value => { now = value; }, set: value => { data = {...data, ...value}; },
    async open() { get('view').hidden = false; elements.get('nav-quota').click(); await tick(); },
    async poll() { intervals.forEach(callback => callback()); await tick(); },
    async refresh() { get('refresh').click(); await tick(); }};
}

test('list preferences hide the five-hour window without hiding weekly quota or triggering refresh', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5, sevenDayRemaining: 80}], checkedAt: 1000, listSettings: {showFiveHour: false}});
  await view.open();
  assert.equal(view.get('show-five-hour').checked, false);
  assert.equal(view.get('list').children[0].children[2].children[0].hidden, true);
  assert.equal(view.get('list').children[0].children[2].children[1].hidden, false);
  view.get('show-five-hour').checked = true;
  await view.get('show-five-hour').handlers.change();
  assert.equal(view.get('list').children[0].children[2].children[0].hidden, false);
  assert.equal(JSON.stringify(view.saves), JSON.stringify([{showFiveHour: true}]));
  assert.deepEqual(view.calls, ['snapshot', 'set-list']);
});

test('interval drafts survive polling and save with the chosen unit without requesting quota data',async()=>{
  const view=fixture();view.set({checkedAt:1000});await view.open();
  assert.equal(view.get('interval-value').value,'5');assert.equal(view.get('interval-unit').value,'minutes');
  view.get('interval-value').value='2';view.get('interval-value').handlers.input();
  view.get('interval-unit').value='hours';view.get('interval-unit').handlers.change();
  assert.equal(view.get('interval-value').max,'24');assert.equal(view.get('interval-apply').disabled,false);
  await view.poll();assert.equal(view.get('interval-value').value,'2');assert.equal(view.get('interval-unit').value,'hours');
  await view.get('interval-form').handlers.submit({preventDefault(){}});
  assert.deepEqual(view.calls,['snapshot','snapshot','set-interval']);assert.equal(JSON.stringify(view.saves),JSON.stringify([{value:2,unit:'hours'}]));
  assert.equal(view.get('interval-apply').disabled,true);assert.match(view.get('interval-feedback').textContent,/2 小时/);
  view.set({busy:true,nextRefreshAt:null});await view.poll();assert.equal(view.get('interval-value').disabled,true);
});

test('failed interval saves preserve the draft and old schedule, and seconds enforce the five-second minimum',async()=>{
  const view=fixture();view.set({checkedAt:1000,nextRefreshAt:301000});await view.open();
  view.get('interval-unit').value='seconds';view.get('interval-unit').handlers.change();
  assert.equal(view.get('interval-value').min,'5');assert.equal(view.get('interval-value').max,'86400');
  view.setSave(async()=>({error:'private storage error'}));
  const previous=view.get('checked').textContent;await view.get('interval-form').handlers.submit({preventDefault(){}});
  assert.equal(view.get('interval-unit').value,'seconds');assert.equal(view.get('interval-apply').disabled,false);
  assert.equal(view.get('checked').textContent,previous);assert.equal(view.get('settings-error').textContent,'刷新间隔保存失败，请重试。');
});

test('a zero-length window stays hidden even when the five-hour display setting is enabled', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5, fiveHourRemaining: 100, fiveHourWindowMinutes: 0,
    fiveHourResetAt: new Date(0).toISOString(), sevenDayRemaining: 99, sevenDayWindowMinutes: 10080}], checkedAt: 1000});
  await view.open();
  const [fiveHour, sevenDay] = view.get('list').children[0].children[2].children;
  assert.equal(fiveHour.hidden, true);
  assert.equal(fiveHour.children.length, 3, '无效窗口不创建重置提示');
  assert.equal(sevenDay.hidden, false);
});

test('five-hour control reflects unavailable windows without overwriting the saved display preference', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5, fiveHourWindowMinutes: 0}, {id: 6, fiveHourWindowMinutes: 0}],
    checkedAt: 1000, listSettings: {showFiveHour: true}});
  await view.open();
  assert.equal(view.get('show-five-hour').checked, false);
  assert.equal(view.get('show-five-hour').disabled, true);
  assert.equal(view.get('five-hour-hint').hidden, false);
  assert.equal(view.get('five-hour-hint').textContent, '当前账号不适用');
  view.set({accounts: [{id: 5, fiveHourWindowMinutes: 300}, {id: 6, fiveHourWindowMinutes: 0}]});await view.poll();
  assert.equal(view.get('show-five-hour').checked, true);
  assert.equal(view.get('show-five-hour').disabled, false);
  assert.equal(view.get('five-hour-hint').hidden, true);
  assert.equal(view.get('list').children[0].children[2].children[0].hidden, false);
  assert.equal(view.get('list').children[1].children[2].children[0].hidden, true);
  assert.deepEqual(view.calls, ['snapshot', 'snapshot']);
});

test('unknown five-hour metadata remains selectable and an explicit hidden preference survives availability changes', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5}], checkedAt: 1000, listSettings: {showFiveHour: false}});await view.open();
  assert.equal(view.get('show-five-hour').disabled, false);
  view.set({accounts: [{id: 5, fiveHourWindowMinutes: 0}]});await view.poll();
  view.set({accounts: [{id: 5, fiveHourWindowMinutes: 300}]});await view.poll();
  assert.equal(view.get('show-five-hour').disabled, false);
  assert.equal(view.get('show-five-hour').checked, false);
  assert.equal(view.get('list').children[0].children[2].children[0].hidden, true);
  assert.deepEqual(view.saves, []);
});

test('column settings hide the header and account cell together without changing the refresh switches', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5}], checkedAt: 1000});await view.open();
  view.get('show-platform').checked = false;
  await view.get('show-platform').handlers.change();
  assert.equal(view.get('platform-heading').hidden, true);
  assert.equal(view.get('list').children[0].children[1].hidden, true);
  assert.equal(view.get('list').children[0].children[3].hidden, false);
  view.get('show-platform').checked = true;
  await view.get('show-platform').handlers.change();
  assert.equal(view.get('platform-heading').hidden, false);
  assert.equal(view.get('list').children[0].children[1].hidden, false);
  assert.deepEqual(view.calls, ['snapshot', 'set-list', 'set-list']);
});

test('failed list preference saves restore the saved choice and explain the failure', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5}], checkedAt: 1000});await view.open();
  view.setSave(async () => ({error: 'private filesystem error'}));
  view.get('show-five-hour').checked = false;
  await view.get('show-five-hour').handlers.change();
  assert.equal(view.get('show-five-hour').checked, true);
  assert.equal(view.get('settings-error').hidden, false);
  assert.equal(view.get('settings-error').textContent, '列设置保存失败，请重试。');
  assert.equal(view.get('show-five-hour').disabled, false);
});

test('account refresh switches show saved choices and send the account ID when changed', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5, name: '账号一', refreshEnabled: true}, {id: 6, name: '账号二', refreshEnabled: false}], checkedAt: 1000});
  await view.open();
  const toggle = row => row.children[3].children[0];
  assert.equal(toggle(view.get('list').children[0]).attributes['aria-checked'], 'true');
  assert.equal(toggle(view.get('list').children[1]).attributes['aria-checked'], 'false');
  toggle(view.get('list').children[0]).click();
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(view.saves), JSON.stringify([{id: 5, enabled: false}]));
  assert.equal(toggle(view.get('list').children[0]).textContent, '已关闭');
  assert.equal(view.get('status').textContent, '已暂停刷新');
  assert.equal(view.get('refresh').disabled, true);
  await view.open();assert.equal(view.calls.filter(name => name === 'refresh').length, 0);
});

test('saving choices disables controls and a rejected save restores the previous switch state', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5, name: '账号', refreshEnabled: true}], checkedAt: 1000});await view.open();
  let reject;view.setSave(() => new Promise((_resolve, fail) => {reject = fail;}));
  const button = view.get('list').children[0].children[3].children[0];button.click();
  assert.equal(button.disabled, true);assert.equal(view.get('refresh').disabled, true);
  await view.poll();assert.equal(button.attributes['aria-checked'], 'true');
  reject(Error('private error'));await new Promise(setImmediate);
  assert.equal(button.disabled, false);assert.equal(button.attributes['aria-checked'], 'true');
  assert.equal(view.get('settings-error').hidden, false);assert.ok(!view.get('settings-error').textContent.includes('private'));
  view.set({busy: true});await view.poll();assert.equal(button.disabled, true);
});

test('quota page lists account remaining percents as text', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5, name: '<b>yuchaoyuan-codex</b>', fiveHourRemaining: 100, sevenDayRemaining: 96}], checkedAt: 1000});
  await view.open();
  const row = view.get('list').children[0];
  assert.equal(row.children[0].textContent, '<b>yuchaoyuan-codex</b>');
  assert.equal(row.tagName, 'tr');
  assert.equal(row.children[0].attributes.scope, 'row');
  const [fiveHour, sevenDay] = row.children[2].children;
  assert.equal(row.children.length, 4);
  assert.equal(fiveHour.children[0].textContent, '5h');
  assert.equal(sevenDay.children[0].textContent, '7d');
  assert.equal(fiveHour.children[2].textContent, '100%');
  assert.equal(sevenDay.children[2].textContent, '96%');
  assert.equal(sevenDay.children.length, 3);
  assert.equal(fiveHour.children[1].value, 100);
  assert.equal(sevenDay.children[1].value, 96);
  assert.equal(sevenDay.children[1].max, 100);
  assert.match(sevenDay.children[1].attributes['aria-label'], /7 天剩余/);
  assert.equal(view.get('table').hidden, false);
  assert.equal(view.get('count').textContent, '1 个账号');
  assert.deepEqual(view.calls, ['snapshot']);
});

test('opening the page loads account quotas', async () => {
  const view = fixture();
  await view.open();
  assert.deepEqual(view.calls, ['snapshot', 'refresh']);
  assert.match(view.get('checked').textContent, /刷新时间/);
});

test('reset countdown updates locally without rebuilding rows or refreshing the account', async () => {
  const view = fixture();
  view.set({accounts: [{id: 5, fiveHourRemaining: 100, sevenDayRemaining: 80,
    fiveHourResetAt: new Date(61000).toISOString(), sevenDayResetAt: new Date(1000 + 6 * 86400000 + 3 * 3600000).toISOString()}], checkedAt: 1000});
  await view.open();
  const row = view.get('list').children[0], [fiveHour, sevenDay] = row.children[2].children;
  assert.equal(fiveHour.children[3].children[0].textContent, '1m');
  assert.equal(sevenDay.children[3].children[0].textContent, '6d 3h');
  assert.equal(sevenDay.children[3].children[1].tagName, 'svg');
  const reset = sevenDay.children[3], tooltip = reset.children[2];
  assert.equal(reset.title, undefined, '不再触发系统原生提示');
  assert.equal(reset.tabIndex, 0);
  assert.equal(tooltip.attributes.role, 'tooltip');
  assert.equal(reset.attributes['aria-describedby'], tooltip.id);
  assert.match(tooltip.textContent, /^重置时间：/);
  view.setNow(61000);await view.poll();
  assert.equal(fiveHour.children[3].children[0].textContent, '0m');
  assert.equal(fiveHour.children[3].children[1].tagName, 'svg');
  assert.equal(view.get('list').children[0], row);
  assert.deepEqual(view.calls, ['snapshot', 'snapshot']);
});

test('a cache save error stays separate from network success and clears after saving recovers', async () => {
  const view = fixture();
  view.set({checkedAt: 1000, cacheError: '本地额度缓存保存失败'});await view.open();
  assert.equal(view.get('status').textContent, '已同步');
  assert.equal(view.get('cache-error').hidden, false);assert.match(view.get('cache-error').textContent, /缓存保存失败/);
  view.set({cacheError: ''});await view.poll();assert.equal(view.get('cache-error').hidden, true);
});

test('subscription appears beside the account details and missing types remain unknown', async () => {
  const view = fixture();
  view.set({accounts: ['Pro 100', 'Pro 200', null, '<img src=x>'].map((subscriptionType, id) => ({id, name: '账号', fiveHourRemaining: 100, subscriptionType})), checkedAt: 1000});
  await view.open();
  const labels = view.get('list').children.map(row => row.children[1].children[0].children[0]);
  assert.deepEqual(labels.map(label => label.textContent), ['Pro 100', 'Pro 200', '订阅未知', '<img src=x>']);
  assert.ok(labels.every(label => label.tagName === 'span' && label.children.length === 0));
});

test('platform reset badges display available cards without treating missing data as zero', async () => {
  const view = fixture();
  view.set({accounts: [0, 2, null].map((resetCardCount, index) => ({id: index, name: '账号', fiveHourRemaining: 100, sevenDayRemaining: 80, resetCardCount})), checkedAt: 1000});
  await view.open();
  assert.deepEqual(view.get('list').children.map(row => row.children[1].children[0].children[1].textContent), ['重置次数 0', '重置次数 2', '重置次数 —']);
  assert.deepEqual(view.get('list').children.map(row => row.children[1].children[0].children[1].title), ['可用重置卡：0 张', '可用重置卡：2 张', '暂无重置卡数据']);
});


test('missing quota stays distinct from zero and does not create an indeterminate progress bar', async () => {
  const view = fixture();
  view.set({accounts: [{id: 6, name: '', fiveHourRemaining: 0, sevenDayRemaining: null}]});
  await view.open();
  const row = view.get('list').children[0];
  assert.equal(row.children[0].textContent, '账号 #6');
  const [fiveHour, sevenDay] = row.children[2].children;
  assert.equal(fiveHour.children[2].textContent, '0%');
  assert.equal(fiveHour.children[1].value, 0);
  assert.equal(sevenDay.children[2].textContent, '—');
  assert.equal(sevenDay.children[2].title, '暂无数据');
  assert.equal(sevenDay.children[1].tagName, 'span');

});

test('empty accounts hide the column headers and keep refresh and update status available', async () => {
  const view = fixture();
  await view.open();
  assert.equal(view.get('table').hidden, true);
  assert.equal(view.get('empty').hidden, false);
  assert.equal(view.get('refresh').disabled, false);
  assert.match(view.get('checked').textContent, /刷新时间/);
});


test('visible polling reads local snapshots and updates background refresh state without rebuilding unchanged rows', async () => {
  const view = fixture();
  view.set({accounts: [{id: 7, name: 'test', fiveHourRemaining: 80, sevenDayRemaining: 70}]});
  await view.open();
  const row = view.get('list').children[0];
  view.set({busy: true, nextRefreshAt: null});
  await view.poll();
  assert.equal(view.get('refresh').disabled, true);
  assert.equal(view.get('refresh').textContent, '正在刷新…');
  assert.equal(view.get('list').children[0], row);
  view.set({busy: false, checkedAt: 5000, nextRefreshAt: 305000});
  await view.poll();
  assert.equal(view.get('refresh').disabled, false);
  assert.equal(view.get('refresh').textContent, '立即刷新');
  assert.deepEqual(view.calls, ['snapshot', 'refresh', 'snapshot', 'snapshot']);
  view.get('view').hidden = true;
  await view.poll();
  assert.equal(view.calls.length, 4);
});

test('reopening after an attempted refresh keeps the backend retry schedule', async () => {
  const view = fixture();
  view.set({attemptedAt: 1000, failedAt: 2000, error: '读取账号额度失败', nextRefreshAt: 302000});
  await view.open();
  await view.open();
  assert.deepEqual(view.calls, ['snapshot', 'snapshot']);
  assert.match(view.get('status').textContent, /^同步更新失败（/);
  await view.refresh();
  assert.deepEqual(view.calls, ['snapshot', 'snapshot', 'refresh']);
});

test('a successful timestamp of zero is cached and does not start another network request', async () => {
  const view = fixture();
  view.set({checkedAt: 0, attemptedAt: 0, nextRefreshAt: 300000});
  await view.open();
  assert.deepEqual(view.calls, ['snapshot']);
  assert.equal(view.get('status').textContent, '已同步');
  assert.match(view.get('checked').textContent, /刷新时间/);
});


test('opening reuses fresh data and refreshes once five minutes have elapsed', async () => {
  const view = fixture();
  view.set({checkedAt: 1000, attemptedAt: 1000, nextRefreshAt: 301000});
  view.setNow(300999);
  await view.open();
  assert.deepEqual(view.calls, ['snapshot']);
  view.setNow(301000);
  await view.open();
  assert.deepEqual(view.calls, ['snapshot', 'snapshot', 'refresh']);
  await view.open();
  assert.deepEqual(view.calls, ['snapshot', 'snapshot', 'refresh', 'snapshot']);
});

test('a recent failure waits five minutes before retrying on opening even with stale successful data', async () => {
  const view = fixture();
  view.set({checkedAt: 1000, attemptedAt: 301000, failedAt: 302000, error: '读取失败', nextRefreshAt: 602000});
  view.setNow(601999);
  await view.open();
  assert.deepEqual(view.calls, ['snapshot']);
  view.setNow(602000);
  await view.open();
  assert.deepEqual(view.calls, ['snapshot', 'snapshot', 'refresh']);
});

test('failure badge contains the failure time and stays red through retries until success', async () => {
  const view = fixture();
  view.set({checkedAt: 1000, failedAt: 2000, attemptedAt: 2000, error: '读取失败', nextRefreshAt: 302000});
  view.setNow(3000);
  await view.open();
  const expected = `同步更新失败（${new Date(2000).toLocaleString('zh-CN')}）`;
  assert.equal(view.get('status').textContent, expected);
  assert.match(view.get('status').className, /quota-sync-failed/);
  view.set({busy: true, nextRefreshAt: null});
  await view.poll();
  assert.equal(view.get('status').textContent, expected);
  assert.match(view.get('status').className, /quota-sync-failed/);
  view.set({busy: false, checkedAt: 4000, error: '', failedAt: null, nextRefreshAt: 304000});
  await view.poll();
  assert.equal(view.get('status').textContent, '已同步');
  assert.doesNotMatch(view.get('status').className, /quota-sync-failed/);
  assert.equal(view.get('error').hidden, true);
});


test('reopening during continued failures uses the next retry time rather than the first failure time', async () => {
  const view = fixture();
  view.set({checkedAt: 1000, attemptedAt: 301000, failedAt: 2000, error: '读取失败', nextRefreshAt: 602000});
  view.setNow(601999);
  await view.open();
  assert.deepEqual(view.calls, ['snapshot']);
  assert.equal(view.get('status').textContent, `同步更新失败（${new Date(2000).toLocaleString('zh-CN')}）`);
  view.setNow(602000);
  await view.open();
  assert.deepEqual(view.calls, ['snapshot', 'snapshot', 'refresh']);
});
