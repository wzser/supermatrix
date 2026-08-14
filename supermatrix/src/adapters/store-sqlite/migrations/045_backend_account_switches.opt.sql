CREATE TABLE IF NOT EXISTS backend_account_switches (
  client_request_id TEXT PRIMARY KEY,
  backend           TEXT NOT NULL,
  caller            TEXT NOT NULL,
  from_profile      TEXT,
  to_profile        TEXT,
  switched_at       TEXT,
  cleared_sessions  INTEGER NOT NULL,
  cleared_branches  INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
