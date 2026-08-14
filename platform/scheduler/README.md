# Scheduler v2

Scheduler v2 is the only scheduler implementation published in Super Matrix `v0.2.0`. It runs as a separate process on port `3502` by default and stores state in its own SQLite database. The legacy port `3500` service is retired.

## Contract

Scheduler owns task definitions, cron evaluation, trigger execution, run records, and mutation authorization. It does not own the target session's business result.

- `script` tasks with a positive timeout are successful when the process exits with code 0.
- `script` tasks without a timeout are successful when the process starts and returns a PID.
- `session` tasks are successful when the target child request is accepted and returns a reference.

In every case, trigger success is not proof that downstream work finished correctly. The target owner must verify its own output.

## Requirements

- Node.js `>=22`
- a writable Scheduler v2 SQLite path
- read access to the Super Matrix core SQLite database
- a running Super Matrix API on port `3501`
- a local admin token for mutation endpoints

## Configuration

```dotenv
SCHEDULER_V2_HOST=127.0.0.1
SCHEDULER_V2_PORT=3502
SCHEDULER_V2_DB=$HOME/SuperMatrixRuntime/scheduler-v2/scheduler.db
SM_DB=$HOME/SuperMatrixRuntime/data/supermatrix.db
SM_BASE_URL=http://127.0.0.1:3501
SCHEDULER_ADMIN_TOKEN=REPLACE_WITH_LOCAL_SECRET
```

Keep `SCHEDULER_ADMIN_TOKEN` and both databases outside Git. Bind to loopback unless external access is intentionally authenticated and protected.

## Install and Run

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

For development:

```bash
npm run dev
```

Health check:

```bash
curl -s http://127.0.0.1:3502/health
```

## HTTP Surface

Read endpoints:

- `GET /health`
- `GET /tasks`
- `GET /tasks/:id`
- `GET /tasks/:id/runs`
- `GET /runs/recent`
- `GET /mutations`

Mutation endpoints require the configured admin token:

- `POST /tasks`
- `PATCH /tasks/:id`
- `DELETE /tasks/:id`
- `POST /tasks/:id/run`

Use the exact request schema implemented by `src/api/routes.ts`. Do not infer a task schema from examples or from the retired scheduler.

## Verification

Before treating a deployment as ready:

1. `npm run typecheck` and `npm test` pass.
2. `GET /health` returns `service: scheduler-v2` on port 3502.
3. A read request succeeds without mutation credentials.
4. An unauthorized mutation is rejected.
5. An authorized test task produces a run record.
6. The target session independently verifies the triggered work.
