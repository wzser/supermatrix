# Configuration

This repository expects local configuration to be supplied through shell
environment variables or untracked `.env` files. Do not commit credentials.

## Core SuperMatrix

| Variable | Required | Description |
| --- | --- | --- |
| `SM_ROOT_GROUP_ID` | yes | Feishu/Lark root console `chat_id`. |
| `SM_ROOT_USER_ID` | yes | Owner `open_id` from `lark-cli auth status`. |
| `SM_WORKSPACE_ROOT` | yes | Directory where Super Matrix creates session workspaces. |
| `SM_DB_PATH` | yes | SQLite database path for the core runtime. |
| `SM_BACKEND` | yes | `claude`, `codex`, or `kimi`. |
| `SM_LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error`. |
| `LARK_APP_ID` | yes | Feishu/Lark app ID. `npm run init` can create this through the PersonalAgent QR wizard. |
| `LARK_APP_SECRET` | local only | App Secret returned by the PersonalAgent QR wizard. It is written to local `.env` so `lark-cli config init --app-secret-stdin` can bind the local profile; never commit a real value. |
| `LARK_TENANT` | local only | `feishu` or `lark`, detected by the QR wizard when available. |
| `SM_LARK_CLI_PATH` | no | Override for the lark-cli binary. |
| `SM_API_PORT` | no | Local API port. Default: `3501`. |
| `SM_RUNTIME_ROOT` | no | Root directory for runtime data shared by platform tools. |

## LocalWatch

LocalWatch is the optional local supervisor for macOS/Linux development
machines. On macOS, the bundled launchd helper opens Terminal.app first so
Claude Code can still read credentials from the login keychain.

| Variable | Required | Description |
| --- | --- | --- |
| `SM_ENV_FILE` | no | Env file loaded by `scripts/localwatch.sh`. Default: repository root `.env`. |
| `LOCALWATCH_HEARTBEAT_GROUP` | optional | Feishu/Lark chat ID for periodic connectivity heartbeats. Leave blank to disable heartbeat sends. |
| `LOCALWATCH_SELFCHECK_TARGET` | no | Session name that receives localwatch self-check spawns. Default: `supermatrix-root`. |
| `LOCALWATCH_SELFCHECK_FROM` | no | Caller identity used in self-check spawn payloads. Default: `supermatrix-root`. |
| `SCHEDULER_CWD` | no | Scheduler workspace. Default: `platform/scheduler` in this repository. |
| `SCHEDULER_BIN` | no | Scheduler entry file. Default: `$SCHEDULER_CWD/dist/main.js`. |
| `BUSINESS_SCREEN_CWD` | optional | Optional local business screen workspace. Leave blank to disable management. |
| `BUSINESS_SCREEN_PORT` | no | Optional business screen port. Default: `4322`. |
| `BUSINESS_SCREEN_HOST` | no | Optional business screen host. Default: `0.0.0.0`. |

## Backend CLIs

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

Kimi ACP, when used:

```bash
kimi login
kimi info
```

Optional backend variables:

| Variable | Description |
| --- | --- |
| `SM_CLAUDE_DEFAULT_MODEL` | Default Claude model override. |
| `SM_CODEX_DEFAULT_MODEL` | Default Codex model override. |
| `SM_KIMI_CLI_PATH` | Kimi CLI path override. |

Only set models that your local account can actually use.

## Scheduler

| Variable | Required | Description |
| --- | --- | --- |
| `SCHEDULER_DB_PATH` | yes | Scheduler SQLite database path. |
| `SCHEDULER_SPAWN_API_URL` | no | SuperMatrix spawn endpoint. |
| `SCHEDULER_NOTIFY_API_URL` | no | SuperMatrix notify endpoint. |
| `SCHEDULER_USER_DM_OPEN_ID` | recommended | Owner user open ID; falls back to `SM_ROOT_USER_ID` in examples. |
| `SCHEDULER_SUPERMATRIX_DB_PATH` | no | Core runtime DB path; can use `SM_DB_PATH`. |
| `SCHEDULER_BITABLE_BASE_TOKEN` | optional | Feishu Bitable base token for sync tasks. |
| `SCHEDULER_BITABLE_TABLE_ID` | optional | Feishu Bitable table ID for sync tasks. |

## Autobitable

Autobitable exposes a local webhook adapter for Feishu Bitable automation. It
does not provide a hosted server. To use it, prepare your own public HTTPS
domain and server/reverse proxy, then forward only the autobitable webhook path
to the local adapter. The public repository includes only an example registry;
create the real registry as an untracked local file.

| Variable | Required | Description |
| --- | --- | --- |
| `AUTOBITABLE_PORT` | no | Local adapter port. Default: `3510`. |
| `AUTOBITABLE_WEBHOOK_SECRET` | yes for inbound webhooks | Shared fallback secret for legacy webhook entries. Prefer per-webhook secrets in the local registry. |
| `AUTOBITABLE_REGISTRY_PATH` | yes for ledger sync | Local `bitable-webhooks.json` path. |
| `AUTOBITABLE_RUN_STORE_PATH` | no | Local JSONL run ledger path. Keep this untracked. |
| `AUTOBITABLE_LEDGER_BASE_TOKEN` | optional | Feishu Bitable base token for publishing the webhook ledger. |
| `AUTOBITABLE_LEDGER_TABLE_ID` | optional | Feishu Bitable table ID for the webhook ledger. |
| `AUTOBITABLE_PUBLIC_WEBHOOK_URL` | yes for ledger sync | Your own public HTTPS URL that Feishu calls, for example `https://YOUR_PUBLIC_HOST/feishu/bitable/webhook`. |
| `AUTOBITABLE_LARK_CLI_PATH` | no | lark-cli path for ledger sync. |
| `SM_API_BASE` | no | Super Matrix API base URL. Default: `http://127.0.0.1:3501`. |
| `SM_REPO_ROOT` | recommended | Local Super Matrix source root used to build portable PATH entries. |

## Watchdog

Watchdog reviews repo state, daily-commit skips, idle sessions, and upgrade
health. Feishu table/chat targets are intentionally blank in this public
release and must be supplied locally.

| Variable | Required | Description |
| --- | --- | --- |
| `WATCHDOG_DB_PATH` | yes | Watchdog local SQLite database path. |
| `WATCHDOG_NOTIFY_DISABLED` | no | Set to `1` to disable notifications during local tests. |
| `WATCHDOG_DISABLE_SYNC` | no | Set to `1` to disable Bitable sync during local tests. |
| `WATCHDOG_LARK_CLI_PATH` | no | lark-cli path. Falls back to `SM_LARK_CLI_PATH` or `lark-cli`. |
| `WATCHDOG_BITABLE_BASE_TOKEN` | optional | Watchdog issue/sync Bitable base token. |
| `WATCHDOG_BITABLE_TABLE_ID` | optional | Watchdog issue/sync Bitable table ID. |
| `WATCHDOG_DAILY_COMMIT_BASE_TOKEN` | optional | Daily-commit control Bitable base token. |
| `WATCHDOG_DAILY_COMMIT_TABLE_ID` | optional | Daily-commit control table ID. |
| `WATCHDOG_SESSION_BASE_TOKEN` | optional | Session control Bitable base token. |
| `WATCHDOG_SESSION_TABLE_ID` | optional | Session control table ID. |
| `WATCHDOG_DAILY_COMMIT_CODEX_BIN` | no | Codex binary for reviewer runs. |
| `WATCHDOG_DAILY_COMMIT_CODEX_MODEL` | no | Codex reviewer model. |
| `WATCHDOG_SAFE_RELOAD_PATH` | no | Safe reload script path. |
| `WATCHDOG_SAFE_RELOAD_TASK_URL` | no | Optional scheduler task URL for safe-reload monitoring. |
| `WATCHDOG_WEEKLY_RANK_CHAT_ID` | optional | Chat ID for weekly rank reports. |
| `WATCHDOG_WEEKLY_TOKEN_CHAT_ID` | optional | Chat ID for weekly token reports. |
| `WATCHDOG_CLAUDE_BIN` | no | Claude CLI path for weekly upgrade checks. |
| `WATCHDOG_CODEX_BIN` | no | Codex CLI path for weekly upgrade checks. |
| `WATCHDOG_NPM_BIN` | no | npm binary for weekly upgrade checks. |

## Skill Master

Skill Master keeps reusable skills indexed and can sync the skill registry and
usage review results to Feishu. Runtime metrics, reviews, and local configs are
excluded from the public repository.

| Variable | Required | Description |
| --- | --- | --- |
| `SKILL_MASTER_FEISHU_BASE_TOKEN` | optional | Feishu Bitable base token for skill registry/evaluation sync. |
| `SKILL_MASTER_FEISHU_TABLE_ID` | optional | Skill registry table ID. |
| `SKILL_MASTER_CALL_COUNTS_TABLE_ID` | optional | Skill call-count table ID. |
| `SKILL_MASTER_ISSUES_TABLE_ID` | optional | Skill issue table ID. |
| `SKILL_MASTER_LARK_CLI_PATH` | no | lark-cli path for skill sync scripts. |
| `SORFTIME_MCP_KEY` | optional | Sorftime MCP key, only needed for the Sorftime skill. |
| `LINGXING_APP_ID` / `LINGXING_APP_SECRET` | optional | Lingxing API credentials for the Lingxing skill. |
| `LINGXING_RELAY_URL` / `LINGXING_RELAY_TOKEN` | optional | Lingxing HTTPS relay config. |
| `ZCLAW_API_KEY` | optional | Local Ziniao bridge key for the Ziniao skill. |

## Heartbeat

Heartbeat is optional. It requires the core Super Matrix API to be running, a
readable Super Matrix database, a `heartbeat` session/workspace, and a
controller model API key. Without those values it is only code in the public
repository, not an enabled patrol service.

| Variable | Description |
| --- | --- |
| `SM_API_BASE` | Super Matrix local API base URL used for `/api/spawn` and related control actions. Default: `http://localhost:3501`. |
| `SM_DB_PATH` | Super Matrix main SQLite database. Heartbeat reads session, run, child, and heartbeat-enabled state from this file. |
| `HEARTBEAT_WORKSPACE` | Heartbeat session workspace. |
| `HEARTBEAT_STATE_DB` | Heartbeat local SQLite state. |
| `HEARTBEAT_SESSION` | Session name, default `heartbeat`. |
| `HEARTBEAT_CONTROLLER_PROVIDER` | Controller provider, default `minimax`. |
| `HEARTBEAT_CONTROLLER_MODEL` | Controller model. Default: `MiniMax-M2.7`. |
| `HEARTBEAT_ESCALATION_MODEL` | Escalation model for higher-risk or failed controller paths. |
| `HEARTBEAT_MINIMAX_API_KEY` | Local Minimax key, if using Minimax. |
| `MINIMAX_API_KEY` | Fallback key read when `HEARTBEAT_MINIMAX_API_KEY` is not set. |
| `HEARTBEAT_MINIMAX_BASE_URL` | Minimax-compatible base URL. |
| `HEARTBEAT_MAX_RECENT_RUNS` | Number of recent runs read per session. |
| `HEARTBEAT_STALE_RUNNING_MINUTES` | Running-run stale threshold. |
| `HEARTBEAT_CHILD_SLA_MINUTES` | Child/cross-session stale threshold. |
| `HEARTBEAT_MODEL_PREFILTER` | `1` enables deterministic local prefilter before model calls. |
| `HEARTBEAT_LOG_FEISHU_BASE_TOKEN` | Optional Feishu Bitable base token for heartbeat event sync. |
| `HEARTBEAT_LOG_FEISHU_TABLE_ID` | Optional Feishu Bitable table ID for heartbeat event sync. |

Typical local-only configuration:

```bash
SM_API_BASE=http://localhost:3501
SM_DB_PATH=$HOME/SuperMatrixRuntime/data/supermatrix.db
HEARTBEAT_SESSION=heartbeat
HEARTBEAT_STATE_DB=$HOME/SuperMatrixWorkspaces/heartbeat/data/heartbeat.sqlite
HEARTBEAT_CONTROLLER_PROVIDER=minimax
HEARTBEAT_MINIMAX_API_KEY=YOUR_MINIMAX_KEY
```

## First Principle

First Principle scripts operate on templates and optional Feishu sync targets.
For Feishu table sync, set:

```bash
FEISHU_BASE_TOKEN=YOUR_BASE_TOKEN
FEISHU_SESSION_TABLE_ID=YOUR_TABLE_ID
```

For the included First Principle mirror scripts, configure these local-only
values as needed:

```bash
FEISHU_WIKI_BASE_URL=https://YOUR_TENANT.feishu.cn/wiki
FP_SESSION_BASE_TOKEN=YOUR_SESSION_BASE_TOKEN
FP_SESSION_TABLE_ID=YOUR_SESSION_TABLE_ID
FP_PATROL_BASE_TOKEN=YOUR_PATROL_BASE_TOKEN
FP_PATROL_TABLE_ID=YOUR_PATROL_TABLE_ID
FP_CHANGELOG_TABLE_ID=YOUR_CHANGELOG_TABLE_ID
FP_HEARTBEAT_FIELD_ID=YOUR_HEARTBEAT_FIELD_ID
```

For Social King and Mythos mirrors:

```bash
SOCIAL_KING_BASE_TOKEN=YOUR_SOCIAL_KING_BASE_TOKEN
SOCIAL_KING_TABLE_ID=YOUR_SOCIAL_KING_TABLE_ID
MYTHOS_FEISHU_BASE_TOKEN=YOUR_MYTHOS_BASE_TOKEN
MYTHOS_SOURCES_TABLE_ID=YOUR_SOURCES_TABLE_ID
MYTHOS_QUERIES_TABLE_ID=YOUR_QUERIES_TABLE_ID
MYTHOS_PARENT_NODE_TOKEN=YOUR_PARENT_NODE_TOKEN
MYTHOS_FEISHU_SPACE_ID=YOUR_SPACE_ID
```

## Paths

Prefer `$HOME`-relative paths:

```bash
SM_WORKSPACE_ROOT=$HOME/SuperMatrixWorkspaces
SM_RUNTIME_ROOT=$HOME/SuperMatrixRuntime
SM_DB_PATH=$HOME/SuperMatrixRuntime/data/supermatrix.db
```

Avoid hardcoding machine-specific absolute paths in committed files.
