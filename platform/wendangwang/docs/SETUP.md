# Setup and acceptance

This is an agent-facing procedure, not an installer. Run it in a user-owned
copy or linked checkout of this directory. Do not copy a maintainer's
`registry/assets` directory or runtime database.

## 1. Prepare an isolated namespace

```sh
umask 077
export ROOT="$PWD"
export PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python}"
python3.11 -m venv "$ROOT/.venv"
export SM_FEISHU_PYTHON="$PYTHON_BIN"
export SM_FEISHU_NAMESPACE_MODE=standalone
export LARK_CLI_BIN="/path/to/the/agent-owned/lark-cli"
mkdir -p "$ROOT/data" "$ROOT/registry/assets"
export QUEUE_DB="$ROOT/data/sync-queue.sqlite"
if [ ! -s "$QUEUE_DB" ]; then
  "$ROOT/bin/feishu-sync-status" --db "$QUEUE_DB"
fi
```

The native status command initializes a missing (or empty) queue database and
prints zero counts before the first enqueue. On resume, a non-empty
`$QUEUE_DB` is reused in place: do not delete, truncate, or recreate it.

The package has no third-party Python dependencies. The executable named by
`LARK_CLI_BIN` must already be authenticated by the receiving agent and must
support the native `base` record commands used by its own Lark installation.
No credential, Keychain item, database, or runtime registry is imported by
this package.

## 2. Create or adopt the user's tables

Review `config/public-table-contracts.json`, select only the roles the agent
will use, and create or adopt those tables with the native Lark CLI. Schema
creation is intentionally outside this package. Use the installed CLI's
current `--help` output for the exact create-table and create-field syntax.
Record the resulting user-owned `base_token`, `table_id`, `field_id` values,
canonical URL, owner, and parent reference in a local contract under
`registry/assets/`. Keep that file untracked; `.gitignore` protects the
top-level user contract directory.

`SM_FEISHU_NAMESPACE_MODE=standalone` selects the portable namespace path: it
does not call a maintainer runtime identity endpoint and lets the user-owned
consumer drain its own queue. Omit it only when the package is deliberately
embedded back into an owner-managed runtime that supplies its own provenance
and drain gate.

The catalog distinguishes `required` from `conditional` roles and marks
non-queue mirrors with `queue_consumer: false`. `queue_consumer: true` means
only that the existing queue adapter is eligible after a user-owned contract
and readback gate exist; it does not claim that the owner runtime currently
uses the queue and it cannot change that runtime route. Do not make a
non-queue role queueable by editing the catalog. Preserve the owner-approved
logical field names and native field type; the local contract is the source of
actual IDs.

## Static owner mappings

`config/public-table-contracts.json` records the reviewed local-to-remote
mapping without creating schema or granting permissions. The first-principle
onboarding keys are converted as follows:

- `session_meta.session_name` -> `Session`; `alias`, `category`, and `purpose`
  map to `别称`, `分类`, and `Purpose`. `头像` is conditional and must contain a
  file token, not a URL or local path. `附属于` is required by the owner's
  session-init consumer but is not present in the public local SQL schema, so
  this mapping remains partial.
- `principle_modules.module` -> `模块名`, `section_no` -> `段号`,
  `content_sha256` -> `内容sha256`, and `enabled` converts `0/1` to a
  checkbox. The remaining remote governance fields are explicitly listed as
  remote-only; they must not be inferred.
- `patrol_state.scope` -> `配置项` and `enabled` converts `0/1` to `开关`.
  The public default is disabled with missing state closed. The current
  patrol consumer is a native Lark CLI read and is not a queue consumer, so
  the patrol contract remains unbound until its owner confirms schema, IDs,
  permissions, and readback.

The owner source check also records that skill-master currently exposes 14
registry fields, not an owned fifteenth field. Watchdog's current
`src/sync/bitable.ts` and localgit's daily-commit mirror are native Lark CLI
consumers; catalog metadata must not reroute them through the queue. The
localgit mirror is nevertheless listed with its six fields (`date`,
`repo_name`, `committed`, `commit_message`, `files_changed`,
`skipped_reason`).

The public catalog remains `partial` and `platform_table_contracts` remains
`not-verified`: remote table/field IDs, schema readback, and permissions are
not shipped here. A blank or placeholder table name is not completion.

Every catalog `consumer_refs` entry has an explicit `availability`. A
`sourceRef` with `availability: owner-source-only` is provenance for the
owner's existing implementation; it is not a command for the installing
agent and that source is not included in this package. The only executable
portable runtime entries are the package-relative paths in
`runtime_entrypoints` (`bin/feishu-sync-enqueue`,
`bin/feishu-sync-consumer`, `bin/feishu-sync-status`, and `bin/sm-feishu`). These package
entries are the existing queue adapter surface and do not turn an owner's
native Lark runtime into a queue consumer; `queue_consumer` remains a
separate eligibility field.

`seed_input` is deliberately installer-provided. For each selected role or
table, build non-sensitive rows from the catalog's fields in catalog order,
use its declared `unique_key`, and read back the schema and seed rows before
enabling a consumer. The stable seed identity is
`install_key:<asset_id_template>:<unique-key values>`. No maintainer rows,
runtime database copies, production IDs, or credentials are supplied by this
public package.

## 3. Validate and run

```sh
"$ROOT/bin/sm-feishu" asset validate "$ROOT/registry/assets/<user-contract>.json"
"$ROOT/bin/feishu-sync-enqueue" \
  --asset '<asset-id>' --from '<owner-agent>' \
  --key 'YYYY-MM-DD:<owner-agent>:<asset-id>:<stable-key>' \
  --rows '/absolute/path/to/rows.json' \
  --db "$QUEUE_DB" \
  --registry-glob "$ROOT/registry/assets/*.json" --no-drain
"$ROOT/bin/feishu-sync-consumer" \
  --db "$QUEUE_DB" \
  --registry-glob "$ROOT/registry/assets/*.json"
"$ROOT/bin/feishu-sync-status" \
  --db "$QUEUE_DB" --job-id <job-id>
```

For a synchronous owner flow, `feishu-sync-enqueue --wait` uses the same
existing consumer and waits for a terminal verdict. Do not resend a key after
an unknown result or after a terminal verdict.

## 4. Acceptance evidence

Accept only when all of the following are visible in `status` and the receipt:

- `done` includes the remote record ID and an ID-bound readback verification;
- a repeated stable key is reported as a duplicate/idempotent result and does
  not create a second row;
- a permission or other permanent provider error reaches `failed` with its
  error code, rather than being reported as a successful enqueue;
- the local queue, receipt, and lock paths are writable by the user agent;
- the Lark identity has only the exact user-owned table permissions needed for
  the selected operation. Schema permissions are needed only for the native
  schema step, not for this consumer.

The supplied test suite demonstrates these three terminal paths with a local
`lark-cli` stub. It does not constitute remote permission approval.

## Optional local-only notification configuration

The public code does not contain notification URLs or private heartbeat
paths. `SM_NOTIFY_URL`, `SM_HEARTBEAT_ENQUEUE`, and `SM_SESSION_NAME` are
optional user-provided environment variables. Leaving them unset preserves
the queue failure state without attempting an external notification.
