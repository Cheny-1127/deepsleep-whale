'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createSubscriptionTranslator} = require('../src/channels/subscription-translation.cjs');
const reply = text => new Response(JSON.stringify([[[text,'source']]]));
test('translator posts only source text to the fixed HTTPS endpoint without credentials or redirects', async () => {
  const calls = [], translate = createSubscriptionTranslator({fetchImpl:async (...args) => {calls.push(args);return reply('中文 <script>原样文本</script>');}});
  assert.equal(await translate('Reset before 10am PST.'),'中文 <script>原样文本</script>');
  const [target,options] = calls[0], url = new URL(target);
  assert.equal(url.origin,'https://translate.googleapis.com');assert.equal(url.pathname,'/translate_a/single');
  assert.equal(url.searchParams.get('tl'),'zh-CN');assert.equal(url.searchParams.has('q'),false);
  assert.equal(new URLSearchParams(options.body).get('q'),'Reset before 10am PST.');
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.method,'POST');
});
test('long text translates serially in bounded chunks, preserving whitespace and Unicode', async () => {
  let active = 0;const sent = [];
  const translate = createSubscriptionTranslator({fetchImpl:async (url,options) => {
    assert.equal(active++,0);await new Promise(setImmediate);active--;
    const text = new URLSearchParams(options.body).get('q');sent.push(text);assert.ok(Array.from(text).length <= 1200);return reply(text);
  }});
  const source = '  ' + 'word 🌊. '.repeat(800) + '\n\n';
  assert.equal(await translate(source),source);assert.ok(sent.length > 1);assert.ok(sent.every(text => !text.includes('\uFFFD')));
});
test('invalid source does not make network requests', async () => {
  const translate = createSubscriptionTranslator({fetchImpl:() => {assert.fail('unexpected network');}});
  for (const value of ['',null,'  ','x'.repeat(10001)]) await assert.rejects(translate(value),/正文/);
});
test('HTTP, malformed, empty and oversized responses fail without leaking remote diagnostics', async () => {
  for (const response of [new Response('private token diagnostics',{status:429}),new Response('not JSON'),new Response(JSON.stringify([[]])),
    new Response(JSON.stringify([[[null]]])),reply(''),reply('x'.repeat(20001)),new Response('x'.repeat(128 * 1024 + 1)),
    new Response('{}',{headers:{'content-length':String(128 * 1024 + 1)}})]) {
    const translate = createSubscriptionTranslator({fetchImpl:async () => response});
    await assert.rejects(translate('public post'),error => error.message === '在线翻译暂不可用，请稍后重试。');
  }
});
test('cancellation and one overall deadline abort requests; a partially translated post is never returned', async () => {
  const controller = new AbortController(), requests = [];
  const translate = createSubscriptionTranslator({fetchImpl:async (url,{signal}) => {
    requests.push(signal);if (requests.length === 1) return reply('partial');
    controller.abort();signal.throwIfAborted();
  }});
  await assert.rejects(translate('word '.repeat(500),{signal:controller.signal}),/取消/);assert.equal(requests.length,2);
  const expired = createSubscriptionTranslator({timeoutMs:5,fetchImpl:async (url,{signal}) => {
    await new Promise(resolve => setTimeout(resolve,20));signal.throwIfAborted();
  }});
  await assert.rejects(expired('post'),/超时/);
  const cancelled = new AbortController();cancelled.abort();
  const never = createSubscriptionTranslator({fetchImpl:() => assert.fail('already cancelled')});
  await assert.rejects(never('post',{signal:cancelled.signal}),/取消/);
});
