# 原生 TUI 模式：实现与测试

更新日期：2026-10-16。本文描述 `refactor/project-structure` 分支的统一 TUI 实现；测试平台独立运行。

## 结论

当前机器上的 Codex CLI 0.159.3，可以通过真实 GNU Screen 4.09.00、项目 client/server 和 Chromium 156，在网页里用 PageUp/PageDown 和滚轮查看内部会话历史。无需另外实现会话历史读取器。

Codex 的会话翻页由应用重新绘制旧消息；shell 的输出则进入浏览器普通缓冲，使用 xterm scrollback。通过保留鼠标协议自动切换滚轮归属。

## 使用与升级

原生 TUI 是唯一终端模式，无需配置开关，配置示例已删除 `nativeTui`。旧配置中残留的这个字段不再被读取，设为 `false` 也不会切换模式，可手动删除。

服务端与所有 client 必须使用同一代协议（`protocolVersion: 2`），并在安装目录执行 `npm ci` 安装完整依赖后重启监控服务。旧协议 client 会被明确拒绝注册；终端解析依赖缺失会直接报错，不再回退原始字节转发。首次跨越本次模块拆分升级时使用 Git 或部署脚本，参见 [项目结构与升级说明](refactoring.md)。无需为升级而重建任务 Screen。

client 屏蔽 Screen 显示端的 47/1047/1049 备用缓冲切换和清空历史的 3J，保留鼠标/焦点模式、光标隐藏、背景色和其他擦除操作。Screen 内部仍照常处理 Codex 的备用屏幕；网页始终使用普通缓冲，因此退出到 shell 后可以滚动输出历史。组合模式仅删除备用屏幕参数，其他参数继续传递。

首次连接恢复快照，断线且服务端缓存连续时仅补齐增量，缓存不连续时重新恢复快照。client 离线期间继续解析输出并保留终端模型，不维护第二份离线原始字节队列。服务端增量缓存只服务短暂断线补齐，不支持旧式原始字节分页或尾部拼接；浏览器也不再二次过滤输出或通过缩小一行再恢复来触发重绘。

网页输入不再删除鼠标报告。单终端和多终端均支持。应用启用鼠标跟踪时，滚轮交给应用，上翻/下翻按钮发送 PageUp/PageDown，“最新”按钮禁用。应用关闭鼠标跟踪后，shell 的滚轮、上翻/下翻和“最新”操作浏览器历史。前端在解析终端输出后更新按钮状态，不依赖进程名。

测试使用 Codex 的 `tui.alternate_screen="always"`，没有同时开启 `/raw` 或 `--no-alt-screen`。实际应用仍需主动开启鼠标报告，滚轮才会被交给应用；因此未主动启用鼠标跟踪的 TUI 不保证支持应用内部滚轮翻页。

## Screen 显示能力与状态恢复

1. GNU Screen 4.09 会向显示端请求 SGR 鼠标协议，但在本机的输入链路里把 SGR 报告的尾部（例如 `10;6M`）当作普通字符传给程序。client 写入 PTY 前，将 SGR/urxvt 鼠标报告转换成经典六字节报告，并保留二进制字节，避免坐标大于 95 后被 UTF-8 编码破坏。经典报告也按原始字节恢复。
2. 当前 SerializeAddon 能保存备用屏幕和鼠标跟踪类型，却不保存鼠标编码、备用屏幕滚轮模式或隐藏光标。从已解析的 DEC 模式中记录这些状态，追加到快照中；支持跨 chunk 和组合模式，RIS 会清理记录。鼠标跟踪类型继续由库按最终有效状态序列化，避免互斥模式的顺序冲突。

3. Screen 4.x 把 `SGR 3` 记作 standout，默认借用 `xterm-256color` 的反色指令。client 用 `screen-terminal.js` 调用系统 `tic`，原子安装运行账户主目录下的专用 `tm-web-256color` 条目：继承 `xterm-256color`，只把 `smso/rmso` 改为 `ESC[3m/ESC[23m`。client 附着 Screen 的 PTY 使用这个 TERM，任务内部 TERM 不变。真正的反色仍使用 `SGR 7`，两者叠加及重置均可正常保存和恢复。

这项修复不依赖 Screen 启动时读取新的 `.screenrc`。给 `screen -c ... -x` 加配置文件无法改变已运行服务的能力覆盖，因此采用已有 Screen 服务能按连接查询的用户级 terminfo 条目。普通 xterm 连接不使用该条目，测试验证其显示不受影响。client 需要 `tic`（Debian/Ubuntu 的 `ncurses-bin`），账户主目录的 `.terminfo` 必须可写；优先使用 `/usr/bin/tic`，避免 Conda 工具与系统 ncurses 混用。

经典鼠标坐标上限为 223。超界点击/拖动会被丢弃，避免协议碎片成为输入；滚轮坐标会夹到范围内。该兼容转换针对当前项目的单窗口 Screen 转发链路；更换终端复用器或升级 Screen 后应重新验证。

Screen 自己通常在整个 attach 期间使用备用屏幕，这正是仅透传备用屏幕会导致 shell 无法滚动的原因。显示端虚拟化后，shell 历史保留在普通缓冲；Codex 的屏幕重绘可能留下一些片段，浏览器缓冲不是整洁的会话记录。快照保留最多 5000 行历史，并受快照大小上限约束；服务端缓存容量决定能否使用增量补齐，超出后改用快照。

## 验证结果

下列测试均通过：

| 测试 | 覆盖 |
| --- | --- |
| `test-native-tui.js` | 字节保真、拆分/组合模式、Screen 备用屏幕虚拟化、快照与接续、鼠标编码/隐藏光标恢复、RIS、中文与键盘混合鼠标输入、高坐标二进制编码、超界报告 |
| `test-screen-terminal.js` | 已运行 Screen 的双连接隔离、斜体/反色/叠加/重置、重连及重复安装 |
| `test-native-tui-browser.js` | 真实 Screen + client/server + Chromium；斜体和反色、快照与重连恢复、键盘翻页、滚轮抵达应用、重连、新浏览器快照、窗口大小变化、移动端按钮、多终端、高坐标滚轮、无配置开关下的 client 重启、应用退出释放鼠标 |
| `test-native-codex-browser.js` | 真实 Codex 0.159.3 + 全链路；50 轮合成历史、翻页、重连、多浏览器同步、resize；退出到 shell、240 行 shell 历史、滚轮与按钮、刷新快照、再次进入/退出 Codex后历史保留 |
| `test-screen-relay-scroll.js` | 外层备用屏幕虚拟化、拆分与组合模式、鼠标保留、TUI 前后 shell 历史、两种状态的快照恢复 |
| `test-real-screen-browser.js` | shell 历史、多浏览器尺寸接管、多终端、密集 resize、重连 |
| 其余本地测试 | 稳定键与序号回放、快照协议、断网恢复、注册/文件版本、批量更新、检测器、监督器和本地协议回归 |

另通过 JavaScript 语法检查和 `git diff --check`。

Codex 测试使用临时 CODEX_HOME、合成历史和已有登录凭据的临时副本；不提交新提示、不调用模型执行任务、不接入生产 Screen。结束时删除凭据副本，关闭专用 Screen 和测试进程。尚未运行真实 Claude TUI、手机触摸手势或长期生产负载测试；移动端按钮测试由 Chromium 调用与页面相同的处理函数完成。

## 复现

安装依赖并运行测试：

```bash
npm ci
npm run test:setup
npm run test:all
```

测试分组与环境说明见 [测试指南](testing.md)。

安装了系统 Chromium 时，可以通过 `CHROMIUM_EXECUTABLE` 指定路径。真实 Codex 测试需要已登录的 Codex，支持 `CODEX_BIN` 指定二进制。设置 `KEEP_TEST_ARTIFACTS=1` 会保留合成会话、配置和三张截图（最新、PageUp、滚轮）；凭据副本始终删除。
