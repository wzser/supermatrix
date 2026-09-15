# Public modular identity inputs

This directory is a public, static input bundle for the existing
`bin/fp-generate-init` and `scripts/fp_assemble.py` commands. It is not an
installer, service, queue, supervisor, or authorization bundle.

## Use

1. Copy or clone this directory to a user-owned location.
2. Create a Python 3.11.15 environment and set `FP_PYTHON` to its absolute
   executable path. The required compatibility range is `>=3.11,<3.12`.
3. Set `FP_ROOT` to this directory and set `FP_STATE_DIR` to a user-owned
   writable state directory outside this static bundle. Alternatively set
   `FP_NDJSON_PATH` to an explicit external file path. The generator rejects
   both variables being absent so a normal run cannot mutate the public input
   tree. Do not copy a runtime database, credentials, keychain material, or
   private templates.
4. Follow the existing onboarding template in `templates/CLAUDE.md` or
   `templates/AGENTS.md` and invoke the existing command:

```sh
export FP_STATE_DIR="/path/to/agent-state"
"$FP_ROOT/bin/fp-generate-init" \
  --session-name "example-agent" \
  --alias "Example agent" \
  --avatar "emoji:🧪" \
  --category "工具" \
  --purpose "示例身份与原则装配" \
  --backend "codex" \
  --workdir "$PWD" \
  > fp-init.json
```

The command emits both `CLAUDE.md` and `AGENTS.md` content. Write both files,
then rerun `scripts/fp_assemble.py --write`; a second run must report `no-op`.
No live runtime is required for this static generation path. A missing runtime
only means that §001 has no binding yet; it is not a missing-code failure.

When a user-owned Bitable contract is intentionally configured, put the new
user's actual `session_name`, `alias`, `category`, and role-bearing `purpose` in
an external identity JSON (see `examples/identity-input.json`), put the
runtime coordinates in an external copy of
`examples/session-meta.runtime.example.json`, then run the one-shot path:

```sh
export FP_PYTHON="/absolute/path/to/python3.11"
"$FP_ROOT/scripts/session-meta-schema-check.sh" --config "$SESSION_META_CONFIG"
"$FP_ROOT/scripts/bitable-init-sync.sh" --config "$SESSION_META_CONFIG" \
  --identity-json "/path/to/user-identity.json"
```

The seed command is intentionally not emitted by static generation: it is an
owner-authorized, configured remote action. Its receipt is written only to the
external `receipt_path` and must show both queue terminal verification and an
independent Session read-back.

The identity JSON may provide `affiliation` for the Session row's `附属于`
field. It is required when `category` is `员工`; the public bundle never
guesses a private organization. For the other categories, the public defaults
remain `外部` → `独立` and all other categories → `first-principle`; employee
records must use the configured user's own affiliation instead.

## Scope and external bindings

The public bundle contains the general identity, coding, Python-runtime and SOP
principles plus a parameterized one-shot session-metadata carrier. It still has
no runtime database, credentials, queue drain process, or installer. Every
remote coordinate and executable path is supplied by a user-owned runtime
config; missing values fail closed.

`config/public-bindings.json` is the static contract for the existing
first-principle owner carriers and the wendangwang public queue. It records the
actual local fields consumed by generation, the remote field names and native
types, authority direction, unique keys, and the existing consumer that would
perform a write or read. The three SQL tables are reduced local shapes only;
they are not complete remote Session, patrol, or Principles governance schemas.

The generation path consumes `session_name`, `alias`, `avatar`,
`category`, `purpose`, `backend`, and `workdir`, then writes
`initialized_at` and a pending `feishu_sync_ok` marker to the local
`session-init.ndjson`. It does not consume the SQL tables. The assembler reads
`data/module-manifest.json` and `data/session-variants.json`, not
`principle_modules`.

For the required Session contract, this export includes parameterized copies of
the existing consumer shapes:

* `scripts/session-meta-schema-check.sh` performs the read-only current-catalog
  schema gate; table creation/registration remains the existing jianbiao or
  `lark-cli base +table-create` schema-time operation described by
  `config/session-meta-table.json`.
* `scripts/bitable-init-sync.sh` sends exactly one
  `bitable_rows_create_if_absent` operation through the existing wendangwang
  queue, then independently reads the row back. A repeat is a verified skip;
  it never updates an existing row. The seed allowlist is exactly
  `Session/别称/Purpose/分类/附属于`.
* `scripts/sync-session-table.sh` is the native remote-to-local read entry:
  `lark-cli base +record-list`, writing only an external NDJSON snapshot. It
  never opens or clones a private SuperMatrix DB. `--fixture` is a controlled
  local test input, not a production fallback.

The `session_meta.remote_required` value remains `required` in the public
contract. A configured table is not treated as synchronized until schema
read-back, queue terminal proof, and independent row read-back all pass. Human
authority fields are copied/checked, never overwritten.

Principles mirror and patrol are deliberately not public capabilities:
`fp-sync-principle-table.sh` needs the private FP manifest/owner sources, while
`fp-patrol-enabled.sh` is a live FP control read with a separate Feishu
identity and fail-open production policy. The public bundle does not claim
either is usable and does not turn either into a conditional requirement for
the Session seed.

The existing queue command, when the user has a registered wendangwang asset,
is invoked by `scripts/bitable-init-sync.sh` as:

```sh
<configured-feishu-sync-enqueue> --skill-provenance bitable-ops \
  --asset "<registered-asset-id>" --from "<owner-session>" \
  --db "<user-owned-queue-db>" --registry-glob "<user-owned-registry-glob>" \
  --key "<stable-idempotency-key>" --rows "<rows.json>" \
  --op bitable_rows_create_if_absent --wait
```

An accepted/queued response is not completion. The published --wait response
must be status=accepted with job_state_at_response=done, terminal=true, and
waited=true; the caller then performs an independent Session record read-back.
If the configured queue DB is missing, the consumer first invokes the existing
`feishu-sync-status` executable beside the configured enqueue executable to let
the native queue initialize its schema; it never creates an empty DB file.
Do not substitute direct Lark writes, invent a sync service, or enable patrol from this static bundle. Patrol is
initially disabled and missing state is closed in
`config/patrol-state.json`; enabling it requires a separate owner decision and
live runtime verification.

If the registered asset, schema read-back, queue entrypoint, or queue consumer
is unavailable, the outcome is a non-success error; it is never `done`,
`verified_done`, or permission to write remotely. The public bundle does not
provide a consumer process.

The four approved legacy onboarding templates are tracked separately under
`../onboarding-v1/first-principle/templates/`. Their exact source-commit bytes,
source commit, and SHA-256 values are recorded in that directory's
`asset-provenance.json`; v2 generation does not silently read a private
working-tree copy of them.

## Verification

With the configured interpreter, run:

```sh
"$FP_PYTHON" scripts/verify-public-inputs.py
```

This validates the static allowlist, redaction rules, schema/config, generation
and the generate/write/rerun idempotence path without network or runtime DB IO.

The exact dependency and permission contract is in `config/dependencies.json`
and `config/permissions.json`; the current-catalog table contract is in
`config/session-meta-table.json` and `config/public-bindings.json`.
