# 历史快照原型

状态：独立 worktree 中已实现并通过本地测试；尚未部署。

agent 将经过共享过滤器的 PTY 输出同时送到 headless xterm 和 server。headless xterm 保留最近 5000 行历史。浏览器首次连接，或 `sinceSeq` 已不在服务器的连续缓冲中时，server 向 agent 请求快照；agent 等先前写入解析完成，在快照生成期间暂存新输出。server 以收到快照响应前的最后一个数据 `seq` 作为锚点，只把锚点之后的帧接到快照后面。连续的短暂断线仍直接补增量。

`terminal-filter.js` 是 agent 和旧版浏览器输出过滤器的共同实现。新版 agent 发送已过滤的输出；旧版 agent 沿用浏览器侧过滤和原有回放行为。新依赖缺失时 client 会退回旧协议，避免过渡期因缺少模块而退出。

多个浏览器同时观看同一会话时，最后打开、输入或调整窗口的浏览器决定 PTY 尺寸。服务端向所有观看者广播该尺寸并请求新快照；其他浏览器以同一尺寸恢复终端和光标，窗口较窄时可横向滚动。尺寸控制者离开后，仍在观看的浏览器按最近操作时间接管。尺寸切换期间旧尺寸的实时帧被快照覆盖，之后再按序号接上新输出。

验证：

- `node test/test-terminal-snapshot.js`：比较持续渲染和“快照恢复 + 后续相对移动”的屏幕、历史行和光标。
- `node test/test-snapshot-protocol.js`：验证首次快照、锚点前的竞争输出、实时续接、连续增量和缺口恢复。
- `node test/test-offline-queue.js`：用真实 client/server、假 screen 验证 server 重启后快照包含断线期间输出。
- `test/test-real-screen-browser.js`：用专门创建的 GNU Screen 会话、真实 client/server 和 Chromium 验证历史、密集输出时连续 resize、浏览器断线重连、两个不同尺寸浏览器的打开/输入/窗口变化/关闭控制权切换，以及多终端页面接管；测试只绑定 `127.0.0.1`，结束时清理临时会话和进程。此项是可选测试，需要临时安装 Playwright 和 `xterm-addon-fit` 并设置 `PLAYWRIGHT_MODULE`、`XTERM_FIT_JS`、`PLAYWRIGHT_BROWSERS_PATH`。
- 其余现有测试通过。另用终端模型对照测试发现并修复了 resize 越过待解析输出的顺序错误。

## 部署前提与边界

首次升级旧 agent 时，旧版文件更新白名单不认识 `terminal-state.js` 和 `terminal-filter.js`。需要把新版文件与 `package.json`、`package-lock.json` 一起传到目标机器，在每个共享安装目录执行一次 `npm ci --omit=dev`，然后重启该目录下的 agent。先升级 server 也可以，旧 agent 会继续走旧协议。`deploy.sh` 只负责复制文件，不会安装依赖或重启服务。

快照只覆盖 agent 启动后观察到、headless 缓冲仍保留的历史；它不能恢复 agent 启动前的 screen scrollback。当前上限为 5000 行和约 2 MB 的序列化内容。真实会话的多浏览器测试已通过；长期高负载仍未做线上观察。频繁在不同尺寸浏览器间交替输入会反复触发快照，可能出现短暂重绘。

生产容量仍需观察：在本机用 200×50 终端、6000 行各约 170 字符的合成输出测试，单个 agent 的常驻内存增量约 74 MiB；生成约 878 KiB 的快照耗时约 198 ms，期间 RSS 又上升约 46 MiB。这是偏密集的合成负载，不代表真实会话。本机有约 90 GiB 可用内存，现有四个 agent 的基线 RSS 各约 65–68 MiB，因而适合先做单会话灰度、观察内存和快照延迟，再扩大范围；不建议不经观察直接全量上线。
