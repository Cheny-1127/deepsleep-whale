'use strict';
const LIMIT = 96 * 1024;
// 头像只接受 X 的固定图片域名和路径；不允许网页指定任意请求地址或 SVG。
function avatarUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.port && !url.username && !url.password &&
      /^\/profile_images\/[a-z0-9_./-]+$/i.test(url.pathname) ? url.href : '';
  } catch {return '';}
}
function avatarData(value) {
  // 本地缓存同样需要校验类型、大小和文件头，不能仅凭 data URI 中声明的 MIME 类型放行。
  if (typeof value !== 'string' || value.length > LIMIT * 4 / 3 + 32) return '';
  const match = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return '';
  const bytes = Buffer.from(match[2],'base64');
  const valid = match[1] === 'png' ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) :
    match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  return valid && bytes.length <= LIMIT ? value : '';
}
async function fetchAvatar(value, {fetchImpl,signal}) {
  const url = avatarUrl(value);if (!url) return '';
  // 头像属于辅助资料，下载失败返回空值，由订阅缓存保留旧头像，不阻断正文更新。
  try {
    // 禁止跳转绕过固定域名限制；订阅取消和五秒超时任一发生，都应停止头像请求。
    const response = await fetchImpl(url,{redirect:'error',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)});
    if (!response.ok || Number(response.headers.get('content-length')) > LIMIT) {await response.body?.cancel();return '';}
    const type = response.headers.get('content-type')?.split(';')[0].trim();
    if (!['image/png','image/jpeg','image/webp'].includes(type) || !response.body) {await response.body?.cancel();return '';}
    const reader = response.body.getReader(), chunks = [];let size = 0;
    try {
      // 响应可能缺少或伪造 Content-Length，读取时仍累计字节数，超限立即取消。
      for (;;) {
        const {done,value:chunk} = await reader.read();if (done) break;
        size += chunk.length;if (size > LIMIT) {await reader.cancel();return '';}
        chunks.push(Buffer.from(chunk));
      }
    } finally {reader.releaseLock();}
    return avatarData(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`);
  } catch {return '';}
}
module.exports = {avatarUrl,avatarData,fetchAvatar};
