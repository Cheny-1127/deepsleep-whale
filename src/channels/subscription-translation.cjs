'use strict';
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t';
const TEXT_LIMIT = 20000, RESPONSE_LIMIT = 128 * 1024;

function splitSource(text) {
  const chars = Array.from(text), parts = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(start + 1200, chars.length);
    // 优先沿句子或空白拆分，既保留换行，也不截断 emoji 的代理对。
    if (end < chars.length) for (let i = end - 1; i >= start + 600; i--) {
      if (/[\s。！？.!?]/u.test(chars[i])) {end = i + 1;break;}
    }
    parts.push(chars.slice(start,end).join(''));start = end;
  }
  return parts;
}
async function readResponse(response) {
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
    await response.body?.cancel();throw Error('response limit');
  }
  const reader = response.body.getReader(), chunks = [];let size = 0, complete = false;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) {complete = true;break;}
      size += value.byteLength;if (size > RESPONSE_LIMIT) throw Error('response limit');
      chunks.push(Buffer.from(value));
    }
  } finally {if (!complete) await reader.cancel().catch(() => {});reader.releaseLock();}
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(data?.[0]) || !data[0].length || !data[0].every(part => Array.isArray(part) && typeof part[0] === 'string')) throw Error('invalid response');
  const translated = data[0].map(part => part[0]).join('');
  if (!translated.trim() || translated.length > TEXT_LIMIT) throw Error('invalid translation');
  return translated;
}
function createSubscriptionTranslator({fetchImpl = globalThis.fetch, timeoutMs = 30000} = {}) {
  return async function translate(text, {signal} = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw Error('没有可翻译的正文。');
    const deadline = AbortSignal.timeout(timeoutMs), requestSignal = signal ? AbortSignal.any([signal,deadline]) : deadline;
    const results = [];
    try {
      for (const part of splitSource(text)) {
        requestSignal.throwIfAborted();
        const content = part.trim();
        if (!content) {results.push(part);continue;}
        // 固定目标、POST 正文、无凭据和跳转；不把帖子当作模型指令，也不加载远程脚本。
        const response = await fetchImpl(ENDPOINT, {method:'POST', credentials:'omit', cache:'no-store', redirect:'error', signal:requestSignal,
          headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({q:content}).toString()});
        if (!response.ok) {await response.body?.cancel();throw Error('translation unavailable');}
        const translated = await readResponse(response);
        results.push(part.match(/^\s*/u)[0] + translated + part.match(/\s*$/u)[0]);
        if (results.reduce((sum,value) => sum + value.length,0) > TEXT_LIMIT) throw Error('translation limit');
      }
      requestSignal.throwIfAborted();return results.join('');
    } catch {
      // 不向界面或缓存转发远端错误正文，避免泄露网络诊断内容。
      throw Error(signal?.aborted ? '翻译已取消。' : deadline.aborted ? '翻译超时，请重试。' : '在线翻译暂不可用，请稍后重试。');
    }
  };
}
module.exports = {createSubscriptionTranslator, TEXT_LIMIT};
