'use strict';
const {prepareConfigChange}=require('./config-change.cjs');
// 必须是本项目命令且匹配全部工具；收窄过 matcher 的条目不能算完整接入。
function hasClaudeHook(groups,command) {
  return Array.isArray(groups)&&groups.some(group=>(group?.matcher===undefined||group.matcher===''||group.matcher==='*')&&
    Array.isArray(group.hooks)&&group.hooks.some(hook=>hook?.type==='command'&&hook.command===command));
}
function prepareClaudeChange(adapter) {
  const expected=JSON.parse(adapter.config);
  return prepareConfigChange({file:adapter.target,label:'Claude Code',merge(current,missing) {
    const next=missing?{}:current;
    if(!next||typeof next!=='object'||Array.isArray(next)||(next.hooks!==undefined&&(!next.hooks||typeof next.hooks!=='object'||Array.isArray(next.hooks))))throw new Error('Claude Code 配置格式无法识别，未修改文件');
    // 只追加本项目缺失的条目，env、权限等其他设置原样保留。
    const hooks={...next.hooks};
    for(const [event,groups] of Object.entries(expected.hooks)) {
      const existing=hooks[event]||[];
      if(!Array.isArray(existing))throw new Error('Claude Code 事件配置格式无法识别，未修改文件');
      if(!hasClaudeHook(existing,groups[0].hooks[0].command))hooks[event]=[...existing,...groups];
    }
    return {...next,hooks};
  }});
}
module.exports={prepareClaudeChange,hasClaudeHook};
