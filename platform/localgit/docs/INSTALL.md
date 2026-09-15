# localgit module setup

This module is configured with the existing shell environment and native CLIs. It has no dedicated installer.

## Required configuration

Set these values in the child environment. Replace only the explicit placeholders with paths owned by the installation:

```sh
export LOCALGIT_REPO_ROOT="/path/to/platform/localgit"
export NODE_BIN="/absolute/path/to/node"
export SM_RUNTIME_ROOT="/path/to/runtime"
export SM_DB_PATH="$SM_RUNTIME_ROOT/data/supermatrix.db"
export SM_REPO_ROOT="/path/to/framework"
export SM_API_BASE="http://127.0.0.1:3501"
export SM_LARK_CLI_PATH="/absolute/path/to/lark-cli"
```

`LOCALGIT_NODE_BIN` remains accepted for compatibility, but `NODE_BIN` is the public wrapper input. `LOCALGIT_DB_PATH` overrides `SM_DB_PATH` only when a module-specific database is intentional. `LOCALGIT_API_BASE` can override `SM_API_BASE`; `LOCALGIT_NOTIFY_ENDPOINT` and `LOCALGIT_SPAWN2_ENDPOINT` are narrow endpoint overrides for a separately approved local topology.
`SM_REPO_ROOT` is used only as the existing fallback for the native CLI path; `SM_LARK_CLI_PATH` is preferred. `LOCALGIT_LARK_CLI_PATH` remains accepted for compatibility.

The role contract is [localgit-role.json](../config/localgit-role.json). The runtime session used for governance must be managed, affiliated to `first-principle`, non-child, non-deleted, in the platform category, and point to an existing Git workdir. The selection is read-only and de-duplicates shared workdirs. Zero eligible repositories exits with status 2 and is not an installation pass.

## Existing carriers and verification

Run from the configured module root. These wrappers run the primary operation and then their independent verifier in the same detached process:

```sh
env LOCALGIT_BRANCH_PATROL_MODE=report \
  bash "$LOCALGIT_REPO_ROOT/scripts/run-branch-patrol.sh"
bash "$LOCALGIT_REPO_ROOT/scripts/run-daily-commit.sh"
```

Use only an authorized scratch Git repository and fixture runtime database for onboarding verification. Do not run `apply` or a global repository scan as an installation smoke test. The wrapper log, `data/run-state/latest-*.json`, ledger and verifier JSON are the evidence. A successful process launch alone is not acceptance.

## Optional native Lark table mirror

The mirror is disabled unless both user-owned values below are set. No reference Base, table, token or runtime history is included:

```sh
export LOCALGIT_BITABLE_BASE_TOKEN="<user-owned-base-token>"
export LOCALGIT_BITABLE_TABLE_ID="<user-owned-table-id>"
```

Create and inspect the user's table with the installed native CLI after reading that CLI version's help. The shipped consumer first uses `base +record-list --filter-json` for exact `date + repo_name` matching, passes the returned `record_id` to `+record-upsert` when present, and performs an exact-key readback. Ambiguous matches fail closed. The native CLI has no atomic business-key upsert, so this mirror requires one writer for this key range:

```sh
"$SM_LARK_CLI_PATH" base +record-upsert \
  --base-token "$LOCALGIT_BITABLE_BASE_TOKEN" \
  --table-id "$LOCALGIT_BITABLE_TABLE_ID" \
  --json '{"date":"YYYY-MM-DD","repo_name":"example-repo","committed":"yes","commit_message":"chore: example","files_changed":"1","skipped_reason":""}'
```

The exact schema, unique key and field contract are in [daily-commit-bitable.example.json](../config/daily-commit-bitable.example.json). Read back the record by the CLI's supported ID/list operation and compare all six fields. An accepted command, empty table or unverified write is not a pass.

Do not use retired `/api/spawn`, `lark-cli schema base`, hardcoded resource IDs, or a second table/queue/notification service. Cross-session delegation uses the existing Spawn2.0 endpoint; status and result receipts remain distinct from completion.

## Public boundary

The module can govern local Git workspaces without a remote mirror. Keep credentials, databases, logs, runtime registries, recovery/backup assets and real repository data outside the public package. Use the repository's current SOP and the installed CLI help for operation details; do not copy maintainer paths or state.
