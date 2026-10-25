'use strict';
const {execFile}=require('node:child_process');
const path=require('node:path');
const {chatUrl}=require('./chat-metadata.cjs');

function scrollLatest({sessionId,title}, {platform=process.platform,execute=execFile}={}) {
  if(platform!=='darwin')return Promise.reject(Error('已打开聊天；当前平台暂不支持自动定位，请在 Codex 中滚动到最新内容。提醒已保留。'));
  return new Promise((resolve,reject)=>{
    // 静态脚本和独立参数避免把聊天标题当作代码；不使用 shell 或全局键盘事件。
    execute('/usr/bin/osascript',['-l','JavaScript',path.join(__dirname,'codex-scroll-latest.js'),sessionId,title||''],
      {encoding:'utf8',timeout:6000,maxBuffer:4096},(error,stdout)=>{
        if(error){reject(Error('已打开聊天，但无法操作 Codex 的滚动入口；请检查鲸鱼娘的辅助功能与自动化权限。提醒已保留。'));return;}
        let result;try{result=JSON.parse(stdout);}catch{}
        if(result?.status==='scrolled'){resolve();return;}
        const message=result?.status==='permission-required'
          ?'已打开聊天；自动定位需要在 macOS「隐私与安全性 → 辅助功能」中允许鲸鱼娘。提醒已保留。'
          :result?.status==='focus-changed'?'定位已停止：你切换了前台窗口。提醒已保留。'
          :'已打开聊天，但未能确认目标聊天或找到唯一的滚动入口；请在 Codex 中滚动到最新内容。提醒已保留。';
        reject(Error(message));
      });
  });
}

function createCodexChatOpener({openExternal,locateLatest=scrollLatest}={}) {
  let opening=false;
  return {
    async open(sessionId,{title=''}={}) {
      const url=chatUrl(sessionId);
      if(!url)throw Error('无法定位这个 Codex 聊天');
      // 定位包含等待界面更新；串行保护避免连点时把上一聊天的定位应用到下一聊天。
      if(opening)throw Error('正在打开聊天，请稍后重试。提醒已保留。');
      opening=true;
      try {
        await openExternal(url);
        await locateLatest({sessionId,title});
      } finally {opening=false;}
    }
  };
}
module.exports={createCodexChatOpener,scrollLatest};
