-- Durable per-backend maintenance fence. A lease is deliberately separate
-- from session status: it serializes a backend-wide credential/config change
-- against new message-run admission, while in-flight runs are allowed to drain.
CREATE TABLE IF NOT EXISTS backend_maintenance_leases (
  backend TEXT PRIMARY KEY CHECK (backend IN ('claude', 'codex', 'kimi')),
  owner TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backend_maintenance_lease_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex', 'kimi')),
  action TEXT NOT NULL CHECK (action IN ('acquire', 'release')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'acquired',
    'duplicate',
    'running_message_runs',
    'held',
    'released',
    'not_held',
    'owner_mismatch',
    'token_mismatch'
  )),
  owner TEXT NOT NULL,
  request_id TEXT NOT NULL,
  lease_owner TEXT,
  running_message_run_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backend_maintenance_lease_events_backend_created
  ON backend_maintenance_lease_events(backend, created_at DESC, id DESC);
