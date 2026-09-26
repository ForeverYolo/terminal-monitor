# 历史快照原型

状态：独立 worktree 中已实现并通过本地测试；尚未部署。

agent 将经过共享过滤器的 PTY 输出同时送到 headless xterm 和 server。headless xterm 保留最近 5000 行历史。浏览器首次连接，或 `sinceSeq` 已不在服务器的连续缓冲中时，server 向 agent 请求快照；agent 等先前写入解析完成，在快照生成期间暂存新输出。server 以收到快照响应前的最后一个数据 `seq` 作为锚点，只把锚点之后的帧接到快照后面。连续的短暂断线仍直接补增量。

`terminal-filter.js` 是 agent 和旧版浏览器输出过滤器的共同实现。新版 agent 发送已过滤的输出；旧版 agent 沿用浏览器侧过滤和原有回放行为。新依赖缺失时 client 会退回旧协议，避免过渡期因缺少模块而退出。

验证：

- `node test/test-terminal-snapshot.js`：比较持续渲染和“快照恢复 + 后续相对移动”的屏幕、历史行和光标。
- `node test/test-snapshot-protocol.js`：验证首次快照、锚点前的竞争输出、实时续接、连续增量和缺口恢复。
- `node test/test-offline-queue.js`：用真实 client/server、假 screen 验证 server 重启后快照包含断线期间输出。
- 其余现有测试通过；尚未在真实浏览器与真实 GNU Screen 会话上做人工验收。

## 部署前提与边界

首次升级旧 agent 时，旧版文件更新白名单不认识 `terminal-state.js` 和 `terminal-filter.js`。需要把新版文件与 `package.json`、`package-lock.json` 一起传到目标机器，在每个共享安装目录执行一次 `npm ci --omit=dev`，然后重启该目录下的 agent。先升级 server 也可以，旧 agent 会继续走旧协议。`deploy.sh` 只负责复制文件，不会安装依赖或重启服务。

快照只覆盖 agent 启动后观察到、headless 缓冲仍保留的历史；它不能恢复 agent 启动前的 screen scrollback。当前上限为 5000 行和约 2 MB 的序列化内容。真实浏览器人工验收前，不应把这个原型视为已完成生产迁移。
