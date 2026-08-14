# Configuration Reference

Super Matrix reads configuration from the process environment. The repository root `.env` is a local convenience file and must remain untracked. Start from [`.env.example`](../.env.example); never commit real secrets, object IDs, account details, or private paths.

## Core Runtime

| Variable | Required | Purpose |
|---|---:|---|
| `SM_ROOT_GROUP_ID` | yes | Root console Feishu/Lark `chat_id`. |
| `SM_ROOT_USER_ID` | yes | Authorized owner `open_id`. |
| `SM_WORKSPACE_ROOT` | yes | Parent directory for session workspaces. |
| `SM_RUNTIME_ROOT` | recommended | Parent directory for runtime-only data and evidence. |
| `SM_DB_PATH` | yes | Core SQLite database path. |
| `SM_BACKEND` | yes | Default backend: `claude`, `codex`, or `kimi`. |
| `SM_LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error`; default `info`. |
| `SM_API_PORT` | no | Core HTTP port; default `3501`. |
| `LARK_APP_ID` | yes | Internal Feishu/Lark application ID. |
| `LARK_APP_SECRET` | yes | Local application secret; never commit it. |
| `LARK_TENANT` | recommended | `feishu` or `lark`. |
| `SM_LARK_CLI_PATH` | no | Explicit local lark-cli executable path. |

Load the file before starting:

```bash
set -a; source ../.env; set +a
npm run self-check
npm start
```

## Runtime Control

| Variable | Default | Purpose |
|---|---:|---|
| `SM_SHUTDOWN_GRACE_TIMEOUT_MS` | `10000` | Graceful shutdown window. |
| `SM_SPAWN_ORPHAN_THRESHOLD_SEC` | `60` | Minimum age before an orphaned spawn can be evaluated. |
| `SM_SPAWN_SYNC_RESPONSE_TIMEOUT_MS` | runtime default | Window before synchronous Spawn2.0 delivery switches to async. |
| `SM_SPAWN_QUEUE_MAX_PER_PARENT` | runtime default | Maximum queued child requests per parent. |
| `SM_SPAWN_QUEUE_TTL_SEC` | runtime default | Queue item time-to-live. |
| `SM_DISABLE_LEGACY_SPAWN` | unset | Set only after callers have migrated to Spawn2.0. |
| `SM_PREDICATE_PATCH_TOKEN` | none | Local authorization token for predicate patch operations. |

Use long random values for local authorization tokens. Do not reuse an application secret.

## Backend Defaults

| Variable | Purpose |
|---|---|
| `SM_CLAUDE_DEFAULT_MODEL` | Default Claude model available to the local account. |
| `SM_CODEX_DEFAULT_MODEL` | Default Codex model available to the local account. |
| `SM_KIMI_CLI_PATH` | Kimi executable path; default `kimi`. |
| `SM_KIMI_CODE_HOME` | Optional isolated Kimi runtime state directory. |
| `SM_CODEX_SESSIONS_DIR` | Optional Codex session state directory. |

Model and effort settings must match the installed CLI and account. A configured value is not proof that the provider accepts it.

## Scheduler v2

The published scheduler is v2 only. Port `3500` is retired.

| Variable | Required | Purpose |
|---|---:|---|
| `SM_SCHEDULER_BASE_URL` | core integration | Core health target, normally `http://127.0.0.1:3502`. |
| `SCHEDULER_V2_HOST` | no | Bind host; use loopback unless external access is intentionally secured. |
| `SCHEDULER_V2_PORT` | no | Scheduler port; default `3502`. |
| `SCHEDULER_V2_DB` | yes | Scheduler v2 SQLite path. |
| `SM_DB` | yes | Core SQLite path used for session resolution. |
| `SM_BASE_URL` | yes | Core API base, normally `http://127.0.0.1:3501`. |
| `SCHEDULER_ADMIN_TOKEN` | yes | Local token required for mutation endpoints. |

Scheduler success records trigger acceptance or process exit according to the executor contract. They do not prove completion of the target session's work.

## localwatch

| Variable | Purpose |
|---|---|
| `SM_ENV_FILE` | Absolute path to the root local `.env`. |
| `LOCALWATCH_SELFCHECK_TARGET` | Session that receives self-check diagnostics. |
| `LOCALWATCH_SELFCHECK_FROM` | Caller identity used by the self-check request. |
| `SCHEDULER_CWD` | Scheduler v2 working directory. |
| `SCHEDULER_BIN` | Built Scheduler v2 entrypoint. |

The public template checks core port `3501` and Scheduler v2 port `3502`. Keep optional private services out of the public configuration.

## Optional Platform Modules

- **Autobitable:** configure a local webhook secret, a registry path, and a runtime-only run-store path. Public endpoints require your own TLS/reverse-proxy controls.
- **Watchdog:** configure `WATCHDOG_DB_PATH`; leave `WATCHDOG_DISABLE_SYNC=1` unless your own Bitable target is ready. Daily commit ownership belongs to `localgit` in v0.2.0.
- **Heartbeat:** configure a runtime state database, target session, controller provider/model, and provider credential. Do not place real provider keys in repository files.
- **First Principle / Skill Master:** Bitable tokens and table IDs are optional local mirror targets. Keep them in `.env` only.

Each platform module may define additional variables in its own source or documentation. Treat every token, Feishu/Lark/Bitable ID, account name, endpoint, and absolute path as private unless it is an explicit placeholder.

## Secret Handling

1. Keep `.env`, CLI profiles, SQLite databases, logs, and runtime receipts outside Git.
2. Use placeholders in documentation and test fixtures.
3. Run the gitmaster full-tree scan before every tag.
4. Rotate a suspected secret immediately. Rewriting or deleting Git history is a separate containment step, not a substitute for rotation.
