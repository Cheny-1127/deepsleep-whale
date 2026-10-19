# 邮件本地加密缓存

**Goal:** 最近邮件列表和纯文本正文自动同步至本地，重启、断网或暂停后仍能查看已缓存内容。
**Why planning is required:** 邮件正文开始持久化，涉及隐私、账号隔离和异步同步期间的数据一致性。
**Acceptance:** 沿用系统安全存储，不写明文、不暴露正文到共享快照；兼容已有配置；按数量限制清理旧缓存；切换账号、服务器及 UIDVALIDITY 时不复用旧正文；失败同步不清空已有缓存；取消后的网络响应不落盘。

### Outcome 1: 本地缓存与同步
- Work: 在现有加密 mail.enc 记录中增加可选缓存，保持旧版配置可读；同步最近列表并补齐缺失正文，同步不重复下载已有正文，真实 IMAP 批量补齐共用一次只读连接。
- Risks/open questions: 单封邮件仍受现有 5 MB 限制；未下载成功的正文允许后续同步或点击重试，已缓存邮件支持离线读取。
- Verify: `node --test test/imap-mail.test.cjs test/imap-wire.test.cjs`

### Outcome 2: 缓存使用与边界
- Work: 缓存优先读取、恢复列表与上次同步时间；暂停后仍可读取缓存；界面提示本地缓存数量，更新说明与现有界面检查。
- Verify: `node --test test/mail-view.test.cjs test/imap-mail.test.cjs test/imap-wire.test.cjs`、`npm run check`、`git diff --check`。真实 Electron 界面检查此前受启动及审批故障阻塞，若未恢复，明确报告未验证。

### Outcome 3: 最终检查
- Work: 按授权范围只读复查正文加密、缓存隔离、配置兼容、缓存裁剪和延迟响应处理；不访问真实邮箱、不提交或推送。
- Verify: 将最终结论对应至定向测试结果和实际修改。

### Completion evidence
- 完成：沿用 `mail.enc` 系统加密记录，自动补齐缺失正文；启动恢复缓存；暂停/断网保留缓存；按数量裁剪；账号、服务器和 UIDVALIDITY 隔离；快照仅含列表与缓存计数。
- 只读复核范围：`src/channels/imap-mail.cjs`、`src/channels/mail-store.cjs`、邮箱 IPC 调用方、`src/ui/mail-view.mjs`、页面提示与三份邮箱测试。复核后修正重新连接写入失败时不应中断现有状态的问题，并禁止手动读取期间重连以避免并发覆盖。
- 21 项定向测试通过，含真实本地 TLS/IMAP 只读会话、批量连接复用、加密后重启恢复、离线/暂停读取、不重复下载、失败重试、配置兼容、缓存裁剪与隔离、取消晚返回。测试不访问实际邮箱。
- 未完成的运行时验证：真实 Electron 界面启动此前被自动审批服务 404 故障阻塞；本次未再次启动，也未操作真实邮箱或用户加密数据。
