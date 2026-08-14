# Super Matrix Installation and First Run

This guide applies to `v0.2.0`. The repository does not provide an `npm run init` or QR setup wizard. Setup uses a local lark-cli profile and a Feishu/Lark developer application.

## 1. Prepare the Environment

- Node.js `>=22.0.0`
- npm and Git
- A Feishu/Lark internal application
- At least one authenticated backend: Claude Code, Codex CLI, or Kimi CLI
- An always-on machine with writable runtime and workspace directories

```bash
node -v
npm -v
git --version
```

## 2. Install Dependencies

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public
cp .env.example .env
cd supermatrix
npm ci
```

Keep `.env`, SQLite databases, logs, and session workspaces local. Never commit them.

## 3. Configure the Feishu/Lark App

Enable the bot and WebSocket event delivery for the internal app, including `im.message.receive_v1`. Prepare permissions for:

- sending and receiving chat messages;
- reading chats and chat members;
- creating chats as the authorized user;
- inviting the owner and bot to session chats.

Tenant approval behavior and scope names can change. Use the permissions shown by the current lark-cli authorization page.

## 4. Initialize lark-cli

Run from `supermatrix/`:

```bash
npx lark-cli config init --app-id cli_YOUR_APP_ID --app-secret-stdin --name supermatrix
npx lark-cli profile use supermatrix
npx lark-cli auth login --scope "im:message im:message:readonly im:chat:read im:chat.members:read im:chat.members:write_only im:chat:create_by_user"
npx lark-cli auth status
```

`config init` reads the App Secret from stdin and writes local lark-cli configuration. Never commit App Secrets, tenant tokens, or user tokens.

## 5. Create the Root Console

First fill `LARK_APP_ID`, `LARK_APP_SECRET`, and `LARK_TENANT` in the root `.env`, then run:

```bash
set -a; source ../.env; set +a
npx lark-cli im +chat-create --as user --name "Super Matrix Console" --type private --bots "$LARK_APP_ID"
```

Write the returned `chat_id` to `SM_ROOT_GROUP_ID` in `.env`. Write the owner's `userOpenId` from `npx lark-cli auth status` to `SM_ROOT_USER_ID`.

Minimum configuration:

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

See [CONFIGURATION.md](CONFIGURATION.md) for the full variable index.

## 6. Authenticate a Backend CLI

Complete at least one group:

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

Set only default models that the local account can actually use. Keep model-provider credentials outside Git.

## 7. Self-check and Start

```bash
set -a; source ../.env; set +a
npm run self-check
npm start
```

The first startup creates or migrates the core SQLite schema. Logs should show the API listening on `SM_API_PORT` and the root console listener running.

Send these commands in the root console chat:

```text
/help
/status
/new claude alpha
```

Send a normal message in the new `alpha` chat and verify that the local CLI runs and replies in the same chat. Replace `claude` with `codex` or `kimi` for another backend.

## 8. Verify v0.2.0 Capabilities

1. During an active Claude/Codex run, send `/now additional context` and verify success is reported only when the current run accepts it.
2. Send `/branch`, then `/branch experiment` to create and switch a context branch.
3. Start one asynchronous Spawn2.0 request and `POST` to its returned `resultUrl`; verify `commStatus=completed` and a non-empty `finalMessage`.
4. Send `/usage` in the root console and verify the response contains no token, email address, or local configuration path.

## 9. Optional: Start Scheduler v2

Scheduler v2 is a separate service on port `3502` by default:

```bash
cd ../platform/scheduler
npm ci
npm run build
set -a; source ../../.env; set +a
node dist/main.js
```

The root `.env` needs at least:

```dotenv
SCHEDULER_V2_PORT=3502
SCHEDULER_V2_DB=$HOME/SuperMatrixRuntime/scheduler-v2/scheduler.db
SM_DB=$HOME/SuperMatrixRuntime/data/supermatrix.db
SM_BASE_URL=http://127.0.0.1:3501
SCHEDULER_ADMIN_TOKEN=REPLACE_WITH_LOCAL_SECRET
```

`GET http://127.0.0.1:3502/health` proves only that Scheduler is healthy. A successful task run proves triggering, not completion of the target session's business work.

## 10. Optional: macOS Supervision

Install launchd only after manual startup works:

```bash
cd ../../supermatrix
./scripts/launchd/install.sh
```

Or run the supervisor in the foreground:

```bash
./scripts/localwatch.sh
```

The public `localwatch` template checks Super Matrix on `3501` and Scheduler v2 on `3502`. Configure your own service manager on Linux or Windows.

## 11. Common Failures

- **No chat reply:** check the lark-cli profile, user authorization, bot membership, WebSocket event subscription, and `SM_ROOT_GROUP_ID`.
- **Only @-mentions work:** first check whether the session is categorized as external; otherwise inspect message scopes and event delivery.
- **`self-check` fails:** fix the first reported error. Common causes are Node version, port conflicts, unwritable paths, or an unauthenticated backend CLI.
- **Scheduler connection fails:** run only port 3502 and keep `SM_SCHEDULER_BASE_URL` aligned with `SCHEDULER_V2_PORT`.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for additional diagnostics.
