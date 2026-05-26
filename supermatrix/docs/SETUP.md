# SuperMatrix Setup

This document is the public-safe setup guide for the SuperMatrix runtime inside
the Super Matrix repository. It assumes secrets and runtime data are created locally
after cloning the repository.

For the end-to-end repository setup path, start with
`../../docs/SETUP.md`. This file is the lower-level core runtime setup note.

## Requirements

- macOS or Linux
- Node.js 22 or newer
- npm
- Git
- A Feishu/Lark account that can create or select a PersonalAgent app through
  the QR initialization wizard
- Claude Code CLI, Codex CLI, or Kimi CLI, with local login completed for the
  backend you plan to use

## Install

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public/supermatrix
npm install
npm run init
```

`npm run init` displays a QR code, creates or selects a Feishu/Lark
PersonalAgent app, binds the local lark-cli profile, completes user
authorization, creates the `Super Matrix Console` root group, writes the root
repository `.env`, creates local runtime directories, and runs:

```bash
npm run self-check
```

## Feishu/Lark App

The default setup path uses `npm run init`. It requests the capabilities Super Matrix
needs:

- Bot capability
- WebSocket event subscription
- `im.message.receive_v1`
- message send/read scopes
- chat read scope
- chat member read/write scopes
- user-created chat scope for `/new`

Manual fallback:

```bash
npx lark-cli config init --app-id cli_YOUR_APP_ID --app-secret-stdin --name supermatrix
npx lark-cli profile use supermatrix
npx lark-cli auth login --scope "im:message im:message:readonly im:chat:read im:chat.members:read im:chat.members:write_only im:chat:create_by_user"
npx lark-cli auth status
```

Keep App Secret, tenant tokens, user tokens, and generated credentials outside
Git. The repository only contains placeholders.

## Environment

`npm run init` writes the root repository `.env`. Minimum configuration:

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
```

Useful optional variables:

```bash
SM_LARK_CLI_PATH=/ABS/PATH/TO/supermatrix-public/supermatrix/node_modules/.bin/lark-cli
SM_ENV_FILE=/ABS/PATH/TO/supermatrix-public/.env
LOCALWATCH_SELFCHECK_TARGET=supermatrix-root
LOCALWATCH_SELFCHECK_FROM=supermatrix-root
SM_CLAUDE_DEFAULT_MODEL=YOUR_CLAUDE_MODEL
SM_CODEX_DEFAULT_MODEL=YOUR_CODEX_MODEL
SM_KIMI_CLI_PATH=kimi
SM_SCHEDULER_BASE_URL=http://127.0.0.1:3500
SM_PREDICATE_PATCH_TOKEN=LOCAL_RANDOM_TOKEN
```

## First Run

```bash
set -a; source ../.env; set +a
npm run self-check
npm start
```

In the Feishu/Lark root group, test:

```text
/help
/status
/new claude alpha
```

`/new claude alpha` creates a Claude Code-backed session. If you use Codex,
send `/new codex alpha` instead.

For Codex:

```text
/new codex alpha
```

Optional local supervisor:

```bash
./scripts/launchd/install.sh   # macOS launchd + Terminal.app bridge
./scripts/localwatch.sh        # direct foreground supervisor
```

## Claude Code

```bash
claude login
claude --version
```

If your Claude setup uses an API key, store it in your local shell environment,
password manager, or untracked `.env.local`. Do not commit it.

## Codex

```bash
codex login
codex --version
codex exec -- "Reply with exactly OK"
```

Codex model availability depends on the local CLI version, account entitlement,
and local Codex config. Validate a model with the CLI before setting
`SM_CODEX_DEFAULT_MODEL`.

## Runtime Data

The runtime creates workspaces, SQLite databases, logs, and attachment caches.
Keep them outside Git. Recommended layout:

```text
$HOME/SuperMatrixRuntime/
  data/supermatrix.db
$HOME/SuperMatrixWorkspaces/
  <session-name>/
```

The sanitized public repository is a publication artifact, not a backup of live
runtime state.

## Troubleshooting

If Feishu/Lark reports an existing event subscriber, stop the other Super Matrix
process that is using the same app.

If group creation fails, re-check app scopes and re-run `lark-cli auth login`.

If Claude Code fails only in a background supervisor, test it first in an
interactive shell under the same OS user.

If a database needs to be rebuilt, stop the process and remove the file pointed
to by `SM_DB_PATH`. This deletes session/binding records but does not remove
workspace directories.
