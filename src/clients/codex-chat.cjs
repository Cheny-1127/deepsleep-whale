'use strict';
const {chatUrl}=require('./chat-metadata.cjs');

function createCodexChatOpener({openExternal}={}) {
  let opening=false;
  return {
    async open(sessionId) {
      // 只打开通过会话 ID 校验的深链接，避免外部参数混入跳转地址。
      const url=chatUrl(sessionId);
      if(!url)throw Error('无法定位这个 Codex 聊天');
      if(opening)throw Error('正在打开聊天，请稍后重试。提醒已保留。');
      opening=true;
      // 打开失败也释放防连击锁，允许保留的提醒再次尝试。
      try { await openExternal(url); }
      finally {opening=false;}
    }
  };
}
module.exports={createCodexChatOpener};
