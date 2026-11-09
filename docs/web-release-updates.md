# 网页更新与兼容桥接

状态改进单独保存在 `d796163`，网页更新在独立分支 `feat/web-release-updates` 开发。

## 日常使用

1. 在一台在线机器上准备新版源码及其 `package.json`、`package-lock.json`。监控配置的 `client.releaseSource` 可以指向这份源码；不设置时使用监控程序所在的版本目录。
2. 网页管理页选择该机器为版本源，点击拉取。服务器下载完整清单和文件，校验大小、SHA-256、路径、Node 版本、JavaScript 语法，然后准备依赖。
3. 收到“完整版本已准备”后点击重启服务器。所有文件准备成功才切换版本；新服务器必须启动监听并通过健康检查，否则自动恢复上个版本。
4. 点击推送更新。每个安装目录下载一次，该目录下的监控进程全部切换；全部原有终端重新注册且健康检查成功，才返回更新成功。更新期间任务 Screen 持续运行。

新增模块、静态页面和 npm 依赖不再要求旧进程预先认识文件名。发布者以 `managed-files.js` 的部署清单和完整 `public/` 目录构建版本；增加模块仍应把它加入部署清单。依赖文件完全相同时复用既有 `node_modules`；变更时在新版本目录执行 `npm ci --omit=dev`。依赖安装失败不切换运行版本。成功的依赖安装日志保存在版本目录；失败日志保存在本机 `.swt/last-preparation.log`，不通过网页发送。

## 首次升级旧版

旧进程的文件白名单固定，必须先接入一次兼容更新器。支持的历史基线为 `7cd9b52`，状态改进版本 `d796163` 也使用同样的接口；其他版本若补丁定位不唯一会拒绝，避免猜测修改。

```bash
node infra/build-update-bridge.js /absolute/path/to/new-bridge-publisher
# 若当前部署的是状态改进版本，可追加基线参数 d796163
cd /absolute/path/to/new-bridge-publisher
npm ci --omit=dev
```

给兼容发布端准备一份客户端配置，连接现有服务器、附着现有或专用 Screen，设置 `client.releaseSource` 为真正新版源码的绝对路径，再启动它的 `client.js`。网页先从它拉取一次并重启服务器，接入兼容更新器；随后再次拉取并重启，应用完整新版。兼容版保留历史文件布局，只修改旧白名单已有的 `client.js`、`server.js`、`file-update.js`、`service-restart.js`。新服务器向旧客户端推送时会自动完成同样的桥接。

初次桥接的服务重启沿用 Screen；若由 systemd 托管，只有确认当前进程就是该单元的 MainPID 才退出交给 systemd 重启，单元须配置 `Restart=on-failure` 或 `always`。接入后由常驻启动器切换工作进程，Screen 与 systemd 使用相同机制。

## 文件与恢复

安装根目录保留启动入口、配置和任务文件。`.swt/releases/<版本摘要>/` 保存完整版本，`.swt/current` 是原子替换的符号链接；`.swt/prepared.json` 表示已准备，`.swt/activation.json` 记录检查中、完成或已回滚，以及失败原因。常驻启动器记录每个监控进程的 PID 和启动时间，防止 PID 复用导致错误判活。

配置、令牌、任务目录与 `node_modules` 不作为文件载荷直接覆盖。准备、切换使用安装目录级互斥锁。传输限制为 64 MiB、2048 文件、单文件 16 MiB、分片 48 KiB。升级不清理历史版本，便于恢复；目前不提供旧版本垃圾回收。更新器格式版本为 1，要求 Node 20 或以上；不支持通过应用更新替换操作系统 Node。

## Hooks

已配置的事件上报继续工作。若要让项目 hooks 使用始终指向当前版本的稳定命令，可在接入新更新器后执行：

```bash
node /absolute/install/root/file-update.js --configure-hooks claude /absolute/project
node /absolute/install/root/file-update.js --configure-hooks codex /absolute/project
```

仅合并该项目的 `.claude/settings.local.json` 或 `.codex/hooks.json`，保留其他配置和自定义 hooks，不改用户全局配置；Codex 仍可能要求信任 hook。已登记的项目在切换时迁移，失败时恢复配置备份；期间若用户自行编辑过文件则保留用户修改。首次配置后需要 CLI 重新加载或重启。

## 验证

`npm run test:update` 使用独立临时目录和 Screen 套接字目录，执行原始 `7cd9b52` 服务器的网页协议升级、旧客户端自动桥接、同目录两个监控进程切换、依赖锁变更、文件校验与失败回滚。`test-multiproc-update` 额外验证第一个监控健康时不能提前成功，以及跨用户操作被拒绝。
