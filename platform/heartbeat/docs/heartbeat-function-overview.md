# Heartbeat public setup and operating contract

This directory contains the existing Heartbeat patrol entry point. It is a
component for an already-running SuperMatrix installation, not a standalone
service and not a dedicated installer. An agent can configure it from this
document and the existing commands.

## 1. What is included

Heartbeat reads the SuperMatrix session, message-run and cross-session facts,
selects only mechanically actionable candidates, asks a controller for a
bounded JSON decision, and records its own audit state in SQLite. It can then
resume the original owner, send an alert, drain an explicit todo, or perform a
bounded owner-scoped child action.

It never decides business parameters, approval, authorization, spending,
publication, or a backend change. It does not write another session's private
database. A child action cannot create more sessions or change runtime
configuration.

## 2. Portable configuration

Start from [`config/heartbeat.env.example`](../config/heartbeat.env.example)
and replace its placeholders in a private, untracked copy. Do not put tokens,
application secrets, database files, tenant identifiers, group identifiers, or
machine-specific paths in the repository or in a report.

The required boundary is:

| Setting | Meaning |
| --- | --- |
| `SM_API_BASE` | Existing SuperMatrix API base; the controller branch uses `POST /api/spawn2.0`. |
| `SM_DB_PATH` | Existing SuperMatrix runtime SQLite database, read-only for Heartbeat. |
| `HEARTBEAT_STATE_DB` | Separate writable Heartbeat-owned SQLite database. It must not equal `SM_DB_PATH`. |
| `SM_LARK_CLI_PATH` | Existing `lark-cli` executable used for user and bot messages. |
| `HEARTBEAT_CONTROLLER_PROVIDER` | Defaults to `spawn`, reusing the existing agent backend. |
| `HEARTBEAT_CONTROLLER_MODEL` | Available model in the receiving installation's backend catalog. |
| `HEARTBEAT_ESCALATION_MODEL` | Model used only for bounded escalation decisions. |
| `HEARTBEAT_SESSION` | The already-created Heartbeat session name. |
| `HEARTBEAT_TODOMASTER_SESSION` | Optional exact todo-owner session. Empty means unresolved-issue escalation is unavailable. |

The default controller path does not require a new MiniMax account or API key.
MiniMax remains an explicit opt-in provider: set its provider/model and supply
its credential through the receiving installation's approved secret mechanism;
never copy a credential into this component.

The source code derives its fallback paths from the component directory and a
portable `.runtime` directory. For an installation, set both database paths
explicitly so source and runtime remain separate. Importing `load_config()` or
running the unit suite does not create or migrate a production state database.

Runtime baseline: Python `3.11.15` is selected by `.python-version`; the
component declares `>=3.11,<3.12` and has no third-party Python dependency. The
receiving installation must read back its existing `lark-cli` and agent-backend
versions rather than treating a role name as a version guarantee.

## 3. Session scope and enablement

Creating a role/session does not enable patrol. A target is eligible only when
all of these are true:

1. Its runtime row has `heartbeat_enabled = 1`.
2. It is not deleted.
3. It is not a child scope.
4. It is not the configured Heartbeat session itself.

The existing owner-side command that changes this flag is outside this
component's public package. Confirm the flag with the runtime owner before
expecting a target to be scanned. A normal idle or completed session is not a
candidate; a non-stale running session is not interrupted.

## 4. Controller, Lark and state boundaries

The controller provider `spawn` sends a structured request through the existing
SuperMatrix agent backend at `SM_API_BASE`. The request must use
`/api/spawn2.0`, include the existing closure and verification predicate, and
must not use the retired legacy endpoint or legacy payload fields.

`lark-cli` is an existing capability, not an installation target. Heartbeat
uses it for the final user/bot message only after local claims and target-state
gates pass. Authentication, app permissions and group access belong to the
receiving installation; this component never creates or copies credentials.

The local state database is the execution authority. Its main tables are:

| Table | Purpose |
| --- | --- |
| `patrol_runs` | Start, finish, status and counts for each patrol. |
| `heartbeat_events` | Action and gate audit trail. |
| `action_claims` | Idempotence for alerts, resumes, todo and child actions. |
| `child_spawns` | Bounded child lifecycle and closure evidence. |
| `session_todos` / `todo_batches` | Explicit per-session todo pool and batching. |
| `heartbeat_pauses` | Temporary or permanent target pause state. |
| `unrecovered_targets` / `unrecovered_escalation_handoffs` | Repeated-failure and human-attention ledger. |

An empty or newly initialized state database is an expected starting state, not
evidence that the package is missing code. The first authorized real patrol
may initialize it; the fixture tests below deliberately use temporary files.

## 5. Scheduler registration is external

Heartbeat does not create, modify, or enable scheduler tasks. The scheduler
owner must register one recurring scheduler-v2 task whose `type` is `script`
and whose command is the absolute path to this component's
`scripts/heartbeat-patrol`, with this component directory as `cwd`. Use the
scheduler owner's approved v2 write path for recurring tasks; do not write its
database or use a retired scheduler endpoint from this component.

The registration scope is only “periodically trigger the command”. Scheduler
success means the trigger was accepted/spawned, not that Heartbeat completed a
patrol or that an owner task completed. The owner must read back the exact task
id, `enabled`, `type`, cron, command and `cwd`, then verify Heartbeat's own
`patrol_runs` and completion receipt. The task should remain disabled until the
receiver has supplied the required configuration and explicitly authorized the
runtime effect.

## 6. Optional mirror and todo-owner capabilities

The following three runtime mirrors are conditional capabilities and are
disabled by default:

- `heartbeat.runtime.events`: fields from `BITABLE_FIELDS` in
  `heartbeat_patrol/event_sync.py`.
- `heartbeat.runtime.todo_pool`: fields from `TODO_BITABLE_FIELDS`.
- `heartbeat.runtime.todo_aggregate`: fields from
  `TODO_AGGREGATE_BITABLE_FIELDS`.

When disabled, `scripts/sync-heartbeat-events` returns a `status=disabled`
receipt and performs no remote write. The local SQLite state remains
authoritative. Enabling a mirror requires the asset owner's separately
approved base/table/field schema and bot permissions; no remote identifiers
are bundled here, and an empty mirror table is not evidence that patrol is
broken.

The optional field schemas are:

- Events: `patrol_id`, `triggered_at`, `event_type`, `target_session`,
  `logical_key`, `decision`, `trigger_source`, `trigger_cause`,
  `trigger_location`, `child_session_id`, `child_model`, `status`,
  `injected_message`, `summary`, `error`, `source`.
- Todo pool: `todo_id`, `created_at`, `target_session`, `logical_key`,
  `batch_key`, `source_session`, `source_ref`, `todo_type`, `status`,
  `message`, `claimed_at`, `injected_at`, `finished_at`, `injected_message`,
  `source`, `detail`.
- Todo aggregate: `aggregate_key`, `source_ref`, `target_sessions`,
  `source_sessions`, `todo_types`, `sources`, `batch_keys`, `item_count`,
  `statuses`, `final_status`, `recorded_in_pool`, `triggered`,
  `triggered_count`, `failed_count`, `first_created_at`, `last_claimed_at`,
  `last_injected_at`, `last_finished_at`, `latest_todo_id`,
  `latest_logical_key`, `latest_message`, `latest_injected_message`,
  `latest_error`.

The minimum permission boundary is local read access to `SM_DB_PATH`, local
read/write access to `HEARTBEAT_STATE_DB`, network access to the existing
SuperMatrix API for the controller/closure calls, and the existing Lark CLI
message capability for user/bot delivery. Optional dedupe needs only a bot
read of the configured content/source fields. Optional mirror writes and the
shared todo-owner handoff need separate owner-approved permissions and remain
disabled when their inputs are absent.

Unresolved patrol issues can optionally be handed to a shared todo owner using
`HEARTBEAT_TODOMASTER_SESSION` and the existing `spawn2.0` todo-pool closure.
If that exact session value is empty, registration fails closed and the local
event remains the evidence. Heartbeat must not claim `queued`, `accepted`, or
completed handoff without the owner and the transport receipt.

For the optional full-table dedupe read, configure all four
`HEARTBEAT_TODO_DEDUPE_*` identity/field values together and grant only the
read operation needed to inspect content and source fields. If the read cannot
be completed, no new todo is created. The table schema and remote access are
external inputs, not package defaults.

## 7. Safe local verification

Run these checks from the component directory with the installation's pinned
Python 3.11 interpreter. They do not start a patrol, send a message, call the
agent backend, change scheduler state, or write a remote table:

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests
HEARTBEAT_CONTROLLER_PROVIDER=spawn \
SM_API_BASE=http://127.0.0.1:3501 \
SM_DB_PATH=/tmp/heartbeat-fixture/supermatrix.sqlite \
HEARTBEAT_STATE_DB=/tmp/heartbeat-fixture/state.sqlite \
.venv/bin/python -m unittest tests.test_public_release_inputs
scripts/heartbeat-patrol --help
scripts/heartbeat-control --help
scripts/enqueue-heartbeat-todo --help
```

The expected unit result is zero failures. The public-input test checks that
the shipped example and document contain no machine-private path or remote
resource identity, that the default provider is `spawn`, and that an absent
todo owner cannot produce a queued handoff.

After a separately authorized live setup, inspect the local evidence with:

```sh
sqlite3 "$HEARTBEAT_STATE_DB" \
  "SELECT patrol_id,started_at,finished_at,status,sessions_scanned,items_detected,alerts_sent,spawns_started,errors FROM patrol_runs ORDER BY started_at DESC LIMIT 10;"
.venv/bin/python -m json.tool "${HEARTBEAT_COMPLETION_DIR:-$(dirname "$HEARTBEAT_STATE_DB")/completion}/latest.json"
```

Do not interpret process launch, scheduler success, todo insertion, transport
delivery, or a `completed` label without exact owner evidence as business
success. No live acceptance is claimed by the fixture suite.

## 8. Public package allowlist

For a public package, select only the Heartbeat implementation, its scripts,
the public setup document, the non-secret configuration example, and the
selected public installation tests:

```text
.python-version
config/heartbeat.env.example
docs/heartbeat-function-overview.md
heartbeat_patrol/
pyproject.toml
scripts/enqueue-heartbeat-todo
scripts/evaluate-decision-prompt
scripts/heartbeat-control
scripts/heartbeat-log-rotate
scripts/heartbeat-patrol
scripts/heartbeat-temporary-snapshot
scripts/heartbeat-todo-watch
scripts/sync-heartbeat-events
tests/test_public_release_inputs.py
```

The legacy `scripts/r26-history-apply` command is a separately authorized,
destructive historical-maintenance entrypoint, not a required carrier for a new
installation, so it is intentionally excluded from this public allowlist.
The internal `tests/test_r26_history_apply.py` fixture is likewise excluded;
it is retained only for separately authorized historical-maintenance testing.

Exclude local `data/`, private session guidance, generated metadata, local
catalog symlinks, credentials, logs, database files and unrelated historical
rollout notes. This allowlist is a packaging input, not a claim that scheduler,
Lark authorization, todo ownership or any optional mirror is enabled.
