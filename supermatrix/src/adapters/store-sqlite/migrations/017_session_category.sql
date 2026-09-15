-- session-meta v1.0 contract (FP rules/session-meta-fields.md): add `category`
-- as a first-class column for fresh installs. Existing live DBs already had the
-- column added externally; the migrator's `isAlreadyApplied` path swallows the
-- duplicate-column error and just records the version.
ALTER TABLE sessions ADD COLUMN category TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category);
