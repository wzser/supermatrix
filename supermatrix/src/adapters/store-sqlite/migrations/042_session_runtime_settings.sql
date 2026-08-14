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
SELECT id, NULL, NULL, NULL, 0, NULL, 0, NULL, 0, updated_at
FROM sessions
WHERE scope != 'child';
