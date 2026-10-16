# 原生 TUI 模式：实现与测试

更新日期：2026-10-16。代码已合入 main；测试平台独立运行。

## 结论

当前机器上的 Codex CLI 0.159.3，可以通过真实 GNU Screen 4.09.00、项目 client/server 和 Chromium 156，在网页里用 PageUp/PageDown 和滚轮查看内部会话历史。无需另外实现会话历史读取器。

Codex 的会话翻页由应用重新绘制旧消息；shell 的输出则进入浏览器普通缓冲，使用 xterm scrollback。通过保留鼠标协议自动切换滚轮归属。

## 开启和关闭

每个 client 配置的 `client` 对象中增加：

```json
"nativeTui": true
```

只接受布尔值 `true`。不配置或设为 `false` 时保持原有过滤模式。修改后重启对应的 monitor client 即可切换；无需重启任务 Screen 或 Codex。服务端和前端需要包含本分支改动，client 安装目录需要包含 `terminal-state.js`、`terminal-filter.js` 及现有依赖。

开启后，client 屏蔽 Screen 显示端的 47/1047/1049 备用缓冲切换和清空历史的 3J，保留鼠标/焦点模式、光标隐藏、背景色和其他擦除操作。Screen 内部仍照常处理 Codex 的备用屏幕；网页始终使用普通缓冲，因此退出到 shell 后可以滚动输出历史。组合模式仅删除备用屏幕参数，其他参数继续传递。

网页输入不再删除鼠标报告。单终端和多终端均支持。应用启用鼠标跟踪时，滚轮交给应用，上翻/下翻按钮发送 PageUp/PageDown，“最新”按钮禁用。应用关闭鼠标跟踪后，shell 的滚轮、上翻/下翻和“最新”操作浏览器历史。前端在解析终端输出后更新按钮状态，不依赖进程名。

测试使用 Codex 的 `tui.alternate_screen="always"`，没有同时开启 `/raw` 或 `--no-alt-screen`。实际应用仍需主动开启鼠标报告，滚轮才会被交给应用；因此未主动启用鼠标跟踪的 TUI 不保证支持应用内部滚轮翻页。

## 两处必要的兼容修复

1. GNU Screen 4.09 会向显示端请求 SGR 鼠标协议，但在本机的输入链路里把 SGR 报告的尾部（例如 `10;6M`）当作普通字符传给程序。原生模式在 client 写入 PTY 前，将 SGR/urxvt 鼠标报告转换成经典六字节报告，并保留二进制字节，避免坐标大于 95 后被 UTF-8 编码破坏。经典报告也按原始字节恢复。
2. 当前 SerializeAddon 能保存备用屏幕和鼠标跟踪类型，却不保存鼠标编码、备用屏幕滚轮模式或隐藏光标。原生模式从已解析的 DEC 模式中记录这些状态，追加到快照中；支持跨 chunk 和组合模式，RIS 会清理记录。鼠标跟踪类型继续由库按最终有效状态序列化，避免互斥模式的顺序冲突。

经典鼠标坐标上限为 223。超界点击/拖动会被丢弃，避免协议碎片成为输入；滚轮坐标会夹到范围内。该兼容转换针对当前项目的单窗口 Screen 转发链路；更换终端复用器或升级 Screen 后应重新验证。

Screen 自己通常在整个 attach 期间使用备用屏幕，这正是仅透传备用屏幕会导致 shell 无法滚动的原因。显示端虚拟化后，shell 历史保留在普通缓冲；Codex 的屏幕重绘可能留下一些片段，浏览器缓冲不是整洁的会话记录。历史上限仍受现有 5000 行和服务端缓存限制。

## 验证结果

下列测试均通过：

| 测试 | 覆盖 |
| --- | --- |
| `test-native-tui.js` | 字节保真、拆分/组合模式、备用屏幕快照与接续、退出恢复普通缓冲、鼠标编码/隐藏光标恢复、RIS、中文与键盘混合鼠标输入、高坐标二进制编码、超界报告、原有过滤 |
| `test-native-tui-browser.js` | 真实 Screen + client/server + Chromium；键盘翻页、滚轮抵达应用、重连、新浏览器快照、窗口大小变化、移动端按钮、多终端、高坐标滚轮、原生→旧模式→原生切换、应用退出释放鼠标 |
| `test-native-codex-browser.js` | 真实 Codex 0.159.3 + 全链路；50 轮合成历史、翻页、重连、多浏览器同步、resize；退出到 shell、240 行 shell 历史、滚轮与按钮、刷新快照、再次进入/退出 Codex后历史保留 |
| `test-screen-relay-scroll.js` | 外层备用屏幕虚拟化、拆分与组合模式、鼠标保留、TUI 前后 shell 历史、两种状态的快照恢复 |
| `test-real-screen-browser.js` | 默认模式历史、多浏览器尺寸接管、多终端、密集 resize、重连 |
| 其余现有 10 个测试文件 | 稳定键与序号回放、快照协议、断网恢复、注册/文件版本、批量更新、检测器、监督器和本地协议回归 |

另通过 JavaScript 语法检查和 `git diff --check`。

Codex 测试使用临时 CODEX_HOME、合成历史和已有登录凭据的临时副本；不提交新提示、不调用模型执行任务、不接入生产 Screen。结束时删除凭据副本，关闭专用 Screen 和测试进程。尚未运行真实 Claude TUI、手机触摸手势或长期生产负载测试；移动端按钮测试由 Chromium 调用与页面相同的处理函数完成。

## 复现

单元测试无需额外依赖：

```bash
node test/test-native-tui.js
node test/test-screen-relay-scroll.js
```

浏览器依赖可单独安装到临时目录，不改项目的生产依赖：

```bash
npm install --prefix /tmp/terminal-monitor-native-tui-deps playwright xterm-addon-fit@0.8.0
/tmp/terminal-monitor-native-tui-deps/node_modules/.bin/playwright install chromium
export PLAYWRIGHT_MODULE=/tmp/terminal-monitor-native-tui-deps/node_modules/playwright
export XTERM_FIT_JS=/tmp/terminal-monitor-native-tui-deps/node_modules/xterm-addon-fit/lib/xterm-addon-fit.js
node test/test-native-tui-browser.js
node test/test-native-codex-browser.js
node test/test-real-screen-browser.js
```

安装了系统 Chromium 时，可以通过 `CHROMIUM_EXECUTABLE` 指定路径。真实 Codex 测试需要已登录的 Codex，支持 `CODEX_BIN` 指定二进制。设置 `KEEP_TEST_ARTIFACTS=1` 会保留合成会话、配置和三张截图（最新、PageUp、滚轮）；凭据副本始终删除。
