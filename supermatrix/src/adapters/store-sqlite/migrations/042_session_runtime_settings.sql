-- Keep this dependency local for compatibility with databases whose migration
-- ledger says 039 is applied but whose defaults table is missing.
CREATE TABLE IF NOT EXISTS backend_runtime_defaults (
  backend TEXT PRIMARY KEY CHECK (backend IN ('claude', 'codex', 'kimi')),
  model TEXT,
  effort TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_runtime_settings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  main_model_default TEXT,
  main_effort_default TEXT CHECK (
    main_effort_default IS NULL OR main_effort_default IN
      ('low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode')
  ),
  child_backend TEXT CHECK (
    child_backend IS NULL OR child_backend IN ('claude', 'codex', 'kimi')
  ),
  child_backend_configured INTEGER NOT NULL DEFAULT 0 CHECK (child_backend_configured IN (0, 1)),
  child_model TEXT,
  child_model_configured INTEGER NOT NULL DEFAULT 0 CHECK (child_model_configured IN (0, 1)),
  child_effort TEXT CHECK (
    child_effort IS NULL OR child_effort IN
      ('low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode')
  ),
  child_effort_configured INTEGER NOT NULL DEFAULT 0 CHECK (child_effort_configured IN (0, 1)),
  updated_at INTEGER NOT NULL,
  CHECK (
    (child_backend_configured = 0 AND child_backend IS NULL) OR
    (child_backend_configured = 1 AND child_backend IS NOT NULL)
  ),
  CHECK (
    (child_model_configured = 0 AND child_model IS NULL) OR
    (child_model_configured = 1 AND child_model IS NOT NULL)
  ),
  CHECK (
    (child_effort_configured = 0 AND child_effort IS NULL) OR
    (child_effort_configured = 1 AND child_effort IS NOT NULL)
  )
);

INSERT OR IGNORE INTO session_runtime_settings (
  session_id,
  main_model_default,
  main_effort_default,
  child_backend,
  child_backend_configured,
  child_model,
  child_model_configured,
  child_effort,
  child_effort_configured,
  updated_at
)
SELECT
  sessions.id,
  CASE WHEN defaults.backend IS NULL THEN
    CASE sessions.backend
      WHEN 'codex' THEN 'gpt-5.6-terra'
      WHEN 'claude' THEN 'claude-opus-4-8'
      WHEN 'kimi' THEN 'kimi-code/k3'
    END
  ELSE defaults.model END,
  CASE WHEN defaults.backend IS NULL THEN
    CASE sessions.backend
      WHEN 'codex' THEN 'max'
      WHEN 'claude' THEN 'xhigh'
      WHEN 'kimi' THEN NULL
    END
  ELSE defaults.effort END,
  NULL, 0, NULL, 0, NULL, 0, sessions.updated_at
FROM sessions
LEFT JOIN backend_runtime_defaults AS defaults ON defaults.backend = sessions.backend
WHERE sessions.scope != 'child';
