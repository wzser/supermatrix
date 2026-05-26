# Sanitization Report

Date: 2026-05-26

Target repository: `wzser/supermatrix`

## Included

- `supermatrix/`: sanitized SuperMatrix source, tests, templates, public setup
  docs, localwatch supervisor scripts, launchd templates, and repair helpers.
- `platform/first-principle/`: principles templates, SOPs, and public scripts.
- `platform/scheduler/`: scheduler source, tests, package manifests, SOPs.
- `platform/heartbeat/`: heartbeat patrol source, tests, SOPs.
- `platform/socail-king/`: cross-session coordination source, rules, SOPs.
- `platform/mythos/`: public knowledge-map and concept summaries only.
- `platform/autobitable/`: webhook adapter source, tests, sanitized registry
  example, public ingress docs, and ledger sync scripts.
- `platform/watchdog/`: watchdog source, tests, SOPs, and daily-commit review
  tooling.
- `platform/skill-master/`: reusable skills, public setup docs, registry sync
  scripts, and skill evaluation tooling.

## Excluded

- `.git` histories from source directories.
- `.env`, `.env.local`, and local config files.
- SSH keys, GitHub deploy keys, Feishu/Lark secrets, model provider API keys.
- SQLite databases, logs, JSONL/CSV exports, raw runtime state.
- session workspaces and business repositories such as `gsd2/`.
- raw Mythos sources, source indexes, media dumps, and fetched transcripts.
- Autobitable live webhook registry, webhook run store, private ingress host,
  and live per-webhook secrets.
- Watchdog runtime database, daily-commit logs, generated `dist/`, and
  dependency installs.
- Skill Master metrics, call logs, review output, sync logs, virtual
  environments, and generated caches.
- historical review packs, superpowers planning docs, process artifacts, and
  temporary files.
- unreferenced presentation assets, including the former
  `supermatrix/docs/assets/codexroot-avatar.{png,svg}` files.
- `node_modules/`, build outputs, coverage, caches, archives, and large files.
- private Feishu/Wiki/Bitable URLs and real base/table/node tokens.

## Redaction

The export replaced private local paths and user identifiers with placeholders
such as:

- `<SM_REPO_ROOT>`
- `<SM_RUNTIME_ROOT>`
- `<SM_WORKSPACE_ROOT>`
- `<HOME>`
- `LOCAL_USER`
- `LARK_CHAT_ID`
- `LARK_OWNER_OPEN_ID`
- `LARK_APP_ID`

## Validation Commands

Run from the export root:

```bash
find . -type f \( -name '.env' -o -name '.env.*' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.log' -o -name '*.jsonl' -o -name '*.csv' -o -name '*.zip' -o -name '*.tar' -o -name '*.gz' -o -name '*.pyc' \)
find . -type f -size +5M -exec ls -lh {} +
find . -type l -exec sh -c 'for p do t=$(readlink "$p"); case "$t" in /*) printf "%s -> %s\n" "$p" "$t";; esac; done' sh {} +
rg -n --hidden --glob '!**/.git/**' --glob '!package-lock.json' --glob '!*.lock' '<HOME>/LOCAL_USER|oc_[0-9a-fA-F]{20,}|ou_[0-9a-fA-F]{20,}|cli_[0-9a-fA-F]{12,}|app_token[=:][A-Za-z0-9_-]+|Bearer [A-Za-z0-9._-]{20,}|\bsk-[A-Za-z0-9_-]{20,}\b'
```

The expected result is no real secrets, no private absolute paths, no runtime
databases/logs/exports, no absolute symlinks, and no large files.

## Validation Result

Completed on 2026-05-25:
Updated on 2026-05-26 after adding localwatch and renaming the target
repository:

- No real secret, private user, long Feishu/Lark ID, bearer token, OpenAI key,
  Anthropic key, or private-key block matched the strict scan.
- No forbidden runtime files matched after allowing `.env.example`,
  `.env.local.example`, and checked-in backend stream fixture `.jsonl` files.
- No files larger than 5 MB.
- No absolute symlinks.
- No `node_modules`, `dist`, `__pycache__`, or `.pytest_cache` directories.
- No remaining image, archive, PDF, or media assets after the unreferenced
  `codexroot-avatar` files were removed.
- The injected `session-catalog.json` and Principles symlinks in copied
  platform workspaces were removed from the public snapshot.
- Working tree file size excluding `.git`: 7.3 MB.

The remaining broad `/Users/` matches are test fixtures that intentionally
exercise rejection of absolute local paths. The `gsd2` string appears only in
this report as an explicitly excluded example.

Private Feishu tenant URLs and Bitable IDs were replaced with placeholders such
as `https://YOUR_TENANT.feishu.cn/wiki/<WIKI_NODE_TOKEN>`,
`FP_SESSION_BASE_TOKEN`, `FP_SESSION_TABLE_ID`,
`SOCIAL_KING_BASE_TOKEN`, `MYTHOS_FEISHU_BASE_TOKEN`,
`AUTOBITABLE_PUBLIC_WEBHOOK_URL`, `WATCHDOG_SESSION_BASE_TOKEN`,
`SKILL_MASTER_FEISHU_BASE_TOKEN`, and `YOUR_SORFTIME_MCP_KEY`.

Test evidence:

- `supermatrix`: `npm run verify` passed.
- `supermatrix`: `npm run test:unit` passed inside verify, 78 test files and
  643 tests.
- `supermatrix`: `npm run test:adapters` passed inside verify, 38 test files
  and 283 tests.
- `supermatrix`: `npm run test:e2e` passed inside verify, 8 test files and 16
  tests.
- `supermatrix`: `bash -n scripts/localwatch.sh scripts/repair/*.sh` passed.
- `supermatrix`: `zsh -n scripts/launchd/install.sh scripts/launchd/supermatrix-launch.sh scripts/launchd/uninstall.sh` passed.
- `platform/scheduler`: `npm run build` passed.
- `platform/scheduler`: `npm test` passed, 90 test files and 634 tests.
- `platform/heartbeat`: `python3 -m pytest tests` passed, 112 tests.
- `platform/socail-king`: `node --test test/*.test.mjs` passed, 30 tests.
- `platform/autobitable`: `npm test` passed, 15 tests.
- `platform/watchdog`: `npm run build` passed.
- `platform/watchdog`: `npm test` passed, 10 test files and 56 tests.
- `platform/skill-master`: `python3 -m py_compile` passed for the changed
  Python entry points.
