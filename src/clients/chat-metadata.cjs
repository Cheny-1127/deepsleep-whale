'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function chatUrl(id) { return typeof id==='string' && UUID.test(id) ? `codex://threads/${id}` : null; }
function createTitleReader(home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')) {
  let db,query,readCache,readMtime=-1;
  function lookup(id) {
    if (!chatUrl(id)) return {kind:'unavailable'};
    try {
      // name 才是侧栏名称；title 在当前 Codex 中可能仍是未经整理的首条输入。
      if (!query) {
        const { DatabaseSync }=require('node:sqlite');
        db ||= new DatabaseSync(path.join(home,'state_5.sqlite'),{readOnly:true});
        const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(row=>row.name));
        const title=columns.has('name') ? "COALESCE(NULLIF(name,''),title)" : 'title';
        const source=columns.has('thread_source') ? 'thread_source' : 'NULL';
        query=db.prepare(`SELECT ${title} AS title, ${source} AS thread_source FROM threads WHERE id = ?`);
      }
      const row=query.get(id);
      if(!row)return {kind:'missing'};
      return {kind:row.thread_source==='subagent'?'other':'chat',title:row.title||null};
    } catch { return {kind:'unavailable'}; }
  }
  return {
    lookup,
    title(id) { return lookup(id).title || null; },
    readState() {
      try {
        const file=path.join(home,'.codex-global-state.json');
        const stat=fs.statSync(file);
        if(stat.size>5*1024*1024)return null;
        if(stat.mtimeMs===readMtime)return readCache;
        const data=JSON.parse(fs.readFileSync(file,'utf8'))['electron-thread-read-state-v1'];
        if(data?.version!==1 || !data.unreadByIdentity || typeof data.unreadByIdentity!=='object')return null;
        const unreadIds=new Set();let valid=false;
        // 仅比较本机正式聊天的 UUID；不解析认证文件，也不统计远程主机或其他聊天。
        for(const hosts of Object.values(data.unreadByIdentity)) {
          if(!hosts||typeof hosts!=='object')continue;
          for(const [host,ids] of Object.entries(hosts))if(host.startsWith('local:')&&Array.isArray(ids)) {
            valid=true;for(const id of ids)if(chatUrl(id))unreadIds.add(id);
          }
        }
        if(!valid)return null;
        readMtime=stat.mtimeMs;readCache={updatedAt:stat.mtimeMs,unreadIds};
        return readCache;
      } catch { return null; } // 不存在、写入中或版本不同：保留待查看，允许用户手动处理。
    },
    close() { db?.close(); }
  };
}
function createCursorTitleReader(file=process.env.WHALE_CURSOR_STATE_DB || path.join(os.homedir(),'Library','Application Support','Cursor','User','globalStorage','state.vscdb')) {
  let db,query;
  return {
    lookup(id) {
      if(typeof id!=='string'||!id.startsWith('cursor:')||!UUID.test(id.slice(7)))return {kind:'unavailable'};
      try {
        // 只查询当前聊天的侧栏标题，不提取聊天正文、提示词或工具内容。
        if(!query) {
          const {DatabaseSync}=require('node:sqlite');
          db ||= new DatabaseSync(file,{readOnly:true});
          query=db.prepare("SELECT json_extract(value,'$.name') AS title FROM composerHeaders WHERE composerId = ?");
        }
        const row=query.get(id.slice(7));
        return row&&typeof row.title==='string'&&row.title.trim()?{kind:'chat',title:row.title.trim()}:{kind:'unavailable'};
      }catch {return {kind:'unavailable'};}
    },
    close() {db?.close();}
  };
}
module.exports={chatUrl,createTitleReader,createCursorTitleReader};
