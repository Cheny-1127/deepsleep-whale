'use strict';
// 每轮单独记录调用，不能用另一个工具的返回清除仍在检查权限的调用。
class ToolActivity {
  constructor(turnId) {
    this.turnId=turnId;this.ended=false;this.active=new Map();this.pending=new Map();this.finished=new Set();this.finishedNames=new Set();this.runtimeRequests=[];
  }
  state() { return this.pending.size ? 'approval' : this.active.size ? 'working' : 'thinking'; }
  update(event) {
    const {hook_event_name:type,tool_use_id:id,tool_name:name}=event;
    const key=id || `legacy:${name||'unknown'}`;
    if(type==='PreToolUse') {
      if(id&&this.finished.has(id))return null;
      // 兼容旧发送端没有任何工具标识的顺序事件。
      if(!id&&!name) {this.pending.clear();this.active.clear();}
      this.active.set(key,{name});
    } else if(type==='PermissionRequest') {
      if(id&&this.finished.has(id))return null;
      if(id&&!this.active.has(id))this.active.set(id,{name});
      const candidates=new Set([...this.active].filter(([,call])=>!name||call.name===name).map(([callId])=>callId));
      if(!id&&name&&!candidates.size&&this.finishedNames.has(name))return null;
      // PermissionRequest 官方输入未保证调用 ID；同名并行时记录候选，宁可保留也不误清其他检查。
      const request={id,name,candidates,runtimeBound:new Set(),runtimeBaseline:new Set(this.runtimeRequests.map(r=>r.id))};
      this.bindRuntime(request,this.runtimeRequests);
      this.pending.set(id||`name:${name||'unknown'}`,request);
    } else if(type==='PostToolUse') {
      if(id&&this.finished.has(id))return null;
      let returned=id;
      if(!returned) {
        const candidates=[...this.active].filter(([,call])=>!name||call.name===name);
        if(candidates.length===1)returned=candidates[0][0];
      }
      if(returned)this.active.delete(returned);
      for(const [pendingId,request] of this.pending) {
        if(request.id) {
          if(request.id===id)this.pending.delete(pendingId);
        } else if(request.candidates.size) {
          if(returned)request.candidates.delete(returned);
          if(!request.candidates.size)this.pending.delete(pendingId);
        } else if(request.name ? request.name===name : !id&&!name) {
          this.pending.delete(pendingId);
        }
      }
      if(id) {this.finished.add(id);if(this.finished.size>500)this.finished.delete(this.finished.values().next().value);}
      if(name)this.finishedNames.add(name);
    }
    return this.state();
  }
  bindRuntime(request,requests) {
    for(const item of requests) {
      if(request.id?request.id===item.itemId:request.candidates.has(item.itemId)&&
        (request.candidates.size===1||!request.runtimeBaseline.has(item.id)))request.runtimeBound.add(item.id);
    }
  }
  resetRuntime() {this.runtimeRequests=[];for(const request of this.pending.values())request.runtimeBound.clear();}
  // 必须先看见对应请求，再确认它被处理；旧请求的消失不能清除同轮刚到达的新申请。
  syncApproval(waiting,active,requests) {
    this.runtimeRequests=requests.filter(r=>r&&typeof r.id==='string'&&typeof r.itemId==='string');
    let changed=false;
    for(const [key,request] of this.pending) {
      this.bindRuntime(request,this.runtimeRequests);
      if(!waiting&&request.runtimeBound.size) {this.pending.delete(key);changed=true;}
    }
    if(changed&&!active&&!this.pending.size)this.active.clear();
    return changed;
  }
  finish() { this.ended=true;this.runtimeRequests=[];this.active.clear();this.pending.clear(); }
}
module.exports={ToolActivity};
