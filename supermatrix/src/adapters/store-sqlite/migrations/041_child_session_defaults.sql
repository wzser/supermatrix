CREATE TABLE IF NOT EXISTS child_session_defaults (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  backend TEXT CHECK (backend IS NULL OR backend IN ('claude', 'codex', 'kimi')),
  backend_configured INTEGER NOT NULL DEFAULT 0 CHECK (backend_configured IN (0, 1)),
  model TEXT,
  model_configured INTEGER NOT NULL DEFAULT 0 CHECK (model_configured IN (0, 1)),
  effort TEXT,
  effort_configured INTEGER NOT NULL DEFAULT 0 CHECK (effort_configured IN (0, 1)),
  updated_at INTEGER NOT NULL
);
