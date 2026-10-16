# TUI 正文覆盖输入区：快照状态恢复修复

日期：2026-10-16。滚动区域修复已合入 main，并通过独立测试平台验收。

## 症状与原因

网页运行一段时间后，正文滚动进入底部输入框，重新打开终端后暂时恢复。截图只能说明最终画面；隔离案例已复现一条能导致同类症状的路径：

1. client 的终端模型保留了正文滚动区域，例如第 2～40 行；输入框在下方固定行。
2. SerializeAddon 0.11.0 生成屏幕和模式快照时，不包含 DECSTBM 滚动上下边界。
3. 浏览器重置后写入快照，画面暂时正确，但滚动区域变成整屏。
4. 后续换行、滚屏、插入或删除行依照错误区域执行，正文就可能覆盖输入区。

这说明鼠标模式等已覆盖状态可以独立于历史行数保存，但先前的快照并没有覆盖所有后续绘制依赖的状态。

## 修复

client 在同一个输出解析边界捕获 `parserState`：滚动上下边界、光标横纵位置。broker 将其与快照一起发送。浏览器在快照解析完成的回调中恢复这些值，再继续解析后续实时输出。

直接发送 DECSTBM 来恢复区域会移动光标，并可能破坏右边界的待换行状态。因此对当前固定版本的 xterm/headless 5.3.0 使用内部 buffer 字段恢复，前端校验字段和坐标范围。这处依赖在升级 xterm 时需要重新验证。旧 client 没有附带字段时继续使用原有恢复流程。

需要同时更新 `terminal-state.js`、`server.js` 和 `public/index.html`，更新后重新进入终端取得新快照。网页推送清单已包含这些文件。

## 验证

新增 `test/test-scroll-region-browser.js` 使用真实 broker、Chromium 和隔离模拟 agent，不提交模型提示。修复前稳定出现 `live output overwrote input box`；修复后覆盖：

- 首次快照、重新进入、WebSocket 重连、窗口尺寸改变后的连续正文滚动。
- 7000 次实时重绘，控制指令跨 chunk，以及输出过程中重新请求快照。
- 非零滚动区域顶部、origin mode、光标处于右边界待换行的快照接续。
- 局部上下滚屏、插入和删除行，固定输入框/底栏保持完整。

运行方式与其他浏览器测试相同：

```bash
export PLAYWRIGHT_MODULE=/tmp/terminal-monitor-native-tui-deps/node_modules/playwright
export XTERM_FIT_JS=/tmp/terminal-monitor-native-tui-deps/node_modules/xterm-addon-fit/lib/xterm-addon-fit.js
export CHROMIUM_EXECUTABLE=/home/renhangqi/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome
node test/test-scroll-region-browser.js
```

另通过现有快照协议、原生鼠标/翻页、真实 Screen、真实 Codex 和 shell 往返测试。

## 后续排查记录

完整终端状态的补齐暂缓实施。当前快照覆盖范围、已知缺失项和恢复顺序风险见 [终端快照已知状态缺口与排查记录](../KNOWN_TERMINAL_STATE_GAPS.md)。后续遇到刷新暂时恢复、继续绘制又错乱时，可按该清单排查。
