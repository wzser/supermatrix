# Super Matrix

**Language:** [中文](README.md) | English

Super Matrix connects Claude Code, Codex CLI, and Kimi CLI to Feishu/Lark as a local-first, auditable multi-agent collaboration system. Every session has its own chat, workspace, backend context, and runtime state while code, data, and credentials remain on the local machine.

Current version: `v0.2.0`. See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the complete release summary.

## New Platform Capabilities in v0.2.0

- **Live run steering:** `/now <instruction>` injects additional context into the active Claude or Codex run. Success is returned only when that same run confirms receipt. It does not start idle sessions, and Kimi is not supported yet.
- **Session conversation branches:** `/branch` creates, lists, and switches backend context branches within one workspace. It does not create Git branches or copy files.
- **`localgit` platform module:** owns local daily commits, hold/ledger decisions, branch convergence, and auditable Git judgments. High-risk files are never committed automatically.
- **`gitmaster` release module:** adds closed-allowlist exports, bilingual private-keyword replacement, secret/PII scans, release evidence, and remote HEAD verification.

## Updated Platform Capabilities in v0.2.0

- **Spawn2.0 result consumption:** asynchronous results are explicitly consumed with the returned `resultUrl` using `POST .../take`. Ordinary GET requests remain read-only, and caller consumption is recorded to reduce duplicate delivery.
- **Scheduler v2 is the only published scheduler:** it listens on port `3502`. A scheduler success proves only that execution was triggered; the target session still owns business verification.
- **Stronger backend runtime control:** unified backend/model/effort defaults, explicit Kimi model boundaries, restart provenance, and process observation.
- **Safer quota rendering:** `/usage` renders only approved projection fields and excludes tokens, account email addresses, and local configuration paths.
- **Updated supervision ownership:** the public `localwatch` template checks Scheduler v2 on `3502`. Daily commit ownership moves from Watchdog to `localgit`; Watchdog focuses on runtime, CLI, upgrade, and sensitive-information health.
- **Refreshed production dependencies:** the core Lark SDK/HTTP stack and Scheduler Hono stack are upgraded, while unused Anthropic SDK dependencies are removed from localgit and Watchdog. The release gate requires zero production audit findings across all four Node modules.

## Upgrade From v0.1.0

Before upgrading, back up the root `.env`, the SQLite database referenced by `SM_DB_PATH`, and any session workspaces you need to retain. Keep those files outside the Git repository.

```bash
git fetch --tags origin
git checkout v0.2.0
cd supermatrix
npm ci
set -a; source ../.env; set +a
npm run self-check
npm run verify
```

Review these changes during the upgrade:

1. The minimum Node.js version is now **22**, replacing the older documentation that said 20.
2. The repository no longer provides an `npm run init` QR wizard. Follow [docs/SETUP.en.md](docs/SETUP.en.md) to initialize lark-cli and the root console chat manually.
3. Change `SM_SCHEDULER_BASE_URL` to `http://127.0.0.1:3502` and configure `SCHEDULER_ADMIN_TOKEN` for Scheduler v2.
4. Do not start the retired scheduler on port 3500. Check launchd files, shell scripts, and reverse proxies for old 3500 references.
5. Daily commit automation now belongs to `platform/localgit`; remove any duplicate legacy Watchdog daily-commit trigger.
6. The first core startup applies SQLite migrations. After startup, verify `/status`, `/branch`, and one Spawn2.0 asynchronous result-consumption flow.

## Intended Use and Constraints

- Designed for individuals or small teams already using local CLI agents and wanting Feishu/Lark access and collaboration.
- The core runtime can run in common Node.js environments, but the included long-running supervisor is currently validated only with macOS launchd.
- Requires an always-on machine and user-managed Feishu/Lark permissions, backend CLI authentication, and network access.
- This is a local-first collaboration framework, not a multi-tenant SaaS. Keep human review and independent verification for consequential actions.

## Quick Start

### Prerequisites

| Item | Requirement |
|---|---|
| Node.js | `>=22.0.0` |
| Feishu/Lark | An internal app with WebSocket event subscriptions |
| Backend | At least one authenticated Claude Code, Codex CLI, or Kimi CLI |
| Local machine | Git, npm, and writable runtime/workspace directories |

### Install the Core Runtime

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public
cp .env.example .env
cd supermatrix
npm ci
```

Initialize the lark-cli profile and user authorization:

```bash
npx lark-cli config init --app-id cli_YOUR_APP_ID --app-secret-stdin --name supermatrix
npx lark-cli profile use supermatrix
npx lark-cli auth login --scope "im:message im:message:readonly im:chat:read im:chat.members:read im:chat.members:write_only im:chat:create_by_user"
npx lark-cli auth status
```

Create the root console chat:

```bash
set -a; source ../.env; set +a
npx lark-cli im +chat-create --as user --name "Super Matrix Console" --type private --bots "$LARK_APP_ID"
```

Write the returned `chat_id` to `SM_ROOT_GROUP_ID` in `.env`, and write the owner's `userOpenId` from `auth status` to `SM_ROOT_USER_ID`. Then run:

```bash
set -a; source ../.env; set +a
npm run self-check
npm start
```

Send these commands in the root console chat:

```text
/help
/status
/new claude alpha
```

See [docs/SETUP.en.md](docs/SETUP.en.md) for app permissions, event subscriptions, and first-run verification.

## Common Commands

| Command | Purpose |
|---|---|
| `/new <backend> <name>` | Create a session, chat, and local workspace |
| `/status` | Inspect all sessions or one session |
| `/now <text>` | Inject context into the active Claude/Codex run |
| `/next <text>` | Queue follow-up work in FIFO order |
| `/branch [name]` | List, create, or switch conversation branches |
| `/cancel` | Stop the active run; `/cancel next` clears only queued work |
| `/reset` | Clear backend context while preserving workspace files |
| `/usage` | Render a security-filtered quota snapshot |
| `/help` | Show complete runtime command help |

See [docs/COMMANDS.md](docs/COMMANDS.md) for command scope and side effects.

## System Layout

```text
Feishu/Lark chat
  -> Super Matrix API / CLI
  -> local SQLite state
  -> isolated session workspace
  -> Claude Code / Codex / Kimi CLI
```

`supermatrix/` is the core runtime. Modules under `platform/` are enabled only when needed:

| Module | Published capability |
|---|---|
| `first-principle` | Identity templates, principle assembly, and session metadata governance |
| `scheduler` | Scheduler v2 triggering, run history, and management API |
| `heartbeat` | Evidence-based patrols for stuck or unfinished sessions |
| `autobitable` | Generic Feishu Bitable webhook adapter and ledger synchronization |
| `watchdog` | Runtime, CLI, upgrade, and security health checks |
| `skill-master` | Reusable skill registration, synchronization, and evaluation |
| `socail-king` | Cross-session handoff and exception review; the historical directory spelling is retained |
| `mythos` | Local knowledge-base templates, indexing, and citation tools |
| `localgit` | Local daily commits, hold/ledger decisions, and branch convergence |
| `gitmaster` | Sanitized snapshots, scans, tags, and GitHub release workflow |

Platform modules are not core startup prerequisites and are never started merely because they are present in the repository.

## Data and Security Boundary

This repository is a sanitized publication target, not a live runtime mirror. The published tree must not contain:

- `.env*`, API keys, tokens, SSH/deploy keys, or local account configuration;
- real Feishu/Lark/Bitable identifiers, employee names, contact details, or private company/brand/product keywords;
- SQLite databases, logs, chat records, CSV/JSONL exports, screenshots, media, archives, or large generated artifacts;
- business session workspaces, raw runtime data, or private absolute paths.

See [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md) for release scans, exclusions, and evidence. Rotate suspected credentials immediately; deleting a value from the latest tree does not remove it from Git history.

## Development and Verification

```bash
cd supermatrix
npm run typecheck
npm run test:unit
npm run test:adapters
npm run test:e2e
npm run verify
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for configuration, [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for diagnostics, and [the release SOP](platform/gitmaster/sop/SOP-sanitized-github-release-active-20260814-rpidv7.md) for the publication workflow.
