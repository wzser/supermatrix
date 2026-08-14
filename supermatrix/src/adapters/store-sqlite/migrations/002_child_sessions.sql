ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_sessions_parent_id ON sessions(parent_id);
