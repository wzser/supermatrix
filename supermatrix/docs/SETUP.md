# Core Runtime Setup

This module contains the Super Matrix core runtime for release `v0.2.0`. The repository-level installation guide is [../../docs/SETUP.en.md](../../docs/SETUP.en.md); the Chinese guide is [../../docs/SETUP.md](../../docs/SETUP.md).

## Requirements

- Node.js `>=22.0.0`
- npm
- an initialized and authorized lark-cli profile
- at least one authenticated Claude Code, Codex CLI, or Kimi CLI backend
- a root `.env` based on [../../.env.example](../../.env.example)

## Install

From this directory:

```bash
npm ci
```

The core package does not provide a setup wizard. Initialize lark-cli and create the root console chat by following the repository-level setup guide.

## Required Environment

```dotenv
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
SM_SCHEDULER_BASE_URL=http://127.0.0.1:3502
```

Keep the root `.env`, databases, logs, backend account state, and session workspaces outside Git.

## Verify and Start

```bash
set -a; source ../.env; set +a
npm run self-check
npm run verify
npm start
```

The first startup creates or migrates the core SQLite schema. Verify the root console with `/help` and `/status`, then create a session with `/new <backend> <name>`.

## Development Commands

```bash
npm run lint:deps
npm run typecheck
npm run test:unit
npm run test:adapters
npm run test:e2e
npm run verify
npm run build
```

`src/` is runtime code. `scripts/` contains maintenance and verification entrypoints; runtime code must not depend on scripts as an application layer.

## Optional Supervision

After manual startup succeeds, macOS users can run:

```bash
./scripts/localwatch.sh
```

or install the provided launchd templates:

```bash
./scripts/launchd/install.sh
```

The public supervisor checks core port `3501` and Scheduler v2 port `3502`. It must read secrets from a local environment file, never from committed files.

## Security Boundary

Do not place real App Secrets, tokens, object IDs, employee/product names, SQLite files, logs, archives, or private absolute paths in this module. The release boundary and scan results are documented in [../../SANITIZATION_REPORT.md](../../SANITIZATION_REPORT.md).
