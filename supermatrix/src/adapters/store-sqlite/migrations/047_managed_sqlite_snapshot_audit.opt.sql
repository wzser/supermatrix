CREATE TABLE IF NOT EXISTS managed_sqlite_snapshot_audit (
  id              TEXT PRIMARY KEY,
  snapshot_id     TEXT NOT NULL,
  operation_id    TEXT NOT NULL,
  event           TEXT NOT NULL CHECK (event IN ('created', 'released')),
  source_path     TEXT NOT NULL,
  owner           TEXT NOT NULL,
  reason          TEXT NOT NULL,
  snapshot_path   TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  snapshot_bytes  INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
  receipt_path    TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  release_reason  TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (snapshot_id, event)
);

CREATE INDEX IF NOT EXISTS idx_managed_sqlite_snapshot_audit_snapshot_created
  ON managed_sqlite_snapshot_audit(snapshot_id, created_at);
