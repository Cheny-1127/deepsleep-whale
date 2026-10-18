'use strict';
const EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']);
const STATES = { UserPromptSubmit: 'thinking', PreToolUse: 'working', PermissionRequest: 'approval', PostToolUse:'thinking', Stop: 'completed', Interrupt: 'idle', SessionEnd: 'idle' };
const { ToolActivity } = require('./tool-activity.cjs');
const { randomUUID } = require('node:crypto');
const { sourceOf, CURSOR_EVENTS } = require('../shared/hook-events.cjs');
const fallbackTitle = id => `聊天 ${id.slice(-8)}`;
const cleanTitle = title => typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,160) : '';

// 事件桥只传事件类型、会话和轮次标识；不保留提示词、工具输入或聊天正文。
function sanitizeEvent(input) {
  if (!input || !EVENTS.has(input.hook_event_name)) return null;
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : null;
  const session = id(input.session_id);
  if (!session) return null;
  const event={ hook_event_name: input.hook_event_name, session_id: session, turn_id: id(input.turn_id) || 'unknown' };
  if(input.source!==undefined&&!['codex','cursor'].includes(input.source))return null;
  if(input.source==='cursor') {
    if(!session.startsWith('cursor:'))return null;
    event.source='cursor';
    if(input.raw_event!==undefined) {
      if(!Object.hasOwn(CURSOR_EVENTS,input.raw_event)||(CURSOR_EVENTS[input.raw_event]!==event.hook_event_name&&!(input.raw_event==='stop'&&event.hook_event_name==='Interrupt')))return null;
      event.raw_event=input.raw_event;
    }
  } else if(session.startsWith('cursor:'))return null;
  // 仅保留调用标识和名称用于匹配；工具输入和返回正文始终丢弃。
  if(['PreToolUse','PermissionRequest','PostToolUse'].includes(event.hook_event_name)) {
    for(const key of ['tool_use_id','tool_name'])if(id(input[key]))event[key]=input[key];
  }
  return event;
}

class Activity {
  constructor({ saved, resolveTitle = () => null, resolveChat, clock=Date.now, sourceRunning={codex:true,cursor:true} } = {}) {
    this.sessions = new Map(); this.seen = new Set(); this.last = null; this.count = 0; this.tools=new Map();this.closedTurns=new Set();
    this.resolveChat=resolveChat || (id=>({kind:'unavailable',title:resolveTitle(id)}));
    this.clock=clock; this.notices=[];this.sourceRunning={...sourceRunning};
    // 只恢复未读和去重记录；上次进程的“工作中”不能当作现在仍在工作。
    if (saved?.version===1) {
      for (const item of Array.isArray(saved.notices) ? saved.notices.slice(0,100) : []) {
        const event=sanitizeEvent(item);
        if (event?.hook_event_name==='Stop' && typeof item.id==='string' && item.id.length<=160 && Number.isFinite(item.time)) {
          this.notices.push({...event,id:item.id,time:item.time,title:cleanTitle(item.title)||fallbackTitle(event.session_id)});
        }
      }
      this.seen=new Set((Array.isArray(saved.seen)?saved.seen:[]).filter(k=>typeof k==='string'&&k.length<=500).slice(-500));
    }
    this.consolidate();
  }
  chat(id) {
    if(id.startsWith('cursor:')) {
      let title;try {const chat=this.resolveChat(id);if(chat?.kind==='chat')title=cleanTitle(chat.title);}catch {}
      return {kind:'chat',title:`Cursor · ${title||id.slice(-8)}`};
    }
    try { return this.resolveChat(id) || {kind:'unavailable'}; }
    catch { return {kind:'unavailable'}; }
  }
  consolidate() {
    const unique=new Set();
    this.notices=this.notices.sort((a,b)=>b.time-a.time).filter(item=>{
      if(this.sourceRunning[sourceOf(item)]!==true) {
        if(unique.has(item.session_id))return false;
        unique.add(item.session_id);return true;
      }
      const chat=this.chat(item.session_id);
      if(['missing','other'].includes(chat.kind)||unique.has(item.session_id))return false;
      unique.add(item.session_id);
      item.title=cleanTitle(chat.title)||item.title;
      return true;
    });
  }
  reconcile(readState,now=this.clock()) {
    const before=JSON.stringify(this.notices);
    this.consolidate();
    if(readState) {
      // Stop 先于桌面侧栏刷新；保留同步窗口，陈旧或不可用状态不能清除提醒。
      this.notices=this.notices.filter(item=>sourceOf(item)==='cursor' || this.sourceRunning.codex!==true || now-item.time<3000 || readState.updatedAt<item.time || readState.unreadIds.has(item.session_id));
    }
    return before!==JSON.stringify(this.notices);
  }
  markRead(id) { this.notices=this.notices.filter(item=>item.id!==id); }
  // 用户明确点击提醒并确认跳转后，只清该 Cursor 对话；后台选中记录不能调用此方法。
  acknowledgeCursor(sessionId) {
    if(typeof sessionId!=='string'||!sessionId.startsWith('cursor:')||!this.notices.some(item=>item.session_id===sessionId))return false;
    this.notices=this.notices.filter(item=>item.session_id!==sessionId);
    return true;
  }
  // 持久化包含暂时隐藏的提醒；客户端运行状态只参与展示，不改变完成记录。
  exportState() { return {version:1,notices:this.notices,seen:[...this.seen]}; }
  setSourceRunning(source,running) {
    if(!['codex','cursor'].includes(source)||typeof running!=='boolean'||this.sourceRunning[source]===running)return false;
    this.sourceRunning[source]=running;
    if(!running)this.pauseSource(source);
    return true;
  }
  pauseSource(source) {
    for(const [id,session] of this.sessions)if(sourceOf(session)===source) {
      this.sessions.delete(id);this.tools.delete(id);
    }
    if(sourceOf(this.last)===source)this.last=[...this.sessions.values()].at(-1)||null;
  }
  pauseSession(id,turn='unknown') {
    const current=this.sessions.get(id);
    if(current&&turn!=='unknown'&&current.turn_id!=='unknown'&&current.turn_id!==turn)return;
    this.sessions.delete(id);this.tools.delete(id);
    if(this.last?.session_id===id)this.last=[...this.sessions.values()].at(-1)||null;
  }
  resetCodexApprovalObservations() {
    for(const [id,tools] of this.tools)if(!id.startsWith('cursor:'))tools.resetRuntime();
  }
  syncCodexApproval({sessionId,turnId,waiting,active,requests}) {
    const session=this.sessions.get(sessionId),tools=this.tools.get(sessionId);
    // 内部客户端状态只校准已有同轮任务，不创建任务、完成提醒、统计或成长。
    if(!session||!tools||tools.ended||sourceOf(session)!=='codex'||this.sourceRunning.codex!==true||
      turnId==='unknown'||session.turn_id!==turnId||tools.turnId!==turnId||typeof waiting!=='boolean'||typeof active!=='boolean'||!Array.isArray(requests))return false;
    if(!tools.syncApproval(waiting,active,requests))return false;
    const updated={...session,state:tools.pending.size?'approval':active?tools.state():'idle'};
    if(updated.state!=='approval')delete updated.approvalSince;
    this.sessions.set(sessionId,updated);
    if(this.last?.session_id===sessionId)this.last=updated;
    return true;
  }
  accept(raw) {
    const event = sanitizeEvent(raw);
    if (!event) return null;
    // 退出时迟到的完成仍保存为隐藏记录，其他事件不能复活已经清理的实时状态。
    const offline=this.sourceRunning[sourceOf(event)]===false;
    if(offline&&event.hook_event_name!=='Stop')return null;
    const chat=this.chat(event.session_id);
    if(['missing','other'].includes(chat.kind))return null;
    let state = STATES[event.hook_event_name];
    const key = `${event.session_id}:${event.turn_id}:${event.hook_event_name}`;
    const turnKey=`${event.session_id}:${event.turn_id}`;
    if(event.turn_id!=='unknown' && ['PreToolUse','PermissionRequest','PostToolUse'].includes(event.hook_event_name) && this.closedTurns.has(turnKey))return null;
    // 同一轮 Stop 只处理一次，避免重复通知和累计成长；缺少轮次 ID 时，
    // 仅忽略连续的完成状态，不能把该会话后续所有回复都当作重复事件。
    const previous = this.sessions.get(event.session_id);
    if (state === 'completed' && (event.turn_id !== 'unknown' ? this.seen.has(key) : previous?.state === 'completed' || (!previous && this.seen.has(key)))) return null;
    let tools=this.tools.get(event.session_id);
    const newTurn=tools && event.turn_id!=='unknown' && tools.turnId!=='unknown' && tools.turnId!==event.turn_id;
    if(event.hook_event_name==='UserPromptSubmit' || !tools || (newTurn&&tools.ended) || (tools.ended&&event.hook_event_name==='PreToolUse'&&event.turn_id==='unknown')) {
      // 已结束轮次的迟到工具事件不能被当作另一轮开始。
      if(event.turn_id!=='unknown' && ['PreToolUse','PermissionRequest','PostToolUse'].includes(event.hook_event_name) && this.seen.has(`${event.session_id}:${event.turn_id}:Stop`))return null;
      tools=new ToolActivity(event.turn_id);this.tools.set(event.session_id,tools);
    } else if(newTurn || (tools.ended&&['PreToolUse','PermissionRequest','PostToolUse'].includes(event.hook_event_name)))return null;
    if(['PreToolUse','PermissionRequest','PostToolUse'].includes(event.hook_event_name)) {
      state=tools.update(event);
      if(!state)return null;
    } else if(['Stop','Interrupt','SessionEnd'].includes(event.hook_event_name)) {
      tools.finish();this.closedTurns.add(turnKey);
      if(this.closedTurns.size>500)this.closedTurns.delete(this.closedTurns.values().next().value);
    }
    if (state === 'completed') {
      this.seen.add(key);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    }
    this.last = { ...event, title:cleanTitle(chat.title)||this.sessions.get(event.session_id)?.title||fallbackTitle(event.session_id), state, time:this.clock() };
    if(state==='approval')this.last.approvalSince=previous?.state==='approval'?(previous.approvalSince??previous.time):this.last.time;
    // 用户继续这个聊天，说明已经回到它；旧提醒不再跨轮次积累。
    if(event.hook_event_name==='UserPromptSubmit')this.notices=this.notices.filter(item=>item.session_id!==event.session_id);
    if (state==='completed') {
      this.notices=this.notices.filter(item=>item.session_id!==event.session_id);
      this.notices.unshift({...event,id:randomUUID(),title:this.last.title,time:this.last.time});
      this.notices=this.notices.slice(0,100);
    }
    // 重新插入使 Map 按最近更新时间排序，聚合时可选出最近仍在工作的会话。
    this.sessions.delete(event.session_id);
    if(!offline)this.sessions.set(event.session_id, this.last);
    if (this.sessions.size > 100) {
      const oldest=this.sessions.keys().next().value;this.sessions.delete(oldest);this.tools.delete(oldest);
    }
    this.count++;
    const accepted=this.last;
    if(offline)this.last=[...this.sessions.values()].at(-1)||null;
    return accepted;
  }
  snapshot() {
    // 客户端退出只过滤展示快照；重开后恢复完成记录，执行中状态等待新的 Hook。
    // 多聊天并行时：等待批准优先，其次是仍在工作的会话，最后才是最近事件。
    // 某个聊天回复结束，不能盖过另一个聊天尚未处理的批准请求。
    const sessions = [...this.sessions.values()].filter(item=>this.sourceRunning[sourceOf(item)]!==false);
    const notices=this.notices.filter(item=>this.sourceRunning[sourceOf(item)]!==false);
    const last=this.last&&this.sourceRunning[sourceOf(this.last)]!==false?this.last:null;
    const pending = sessions.filter(s => s.state === 'approval').length;
    const working = sessions.filter(s => ['working','thinking'].includes(s.state)).length;
    const active = sessions.filter(s => ['working','thinking'].includes(s.state)).at(-1);
    return { state: pending ? 'approval' : active?.state || last?.state || 'idle', pending, working, count: this.count, last,
      sessions:sessions.reverse(),notices,unread:notices.length };
  }
}
module.exports = { Activity, sanitizeEvent };
