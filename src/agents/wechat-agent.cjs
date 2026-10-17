'use strict';
const {startLocalAgent}=require('./local-agent.cjs');
const {startDesktopAgent}=require('./codex-desktop.cjs');
function startWechatAgent(options) {
  // 已选桌面对话交给原 owner；CLI 新建会话继续使用本地执行路径，不自动切换接管方式。
  return options.settings.backend==='codex'&&options.session&&options.transport!=='local'
    ?startDesktopAgent(options):startLocalAgent(options);
}
module.exports={startWechatAgent};
