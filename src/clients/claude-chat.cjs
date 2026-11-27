'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL=/^local_[A-Za-z0-9-]{1,64}$/;
const sessionsDirectory=()=>process.env.WHALE_CLAUDE_SESSIONS||path.join(os.homedir(),'Library','Application Support','Claude','claude-code-sessions');
// Hook 给的是 CLI 会话 ID，桌面端页面用自己的 local_ ID；只读本机会话记录建立对应，不读 transcript 和正文。
function createClaudeSessions({dir=sessionsDirectory(),clock=Date.now,interval=3000}={}) {
  const files=new Map();
  let checkedAt=-Infinity,byCli=new Map();
  const list=folder=>{try {return fs.readdirSync(folder,{withFileTypes:true});}catch {return [];}};
  function read(full,name) {
    const item=JSON.parse(fs.readFileSync(full,'utf8'));
    if(item.sessionId!==name||!LOCAL.test(name)||typeof item.cliSessionId!=='string'||!UUID.test(item.cliSessionId))return null;
    const prior=Array.isArray(item.priorCliSessionIds)?item.priorCliSessionIds.filter(id=>typeof id==='string'&&UUID.test(id)).slice(-200):[];
    return {cliId:item.cliSessionId,prior,sessionId:name,archived:item.isArchived===true,title:typeof item.title==='string'?item.title.trim().slice(0,160):'',
      activity:Number.isFinite(item.lastActivityAt)?item.lastActivityAt:0,focused:Number.isFinite(item.lastFocusedAt)?item.lastFocusedAt:0};
  }
  // 提醒列表每秒查标题；限制扫描频率，且只重新解析修改过的文件。
  function refresh(force) {
    const now=clock();
    if(!force&&now-checkedAt<interval)return;
    checkedAt=now;
    const present=new Set();
    for(const account of list(dir))if(account.isDirectory())for(const org of list(path.join(dir,account.name)))if(org.isDirectory()) {
      const folder=path.join(dir,account.name,org.name);
      for(const file of list(folder)) {
        if(!file.isFile()||!/^local_[A-Za-z0-9-]{1,64}\.json$/.test(file.name))continue;
        const full=path.join(folder,file.name);present.add(full);
        try {
          const stat=fs.statSync(full),stamp=`${stat.mtimeMs}:${stat.size}`,known=files.get(full);
          if(known?.stamp===stamp||stat.size>32*1024*1024)continue;
          files.set(full,{stamp,record:read(full,file.name.slice(0,-5))});
        }catch { /* 记录可能正在写入；沿用上次结果，下次重读。 */ }
      }
    }
    for(const full of files.keys())if(!present.has(full))files.delete(full);
    byCli=new Map();
    const records=[...files.values()].map(item=>item.record).filter(Boolean).sort((a,b)=>b.activity-a.activity);
    for(const record of records)if(!byCli.has(record.cliId))byCli.set(record.cliId,record);
    // 同一桌面会话会更换 CLI 会话 ID；旧 ID 的提醒仍应对应到它，但不能抢占其他会话的当前 ID。
    for(const record of records)for(const id of record.prior)if(!byCli.has(id))byCli.set(id,record);
  }
  return {
    find(id,force=false) {refresh(force);return byCli.get(id)||null;},
    lookup(sessionId) {
      if(typeof sessionId!=='string'||!sessionId.startsWith('claude:'))return {kind:'unavailable'};
      const title=this.find(sessionId.slice(7))?.title;
      return title?{kind:'chat',title}:{kind:'unavailable'};
    },
    // 桌面端在会话变为可见时记录时间；完成之后又进入过才算看过，其余情况不猜测。
    readReceipt(item) {
      if(typeof item?.session_id!=='string'||!item.session_id.startsWith('claude:')||!Number.isFinite(item.time))return null;
      return this.find(item.session_id.slice(7))?.focused>item.time?true:null;
    }
  };
}
function createClaudeChatOpener({openExternal,find}={}) {
  let opening=false;
  return {
    // 返回 false 表示会话不在桌面端（命令行或 IDE），没有可跳转的页面。
    async open(sessionId) {
      const id=typeof sessionId==='string'&&sessionId.startsWith('claude:')?sessionId.slice(7):'';
      if(!UUID.test(id))throw Error('无法定位这个 Claude 会话');
      if(opening)throw Error('正在打开聊天，请稍后重试。提醒已保留。');
      const session=find(id);
      if(!session)return false;
      if(session.archived)throw Error('这个 Claude 会话已归档，请在 Claude 中恢复后查看。提醒已保留。');
      opening=true;
      // continue 只切换页面；resume 链接会导入会话并信任目录，不能用于跳转。
      try {await openExternal(`claude://code/continue?session=${session.sessionId}`);return true;}
      finally {opening=false;}
    }
  };
}
module.exports={createClaudeChatOpener,createClaudeSessions};
