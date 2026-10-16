# 腾讯 / 2080 测试平台

状态：已部署。更新日期：2026-10-16。部署工具、测试用例和终端逻辑已合入 main。

## 访问

- 地址：<http://82.157.107.218/>
- 用户名：`test`
- 密码保存在 2080 的 `/home/renhangqi/terminal-monitor-staging/runtime/access.json`（权限 600）。该文件还包含 client token，不应提交到 Git。
- 页面标题带“测试”。版本信息：<http://82.157.107.218/staging.json>。
- 登录后是 `2080 · Codex 原生 TUI 测试`，使用真实 Codex CLI，预置 50 轮合成历史。可用滚轮和 PageUp/PageDown 验证内部翻页。

测试平台与原有生产域名、8080 broker、monitor-1～4 会话分别运行。测试专用 Codex 工作目录为独立的空 Git 仓库，登录配置也是独立副本，不加载原有私人会话。自动检查只翻页和恢复连接，不提交提示或调用模型生成内容。

## 结构与持久化

| 位置 | 用途 |
| --- | --- |
| 腾讯 `/home/ubuntu/terminal-monitor-staging/releases/` | 按版本存放代码和依赖 |
| 腾讯 `/home/ubuntu/terminal-monitor-staging/current` | 当前代码版本链接 |
| 腾讯 `/home/ubuntu/terminal-monitor-staging/runtime/server.json` | 独立 broker 配置，监听 `127.0.0.1:18080` |
| 腾讯 `terminal-monitor-staging.service` | systemd 服务，开机启动，进程退出后自动重启 |
| 腾讯 Nginx `terminal-monitor-staging` | 仅匹配 IP 的 80 端口虚拟主机，转发 HTTP/WebSocket |
| 腾讯 `/var/lib/terminal-monitor-staging/public/` | 不含凭据的前端 vendor 与版本文件；避免 Nginx 读取私人 home 目录 |
| 2080 `/home/renhangqi/terminal-monitor-staging/` | 独立 releases/current/runtime/bin |
| 2080 Screen `swt-staging-codex` | 专用 Codex 会话；Codex 结束后保留可操作的 shell |
| 2080 Screen `swt-staging-client` | 专用 client，退出后 3 秒重启 |
| 2080 `runtime/sandbox/` | 测试工作目录 |
| 2080 `runtime/codex-home/` | 独立 Codex 配置、会话和登录副本 |

2080 使用 Node 20 的绝对路径，避免系统 Node 12。因为该用户没有启用 systemd linger，使用用户 crontab 的独立管理块：`@reboot` 启动，每分钟检查专用 Screen。原有定时任务保留。启动检查和停止脚本共享 flock 锁，防止重复启动；停止标记可以阻止 watchdog 重启已手动停止的平台。

Codex 账号/API 请求需要 2080 的本地代理。部署配置通过 `--task-proxy` 指定（默认 `http://127.0.0.1:7890`），保存到运行配置，并由 task 启动脚本显式加载，因此不依赖 SSH/cron 是否继承交互式 shell 环境。该代理需在 2080 上保持运行；无代理需求时可传入空字符串。

测试 Codex 配置关闭启动更新检查，避免无人值守启动停在升级选择框；这是 [官方示例配置](https://learn.chatgpt.com/docs/config-file/config-sample)提供的 `check_for_update_on_startup` 选项。Screen 和 worker 使用 UTF-8；专用 Codex 显示流有日志。

## 操作

在 2080 的工作目录中：

```bash
cd /home/renhangqi/terminal-monitor
python3 infra/staging/manage.py status
python3 infra/staging/manage.py deploy
python3 infra/staging/manage.py stop
python3 infra/staging/manage.py start
```

`deploy` 从已提交的 Git ref 制作 release，server/client 使用同一份代码；测试用终端 JS/CSS 在部署时复制到本地 vendor，不依赖 CDN。凭据和测试会话在重新部署时保留。默认只更新测试 monitor，保留正在运行的专用 Codex。

`--ref <commit>` 可重新部署历史版本（该版本需包含 `infra/staging` 和 Codex fixture）。部署记录保存在 2080 `runtime/deployment.json`，公开版本文件记录完整源码 commit。发布包会替换测试环境标题、默认用户名和 vendor URL，源码页面及生产安装目录不变。

`stop` 停止测试 server/client/Codex，并留下停止标记；`start` 清除标记，重新启动 broker 和测试会话。systemd 服务仍保持开机启用。测试平台没有实际重启两台机器验证开机恢复；已验证服务 enable 状态、cron 安装和启动检查。

日志：

```bash
ssh ubuntu@82.157.107.218 'journalctl -u terminal-monitor-staging.service -n 80 --no-pager'
tail -80 /home/renhangqi/terminal-monitor-staging/runtime/client.log
tail -80 /home/renhangqi/terminal-monitor-staging/runtime/watchdog.log
# 重启专用 Codex 后启用的原始显示日志
ls -lh /home/renhangqi/terminal-monitor-staging/runtime/codex-screen.log
```

## 公网验收

```bash
export PLAYWRIGHT_MODULE=/tmp/terminal-monitor-native-tui-deps/node_modules/playwright
# 可选：指定系统或已下载的 Chromium
export CHROMIUM_EXECUTABLE=/home/renhangqi/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome
node infra/staging/smoke.js
node infra/staging/smoke.js --recovery
node infra/staging/smoke.js --escape
node infra/staging/smoke.js --recovery --escape --shell
```

`--recovery` 会对专用测试 broker/client 做进程终止测试。它先验证 staging 标识和专用会话名，不操作生产进程。当前恢复测试针对本平台的 Tencent Ubuntu SSH 用户和本机 2080 client；异机运行需调整对应配置/操作方式。

已通过：公网页面与版本标识、本地 vendor、2080 注册、错误密码拒绝、真实浏览器登录、真实 Codex 键盘与滚轮翻页、浏览器重连保留阅读位置、broker 崩溃自动重启与浏览器恢复、2080 client 崩溃自动重启后继续翻页、整页刷新快照恢复、无浏览器脚本错误、无 CDN 请求、停止标记阻止 watchdog、stop/start 重建测试会话。

报告与截图：2080 `/home/renhangqi/terminal-monitor-staging/runtime/smoke/`。部署前后生产站点 `https://monitor.foreveryolo.top/` 均返回 HTTP 200；原有生产 server 进程继续运行。

手机实际触摸、真实 Claude、长期压测和整机重启仍未验证。

## 终端退出与 Esc

专用 task 使用一个父进程运行 Codex；正常退出或异常退出后恢复终端设置并进入测试 shell，Screen 窗口继续存在。shell 会显示原测试会话的恢复命令。可用 `node test/test-staging-shell.js` 验证程序退出、Esc 和 shell 输入。

client 在 WebSocket 重连时保留 PTY 的有效 generation；仅当实际创建替代 PTY 时才更新 generation。否则旧 PTY 在重连后退出会被误判为过期事件，client 虽然在线却不会重新 attach。`test/test-reconnect.js` 包含该场景的回归验证。

公网验证已覆盖键盘 Esc 与工具栏 Esc：前端发送字节 `1b`，Codex 和 Screen 均继续运行。另在 broker 重连后主动结束显示端 PTY，验证重新 attach 并保持原窗口尺寸。此次修复前的日志记录了 Codex shutdown，但没有记录当时的输入字节，因此无法确定用户那次退出的具体按键路径。

## shell 与 Codex 滚动切换

显示端始终保留普通缓冲；Codex 在 Screen 内仍使用自己的备用屏幕。鼠标跟踪开启时，滚轮交给 Codex；退出到 shell 后恢复浏览器历史滚动，“最新”按钮重新可用。

`--shell` 用 Ctrl-C 退出空输入状态的专用 Codex，打印 240 行 shell 测试输出，验证滚轮、上翻按钮、“最新”、刷新快照，再进入/退出 Codex 验证历史保留。完成后重新进入原合成会话，供手动验收；不提交模型提示。

2026-10-14：`9001e52a` 已部署；`--recovery --escape --shell` 公网验收共 16 项通过，测试结束保留原合成 Codex 会话。生产站点 HTTP 200，原 broker 进程继续运行。

## 统一 TUI 版本

测试 client 无需 `nativeTui` 配置。部署同时更新服务端和 client，协议版本固定为 2；`/api/agents` 和 `/staging.json` 可查看 `protocolVersion`。旧协议节点不能注册到该测试服。
