'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createMessageSubscriptions, INTERVAL} = require('../src/channels/message-subscriptions.cjs');
const {xUsername} = require('../src/channels/x-posts.cjs');
const turn = () => new Promise(setImmediate);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-subscriptions-')), calls = [], jobs = new Set(), services = [];
  let now = Date.parse('2026-10-22T12:00:00+08:00'), response = async username => [post(1,username)];
  const clock = {now:() => now, setTimeout(fn,ms) {const job = {fn,at:now + ms,ms};jobs.add(job);return job;},clearTimeout:job => jobs.delete(job)};
  function post(offset,username = 'thsottiaux') {
    return {id:String((BigInt(now - 600000 + offset) - 1288834974657n) << 22n),username,text:'动态 ' + offset};
  }
  const create = () => {
    const service = createMessageSubscriptions({dataDir:dir,clock,readPosts:(username,options) => {calls.push({username,...options});return response(username,options);}});
    services.push(service);return service;
  };
  t.after(() => {services.forEach(s => s.close());fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,clock,jobs,calls,post,create,service:create(),setResponse:fn => {response = fn;},
    async advance(ms) {now += ms;for (const job of [...jobs]) if (job.at <= now) {jobs.delete(job);job.fn();}await turn();await turn();}};
}
test('X handles and supplied post links normalize, while foreign URLs and reserved paths are rejected', () => {
  for (const value of ['@ThSottiaux','thsottiaux','https://x.com/thsottiaux','https://x.com/thsottiaux/status/2113162277688070445?s=20','twitter.com/thsottiaux']) assert.equal(xUsername(value),'thsottiaux');
  for (const value of ['https://evil.test/thsottiaux','https://x.com.evil.test/thsottiaux','https://user:pass@x.com/thsottiaux','https://x.com:444/thsottiaux','http://x.com/thsottiaux','https://x.com/home','https://x.com/thsottiaux/anything','a'.repeat(16),null,'../x']) assert.throws(() => xUsername(value));
});
test('first sync is a baseline, persisted cache is safe and restart retains unread progress', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();
  assert.equal(s.snapshot().posts.length,1);assert.equal(s.summary().unread,0);
  assert.equal(s.snapshot().posts[0].url,`https://x.com/thsottiaux/status/${f.post(1).id}`);
  f.setResponse(async () => [f.post(2),f.post(1)]);await s.refresh();assert.equal(s.summary().unread,1);
  s.close();const restarted = f.create();assert.equal(restarted.summary().unread,1);assert.equal(restarted.snapshot().posts.length,2);
  assert.equal(fs.statSync(path.join(f.dir,'message-subscriptions.json')).mode & 0o777,0o600);
});
test('clear cache retains account, read state and the high-water mark, including after restart', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();
  f.setResponse(async () => [f.post(2),f.post(1)]);await s.refresh();
  s.markRead({username:'thsottiaux',id:f.post(2).id});s.clearCache();
  assert.equal(s.snapshot().posts.length,0);assert.equal(s.snapshot().accounts.length,1);
  s.close();const restarted = f.create();await restarted.refresh();assert.equal(restarted.summary().unread,0);
  f.setResponse(async () => [f.post(3),f.post(2),f.post(1)]);await restarted.refresh();
  assert.deepEqual(restarted.snapshot().posts.filter(p => p.unread).map(p => p.id),[f.post(3).id]);
  restarted.markRead(null);assert.equal(restarted.summary().unread,0);
});
test('cache clear also restores an existing unread flag when the same post is fetched again', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();
  f.setResponse(async () => [f.post(2)]);await s.refresh();s.clearCache();await s.refresh();
  assert.equal(s.summary().unread,1);assert.equal(s.snapshot().posts[0].unread,true);
});
test('cache is bounded to the newest hundred unique posts per account', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');
  f.setResponse(async () => Array.from({length:100},(_,i) => f.post(i + 1)));await s.refresh();
  f.setResponse(async () => Array.from({length:100},(_,i) => f.post(i + 51)));await s.refresh();
  const posts = s.snapshot().posts;assert.equal(posts.length,100);
  assert.equal(posts[0].id,f.post(150).id);assert.equal(posts.at(-1).id,f.post(51).id);assert.equal(s.summary().unread,50);
});
test('hourly work survives restart and a long sleep without replaying missed intervals', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');s.start();await turn();await turn();assert.equal(f.calls.length,1);
  await f.advance(INTERVAL / 2);assert.equal(f.calls.length,1);s.close();
  const restarted = f.create();restarted.start();await turn();assert.equal(f.calls.length,1);
  await f.advance(INTERVAL / 2);assert.equal(f.calls.length,2);
  await f.advance(INTERVAL * 8);await restarted.checkDue();assert.equal(f.calls.length,3);
  assert.equal(f.jobs.size,1);assert.equal([...f.jobs][0].ms,INTERVAL);
});
test('account errors preserve cache and first eventual success still establishes a baseline', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');
  f.setResponse(async () => {throw Error('private diagnostics');});await s.refresh();assert.ok(s.snapshot().accounts[0].error);
  assert.ok(!JSON.stringify(s.snapshot()).includes('private diagnostics'));
  f.setResponse(async () => [f.post(2)]);await s.refresh();assert.equal(s.summary().unread,0);
  f.setResponse(async () => {throw Object.assign(Error(),{code:'X_PUBLIC_UNAVAILABLE'});});await s.refresh();
  assert.equal(s.snapshot().posts.length,1);assert.match(s.snapshot().accounts[0].error,/公开页面/);
});
test('accounts run serially, failures do not prevent other accounts, and pause and removal persist', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');s.add('OpenAI');
  let active = 0;
  f.setResponse(async username => {assert.equal(active++,0);await turn();active--;if (username === 'thsottiaux') throw Error();return [f.post(1,username)];});
  const first = s.refresh();assert.equal(s.refresh(),first);await first;
  assert.deepEqual(f.calls.map(c => c.username),['thsottiaux','openai']);assert.equal(s.snapshot().posts.length,1);
  s.setEnabled({username:'thsottiaux',enabled:false});await s.refresh();assert.equal(f.calls.at(-1).username,'openai');
  s.remove('openai');s.close();const restarted = f.create();assert.equal(restarted.snapshot().accounts[0].enabled,false);
  assert.equal(restarted.snapshot().posts.length,0);assert.throws(() => restarted.add('THSOTTIAUX'),/已在/);
});
test('clear, pause, remove and shutdown cancel late responses instead of restoring cleared content', async t => {
  for (const action of ['clear','pause','remove','close']) {
    const f = fixture(t), s = f.service;s.add('thsottiaux');let done;
    f.setResponse(() => new Promise(resolve => {done = resolve;}));
    const task = s.refresh();await turn();
    if (action === 'clear') s.clearCache();if (action === 'pause') s.setEnabled({username:'thsottiaux',enabled:false});
    if (action === 'remove') s.remove('thsottiaux');if (action === 'close') s.close();
    assert.equal(f.calls[0].signal.aborted,true);done([f.post(1)]);await task;assert.equal(s.snapshot().posts.length,0);
  }
});
test('pausing or deleting another account does not cancel the active account or defer its hourly check', async t => {
  for (const action of ['pause','remove']) {
    const f = fixture(t), s = f.service;s.add('thsottiaux');s.add('openai');let done;
    f.setResponse(() => new Promise(resolve => {done = resolve;}));
    const task = s.refresh();await turn();
    if (action === 'pause') s.setEnabled({username:'openai',enabled:false});else s.remove('openai');
    assert.equal(f.calls[0].signal.aborted,false);
    done([f.post(1)]);await task;
    assert.equal(s.snapshot().posts.length,1);assert.deepEqual(f.calls.map(c => c.username),['thsottiaux']);
    assert.ok(s.snapshot().accounts[0].checkedAt);
  }
});
test('failed saves preserve file and memory, back off instead of busy-looping, and invalid files stay untouched', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');
  const file = path.join(f.dir,'message-subscriptions.json'), before = fs.readFileSync(file,'utf8');
  fs.mkdirSync(file + '.tmp');assert.throws(() => s.remove('thsottiaux'),/保存失败/);
  assert.equal(s.snapshot().accounts.length,1);assert.equal(fs.readFileSync(file,'utf8'),before);
  s.start();await turn();assert.equal(f.calls.length,0);assert.equal([...f.jobs][0].ms,INTERVAL);
  fs.rmdirSync(file + '.tmp');s.close();fs.writeFileSync(file,'broken fixture');
  const broken = f.create();assert.match(broken.snapshot().storeError,/无法读取/);assert.throws(() => broken.add('openai'),/无法读取/);
  broken.start();await turn();assert.equal(fs.readFileSync(file,'utf8'),'broken fixture');assert.equal(f.calls.length,0);
});
test('malformed and foreign-author responses never overwrite good posts or open arbitrary URLs', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();const good = s.snapshot().posts;
  for (const result of [[{...f.post(2),username:'openai'}],[{...f.post(2),id:'javascript:alert(1)'}],{},Array(101).fill(f.post(2))]) {
    f.setResponse(async () => result);await s.refresh();assert.deepEqual(s.snapshot().posts,good);assert.ok(s.snapshot().accounts[0].error);
  }
  assert.throws(() => s.postUrl({username:'thsottiaux',id:'javascript:alert(1)'}));
  assert.throws(() => s.markRead({username:'thsottiaux',id:f.post(9).id}));
});
