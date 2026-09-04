# Terminal Monitor（终端监控器）

通过浏览器远程查看和操作多台内网 Linux 机器上的 **GNU Screen** 会话。自建 WebSocket 中继，**内网机器无需开放任何入站端口**，只需能访问公网即可。支持多终端、移动端虚拟键盘、历史滚动缓冲、文件上传下载，以及可选的 AI 督工自动驱动任务。

> 适用场景：实验室 / 公司内网的 GPU 服务器、跑长任务的集群节点、家里的 NAS —— 只要上面有 screen 会话，就能在任何浏览器（含手机）上随时接管和监控。

---

## 目录

- [一、它能做什么](#一它能做什么)
- [二、架构与数据流](#二架构与数据流)
- [三、30 秒快速上手](#三30-秒快速上手)
- [四、安装与部署](#四安装与部署)
- [五、配置文件详解](#五配置文件详解)
- [六、日常使用](#六日常使用)
- [七、进阶：AI 督工](#七进阶ai-督工)
- [八、消息协议（二次开发参考）](#八消息协议二次开发参考)
- [九、安全建议](#九安全建议)
- [十、常见问题 FAQ](#十常见问题-faq)
- [十一、项目结构](#十一项目结构)

---

## 一、它能做什么

| 功能 | 说明 |
|------|------|
| 远程终端 | 浏览器里完整操作远端 screen 会话，支持 vim / tmux-in-screen / TUI 程序 |
| 多机仪表盘 | 一屏查看所有内网机器，显示最后几行输出、是否在等待输入、系统信息 |
| 多终端同屏 | 同时监控多台机器，分屏查看 |
| 无需入站端口 | 内网机器**主动出站**连接公网服务器，不用做端口映射 / 打洞 |
| 历史不丢失 | 服务端为每台机器缓存 ~2MB 终端输出，断线/刷新后自动回放 |
| 文件传输 | 浏览器 ↔ 内网机器之间上传 / 下载文件（限 `$HOME` 目录内，单文件 ≤ 200MB） |
| 移动端友好 | 手机自动弹出虚拟键盘（方向键 / Tab / Ctrl 组合键 / 粘贴） |
| 自动重连 | 客户端指数退避重连（1s→30s），浏览器断线 2 秒自动重连免登录 |
| 系统信息 | 自动采集 hostname / IP / OS / CPU / 内存 / 磁盘 / GPU / 负载并展示 |
| AI 督工（可选） | 接入 LLM，终端空闲时自动分析上下文并注入命令，循环驱动任务完成 |

---

## 二、架构与数据流

```
内网机器 A (screen) ──ws──┐
内网机器 B (screen) ──ws──┼──► 公网服务器 (broker + web) ──► 浏览器
内网机器 C (screen) ──ws──┘
```

核心思路：**内网机器主动向公网服务器发起 WebSocket 连接（出站）**，因此内网防火墙无需开放任何端口。公网服务器只做中继（broker），把浏览器用户的 I/O 转发给对应 agent。

### 三个组件

| 组件 | 文件 | 作用 |
|------|------|------|
| **服务端** | `server.js` | 公网机器上运行。HTTP 静态页面 + WebSocket broker，维护 scrollback 缓冲、鉴权 |
| **客户端 (Agent)** | `client.js` | 内网机器上运行。用 node-pty 挂载 screen 会话，把 I/O 通过 ws 上行 |
| **前端** | `public/index.html` | 单 HTML 文件（xterm.js，CDN 加载），零构建。登录 → 仪表盘 → 终端三视图 |

### 数据流

```
终端输出： screen → PTY onData → base64 → WS → server → WS → xterm.js write
键盘输入： xterm.js onData → TextEncoder → base64 → WS → server → WS → PTY write
```

所有数据消息都是 **base64 编码的 payload 走 JSON WebSocket 消息**，UTF-8 安全。

---

## 三、30 秒快速上手

> 前提：公网服务器 + 各内网机器都已安装 **Node.js ≥ 18**（推荐 20）和 `screen`。

**1. 公网服务器：**

```bash
git clone <本仓库> terminal-monitor && cd terminal-monitor
npm install            # 安装 ws + node-pty
cp config.example.json config.json
# 编辑 config.json：改 password、生成一个 token
node server.js         # 或 bash install.sh server（自动放进 screen 后台）
```

**2. 内网机器：**

```bash
cd terminal-monitor && npm install
cp config.client.example.json config.client-mybox.json
# 编辑：填入公网 IP、与 server 相同的 token、screen 会话名
screen -dmS mywork bash -c "..."   # 先确保有个 screen 会话
node client.js --config=config.client-mybox.json
```

**3. 浏览器：**

打开 `http://<公网IP>:8080`，输入密码登录 → 看到机器卡片 → 点进去即可操作终端。

---

## 四、安装与部署

### 4.1 环境要求

- **Node.js ≥ 18**（20 LTS 最佳）
- **GNU Screen** 已安装（内网机器需要）
- 内网机器需要能访问公网服务器的端口（出站）

### 4.2 一键部署脚本（推荐）

`install.sh` 提供三种模式，自动检查 Node、生成配置、`npm install`、并在独立 screen 会话里启动：

```bash
bash install.sh server              # 公网服务器
bash install.sh client              # 内网机器（交互式选 screen 会话）
bash install.sh client mywork       # 内网机器，直接指定 screen 会话名
bash install.sh debug               # 本地调试：同机同时起 server + client
bash install.sh debug mywork        # 本地调试，指定 screen 会话
```

启动后的 screen 会话名：
- 服务端：`swt-server`
- 客户端：`swt-client-<screen会话名>`

### 4.3 手动启动

```bash
npm install

# 服务端
node server.js                                   # 默认读 config.json
node server.js --config=config.json

# 客户端（每个 screen 会话一个独立配置）
node client.js --config=config.client-mybox.json

# AI 督工（可选）
node ai-overseer.js --config=config.ai-overseer.json
```

### 4.4 批量远程部署（scp 推送）

`deploy.sh` 把项目文件 scp 到多台机器，带失败重试。目标列表写在 `deploy.targets.conf`（已被 gitignore，含密码/内网 IP，不要提交）：

```bash
cp deploy.targets.example.conf deploy.targets.conf
# 编辑：每行  label|user|host|port|path

./deploy.sh                                  # 推送默认文件集
./deploy.sh server.js public/index.html      # 推送指定文件

# 重启指定目标上的远程服务（使用 install.sh 创建的 screen 会话）
bash restart.sh server server                # label 为 server 的目标
bash restart.sh client mywork gpu-box        # gpu-box 上的 swt-client-mywork
```

`restart.sh` 必须指定 `deploy.targets.conf` 中的目标 label，只负责通过 SSH 重启进程，不会重新推送代码；客户端还必须指定对应的 Screen 会话名。

### 4.5 后台常驻

推荐用 screen / tmux / systemd 任选其一让进程常驻。最简单：

```bash
screen -dmS swt-server bash -c "cd /path/to/terminal-monitor && node server.js"
```

---

## 五、配置文件详解

所有配置都是 JSON。**含密钥的真实配置已被 `.gitignore` 忽略**，仓库只提供 `*.example.json` 模板。

### 5.1 服务端 `config.json`

由 `config.example.json` 复制而来：

```json
{
  "mode": "server",
  "server": {
    "port": 8080,
    "password": "你的浏览器登录密码",
    "tokens": {
      "一串随机hex的token": { "name": "default", "desc": "说明", "user": "user" }
    },
    "supervisor": {
      "enabled": false,
      "summaryInterval": 300,
      "idleTimeout": 600,
      "webhook": ""
    }
  },
  "client": { "...": "（服务端运行时用不到 client 段，保留即可）" }
}
```

| 字段 | 说明 |
|------|------|
| `server.port` | HTTP + WebSocket 监听端口 |
| `server.password` | **浏览器登录密码** |
| `server.tokens` | **预共享 token 白名单**，client 注册时必须命中其中之一；`user` 字段可做简单多用户隔离 |
| `server.supervisor` | 可选的状态汇总/空闲告警模块，`enabled:true` 开启，`webhook` 可填钉钉/Slack/自定义接收地址 |

> 生成 token：`openssl rand -hex 16`

### 5.2 客户端 `config.client-<session>.json`

由 `config.client.example.json` 复制而来。**每个 screen 会话一个独立文件**，互不覆盖：

```json
{
  "mode": "client",
  "server": { "port": 8080, "password": "unused" },
  "client": {
    "serverUrl": "ws://你的公网IP:8080",
    "token": "与服务端 tokens 白名单里的一致",
    "name": "gpu-box-1",
    "screen": "mywork",
    "screenMode": "auto",
    "attrs": { "tags": ["gpu", "dev"] }
  }
}
```

| 字段 | 说明 |
|------|------|
| `client.serverUrl` | 公网服务器 ws 地址（生产建议 `wss://` + 反代 TLS） |
| `client.token` | 必须在服务端白名单中 |
| `client.name` | 仪表盘上显示的机器名 |
| `client.screen` | 要附加的 screen 会话名 |
| `client.screenMode` | `auto`（默认，用 `-x` 多显示模式）/ `reattach`（用 `-r`） |
| `client.attrs.tags` | 自定义标签，前端可按标签筛选 |
| `client.cols` / `client.rows` | 初始 PTY 尺寸（默认 200×50），浏览器连上后会发送真实 resize |

多实例示例：

```
config.client-train.json     # 监控 train 会话
config.client-download.json  # 监控 download 会话
```

### 5.3 AI 督工 `config.ai-overseer.json`（可选）

由 `config.ai-overseer.example.json` 复制而来。详见 [第七节](#七进阶ai-督工)。

---

## 六、日常使用

### 6.1 浏览器界面

1. **登录页**：输入密码（用户名可选，用于多用户隔离）。密码会存 localStorage，刷新 / 断线自动重连免登录。
2. **仪表盘**：所有在线机器以卡片展示，含：
   - 机器名 / screen 会话名 / 标签
   - 最后几行输出（实时刷新）
   - 状态：`RUNNING`（运行中）/ `WAITING`（等待输入，检测到命令行提示符）
   - 系统信息（CPU / 内存 / GPU / 磁盘 / 负载 / 在线时长）
3. **终端视图**：点击卡片进入，标准 xterm.js 终端，支持：
   - 多终端同屏（`connect_multi`）
   - 历史滚动缓冲（服务端缓存 ~2MB，可点"加载更多历史"向前翻）
   - 重启 screen 会话（按钮：杀掉 PTY 触发 respawn，重新 `-x` 挂载）

### 6.2 移动端

屏幕宽度 < 600px 自动显示虚拟键盘工具栏：方向键 ↑↓←→、Tab、Esc、Home/End、退格、Ctrl 组合键（点 Ctrl 激活再按字母）、粘贴。

### 6.3 管理进程

```bash
screen -r swt-server                   # 进入服务端前台
screen -r swt-client-mywork            # 进入某客户端前台
screen -S swt-server -X quit           # 停止服务端
screen -S swt-client-mywork -X quit    # 停止某客户端
```

### 6.4 备份脚本

`backup.sh` 是项目自身的 git 备份工具：

```bash
./backup.sh "提交信息"        # commit
./backup.sh "v1.1" --tag      # commit + tag
./backup.sh --list            # 查看历史
./backup.sh --restore <hash>  # 还原某版本
```

### 6.5 HTTP API

服务端暴露两个简单接口（可用于外部脚本监控 / CI 集成）：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/agents` | GET | 返回所有在线 agent 状态 JSON（最后 10 行输出、是否等待输入等） |
| `/api/action` | POST | body `{agentId, input}`，向指定 agent 终端注入输入 |

---

## 七、进阶：AI 督工

`ai-overseer.js` 是一个可选的自动化组件：它以浏览器身份连接 server，盯住指定 agent 的终端输出；当终端空闲（等待输入）超过阈值时，截取最近上下文调用 LLM 分析，按 LLM 决策向终端注入命令，循环直到任务完成或达到最大迭代次数。

**典型用途**：长跑任务中途卡住需要人工回车 / 输入选项 / 确认时，让 LLM 自动判断并继续。

```jsonc
// config.ai-overseer.json
{
  "mode": "ai-overseer",
  "aiOverseer": {
    "serverUrl": "ws://你的公网IP:8080",
    "password": "浏览器登录密码",
    "agentName": "要盯的机器名（client.name）",
    "taskGoal": "用一句话描述任务目标，LLM 会以此判断是否完成",
    "idleTimeout": 30,       // 终端空闲多少秒后触发分析
    "checkInterval": 5,      // 轮询间隔（秒）
    "maxIterations": 50,     // 最大注入次数，防止失控
    "maxHistoryLines": 150,  // 每次送给 LLM 的上下文行数
    "llm": {
      "provider": "openai",  // 或 "anthropic"
      "apiKey": "sk-xxx",
      "model": "gpt-4o-mini",
      "baseUrl": "http://你的LLM地址/v1",  // 兼容 OpenAI 协议的本地模型也可
      "temperature": 0.3,
      "maxTokens": 1000,
      "jsonMode": false
    }
  }
}
```

启动：`node ai-overseer.js --config=config.ai-overseer.json`

> ⚠️ AI 督工会向真实终端注入命令，请务必在可控环境使用、限制 `maxIterations`、并审查 LLM 输出。建议先用只读/沙箱机器验证。

---

## 八、消息协议（二次开发参考）

所有消息为 **JSON over WebSocket**，首条消息决定连接角色（`register` = agent，`auth` = browser）。

### Client ↔ Server

| 方向 | type | 字段 | 说明 |
|------|------|------|------|
| C→S | `register` | `token, name, screen, attrs, sys, cols, rows` | 注册并携带系统信息 |
| C→S | `data` | `payload` | 终端输出（base64） |
| C→S | `ping` | — | 心跳 |
| S→C | `data` | `payload` | 键盘输入（base64） |
| S→C | `resize` | `cols, rows` | 终端尺寸变更 |
| S→C | `restart_screen` | — | 要求 agent 重启 screen 会话 |
| S→C | `kill` | — | 远程关停 agent |
| S→C | `pong` | — | 心跳响应 |
| 双向 | `file_*` | 见下 | 文件传输系列 |

### Browser ↔ Server

| 方向 | type | 字段 | 说明 |
|------|------|------|------|
| B→S | `auth` | `password, username` | 登录 |
| B→S | `connect` | `agentId, resume` | 连接单台机器 |
| B→S | `connect_multi` | `agentIds, resume` | 连接多台 |
| B→S | `data` | `payload, agentId` | 键盘输入 |
| B→S | `resize` | `cols, rows, agentId` | 尺寸变更 |
| B→S | `scrollback_more` | `agentId, fromIndex` | 懒加载更早历史 |
| S→B | `auth_ok` | `agents, user` | 登录成功 + 机器列表 |
| S→B | `agents` | `agents` | 机器上下线 / 定时刷新（10s） |
| S→B | `data` | `payload, agentId` | 终端输出（含历史回放） |
| S→B | `scrollback_info` / `scrollback_data` / `scrollback_end` | — | 历史缓冲元信息与分块 |
| S→B | `error` | `message` | 错误 |

### 文件传输（`file_*` 系列）

| type | 方向 | 说明 |
|------|------|------|
| `file_ls` / `file_ls_result` | B→S / S→B | 列目录（基于 screen 内 shell 的 `pwd`，限 `$HOME` 内） |
| `file_upload_start` / `file_upload_ack` / `file_chunk` / `file_chunk_ack` / `file_upload_end` / `file_upload_done` | 双向 | 分块上传（256KB/块，≤200MB） |
| `file_download_start` / `file_download_meta` / `file_download_chunk` / `file_download_end` | 双向 | 分块下载 |

---

## 九、安全建议

本项目定位为**可信内网 / 个人使用**的轻量方案，默认未启用 TLS。生产部署请注意：

- ✅ **前置 Nginx + TLS**：用 `wss://` 终止 TLS，避免密码明文传输。参考反代：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 86400;
  }
  ```

- ✅ **强密码 + 强 token**：`password` 和 `tokens` 都用高熵随机串。
- ✅ **token 白名单**：未登记 token 的连接会被立即断开。
- ✅ **文件传输沙箱**：上传/下载/列目录均限制在 agent 进程的 `$HOME` 内，路径逃逸会被拒绝。
- ✅ **限制 LLM 权限**：使用 AI 督工时设小 `maxIterations`，先在隔离机器验证。
- ⚠️ 浏览器密码默认存 localStorage 以便自动重连；如多人共用设备，请用完点"退出登录"清除。

---

## 十、常见问题 FAQ

**Q：内网机器连不上服务器？**
A：确认 `serverUrl` 的公网 IP/端口正确、服务器防火墙放行了该端口、内网机器能出站访问该端口。客户端日志会打印连接与重连信息。

**Q：终端空白 / 卡住？**
A：确认内网机器上确实存在配置里写的 screen 会话（`screen -ls`）。`screenMode:auto` 用 `-x`，要求会话已存在（可 attached）。

**Q：刷新页面后历史还在吗？**
A：在。服务端为每台机器缓存约 2MB 输出，重连后自动回放最近部分，更早的可点"加载更多"。

**Q：node-pty 安装失败？**
A：需要编译环境：`sudo apt-get install -y make g++ python3`（或对应发行版工具链）。建议直接用 Node 20 LTS。

**Q：能否不用 screen，直接开 shell？**
A：当前客户端围绕 screen 设计（`screen -x/-r`）。可自行改造 `client.js` 的 `spawnPty` 直接 spawn bash。

**Q：支持 tmux 吗？**
A：暂不直接支持，但 tmux 也可在 screen 会话里运行；原生 tmux attach 在 Roadmap 中。

**Q：多用户权限？**
A：目前仅靠 token 的 `user` 字段做简单隔离（不同用户看到不同机器），细粒度只读/读写权限在 Roadmap 中。

---

## 十一、项目结构

```
terminal-monitor/
├── package.json                       # 依赖：ws, node-pty
├── package-lock.json
├── .gitignore                         # 忽略真实配置、日志、node_modules
├── README.md                          # 本文档
│
├── server.js                          # 服务端：WS broker + HTTP 静态页 + scrollback
├── client.js                          # 客户端：PTY + screen + WS 上行 + 文件传输
├── supervisor.js                      # 可选：状态汇总 / 空闲告警 / webhook
├── ai-overseer.js                     # 可选：AI 督工，LLM 驱动终端任务
│
├── public/
│   └── index.html                     # 前端 SPA（xterm.js，CDN，零构建）
│
├── install.sh                         # 一键部署：server / client / debug
├── deploy.sh                          # 批量 scp 推送（读 deploy.targets.conf）
├── deploy.targets.example.conf        # 部署目标模板（复制为 .conf 后编辑）
├── backup.sh                          # git 备份 / 还原脚本
│
├── config.example.json                # 服务端配置模板
├── config.client.example.json         # 客户端配置模板
└── config.ai-overseer.example.json    # AI 督工配置模板
```

---

## License

MIT — 自由使用、修改、分发。欢迎提 issue / PR。
