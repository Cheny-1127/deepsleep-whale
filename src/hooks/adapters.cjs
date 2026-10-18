'use strict';
const { CODEX_EVENTS, CURSOR_EVENTS, SOURCES, sourceOf, eventName } = require('../shared/hook-events.cjs');
const LABELS={UserPromptSubmit:'开始思考',PreToolUse:'调用工具',PermissionRequest:'权限检查',PostToolUse:'工具返回，继续思考',Stop:'本轮完成',Interrupt:'已停止',SessionEnd:'会话结束'};
// 适配器只转换客户端事件；任务聚合、接收偏好和信任判断由各自模块处理。
function adaptCursor(input) {
  if(!input||!Object.hasOwn(CURSOR_EVENTS,input.hook_event_name))return null;
  const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,150}$/.test(value);
  const id=input.conversation_id||input.session_id;
  const turn=input.generation_id||(input.hook_event_name==='sessionEnd'?'unknown':null);
  if(!valid(id)||!valid(turn))return null;
  let name=CURSOR_EVENTS[input.hook_event_name];
  if(input.hook_event_name==='stop') {
    if(input.status==='aborted'||input.status==='error')name='Interrupt';
    else if(input.status!=='completed')return null;
  }
  const event={source:'cursor',raw_event:input.hook_event_name,hook_event_name:name,session_id:`cursor:${id}`,turn_id:turn};
  if(name==='PostToolUse')for(const key of ['tool_use_id','tool_name'])if(valid(input[key]))event[key]=input[key];
  return event;
}
function adapterInfo() {
  return SOURCES.map(source=>({id:source,name:source==='codex'?'Codex':'Cursor',
    mappings:(source==='codex'?CODEX_EVENTS.map(name=>[name,name]):Object.entries(CURSOR_EVENTS))
      .map(([event,normalized])=>({event,normalized,label:LABELS[normalized],note:source==='cursor'&&event==='stop'?'仅 completed 计为完成；aborted / error 记为停止':''})),
    capabilities:source==='codex'?'支持聊天名称、原对话跳转和已读同步。':'支持开始、工具返回、完成与停止提醒；支持读取本机聊天标题，读取不到时显示短 ID；点击提醒成功跳转、手动标为已读或继续发送消息后，清除对应完成提醒。'}));
}
module.exports={eventName,LABELS,CODEX_EVENTS,CURSOR_EVENTS,SOURCES,sourceOf,adaptCursor,adapterInfo};
