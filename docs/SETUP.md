# Super Matrix 安装与首次启动

本文适用于 `v0.2.0`。当前仓库没有 `npm run init` 或二维码初始化向导；安装过程使用 lark-cli 的本地 profile 和飞书/Lark 开放平台配置。

## 1. 准备环境

- Node.js `>=22.0.0`
- npm、Git
- 一个飞书/Lark 内部应用
- 至少一个已登录的后端：Claude Code、Codex CLI 或 Kimi CLI
- 一台能长期在线且可写本地 runtime/workspace 目录的机器

```bash
node -v
npm -v
git --version
```

## 2. 安装依赖

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public
cp .env.example .env
cd supermatrix
npm ci
```

`.env`、SQLite、日志和 session 工作区必须留在本机，不能提交到 Git。

## 3. 配置飞书/Lark 应用

在开放平台为内部应用启用机器人和 WebSocket 事件订阅，订阅 `im.message.receive_v1`。至少准备以下能力：

- 收发群消息；
- 读取群和群成员；
- 以用户身份创建群；
- 邀请 owner 和机器人进入 session 群。

租户审批和 scope 名称可能随平台控制台变化；以 lark-cli 授权页实际显示为准。

## 4. 初始化 lark-cli

在 `supermatrix/` 目录执行：

```bash
npx lark-cli config init --app-id cli_YOUR_APP_ID --app-secret-stdin --name supermatrix
npx lark-cli profile use supermatrix
npx lark-cli auth login --scope "im:message im:message:readonly im:chat:read im:chat.members:read im:chat.members:write_only im:chat:create_by_user"
npx lark-cli auth status
```

`config init` 会安全读取 App Secret 并写入本机 lark-cli 配置。不要把 App Secret、tenant token 或 user token 写进仓库。

## 5. 创建 root console

先在根目录 `.env` 填写 `LARK_APP_ID`、`LARK_APP_SECRET` 和 `LARK_TENANT`，再执行：

```bash
set -a; source ../.env; set +a
npx lark-cli im +chat-create --as user --name "Super Matrix Console" --type private --bots "$LARK_APP_ID"
```

把返回的 `chat_id` 写入 `.env` 的 `SM_ROOT_GROUP_ID`。把 `npx lark-cli auth status` 返回的 owner `userOpenId` 写入 `SM_ROOT_USER_ID`。

最小配置：

```dotenv
SM_ROOT_GROUP_ID=oc_YOUR_ROOT_GROUP_CHAT_ID
SM_ROOT_USER_ID=ou_YOUR_OPEN_USER_ID
SM_WORKSPACE_ROOT=$HOME/SuperMatrixWorkspaces
SM_RUNTIME_ROOT=$HOME/SuperMatrixRuntime
SM_DB_PATH=$HOME/SuperMatrixRuntime/data/supermatrix.db
SM_BACKEND=claude
LARK_APP_ID=cli_YOUR_APP_ID
LARK_APP_SECRET=YOUR_LOCAL_APP_SECRET
LARK_TENANT=feishu
SM_API_PORT=3501
SM_SCHEDULER_BASE_URL=http://127.0.0.1:3502
```

完整变量见 [CONFIGURATION.md](CONFIGURATION.md)。

## 6. 登录后端 CLI

至少完成一组：

```bash
claude login
claude --version
```

```bash
codex login
codex --version
codex exec -- "Reply with exactly OK"
```

```bash
kimi --version
```

只在 `.env` 中设置本机账号确实可用的默认模型。不要把模型账号凭证提交到仓库。

## 7. 自检与启动

```bash
set -a; source ../.env; set +a
npm run self-check
npm start
```

首次启动会创建或迁移核心 SQLite schema。启动日志应显示 API 监听 `SM_API_PORT`，并成功监听 root console 群。

在 root console 群依次发送：

```text
/help
/status
/new claude alpha
```

进入新建的 `alpha` 群发送普通消息，确认本机 CLI 被调用且结果回到原群。使用其他后端时把 `claude` 改为 `codex` 或 `kimi`。

## 8. 验证 v0.2.0 能力

1. 在运行中的 Claude/Codex session 发送 `/now 补充说明`，确认只有当前 run 接收成功时才返回成功。
2. 发送 `/branch`，再用 `/branch experiment` 创建并切换上下文分支。
3. 发起一个 Spawn2.0 异步任务，使用返回的 `resultUrl` 执行 `POST .../take`，确认 `commStatus=completed` 且 `finalMessage` 非空。
4. 在 root console 发送 `/usage`，确认输出不包含 token、邮箱或本地配置路径。

## 9. 可选：启动 Scheduler v2

Scheduler v2 是独立服务，默认端口 `3502`：

```bash
cd ../platform/scheduler
npm ci
npm run build
set -a; source ../../.env; set +a
node dist/main.js
```

根目录 `.env` 至少需要：

```dotenv
SCHEDULER_V2_PORT=3502
SCHEDULER_V2_DB=$HOME/SuperMatrixRuntime/scheduler-v2/scheduler.db
SM_DB=$HOME/SuperMatrixRuntime/data/supermatrix.db
SM_BASE_URL=http://127.0.0.1:3501
SCHEDULER_ADMIN_TOKEN=REPLACE_WITH_LOCAL_SECRET
```

`GET http://127.0.0.1:3502/health` 只能证明 Scheduler 服务健康。一次 task run 的 success 只证明点火成功，业务完成仍由目标 session 验收。

## 10. 可选：macOS 长保活

确认手动启动已成功后再安装：

```bash
cd ../../supermatrix
./scripts/launchd/install.sh
```

也可前台运行：

```bash
./scripts/localwatch.sh
```

公开 `localwatch` 默认检查 Super Matrix `3501` 和 Scheduler v2 `3502`。Linux/Windows 需要自行配置进程管理器。

## 11. 常见失败

- **群里无回复**：检查 lark-cli profile、用户授权、机器人是否在群内、WebSocket 事件订阅和 `SM_ROOT_GROUP_ID`。
- **只能 @ 机器人后响应**：先确认 session 是否被标记为 `外部`；内部 session 再检查消息 scope 与事件订阅。
- **`self-check` 失败**：按输出顺序修复第一个错误，常见原因是 Node 版本、端口占用、路径不可写或后端 CLI 未登录。
- **Scheduler 连接失败**：确认只启动 3502，`SM_SCHEDULER_BASE_URL` 与 `SCHEDULER_V2_PORT` 一致。

更多排查见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
