# Codex State Snapshot Lifecycle

Use this only before a Codex-state recovery that changes `~/.codex/state_5.sqlite` data. The active database is never copied with `cp`, renamed, replaced, or deleted by this workflow. The tool opens it read-only and uses SQLite's backup API to create a consistent full snapshot.

```sh
npx tsx scripts/codex-state-snapshot.ts create \
  --owner codexroot \
  --operation-id codex-restore-20260804-example \
  --reason 'restore 2026-08-03 incident threads' \
  --expiry-hours 24
```

The command creates exactly one managed artifact beneath:

`/Users/LOCAL_USER/SuperMatrixRuntime/data/codex-state-snapshots/snapshots/<snapshot-id>/state_5.sqlite`

Its compact receipt is retained separately at:

`/Users/LOCAL_USER/SuperMatrixRuntime/data/codex-state-snapshots/receipts/<snapshot-id>.json`

The receipt requires `owner`, `operationId`, `reason`, `createdAt`, `expiresAt`, full-SHA-256, bytes, and `PRAGMA quick_check(1)=ok`. `expiry-hours` is mandatory and limited to 1–72 hours. The durable history is written as append-only `created` / `released` rows in SuperMatrix's primary `supermatrix.db` table `managed_sqlite_snapshot_audit`; the old `codex_state_snapshot_audit` table remains historical only. No historical full database copy is retained for audit purposes.

After the restore's own verification succeeds, release the pre-restore artifact immediately:

```sh
npx tsx scripts/codex-state-snapshot.ts finalize \
  --receipt /Users/LOCAL_USER/SuperMatrixRuntime/data/codex-state-snapshots/receipts/<snapshot-id>.json \
  --operation-id codex-restore-20260804-example
```

`finalize` requires the matching operation ID, reads the active database only to require `PRAGMA quick_check(1)=ok`, deletes the managed snapshot artifact, and retains the receipt plus a `released` audit row. A second active snapshot for the same source is rejected; it cannot silently replace rollback state for an unfinished operation. The existing daily `weekly-cache-cleanup --apply` job runs the same generic expiry sweep, so expired artifacts are removed even if a recovery operator does not finalize them. Schema-v1 receipts and their existing `state_5.sqlite` paths remain readable until they expire.

Do not make recovery copies at `~/.codex/state_5.sqlite.bak-*` or under incident folders such as `codex-transcript-restore/`. The daily cleanup has a 3-day fail-safe rule for legacy `state_5.sqlite.bak-*`; it never matches the active `state_5.sqlite`, `state_5.sqlite-wal`, or `state_5.sqlite-shm` files.
