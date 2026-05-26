# Setup

**Language:** [中文](SETUP.md) | English

This is the end-to-end setup guide for the public Super Matrix repository. The core rule is simple: real credentials and runtime data stay local; the repository only contains source code, templates, example config, and documentation.

## 1. Prepare Local Dependencies

- macOS or Linux
- Node.js 22 or newer
- npm
- Git
- At least one logged-in backend CLI: Claude Code, Codex, or Kimi

Verify local tools:

```bash
node --version
npm --version
git --version
```

## 2. Clone And Install The Core Runtime

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public
cd supermatrix
npm install
```

`npm run verify` runs dependency checks, TypeScript checks, and test suites.
For first setup, you can run it after `npm run init` completes.

## 3. Run The QR Initialization Wizard

```bash
npm run init
```

The default initialization path follows the `feishu-claude-code-bridge` style
and uses a Feishu/Lark PersonalAgent QR wizard:

1. The terminal renders a QR code.
2. Scan it with the Feishu/Lark app.
3. Create or select a PersonalAgent app.
4. The initializer writes the returned App ID, App Secret, tenant, and scanner
   `open_id` to the local root `.env`.
5. The initializer binds a local `supermatrix` lark-cli profile with
   `lark-cli config init --app-secret-stdin`.
6. The initializer runs `lark-cli auth login` so you can grant the scopes for
   chat creation, message send/read, and group message handling.
7. The initializer creates the `Super Matrix Console` root console group and writes
   its `chat_id` to `SM_ROOT_GROUP_ID`.
8. The initializer creates `SM_WORKSPACE_ROOT`, `SM_RUNTIME_ROOT`, and SQLite
   directories, then runs `npm run self-check`.

Real App Secrets, tenant tokens, user tokens, auth tokens, and generated `.env`
files stay local-only. Do not commit them.

To generate config without running the final self-check:

```bash
npm run init -- --skip-self-check
```

If your tenant does not allow the PersonalAgent to create groups automatically,
skip group creation, then manually create the root console and fill
`SM_ROOT_GROUP_ID`:

```bash
npm run init -- --skip-root-group
```

## 4. Required Feishu/Lark Permissions

The initializer requests these scopes:

- Bot capability
- WebSocket event subscription
- `im.message.receive_v1`
- message send/read scopes
- chat read scope
- chat member read/write scopes
- user-created chat scope

These permissions let Super Matrix receive group messages, reply, create session groups, invite the owner, and bind the root console/session groups to the local runtime.

If a session only responds when the bot is @ mentioned, first check whether that
session is marked `外部`; only `外部` sessions intentionally require mentions. If
it is not `外部` and plain messages still do not arrive, verify that the app
subscribes to and receives `im.message.receive_v1`, and that bot message
read/chat read permissions have been granted.

## 5. Manual Fallback: Initialize lark-cli

Normally this is not needed because `npm run init` does it. If the QR wizard or
lark-cli profile binding fails, run this from `supermatrix`:

```bash
npx lark-cli config init --app-id cli_YOUR_APP_ID --app-secret-stdin --name supermatrix
npx lark-cli profile use supermatrix
npx lark-cli auth login --scope "im:message im:message:readonly im:chat:read im:chat.members:read im:chat.members:write_only im:chat:create_by_user"
npx lark-cli auth status
```

`config init` writes local lark-cli config. Keep App Secret, tenant tokens, user tokens, and generated credentials outside Git.

Create the root console group:

```bash
set -a; source ../.env; set +a
npx lark-cli im +chat-create --as user --name "Super Matrix Console" --type private --bots "$LARK_APP_ID"
```

Write the returned `chat_id` to `SM_ROOT_GROUP_ID` in the root `.env`. Write the owner's `userOpenId` from `auth status` to `SM_ROOT_USER_ID`.

## 6. Log In To Backend CLIs

Claude Code:

```bash
claude login
claude --version
```

Codex:

```bash
codex login
codex --version
codex exec -- "Reply with exactly OK"
```

Kimi:

```bash
kimi login
kimi info
```

Only configure models your local account can actually use. Keep model API keys or provider keys in your local shell, password manager, or untracked `.env`; do not commit them.

## 7. Check The Generated `.env`

`npm run init` creates or updates the root `.env`. The minimum config should include:

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

Common optional values:

```bash
SM_API_BASE=http://localhost:3501
SM_CLAUDE_DEFAULT_MODEL=YOUR_CLAUDE_MODEL
SM_CODEX_DEFAULT_MODEL=YOUR_CODEX_MODEL
SM_KIMI_CLI_PATH=kimi
```

See [CONFIGURATION.md](CONFIGURATION.md) for the full environment variable index.

## 8. Start And Verify

```bash
cd supermatrix
set -a; source ../.env; set +a
npm run self-check
npm start
```

In the root console group:

```text
/help
/status
/new claude alpha
```

`/new <backend> <name>` creates a session. `/new claude alpha` creates:

- a session record
- a Feishu/Lark group for `alpha`
- a local workspace at `SM_WORKSPACE_ROOT/alpha`
- identity files and catalog references for the session

Enter the new `alpha` group and send a normal message. Normal messages become prompts for the backend CLI; slash commands control Super Matrix itself.

If you use Codex, send:

```text
/new codex alpha
```

To keep the local runtime alive, install localwatch on macOS:

```bash
./scripts/launchd/install.sh
```

On non-launchd environments, start it directly first:

```bash
./scripts/localwatch.sh
```

I also recommend creating a root session bound to the Super Matrix source
directory, then using it to send the remaining platform `/new` commands. In the
root console group, send:

```text
/new claude supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

If you use Codex:

```text
/new codex supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

After it is created, paste the initialization assistant prompt from the README
First Run section into the `Super Matrix Root` group. It will create platform
groups such as `first-principle`, `scheduler`, `heartbeat`, `autobitable`,
`watchdog`, and `skill-master`.

## 9. Optional Platform Components

After the core runtime starts, configure platform components as needed:

- scheduler: timed tasks and task lifecycle. Configure `SCHEDULER_DB_PATH`, `SCHEDULER_SPAWN_API_URL`, and `SCHEDULER_NOTIFY_API_URL`.
- heartbeat: stuck-run and unfinished-work patrols. It is not automatically usable after `npm run init`; first make sure the Super Matrix API is running, configure `SM_API_BASE`, `SM_DB_PATH`, `HEARTBEAT_SESSION`, and `HEARTBEAT_STATE_DB`, and provide a controller model key such as `HEARTBEAT_MINIMAX_API_KEY` or `MINIMAX_API_KEY`. Usually scheduler then calls `platform/heartbeat/scripts/heartbeat-patrol` on a fixed interval. To sync triggered events to a Feishu table, also configure `HEARTBEAT_LOG_FEISHU_BASE_TOKEN` and `HEARTBEAT_LOG_FEISHU_TABLE_ID`.
- autobitable: Feishu Bitable webhook adapter. This requires a public HTTPS ingress. Provide your own domain and server/reverse proxy, forward Feishu requests to the local adapter, then configure `AUTOBITABLE_PORT`, `AUTOBITABLE_REGISTRY_PATH`, and `AUTOBITABLE_PUBLIC_WEBHOOK_URL`.
- watchdog: daily-commit and repo patrols. Configure `WATCHDOG_DB_PATH`, `WATCHDOG_LARK_CLI_PATH`, and any Bitable/chat IDs you want to sync.
- skill-master: shared skill index and evaluation sync. Configure `SKILL_MASTER_FEISHU_BASE_TOKEN`, `SKILL_MASTER_FEISHU_TABLE_ID`, and related Feishu targets.

Real API keys, base tokens, table IDs, chat IDs, webhook secrets, domains, and server addresses belong in local `.env` or private local config only. The public repository does not provide or expose any ready-to-use autobitable server address or heartbeat controller model key.

## 10. FAQ

### Feishu/Lark does not reply

Check that lark-cli is logged in, the bot is in the root console group, WebSocket event subscription is enabled, and `SM_ROOT_GROUP_ID` is the correct `chat_id`.

### `/new` cannot create a group

Check the user-created chat scope, `LARK_APP_ID`, and whether the owner completed `lark-cli auth login`.

### A session was created but work does not run

Check that `SM_WORKSPACE_ROOT` is writable, the backend CLI works in a normal terminal, and the selected model is available to your account.

### `npm run self-check` fails

Fix the first reported error first. Common causes are old Node versions, port conflicts, missing `.env` values, unwritable SQLite paths, or backend CLI login issues.

### Should runtime data be committed?

No. SQLite databases, logs, JSONL/CSV exports, session workspaces, business repositories, API keys, and deploy keys are local-only. See [../SANITIZATION_REPORT.md](../SANITIZATION_REPORT.md) for the public boundary.
