'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 白名单 deeplink 只会聚焦智能体窗口，不会把自定义扩展链接改送到 IDE。
const GLASS_URL='cursor://anysphere.cursor-deeplink/glass';
const SOCKET_NAME='cursor-jump.sock';
const PENDING_NAME='cursor-jump.json';
function parseJumpRequest(line) {
  let packet;
  try { packet=JSON.parse(String(line).split('\n')[0]); }
  catch { return null; }
  if(!packet||!UUID.test(packet.id||'')||!UUID.test(packet.request||''))return null;
  return {id:packet.id,request:packet.request};
}
module.exports={GLASS_URL,SOCKET_NAME,PENDING_NAME,parseJumpRequest};
