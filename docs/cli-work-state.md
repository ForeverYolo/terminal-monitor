# CLI 身份与工作状态

普通 shell、日志和非 code-cli 程序不显示工作状态。所有 CLI 共用一套界面规则：相邻输入区、操作提示、模型/上下文状态，或输入框上下边界与操作提示的组合。`*` 等容易与正文混淆的提示符必须同时具备输入框边界和模型状态。品牌标题、进程名、spinner、`Working`、`esc to interrupt` 都不能单独确认 Code CLI。

识别顺序固定为「通用界面判断 → 前台进程命名」。`detectScreen()` 不读取品牌、模型厂商或进程提示，只产生 `generic` 结果；`CliTracker` 在识别成功后根据唯一前台进程命名。已知进程显示 Codex、Claude、Qoder 等名称，未知进程显示安全截取的程序/脚本名（`app: generic` 与可选 `appName`），无法唯一确定时保留 Code CLI。进程存在不代表正在工作，也不放宽界面规则。

检测读取 client 已有 xterm 模型的当前屏幕，等待解析完成，不扫描原始字节流或历史滚动区。身份初次确认有 300ms 稳定窗口。已绑定 CLI 在头部消失时保留身份；进程退出/挂起后清理。Linux `/proc` 和 Screen 子进程用于辅助绑定，不以进程存在推断正在处理任务。相同 CLI 的 launcher/TUI/app-server 祖先链合并为一个实例。

## 统一状态

`cliState` 包含 `isCodeCli`、`app`、可选 `appName`、`status`、`source`、`prompt`、`options`、`sessionId`、`changedAt`。状态为 `working / idle / waiting_permission / waiting_input / unknown`；来源为 `hooks / screen`。连接在线/离线独立于任务状态。

卡片、管理页、API、手机操作栏、通知和 supervisor 共用此结果。`needsInput` 和旧 `claudeState` 仅为派生兼容字段，服务端不再根据输出末尾字符另行判断。

运行逻辑只维护 `cliState`；旧字段在协议输出时生成，不再维护第二份状态缓存。一次 `CliTracker.screen()` 完成当前屏幕识别与 hooks 校正，调用方无需分两次处理画面。`terminal-text.js` 只提供预览/结构化文本需要的 ANSI 清理，旧的历史字节流检测器已移除。卡片与管理页通过同一 `stateText()` 生成状态文字。

## 自动接入 Codex / Claude hooks

监控现在默认自动接入。在 Screen 中确认唯一的前台 Codex／Claude 进程和工作目录后，合并对应目录的 hooks；不要求 Git 仓库，也不排除用户主目录。Codex 使用 `.codex/hooks.json`，Claude 按运行版本选择本地 `.claude/settings.local.json`。在 `~` 启动 Claude 时写入 `~/.claude/settings.local.json`，保留 `~/.claude/settings.json`；Codex 在 `~` 使用默认配置目录时，该 hooks 文件同时是用户级来源，首次仍需按其规则信任。已有自定义 hooks、权限和其他设置均保留。监控命令指向安装目录的稳定入口，升级后继续调用当前版本。配置备份保存在安装目录 `.swt/hook-config-backups/`，目录自动加入内部升级维护列表，无需手工登记。

配置成功不代表事件已生效。尚未收到真实事件时仍显示“推断 · 事件待接通”，卡片列出后续操作；收到经过 PID、启动时间、Screen 归属和会话检查的事件后才显示“事件”，并移除接入提示。Codex 首次仍需在 `/hooks` 中信任监控 hooks；当前会话可以在 `/hooks` 中发现新增配置。监控不会自动信任其他 hooks 或重新启动任务。Claude 的配置会按其设置加载规则生效，未接通时可检查 `/hooks` 或重新加载会话配置。

`client.autoHooks: false` 可关闭自动配置，已明确关闭 hooks 的 CLI 保留原设置。配置损坏、目录权限、来源限制或多 CLI 归属不明时不会强行修改；适用的失败原因会显示在卡片。生成的未跟踪配置写入项目 Git 内部 excludes，不修改团队 `.gitignore`。

官方参考：[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude hooks](https://code.claude.com/docs/en/hooks)。

### 手动诊断

以下命令仍可用于查看适配器生成的配置：

在运行被监控 Screen 的同一台机器上生成配置片段：

```bash
node /absolute/path/terminal-monitor/cli-hook.js codex --print-config
node /absolute/path/terminal-monitor/cli-hook.js claude --print-config
```

将对应 `hooks` 片段合并到该 CLI 的配置中；不要覆盖已有 hooks。Codex 支持其配置层旁的 `hooks.json`；Claude 使用 settings 中的 `hooks`。Codex 非托管 hooks 需要在 `/hooks` 中信任。新配置应在 CLI 加载后验证；既有 Screen 可保留，必要时退出 CLI 并恢复原对话。

hooks 通过 `STY` 找到 Screen 名称，连接当前用户私有目录中的 Unix socket（目录 700、socket 600）。事件绑定 CLI 进程 PID、进程启动时间、会话 ID 和可用的 turn ID；接收端验证该进程属于被监控 Screen 的前台 CLI。无法读取 `/proc` 或多个窗口归属有歧义时不接纳 hooks，继续画面推断。

Codex 的共享 `app-server --managed-daemon` 不属于前台 Screen，继承的 `STY` 也可能已经过期。这一路只在实际 hook 执行目录与事件 `cwd` 一致时，查找同一 Codex 配置目录、同一项目的唯一前台 Screen Codex（包括 `-C`／`--cd`），然后交给接收端重新验证 PID 和启动时间。同项目多个 Screen Codex（含未监控会话）、多窗口或目录不明时继续推断，不按旧 `STY` 猜测。普通后台 CLI 和子代理不使用这一路径。

只传事件名和必要身份字段，不传提示正文、工具参数、模型回答、凭据或完整 transcript。脚本不返回授权决定或模型上下文；监控不可用时快速退出，不阻断 CLI。

hooks 优先于旧画面。长时间无事件不会自动判空闲。`Stop` 是结束前事件，其他 hooks 可能继续任务，因此先标记未知，等新解析的空闲画面确认；继续调用工具会恢复工作中。等待授权后的恢复也可由新画面校正。Qoder 使用画面检测，尚未提供 Qoder hooks 适配。

## 验证

```bash
npm test
npm run test:screen
npm run test:browser
npm run test:codex
```

以上均不发送新模型提示。`test/fixtures/cli-screens.json` 是 2026-11-09 在隔离目录采集的真实 Codex 0.159.3、Claude 2.1.100、Qoder CN 1.1.85 当前屏幕，路径与邮箱已脱敏。Claude 此样本没有加载登录配置，应该显示未知/需要登录。

以下是显式选择的实时 hooks 测试，每个 CLI 发送一条简短无工具任务，不属于默认测试或 `test:all`：

```bash
RUN_LIVE_CLI_HOOK_TEST=1 node test/test-cli-live-hooks.js codex
RUN_LIVE_CLI_HOOK_TEST=1 node test/test-cli-live-hooks.js claude
```

该测试使用临时 Screen、目录和配置；Codex 凭据为临时副本，Claude 只复用本机提供方认证设置而不加载用户 hooks。结束后删除临时配置和凭据副本。授权、取消、进程复用、乱序/旧会话事件使用可重复的状态机和真实 Screen/socket 测试覆盖。

## 边界

画面检测属于推断，不能承诺对任意未知 CLI 都能识别。未匹配则隐藏状态，已确认 CLI 但状态证据不足则显示未知。纯画面模式翻看应用内部历史可能影响推断；hooks 工作态不会被旧空闲输入框覆盖。前台多窗口的 hooks 歧义不做自动猜测。

Qoder CN 1.1.85 另在临时目录执行一条无工具短任务，已采集实际 `Generating... (esc to cancel, 0s)` 与结束后的空闲画面，见 `cli-task-screens.json`。模型回答区域已省略；固定输入框在工作期间仍然可见，不能单凭它判空闲。

部署需同时更新测试 broker/client 与前端；新增文件已列入 `managed-files.js`。自动接入的回归包括临时 Screen 中的首次自动配置、真实命令 hook/socket 上报、来源标记及任务会话保留；真实 Codex `/hooks` 的无模型请求测试可用 `RUN_LOCAL_CODEX_HOOK_SETUP_TEST=1 node test/test-auto-hooks-codex.js` 运行。
