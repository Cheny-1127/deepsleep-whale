'use strict';
const STAGES={client:'客户端执行',desktop:'桌面对话转发',spawn:'启动客户端',initialize:'初始化客户端','thread/read':'读取对话','thread/resume':'续接对话','thread/start':'新建对话','turn/start':'启动任务',turn:'执行任务',cursor:'Cursor 执行'};
const REASONS={
  UNKNOWN:'客户端执行失败，尚未取得可公开的错误原因',
  BINARY:'未找到可用的客户端，请检查安装和可执行文件路径',
  SPAWN:'无法启动客户端，请检查可执行文件和项目目录',
  CONNECTION:'客户端连接已关闭',EXIT:'客户端提前退出',
  RPC_TIMEOUT:'客户端请求超时',RPC_REJECTED:'Codex 拒绝了本次请求',
  AUTH:'模型服务认证被拒绝或已失效',MODEL:'所选模型不可用或当前服务不支持',
  CONTEXT:'会话上下文超出模型限制',RATE_LIMIT:'模型服务限流或额度不足',
  HISTORY:'会话历史无法加载，请检查本机 Codex 会话完整性',UNSUPPORTED:'客户端不支持本次请求或所需接口',
  PROJECT:'会话与所选项目不一致，请重新选择对话',BUSY:'该对话正在运行，请等待结束后再继续',
  THREAD_ID:'Codex 没有返回会话 ID',THREAD_CHANGED:'Codex 返回了不同的会话，已停止执行',
  OUTPUT_LIMIT:'客户端单条协议消息超出 2 MB 限制',REPLY_LIMIT:'客户端回复超出长度限制，请缩小任务范围',
  INTERACTION:'客户端交互失败',CURSOR_RESULT:'Cursor 未返回可识别的结果，请检查 CLI 版本',
  DESKTOP_UNAVAILABLE:'无法连接持有该会话的 Codex 桌面端，请打开该对话并确认配置目录一致',
  DESKTOP_PROTOCOL:'桌面会话连接或协议状态不匹配，已停止转发，请检查客户端版本并重新选择对话',
  DELIVERY_UNKNOWN:'未能确认本次桌面消息的执行结果，请先到原会话查看；不会自动重发',
  TURN_FAILED:'Codex 未完成任务',TIMEOUT:'任务超过十分钟，已停止',CANCELLED:'任务已停止'
};
class AgentError extends Error {
  constructor(code,stage='client',rpcCode) {
    super(REASONS[code]||REASONS.UNKNOWN);this.name='AgentError';
    this.code=Object.hasOwn(REASONS,code)?code:'UNKNOWN';this.stage=Object.hasOwn(STAGES,stage)?stage:'client';
    if(Number.isSafeInteger(rpcCode))this.rpcCode=rpcCode;
  }
}
function rpcFailure(error,stage) {
  // 原始服务错误可能包含 token、URL 或请求内容，只匹配类别，不保存或转发原文。
  const text=String(error?.message||'').slice(0,4000)+' '+(typeof error?.codexErrorInfo==='string'?error.codexErrorInfo:Object.keys(error?.codexErrorInfo||{}).join(' '));
  let code='RPC_REJECTED';
  if(/unauthoriz|authentication|invalid.api.key|\b401\b/i.test(text))code='AUTH';
  else if(/context.window|context.length|contextWindowExceeded|too many tokens/i.test(text))code='CONTEXT';
  else if(/rate.limit|quota|usageLimit|\b429\b/i.test(text))code='RATE_LIMIT';
  else if(/model.*(?:not found|not supported|unavailable|does not exist)/i.test(text))code='MODEL';
  else if(/history.*(?:lineage|rollout|missing|invalid)|missing source rollout/i.test(text))code='HISTORY';
  else if(/unsupported|experimentalApi|method not found/i.test(text))code='UNSUPPORTED';
  else if(/thread.*(?:active|busy|in progress)/i.test(text))code='BUSY';
  return new AgentError(code,stage,error?.code);
}
function failureDetails(error) {
  const safe=error instanceof AgentError?error:new AgentError('UNKNOWN');
  return {code:safe.code,stage:safe.stage,...(safe.rpcCode===undefined?{}:{rpcCode:safe.rpcCode}),
    message:`${STAGES[safe.stage]}失败：${REASONS[safe.code]||REASONS.UNKNOWN}${safe.rpcCode===undefined?'':`（RPC ${safe.rpcCode}）`}`};
}
module.exports={AgentError,rpcFailure,failureDetails};
