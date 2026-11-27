'use strict';
const {prepareConfigChange}=require('./config-change.cjs');
function prepareCursorChange(adapter) {
  const expected=JSON.parse(adapter.config);
  return prepareConfigChange({file:adapter.target,label:'Cursor',merge(current,missing) {
    const next=missing?{version:1,hooks:{}}:current;
    if(!next||Array.isArray(next)||next.version!==1||(next.hooks!==undefined&&(!next.hooks||typeof next.hooks!=='object'||Array.isArray(next.hooks))))throw new Error('Cursor 配置格式无法识别，未修改文件');
    next.hooks={...next.hooks};
    for(const [event,definitions] of Object.entries(expected.hooks)) {
      const hooks=next.hooks[event]||[];
      if(!Array.isArray(hooks))throw new Error('Cursor 事件配置格式无法识别，未修改文件');
      if(!hooks.some(hook=>hook?.command===definitions[0].command))next.hooks[event]=[...hooks,...definitions];
    }
    return next;
  }});
}
module.exports={prepareCursorChange};
