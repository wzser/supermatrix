# Scheduler v2

Scheduler v2 is the only scheduler in this package. It is a small,
fire-and-forget cron service: at each scheduled slot it triggers a local script
or calls the core runtime's Spawn2.0 endpoint, then records trigger state in its
own SQLite database. It does not execute business work or certify that a target
session finished its work.

The legacy scheduler and its old listener (port 3500) are retired. Do not start
it, install it, or run the two services in parallel. One S5/LocalWatch-managed
process runs this v2 service on port 3502 by default.

## Standard setup

There is no dedicated installer. The receiving agent uses this document and the
existing Node commands:

```sh
cd v2
cp config.example.env .env.local
# Edit .env.local locally. Never commit it.
set -a; . ./.env.local; set +a
npm ci
npm run typecheck
npm test
npm run build
./start.sh
```

`start.sh` uses `SM_ENV_FILE` when supplied, otherwise it uses the environment
already provided by the caller. It runs `npm ci` only when dependencies are
missing and then executes the built service. S5/LocalWatch owns the lifecycle;
do not add another daemon, installer, watcher, or queue.

## Configuration and security boundary

The scheduler database is independent from the core runtime database:

- `SCHEDULER_V2_DB` is the writable v2 database. It contains the scheduler's
  task, run, and mutation records.
- `SM_DB` is the core runtime database, opened read-only for session-category
  lookup. It is not the scheduler database and must not be copied from another
  installation.
- `SM_BASE_URL` is the local core API base, normally
  `http://127.0.0.1:3501`.
- `SCHEDULER_ADMIN_TOKEN` is a new, local, randomly generated write token. Do
  not reuse an application secret or place the token in Git.
- Authenticated mutations require `X-Scheduler-Auth`,
  `X-SM-Actor-Session`, and `X-SM-Spawn-Comm-Id`. The latter two values are
  persisted in `task_mutations` together with before/after snapshots. The
  loopback session-oneshot creation exception uses the explicit synthetic actor
  `loopback_session_oneshot`; it does not trust caller-supplied attribution.

Bind to loopback unless an intentionally secured reverse proxy is part of the
installation. Missing `SCHEDULER_ADMIN_TOKEN` is a startup error, not an
unlocked development mode. The service must not be considered ready until the
token is configured.

Cron expressions use the process timezone. Set `TZ` in the environment before
starting the service when a fixed timezone is required; for example,
`TZ=Asia/Shanghai`. The daily mirror's idempotency date is always calculated in
`Asia/Shanghai`, regardless of the process timezone.

## Runtime model

The SQLite schema has three tables:

- `tasks`: one row per task definition.
- `task_runs`: append-only trigger history. A pessimistic failed row is written
  before dispatch and becomes `success` only after trigger acceptance.
- `task_mutations`: append-only create/update/delete/disable audit records with
  actor, communication id, and before/after snapshots. It intentionally has no
  foreign key to `tasks`, so delete attribution survives task deletion.

Every scheduled slot is idempotent on `(task_id, scheduled_at)`. `success` and
`last_success_at` mean trigger success only:

- script: a PID was obtained, or a configured wait-for-exit completed with code
  zero;
- session: Spawn2.0 returned a real child reference.

They do not prove that business work, a message, a report, or a downstream
write completed. The target owner must verify its own result. A `POST` that
accepts a manual run, a healthy `/health` response, or a queue receipt is not
itself business acceptance.

Failure alerts use the core runtime's `POST ${SM_BASE_URL}/api/notify` endpoint
with `source: "scheduler"`; the scheduler never invokes a user identity or a
direct Lark CLI notification. `alertChannel: "none"` disables alerts,
`owner_dm` follows the core runtime's scheduler route, and `oc_<chat-id>` is an
explicit destination supplied by the local installation. The channel value is
not proof that a task owner received or acted on an alert.

## API and write path

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Process health: `{"ok":true,"service":"scheduler-v2"}` |
| POST | `/tasks` | Create a task; 201 plus a task id on success |
| GET | `/tasks` and `/tasks/:id` | Read task definitions |
| PATCH | `/tasks/:id` | Update and re-register a task |
| DELETE | `/tasks/:id` | Unregister and delete a task |
| POST | `/tasks/:id/run` | Accept a manual trigger request (202) |
| GET | `/tasks/:id/runs` and `/runs/recent` | Read trigger history |
| GET | `/mutations` | Read mutation audit records |

Recurring task writes and all deletes/updates/manual runs go through the
scheduler's protected write path. The normal cross-session route is a Spawn2.0
request addressed to the scheduler owner. The narrow unauthenticated exception
is only loopback `POST /tasks` for a `session` task with `oneshot: true`.

## Real trigger acceptance

Use a disposable database, port, runtime directory, and marker file for a local
smoke test. The minimum evidence is: health 200; task create 201; GET read-back
matching the task id/name; manual run 202; a `success` run with the expected
trigger evidence; and the marker or target-side artifact. Also read
`/mutations` and confirm the expected actor and communication id. Do not use a
production database or task for this check.

For a session task, trigger acceptance stops at a real Spawn2.0 child reference;
the owner must separately verify the delivered message or business artifact.
For a script task with a positive `config.timeout`, verify exit code zero through
the resulting `success` run. With no timeout, verify the PID and the script's
own artifact because the scheduler intentionally does not follow the child.

## Daily table mirror (best effort)

The mirror is not part of the cron dispatch critical path. The daily script
reads the scheduler DB read-only and submits one complete roster to the external
`feishu-sync-enqueue` command using asset name
`scheduler.mirror.v2-tasks`. Configure `SCHEDULER_MIRROR_ENQUEUE_BIN` if that
command is not on `PATH`.

The receiving runtime must separately provide the queue command, register the
logical asset, configure the table schema and permissions, and complete its own
Lark authorization. No token, table id, chat id, or remote resource id belongs
in this package. `accepted` or `duplicate` proves queue admission only; it does
not prove an immediate remote table read-back. A mirror failure must not stop
scheduled task dispatch.

The asset's logical row schema is:

| Field | Type | Meaning |
|---|---|---|
| `task_id`, `name`, `owner`, `type`, `cron`, `category`, `description`, `config`, `prompt`, `alert_channel`, `latest_outcome` | text | Task identity and readable configuration/status |
| `enabled`, `retry_enabled` | checkbox/boolean | Current task flags |
| `alert_threshold` | number | Consecutive-failure alert threshold |
| `last_success_at` | number/datetime | Last accepted trigger timestamp |

The table owner must ensure the registered schema matches these logical names
and types before enabling the daily mirror. The scheduler does not create or
rename remote fields.

## Verification commands

```sh
cd v2
npm ci
npm run typecheck
npm test
npm run build
```

These checks prove the public package builds and its local tests pass. They do
not prove a new user's Lark consent, application approval, backend login,
cross-session delivery, scheduled delivery, or restart persistence. Those are
external inputs and must be verified by the receiving agent with disposable
local state and the target owner's own evidence.
