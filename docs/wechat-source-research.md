# 微信网关源码调查与首版边界

调查日期：2026-10-17。实现目标：微信 → deepsleep 授权/任务管理 → 本机 Codex 或 Cursor CLI → 微信；模型认证留在客户自己的客户端。

## 已核实来源

- [Hermes 固定源码](https://github.com/NousResearch/hermes-agent/blob/868b9f244f5aa3ad238e494048046fe4f29c28ba/plugins/platforms/weixin/adapter.py)：通过远端 ref 与本地浅克隆 HEAD 核实提交。当前路径已从旧教程中的 `gateway/platforms/weixin.py` 迁移到插件目录。MIT 许可见本仓库 `licenses/hermes-agent-MIT.txt`。
- [Hermes 微信配置说明](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin)：扫码建立机器人身份，私聊优先；不能理解为接管扫码人的全部微信聊天。
- [Codex 公共 app-server](https://learn.chatgpt.com/docs/app-server)：本机 `0.163.0-alpha.10.2` 生成的 JSON Schema 交叉核实初始化、thread/start、thread/resume、turn/start、turn/interrupt、命令/文件审批结构。
- [Cursor 无头运行](https://cursor.com/docs/cli/headless) 与 [输出格式](https://cursor.com/docs/cli/reference/output-format)：`--print --output-format json`、Ask 模式和 `--resume`；当前机器没有 Cursor CLI，使用本地协议夹具验证调用形状。

## 微信协议映射

| 行为 | Hermes 实际位置 | 本项目处理 |
|---|---|---|
| 常量及认证请求头 | adapter.py 52、145–154 行 | iLink App ID `bot`，channel `2.2.0`，client version `131584`；Bearer token、AuthorizationType、随机 UIN |
| 二维码及登录确认 | 576–648 行 | 请求 `get_bot_qrcode?bot_type=3`，编码 `qrcode_img_content`；用独立 `qrcode` 轮询状态，确认后保存机器人 ID、token、base URL、扫码用户 ID |
| 游标与长轮询 | `_get_updates`、`_poll_loop` | POST `getupdates`，保存 `get_updates_buf`；超时继续轮询，网络失败退避，`-14` 停止并提示重扫 |
| 文本回复 | 299–316、970–1053 行 | POST `sendmessage`，`message_type=2`，text item，带最新 context token 和稳定 client ID；按 Unicode 分段 |
| 会话令牌 | `ContextTokenStore`、890–892 行 | 按账号/发送者保存最新 context token；消息去重与游标持久化后才执行 |

服务端 base URL 与扫码跳转仅接受微信 HTTPS 域名；HTTP 重定向不会携带认证自动跟随。二维码由本机 `qrcode` 库生成。未移植 Hermes 的附件、语音、CDN、长期记忆、模型管理及群聊能力。发送遇到 `-14` 或 `-2` 配合 `prepare failed` / `unknown error` 时，按 Hermes 的做法沿用相同 client ID 去掉旧 context token 重发一次；仍失败则暂存待投递结果。限流及网络失败采用退避，不重跑模型任务。

## 模块与隔离

- `src/channels/wechat-api.cjs` 仅处理 iLink 协议；`wechat-store.cjs` 使用 Electron safeStorage 加密整个微信状态，拒绝 `basic_text`；`wechat-gateway.cjs` 管理联系人授权、命令、任务、审批和投递。
- `src/agents/local-agent.cjs` 通过独立子进程使用客户端已有认证，不读取/复制密钥，不写 provider 配置。Codex 支持已有 CODEX_HOME / profile；Cursor 使用 Ask 模式。没有 shell 字符串拼接或自动 `--force`。
- Codex 支持所选项目内修改代码；每轮显式指定 workspaceWrite、仅所选目录可写、默认无网络及额外临时目录写入权限，额外操作仍需按次审批。续接传 `excludeTurns:true`，保留会话上下文但不回传整段历史。受控失败阶段与错误码由 `agent-error.cjs` 提供，不直接转发或存储原始 RPC/stderr。
- 微信连接独立于客户端与项目；默认 Codex 自动发现，多个客户端按稳定 ID、勾选启用与列表优先级管理。选择记录按机器人/发送者隔离；每个排队任务固定项目真实路径、实例配置与会话 ID。执行全局串行，最多 5 个活动/待处理任务。停止只终止自己启动的进程组，不终止用户桌面客户端，也不等待目录查询结束。
- `src/agents/codex-catalog.cjs` 使用公共 thread/list（显式包含 cli/vscode/appServer 来源及所有 provider）与 thread/read 元信息接口，支持分页；仅投影 ID、名称、目录与状态，不转发 preview 或 turns。/projects 从最近会话提取项目；新项目可直接使用绝对路径。/chat 选择已有 Codex 对话，/new 为下一条任务新建持久会话。优先级用于新对话默认选择，已有对话固定实例；修改身份配置会清除相关续接 ID，失败不切换其他实例重跑。
- 联系人未授权时不执行、不回显历史任务。审批绑定发送者、当前任务和一次性随机 ID；缺少可审查内容、整会话文件授权及额外权限请求保守拒绝，超时默认拒绝。交互式问答/自定义工具暂不支持。
- 接收消息先落去重记录，重启将原来的执行/排队状态标记中断。结果采用持久待投递队列；发送失败不触发模型任务重跑。无法安全保存状态时停止连接与任务。网络 ACK 丢失时无法保证第三方恰好投递一次，只复用原 client ID 重发。
- 桌面配置 IPC 仅接受小屋主 frame；快照不包含机器人 token、context token、任务正文/结果或二维码轮询 token。二维码图片仅用于当前登录。既有桌面 IPC 观察器保持只读职责，微信任务独立显示在接入页。已有桌面对话由独立的微信转发适配器通过原 owner 投递，见下文最新协议调查。

## 验证与仍需用户实测的部分

单元测试验证协议、URL 约束、安全存储调用、陌生联系人、去重、会话续接、重启不重跑、独立投递重试、审批关联、取消、登录失效和保存失败。CLI 夹具模拟真实子进程与 JSON-RPC / JSON 输出；Electron 测试模拟 iLink 与加密后端，验证配置、扫码二维码、收消息到 Codex 夹具结果的完整闭环。

首轮本机真实 Codex 在临时 CODEX_HOME 与项目中完成 initialize、ephemeral thread/start，返回 `approvalPolicy=on-request`、`approvalsReviewer=user`、`sandbox=readOnly / networkAccess=false`；当时未发送 turn/start 或调用模型。

用户明确要求继续当前会话修改代码后，默认 Codex 调整为上述项目写入策略。新增验证使用私有临时配置/会话副本和临时项目：实际 Codex 完成一次最小模型回复，并完成创建 `smoke-check.txt`、精确内容 `OK\n` 的真实文件修改。当前长会话副本的续接回包从 1,705,999 字节降为 3,487 字节，ID 不变；该续接检查拦截了 turn/start。大于 2 MB 历史的夹具能复现旧代码传输超限，修复后通过；真实副本在这次检查中未超过 2 MB，因此不能据此断言用户旧失败就是传输超限。旧网关没有保存原始失败原因，无法恢复。

多实例调整后，真实本机 CLI 的 thread/list 返回 20 条桌面对话（含当前聊天），thread/read 能读取同一聊天；仅输出数量和匹配结果。临时 CODEX_HOME 中，一个进程创建、命名且不调用模型的持久空对话可被另一个进程按 ID 读取，但未进入 thread/list；注入无模型调用的测试历史后仍未进入列表，因此没有声称空对话或微信新对话的桌面展示已通过。实际桌面刷新与完成一轮任务后的展示需继续验收。独立 app-server 的运行状态检查也不构成跨桌面进程的原子锁，同一对话应等待桌面轮次结束后再从微信续接。

用户已经通过真实微信选中本机对话并发起任务，但旧版执行失败；尚未验证修复后的真实微信与当前桌面对话端到端修改。临时项目的真实模型与写入验证仅覆盖本机现有 provider；没有真实 Cursor CLI、官方订阅与各种中转配置的完整兼容性证据。重启后在微信用 `/projects` 或 `/chats` 选择工作内容，再验证任务、继续追问、`/status`、`/stop`。Finder 启动可能缺少终端 PATH/代理环境，必要时展开高级选项指定二进制、配置目录，或从具备相应环境的终端启动。该实现不承诺唤醒睡眠电脑；Cursor 编辑器已有聊天暂不支持接续。

## 桌面对话原文转发（2026-10-17 最新调整）

此前通过独立 app-server 的 thread/list/read 能看到共享历史，不能证明可以接管桌面持有的聊天。用户 23:31 的重试已明确在 thread/resume 阶段收到 RPC -32600 并被本地错误分类为 busy；不将此归因于认证或模型权限。实现改为直接请求桌面 owner，不再对 /chat 选择的已有会话调用 thread/resume。

本机安装包 `/Applications/ChatGPT.app/Contents/Resources/app.asar` 中 `.vite/build/src-DsLVGakC.js`、`main-CLu1A25j.js` 定义了桌面内部 IPC。只读实机验证完成 initialize、thread-owner-discovery 和指定 owner 的 thread-stream-following-changed；收到当前聊天 version=11、canonical history 的快照，owner 与发现结果一致。仅输出字段名称、状态、ID 和文本长度，未发送模型任务。

| 用途 | 消息与版本 | 实现边界 |
|---|---|---|
| 连接 | initialize / 0 | 连接已有的当前用户私有 Unix socket，不创建服务、不改客户端配置 |
| 发现 | thread-owner-discovery / 1 | hostId=local，固定 handledByClientId；无 owner 不切换 CLI |
| 订阅 | thread-stream-following-changed / 1 | 只订阅所选聊天和 owner；退出取消订阅 |
| 投递 | thread-follower-start-turn / 2 | request 只含 threadId、原文 input 与唯一 clientUserMessageId；context.inheritThreadSettings=true，不传权限/模型覆盖 |
| 回复 | thread-stream-state-changed / 11 | 校验 owner、host、conversation、revision；按消息 ID/turn ID 关联，完成后只返回最终助手文本 |
| 取消 | thread-follower-interrupt-turn / 4 | expectedTurnId 必须为本次消息确认的轮次；投递前取消不干扰旧轮次 |
| 审批 | thread-follower-command-approval-decision、thread-follower-file-approval-decision / 1 | 只响应本轮仍存在且经微信用户明确决定的请求，不做会话授权 |

公开 [app-server 文档](https://learn.chatgpt.com/docs/app-server) 不等于桌面内部 IPC 的兼容承诺。该实现针对上述已安装版本进行协议检查；后续桌面升级可能需要适配。`/new` 仍是 CLI 创建路径，并记录 transport 防止追问时误切到桌面；这里没有声称已经支持通过桌面创建新聊天。
