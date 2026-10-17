'use strict';
const {DatabaseSync}=require('node:sqlite');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECTED_AGENT='cursor/glass.selectedAgent';
function agentUrl(id) { return `cursor://anysphere.cursor-deeplink/agent?id=${id}`; }
function readSelectedAgent(file) {
  let db;
  try {
    db=new DatabaseSync(file,{readOnly:true});
    const row=db.prepare('SELECT value FROM ItemTable WHERE key=?').get(SELECTED_AGENT);
    return typeof row?.value==='string'?row.value:null;
  } catch { return null; }
  finally { db?.close(); }
}
function delay(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
function createCursorChatOpener({openExternal,stateFile,readSelected,timeout=8000}={}) {
  const selected=readSelected||(()=>readSelectedAgent(stateFile));
  return {
    async open(sessionId) {
      if(typeof sessionId!=='string'||!sessionId.startsWith('cursor:')||!UUID.test(sessionId.slice(7)))throw new Error('无法定位这个 Cursor 聊天');
      const id=sessionId.slice(7);
      await openExternal(agentUrl(id));
      // 系统接受深链接不等于目标对话已打开；确认选中目标智能体后才允许消费提醒。
      const deadline=Date.now()+timeout;
      do {
        if(selected()===id)return;
        if(Date.now()>=deadline)break;
        await delay(200);
      } while(Date.now()<=deadline);
      throw new Error('没有回到这个 Cursor 对话。请从智能体列表打开，提醒已保留。');
    },
    selectedSession() {
      const id=selected();
      return typeof id==='string'&&UUID.test(id)?`cursor:${id}`:null;
    },
    receive() { return false; }
  };
}
module.exports={createCursorChatOpener,agentUrl,readSelectedAgent};
