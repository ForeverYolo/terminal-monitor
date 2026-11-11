# CLI 状态逻辑简化检查（2026-11-09）

本页保留早期重构和回归记录。当前代码仅使用 `cliState`，旧协议转换及 API 派生兼容字段已移除。

## 改动

- `CliTracker.screen()` 一次完成进程生命周期检查、屏幕识别和 hooks 校正。删除独立 `reconcile()` 调用路径，同一屏幕不再解析两次。
- client、手机操作栏和 supervisor 使用统一状态，移除内部维护的旧 Claude 状态副本。后续清理已移除旧客户端消息和 API 派生兼容字段。
- 删除未参与运行的 215 行旧正则检测器，将原 ANSI 清理函数原样提取到 17 行 `terminal-text.js`。旧检测器的测试由当前屏幕检测、终端文本和原有启动参数校验覆盖。
- 卡片和管理页共用 `stateText()`，保留紫色圆角标签、状态/应用/来源顺序及独立 shell 输出预览。
- 删除手机操作栏的重复分支和未使用的旧状态配色规则。
- 修复无关 Notification 在返回拒绝前修改内部进程绑定的问题；无关通知现在不改变绑定或状态。

未修改 CLI 界面识别规则、状态种类、事件绑定保护、终端字节转发、快照协议或生产配置。实现提交 `69723a9` 净减少 262 行（含测试和文档），不以删行数替代行为验证。

## 验证

- 51 项 CLI 身份、负样本、状态切换、过期会话和进程退出检查通过。
- 真实 Screen → command hook → Unix socket 的绑定、隐私、退出和作用域配置检查通过。
- Codex、Claude 各一条隔离的无工具任务，实际 hooks 工作到空闲切换通过；Claude 彩色输出通过。
- 手机操作栏改动前后对 11 种状态逐项输出一致。
- `test:all` 的 unit、protocol、screen、browser 四组通过，包括新旧状态消息兼容、手机输入、刷新和 shell 预览；`git diff --check` 通过。

`test:all` **未全绿**：最后的 `native-codex-browser` 在第二浏览器滚轮翻页断言处超时。简化前 `902b2a7` 在独立 worktree 下同一处复现；只检查可见画面、等待鼠标模式和显式聚焦的诊断也未解决，诊断改动已撤回。根因未确定，没有将此项记为通过，也没有修改翻页实现或放宽断言。

诊断日志分别为 `/tmp/terminal-monitor-simplify-all.log`、`/tmp/terminal-monitor-simplify-codex-baseline.log`；真实 hooks 记录为 `/tmp/terminal-monitor-simplify-live.log`。测试不操作生产 Screen。

## 状态检查优化前的原始版本对照

针对“是否在本轮状态检查优化前就能复现”的追问，另在独立 worktree 检出原始 `7cd9b52`，不修改测试或实现源码，复用相同的现有依赖和浏览器，直接运行其 `test/test-native-codex-browser.js`。

该版本同样在第二浏览器滚轮翻页断言（原文件第 75 行）超时；此前单窗口 PageUp、滚轮与重连三项通过。日志为 `/tmp/terminal-monitor-pre-status-codex.log`，无新模型请求。失败现场保留在 `/tmp/swt-native-browser-rFu3av`，测试凭据副本已按测试清理逻辑删除。

这证明在当前环境下，无需本轮状态检查改动也会出现该测试失败；不代表已经确定根因，也不代表当前环境与过去记录测试通过时的所有外部条件相同。
