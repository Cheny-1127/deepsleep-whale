(function(root) {
  'use strict';
  // 三连击动作白名单，主进程和页面共用；页面不能提交名单以外的动作。
  const actions=Object.freeze({panel:'打开小屋',pat:'摸摸头',feed:'喂饭',happy:'开心',angry:'生气',none:'不启用（保留默认互动）'});
  if(typeof module==='object'&&module.exports)module.exports=actions;
  else root.SHORTCUT_ACTIONS=actions;
})(globalThis);
