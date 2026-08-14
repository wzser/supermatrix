# Super Matrix

**语言：** 中文 | [English](README.en.md)

Super Matrix 把 Claude Code、Codex CLI 和 Kimi CLI 接入飞书/Lark，形成一套本地执行、多人可用、可审计的多 Agent 协作系统。每个 session 有独立群聊、工作区、后端上下文和运行状态；代码、数据与凭证仍留在本机。

当前版本：`v0.2.0`。完整变更见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

## v0.2.0 新增的平台能力

- **运行中即时补充指令**：`/now <说明>` 可向当前 Claude/Codex run 注入补充信息。只有同一 run 明确确认接收才返回成功；空闲 session 不会因此启动新任务，Kimi 暂不支持。
- **session 对话分支**：`/branch` 在同一工作区内创建、查看和切换后端上下文分支，不创建 Git branch，也不复制工作区。
- **`localgit` 平台模块**：接管本地仓库 daily commit、hold/ledger、分支收敛和可审计裁决；高风险文件不自动提交。
- **`gitmaster` 发布模块**：新增闭合白名单导出、双语私有关键词替换、secret/PII 扫描、发布证据和远端 HEAD 核验流程。

## v0.2.0 更新的平台能力

- **Spawn2.0 结果消费**：异步结果使用返回的 `resultUrl` 显式 `POST .../take` 消费；普通 GET 保持只读，并记录调用方消费状态，减少重复投递。
- **Scheduler v2 成为唯一公开实现**：服务端口为 `3502`。调度器的 success 只证明任务已点火，不替代目标 session 的业务验收。
- **后端运行时控制更完整**：统一 backend/model/effort 默认值，补充 Kimi 模型边界、重启来源记录和进程观测能力。
- **额度展示收紧**：`/usage` 只渲染安全投影字段，不展示 token、账号邮箱或本地配置路径。
- **公开守护链路更新**：`localwatch` 使用通用公开模板，默认检查 Scheduler v2 的 `3502` 端口；daily commit 职责从 Watchdog 迁移到 `localgit`，Watchdog 聚焦运行时、CLI、升级与敏感信息健康检查。
- **生产依赖基线更新**：升级核心 Lark SDK/HTTP 依赖和 Scheduler Hono 依赖，移除 localgit、Watchdog 未使用的 Anthropic SDK；发布门禁要求四个 Node 模块的生产依赖审计为零漏洞。

## 从 v0.1.0 升级

升级前备份根目录 `.env`、`SM_DB_PATH` 指向的 SQLite 数据库，以及需要保留的 session 工作区。不要把这些文件复制进 Git 仓库。

```bash
git fetch --tags origin
git checkout v0.2.0
cd supermatrix
npm ci
set -a; source ../.env; set +a
npm run self-check
npm run verify
```

升级时必须检查以下变化：

1. Node.js 最低版本从旧文档中的 20 调整为 **22**。
2. 仓库不再提供 `npm run init` 二维码向导；首次安装和缺失配置按 [docs/SETUP.md](docs/SETUP.md) 手动初始化 lark-cli 与 root console 群。
3. 把 `SM_SCHEDULER_BASE_URL` 改为 `http://127.0.0.1:3502`，并为 Scheduler v2 配置 `SCHEDULER_ADMIN_TOKEN`。
4. 不再启动旧的 3500 Scheduler；检查 launchd、shell 脚本和反向代理里是否仍引用 3500。
5. daily commit 自动化改由 `platform/localgit` 承担；不要同时保留 Watchdog 的旧 daily-commit 定时入口。
6. 第一次启动会应用核心 SQLite migration。启动后再运行 `/status`、`/branch` 和一次 Spawn2.0 异步结果消费验证。

## 适用场景与限制

- 适合已经使用本地 CLI Agent、需要通过飞书/Lark 远程派活和多人协作的个人或小团队。
- 核心运行时可在常见 Node.js 环境运行，但仓库提供的长保活脚本目前只在 macOS launchd 上验证。
- 需要一台长期在线的机器，并自行完成飞书/Lark 应用权限、后端 CLI 登录和网络配置。
- 这是本地优先的协作框架，不是多租户 SaaS；关键动作仍应保留人工 review 和独立验收。

## 快速开始

### 前置条件

| 项目 | 要求 |
|---|---|
| Node.js | `>=22.0.0` |
| 飞书/Lark | 可创建内部应用并配置 WebSocket 事件订阅 |
| 后端 | 至少登录 Claude Code、Codex CLI 或 Kimi CLI 之一 |
| 本机 | Git、npm、可写的 runtime 与 workspace 目录 |

### 安装核心运行时

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public
cp .env.example .env
cd supermatrix
npm ci
```

初始化 lark-cli profile 和用户授权：

```bash
npx lark-cli config init --app-id cli_YOUR_APP_ID --app-secret-stdin --name supermatrix
npx lark-cli profile use supermatrix
npx lark-cli auth login --scope "im:message im:message:readonly im:chat:read im:chat.members:read im:chat.members:write_only im:chat:create_by_user"
npx lark-cli auth status
```

创建 root console 群：

```bash
set -a; source ../.env; set +a
npx lark-cli im +chat-create --as user --name "Super Matrix Console" --type private --bots "$LARK_APP_ID"
```

把返回的 `chat_id` 写入 `.env` 的 `SM_ROOT_GROUP_ID`，把 `auth status` 返回的 owner `userOpenId` 写入 `SM_ROOT_USER_ID`。然后运行：

```bash
set -a; source ../.env; set +a
npm run self-check
npm start
```

在 root console 群发送：

```text
/help
/status
/new claude alpha
```

完整的应用权限、事件订阅和首轮验证步骤见 [docs/SETUP.md](docs/SETUP.md)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `/new <backend> <name>` | 创建 session、群聊和本地工作区 |
| `/status` | 查看全部或指定 session 状态 |
| `/now <text>` | 向当前 Claude/Codex run 注入补充说明 |
| `/next <text>` | 当前任务完成后按 FIFO 执行后续任务 |
| `/branch [name]` | 查看、创建或切换对话分支 |
| `/cancel` | 终止当前运行；`/cancel next` 只清空队列 |
| `/reset` | 清空后端上下文但保留工作区文件 |
| `/usage` | 查看经过安全投影的额度快照 |
| `/help` | 查看运行时完整命令帮助 |

命令范围和副作用见 [docs/COMMANDS.md](docs/COMMANDS.md)。

## 系统组成

```text
飞书/Lark 群
  -> Super Matrix API / CLI
  -> 本地 SQLite 状态库
  -> 独立 session 工作区
  -> Claude Code / Codex / Kimi CLI
```

`supermatrix/` 是核心运行时。`platform/` 中的模块按需启用：

| 模块 | 公开能力 |
|---|---|
| `first-principle` | 身份模板、原则装配和 session 元数据治理 |
| `scheduler` | Scheduler v2 定时点火、运行记录和管理 API |
| `heartbeat` | 卡住或未完成 session 的证据化巡检 |
| `autobitable` | 通用飞书多维表格 webhook adapter 与台账同步 |
| `watchdog` | runtime、CLI、升级和安全健康检查 |
| `skill-master` | 可复用 skill 的注册、同步和评估 |
| `socail-king` | 跨 session 交接与异常闭环复盘；目录名保留历史拼写 |
| `mythos` | 本地知识库模板、索引与引用工具 |
| `localgit` | 本地 Git 日结、hold/ledger 与分支收敛 |
| `gitmaster` | 脱敏快照、扫描、tag 和 GitHub 发布流程 |

平台模块不是核心首次启动的前置条件，也不会因为存在于仓库中就自动运行。

## 数据与安全边界

这个仓库是脱敏发布目标，不是 live runtime 镜像。公开树不应包含：

- `.env*`、API key、token、SSH/deploy key 或本地账号配置；
- 真实飞书/Lark/Bitable 对象 ID、人员姓名、联系方式、公司/品牌/产品关键词；
- SQLite、日志、聊天记录、CSV/JSONL 导出、截图、媒体、archive 或大型生成物；
- session 业务工作区、原始运行数据和私有绝对路径。

发布扫描、排除项与证据摘要见 [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md)。发现疑似凭证时应立即轮换；从最新 tree 删除并不能清除 Git 历史中的旧对象。

## 开发与验证

```bash
cd supermatrix
npm run typecheck
npm run test:unit
npm run test:adapters
npm run test:e2e
npm run verify
```

配置索引见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)，故障排查见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。发布流程见 [platform/gitmaster/sop/SOP-sanitized-github-release-active-20260814-rpidv7.md](platform/gitmaster/sop/SOP-sanitized-github-release-active-20260814-rpidv7.md)。
