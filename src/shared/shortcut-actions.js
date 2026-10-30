(function(root) {
  'use strict';
  // 连击动作白名单，主进程和页面共用；双击、三连击分别绑定其中一个动作。
  const actions=Object.freeze({panel:'打开小屋',pat:'摸摸头',feed:'喂饭',happy:'开心',angry:'生气','store-pet':'收纳到边缘',none:'不启用（保留默认互动）'});
  if(typeof module==='object'&&module.exports)module.exports=actions;
  else root.SHORTCUT_ACTIONS=actions;
})(globalThis);
