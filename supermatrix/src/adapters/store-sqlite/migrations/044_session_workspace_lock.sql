ALTER TABLE sessions
ADD COLUMN workspace_locked INTEGER NOT NULL DEFAULT 0
CHECK (workspace_locked IN (0, 1));
