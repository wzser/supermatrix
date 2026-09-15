# Agent communication review: public-safe input

This directory is a small, portable input package for an agent that already has
the host's commands. It documents two live workflows:

1. interview both sides before writing a communication judgment;
2. adjudicate one stalled Spawn2.0 exception from one immutable snapshot.

There is no installer, daemon, scheduler, queue worker, watcher, messaging writer,
database copy, secret, or production state in this package. The receiving agent
reads the Markdown, fills its local configuration, and uses its existing
`/api/spawn2.0` and table-sync commands.

## First run

```bash
cd public-safe
node --version                 # Node.js >=20.0.0
npm run verify                 # local stub only; no network or external writes
```

Then read, in order:

1. `CONFIG.md`
2. `sop/INDEX.md`
3. the active SOP matching the work (`judgment-via-interview` or
   `spawn-exception-transaction`)
4. the referenced JSON Schema files.

`scripts/verify-stub-flow.mjs` is the acceptance probe. It simulates terminal
Spawn2 A and B responses, creates one judgment and one exception transaction in
a temporary local ledger, checks append-only ordering, and checks that the table
projection never writes the human-authoritative fields.

The deprecated cross-session report runner is intentionally absent. It is not
an implementation of either live workflow.
