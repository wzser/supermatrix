CREATE TABLE IF NOT EXISTS backend_runtime_defaults (
  backend TEXT PRIMARY KEY CHECK (backend IN ('claude', 'codex', 'kimi')),
  model TEXT,
  effort TEXT,
  updated_at INTEGER NOT NULL
);
