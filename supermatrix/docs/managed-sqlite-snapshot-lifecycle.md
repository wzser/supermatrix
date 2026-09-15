# Managed SQLite Snapshot Lifecycle

Use this before a mutation or recovery that changes one of the live runtime databases:

- `SuperMatrixRuntime/data/supermatrix.db`
- `SuperMatrixRuntime/data/scheduler.db`
- `SuperMatrixRuntime/data/scheduler-v2.db`

The snapshot is rollback protection for that operation, not cache-cleanup input and not a disaster backup. The tool uses SQLite's backup API, verifies `PRAGMA quick_check(1)`, records SHA-256 and bytes, and requires `owner`, `operationId`, `reason`, and a hard 1–72 hour expiry.

```sh
npx tsx scripts/managed-sqlite-snapshot.ts create \
  --source-db /Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db \
  --owner codexroot \
  --operation-id repair-mr_example \
  --reason 'repair stale run state' \
  --expiry-hours 24
```

Artifacts live only beneath:

`/Users/LOCAL_USER/SuperMatrixRuntime/data/managed-sqlite-snapshots/snapshots/<snapshot-id>/snapshot.sqlite`

Compact receipts remain beneath `managed-sqlite-snapshots/receipts/`. Lifecycle events are append-only rows in `managed_sqlite_snapshot_audit`.

Only one active managed snapshot is allowed for a source database. A second create fails instead of deleting rollback state for an unfinished operation.

After the mutation's semantic checks and source `quick_check` pass, release the full artifact immediately:

```sh
npx tsx scripts/managed-sqlite-snapshot.ts finalize \
  --receipt /Users/LOCAL_USER/SuperMatrixRuntime/data/managed-sqlite-snapshots/receipts/<snapshot-id>.json \
  --operation-id repair-mr_example
```

Run the independent lifecycle sweep explicitly when expired artifacts need to be
released:

```sh
npx tsx scripts/managed-sqlite-snapshot.ts prune
```

When this command is invoked, missing or corrupt receipts cannot retain a managed
artifact forever: an orphaned managed directory is hard-pruned after 72 hours and
recorded by this lifecycle entrypoint. Invocation is a separate operational
responsibility; this command is deliberately outside the weekly cache-cleanup
dry-run/apply scope and is not scheduled by that entrypoint.

Do not create new `supermatrix-before-*`, `supermatrix.db.pre-*`, or `scheduler*.bak*` files manually. A separate three-day cleanup rule exists only as a fail-safe for legacy unmanaged copies.

External full backups are independent disaster recovery. Their success or failure neither creates a local mutation snapshot nor extends a local snapshot's expiry.
