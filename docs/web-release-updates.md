# 网页完整版本更新

服务端和客户端统一使用完整版本更新协议，版本状态由发布摘要与健康检查结果确定。

## 日常使用

1. 在一台在线机器上准备新版源码及其 `package.json`、`package-lock.json`。监控配置的 `client.releaseSource` 可以指向这份源码；不设置时使用监控程序所在的版本目录。
2. 网页管理页选择该机器为版本源，点击拉取。服务器下载完整清单和文件，校验大小、SHA-256、路径、Node 版本、JavaScript 语法，然后准备依赖。
3. 收到“完整版本已准备”后点击重启服务器。所有文件准备成功才切换版本；新服务器必须启动监听并通过健康检查，否则自动恢复上个版本。
4. 点击推送更新。每个安装目录下载一次，该目录下的监控进程全部切换；全部原有终端重新注册且健康检查成功，才返回更新成功。更新期间任务 Screen 持续运行。

新增模块、静态页面和 npm 依赖不再要求旧进程预先认识文件名。发布者以 `managed-files.js` 的部署清单和完整 `public/` 目录构建版本；增加模块仍应把它加入部署清单。依赖文件完全相同时复用既有 `node_modules`；变更时在新版本目录执行 `npm ci --omit=dev`。依赖安装失败不切换运行版本。成功的依赖安装日志保存在版本目录；失败日志保存在本机 `.swt/last-preparation.log`，不通过网页发送。

## 更新协议

网页更新只接受支持当前完整版本协议的节点。旧文件覆盖协议和首次升级桥接已移除；不支持的版本源或目标节点会收到明确错误，需要通过标准安装/部署方式更新。管理页只比较 release ID 与健康检查状态，不再轮询文件哈希或推断本地磁盘版本。

## 文件与恢复

安装根目录保留启动入口、配置和任务文件。`.swt/releases/<版本摘要>/` 保存完整版本，`.swt/current` 是原子替换的符号链接；`.swt/prepared.json` 表示已准备，`.swt/activation.json` 记录检查中、完成或已回滚，以及失败原因。常驻启动器记录每个监控进程的 PID 和启动时间，防止 PID 复用导致错误判活。

配置、令牌、任务目录与 `node_modules` 不作为文件载荷直接覆盖。准备、切换使用安装目录级互斥锁。传输限制为 64 MiB、2048 文件、单文件 16 MiB、分片 48 KiB。升级不清理历史版本，便于恢复；目前不提供旧版本垃圾回收。更新器格式版本为 1，要求 Node 20 或以上；不支持通过应用更新替换操作系统 Node。

## Hooks

已配置的事件上报继续工作。监控默认自动为确认的 Codex／Claude 项目配置稳定命令并记录升级目标，不需要手工登记。手动诊断或预先接入项目时仍可执行：

```bash
node /absolute/install/root/file-update.js --configure-hooks claude /absolute/project
node /absolute/install/root/file-update.js --configure-hooks codex /absolute/project
```

合并对应目录的 `.claude/settings.local.json` 或 `.codex/hooks.json`，保留其他配置和自定义 hooks；工作目录可以是 `~`，不要求进入 Git 项目。Claude 的用户 `settings.json` 保持原样；Codex 在主目录使用默认配置路径时，hooks 文件属于用户级来源，仍可能要求信任。已登记目录在切换时迁移，失败时恢复配置备份；期间若用户自行编辑过文件则保留用户修改。首次配置后需要 CLI 加载新配置。

## 验证

`npm run test:update` 在独立临时目录和 Screen 套接字目录验证完整版本拉取、应用、多监控推送、依赖锁变更、文件校验、hooks 配置保留和启动失败回滚；同时确认不支持的更新器被拒绝且不会触发文件覆盖。`test-multiproc-update` 验证全部监控健康后才能确认成功，以及跨用户操作被拒绝。`test-release-status` 验证 release ID 状态展示、旧消息忽略和旧 API 字段移除。
