# Setup

**语言：** 中文 | [English](SETUP.en.md)

本页是 Super Matrix 公开仓库的端到端初始化指南。核心原则是：真实凭证和运行数据只放在本机，仓库里只保留源码、模板、示例配置和文档。

## 1. 准备本机依赖

- macOS 或 Linux
- Node.js 22 或更新版本
- npm
- Git
- 至少一个已登录的后端 CLI：Claude Code、Codex 或 Kimi

验证本机工具：

```bash
node --version
npm --version
git --version
```

## 2. 克隆并安装核心运行时

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public
cd supermatrix
npm install
```

`npm run verify` 会执行依赖检查、TypeScript 检查和测试套件；第一次安装可以先跳过，等 `npm run init` 完成后再跑。

## 3. 运行二维码初始化向导

```bash
npm run init
```

默认初始化路径参考 `feishu-claude-code-bridge` 的机制，走飞书/Lark PersonalAgent 二维码向导：

1. 终端显示二维码。
2. 用飞书/Lark App 扫码。
3. 创建或选择 PersonalAgent 应用。
4. 初始化器把返回的 App ID、App Secret、tenant 和扫码用户 `open_id` 写入本机根目录 `.env`。
5. 初始化器用 `lark-cli config init --app-secret-stdin` 绑定本地 `supermatrix` profile。
6. 初始化器执行 `lark-cli auth login`，让你授权建群、发消息和读群消息所需 scope。
7. 初始化器创建 `Super Matrix Console` root console 群，并把 `chat_id` 写入 `SM_ROOT_GROUP_ID`。
8. 初始化器创建 `SM_WORKSPACE_ROOT`、`SM_RUNTIME_ROOT` 和 SQLite 目录，并运行 `npm run self-check`。

真实 App Secret、tenant token、user token、auth token 和生成的 `.env` 都只留在本机，不要提交到 Git。

如果你只想生成配置、不想立刻跑完整检查，可以使用：

```bash
npm run init -- --skip-self-check
```

如果你的租户不允许 PersonalAgent 自动建群，可以先跳过建群，之后手动创建 root console 并回填 `SM_ROOT_GROUP_ID`：

```bash
npm run init -- --skip-root-group
```

## 4. PersonalAgent 需要的飞书/Lark 权限

初始化器会请求这些 scope：

- Bot 能力
- WebSocket 事件订阅
- `im.message.receive_v1`
- 消息发送和读取权限
- 群信息读取权限
- 群成员读取/写入权限
- 以用户身份建群权限

这些权限用于接收群消息、回复消息、创建 session 群、邀请 owner，并把 root console 和 session 群绑定到本地 runtime。

如果 session 只有 @ 机器人时才响应，先确认该 session 是否被标成 `外部`；只有 `外部` session 会故意要求 @。如果不是 `外部` 仍收不到普通消息，再检查应用是否真的订阅并投递 `im.message.receive_v1`，以及机器人消息读取/群读取权限是否已授权。

## 5. 手动回退：初始化 lark-cli

正常情况下不需要手动执行这一节；`npm run init` 会自动完成。若二维码向导或 `lark-cli` profile 绑定失败，可以在 `supermatrix` 目录手动执行：

```bash
npx lark-cli config init --app-id cli_YOUR_APP_ID --app-secret-stdin --name supermatrix
npx lark-cli profile use supermatrix
npx lark-cli auth login --scope "im:message im:message:readonly im:chat:read im:chat.members:read im:chat.members:write_only im:chat:create_by_user"
npx lark-cli auth status
```

`config init` 会写入本机 lark-cli 配置。App Secret、tenant token、user token 等都必须留在本机，不要提交到 Git。

创建 root console 群：

```bash
set -a; source ../.env; set +a
npx lark-cli im +chat-create --as user --name "Super Matrix Console" --type private --bots "$LARK_APP_ID"
```

把返回的 `chat_id` 写入根目录 `.env` 的 `SM_ROOT_GROUP_ID`。把 `auth status` 里 owner 的 `userOpenId` 写入 `SM_ROOT_USER_ID`。

## 6. 登录后端 CLI

Claude Code：

```bash
claude login
claude --version
```

Codex：

```bash
codex login
codex --version
codex exec -- "Reply with exactly OK"
```

Kimi：

```bash
kimi login
kimi info
```

只配置本机账号确实能用的模型。模型 API key 或 provider key 放在本机 shell、密码管理器或未跟踪的 `.env`，不要写入仓库文件。

## 7. 检查生成的 `.env`

`npm run init` 会生成或更新根目录 `.env`。最小配置应包含：

```bash
SM_ROOT_GROUP_ID=oc_YOUR_ROOT_GROUP_CHAT_ID
SM_ROOT_USER_ID=ou_YOUR_OPEN_USER_ID
SM_WORKSPACE_ROOT=$HOME/SuperMatrixWorkspaces
SM_RUNTIME_ROOT=$HOME/SuperMatrixRuntime
SM_DB_PATH=$HOME/SuperMatrixRuntime/data/supermatrix.db
SM_BACKEND=claude
SM_LOG_LEVEL=info
LARK_APP_ID=cli_YOUR_APP_ID
LARK_APP_SECRET=YOUR_LOCAL_APP_SECRET
LARK_TENANT=feishu
SM_API_PORT=3501
SM_LARK_CLI_PATH=/ABS/PATH/TO/supermatrix-public/supermatrix/node_modules/.bin/lark-cli
```

常用可选项：

```bash
SM_API_BASE=http://localhost:3501
SM_CLAUDE_DEFAULT_MODEL=YOUR_CLAUDE_MODEL
SM_CODEX_DEFAULT_MODEL=YOUR_CODEX_MODEL
SM_KIMI_CLI_PATH=kimi
```

完整变量索引见 [CONFIGURATION.md](CONFIGURATION.md)。

## 8. 启动并验证

```bash
cd supermatrix
set -a; source ../.env; set +a
npm run self-check
npm start
```

在 root console 群里验证：

```text
/help
/status
/new claude alpha
```

`/new <backend> <name>` 会创建 session。`/new claude alpha` 会创建：

- session 记录
- `alpha` 对应的飞书/Lark 群
- `SM_WORKSPACE_ROOT/alpha` 本地工作区
- 该 session 的身份文件和 catalog 引用

进入新建的 `alpha` 群，发送普通消息。普通消息会作为 prompt 交给后端 CLI 执行；斜杠命令用于控制 Super Matrix 本身。

如果使用 Codex，发送：

```text
/new codex alpha
```

如果希望本机长期保活，macOS 可安装 localwatch：

```bash
./scripts/launchd/install.sh
```

非 launchd 环境可以先直接运行：

```bash
./scripts/localwatch.sh
```

建议额外创建一个绑定到 Super Matrix 源码目录的根目录 session，让它自动发送剩余平台 session 的 `/new` 命令。先在 root console 群发送：

```text
/new claude supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

如果使用 Codex，则改为：

```text
/new codex supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

创建后，把 README “第一次使用”里的初始化助手 prompt 粘贴到 `Super Matrix Root` 群，让它创建 `first-principle`、`scheduler`、`heartbeat`、`autobitable`、`watchdog`、`skill-master` 等平台群。

## 9. 可选平台组件

核心运行时启动后，再按需配置平台组件：

- scheduler：定时任务和任务生命周期，配置 `SCHEDULER_DB_PATH`、`SCHEDULER_SPAWN_API_URL`、`SCHEDULER_NOTIFY_API_URL`。
- heartbeat：卡住任务和未完成事项巡检。它不是 `npm run init` 后自动可用；需要先确保 Super Matrix API 正在运行，配置 `SM_API_BASE`、`SM_DB_PATH`、`HEARTBEAT_SESSION`、`HEARTBEAT_STATE_DB`，并提供控制模型 key，例如 `HEARTBEAT_MINIMAX_API_KEY` 或 `MINIMAX_API_KEY`。通常再由 scheduler 定时触发 `platform/heartbeat/scripts/heartbeat-patrol`。如果要把触发事件同步到飞书表，还要配置 `HEARTBEAT_LOG_FEISHU_BASE_TOKEN` 和 `HEARTBEAT_LOG_FEISHU_TABLE_ID`。
- autobitable：飞书多维表格 webhook adapter。这个能力依赖公网 HTTPS 入口；用户需要自备域名和服务器/反向代理，把飞书请求转发到本机 adapter，再配置 `AUTOBITABLE_PORT`、`AUTOBITABLE_REGISTRY_PATH`、`AUTOBITABLE_PUBLIC_WEBHOOK_URL`。
- watchdog：daily-commit 和 repo 巡检，配置 `WATCHDOG_DB_PATH`、`WATCHDOG_LARK_CLI_PATH` 和需要同步的 Bitable/Chat ID。
- skill-master：共享 skill 清单和评估同步，配置 `SKILL_MASTER_FEISHU_BASE_TOKEN`、`SKILL_MASTER_FEISHU_TABLE_ID` 等 Feishu 目标。

这些组件的真实 API key、base token、table ID、chat ID、webhook secret、域名和服务器地址都应留在本机 `.env` 或本机私有配置里。公开仓库不会提供或暴露任何可直接使用的 autobitable 服务器地址或 heartbeat 控制模型密钥。

## 10. 常见问题

### 飞书/Lark 没有回复

检查 lark-cli 是否登录、机器人是否在 root console 群里、WebSocket 事件订阅是否启用、`SM_ROOT_GROUP_ID` 是否是正确 `chat_id`。

### `/new` 不能创建群

检查应用是否有以用户身份建群权限，`LARK_APP_ID` 是否正确，owner 是否已完成 `lark-cli auth login`。

### session 创建了但任务不执行

检查 `SM_WORKSPACE_ROOT` 是否可写，后端 CLI 是否能在普通终端单独运行，模型是否对当前账号可用。

### `npm run self-check` 失败

先修复输出里的第一项错误。常见原因是 Node 版本不够、端口被占用、`.env` 缺项、SQLite 路径不可写、后端 CLI 未登录。

### 能不能把运行数据也提交

不要提交。SQLite、日志、JSONL/CSV 导出、session 工作区、业务仓库、API key、deploy key 都是本机私有数据。公开边界见 [../SANITIZATION_REPORT.md](../SANITIZATION_REPORT.md)。
