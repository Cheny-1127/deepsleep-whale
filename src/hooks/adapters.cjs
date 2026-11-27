'use strict';
const { CODEX_EVENTS, CURSOR_EVENTS, CLAUDE_EVENTS, SOURCES, SOURCE_NAMES, sourceOf, eventName } = require('../shared/hook-events.cjs');
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
// 会话、轮次和工具标识之外的内容（提示词、工具输入输出、路径）一律不转发。
function adaptClaude(input) {
  if(!input||!Object.hasOwn(CLAUDE_EVENTS,input.hook_event_name))return null;
  const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,150}$/.test(value);
  if(!valid(input.session_id))return null;
  const raw=input.hook_event_name,tool=['PreToolUse','PermissionRequest','PostToolUse','PostToolUseFailure'].includes(raw);
  // 子代理与主会话共用 session_id：工具和权限检查归入主会话，其余事件不能结束或重开主会话。
  const subagent=input.agent_id!==undefined;
  if(subagent&&!tool)return null;
  let name=CLAUDE_EVENTS[raw];
  if(raw==='PostToolUseFailure'&&input.is_interrupt===true&&!subagent)name='Interrupt';
  const event={source:'claude',raw_event:raw,hook_event_name:name,session_id:`claude:${input.session_id}`,turn_id:valid(input.prompt_id)?input.prompt_id:'unknown'};
  if(tool&&name!=='Interrupt')for(const key of ['tool_use_id','tool_name'])if(valid(input[key]))event[key]=input[key];
  return event;
}
const NOTES={cursor:{stop:'仅 completed 计为完成；aborted / error 记为停止'},claude:{StopFailure:'接口报错结束本轮，记为停止',PostToolUseFailure:'工具失败；被用户中断时记为停止'}};
const CAPABILITIES={
  codex:'支持聊天名称、原对话跳转和已读同步。',
  cursor:'支持开始、工具返回、完成与停止提醒；支持读取本机聊天标题，读取不到时显示短 ID；点击提醒成功跳转、手动标为已读或继续发送消息后，清除对应完成提醒。',
  claude:'支持开始、工具调用、权限检查与完成提醒，桌面端 Code 页和命令行均可触发；显示桌面端会话标题，读取不到时显示短 ID；在桌面端进入该会话、点击提醒跳转或继续提问后清除完成提醒，命令行和 IDE 会话点击后标为已读。直接中断回复没有对应事件，状态在下次提问或会话结束时清理。'
};
function adapterInfo() {
  return SOURCES.map(source=>({id:source,name:SOURCE_NAMES[source],
    mappings:(source==='codex'?CODEX_EVENTS.map(name=>[name,name]):Object.entries(source==='cursor'?CURSOR_EVENTS:CLAUDE_EVENTS))
      .map(([event,normalized])=>({event,normalized,label:LABELS[normalized],note:NOTES[source]?.[event]||''})),
    capabilities:CAPABILITIES[source]}));
}
module.exports={eventName,LABELS,CODEX_EVENTS,CURSOR_EVENTS,CLAUDE_EVENTS,SOURCES,sourceOf,adaptCursor,adaptClaude,adapterInfo};
