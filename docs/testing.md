# Testing

Clients and Screen tests require `tic` (Debian/Ubuntu: `ncurses-bin`). The
client installs its own named terminfo entry in the account home; Screen tests
leave that application entry installed and preserve other terminal types.

Use Node 20 and install development dependencies with `npm ci`. Browser tests
use pinned xterm/fit and Playwright packages from this checkout, with no
external CDN requests. Run `npm run test:setup` once to install Chromium.
`CHROMIUM_EXECUTABLE` can select an existing browser instead.

| Command | Coverage / prerequisites |
| --- | --- |
| `npm test` | Unit and mock-agent protocol tests; no model calls |
| `npm run test:unit` | Detectors, filters, snapshots, supervisor, HTTP/update contracts and stream lifecycle |
| `npm run test:protocol` | Protocol 2 registration/rejection, snapshots, delta/gap recovery, reconnect and updates |
| `npm run test:screen` | Existing Screen display isolation and styles, disposable sessions, restart/rollback and quoted-path fixtures |
| `npm run test:browser` | Chromium, real Screen, terminal selection, paging, redraw |
| `npm run test:codex` | Logged-in Codex, isolated synthetic history; no new prompts |
| `npm run test:all` | All local groups, including real Codex |
| `npm run test:staging` | Existing public staging platform; see staging-platform.md |

Groups run sequentially and stop on failure. Browser helpers own the asset
routing and browser launch settings. Existing `PLAYWRIGHT_MODULE` and
`XTERM_FIT_JS` overrides remain available for external dependency installations.
Staging recovery tests are explicit; the default local suite never deploys or
restarts production services.

## 网页版本更新

`npm run test:update` 在临时安装目录和独立 Screen 套接字目录验证当前完整版本拉取/推送、旧更新器拒绝、依赖变化、多个监控进程与启动失败回滚。

`node infra/staging/verify-web-update.js` 会在标记为 staging 的专用测试服实际点击管理页的拉取、应用和推送按钮，重启该测试服的监控服务，检查重连和健康结果，并确认任务 Screen PID 不变；不会向任务终端发送输入。凭据读取 staging 私有配置，报告和截图保存在 `runtime/web-update-verification/`。
