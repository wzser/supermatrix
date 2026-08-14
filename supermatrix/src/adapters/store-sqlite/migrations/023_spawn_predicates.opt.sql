CREATE TABLE spawn_predicates (
  spawn_comm_id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  created_by_session_id TEXT NOT NULL,
  last_patched_by_session_id TEXT,
  predicate_json TEXT NOT NULL,
  predicate_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (spawn_comm_id) REFERENCES cross_session_log(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_session_id) REFERENCES sessions(id),
  FOREIGN KEY (created_by_session_id) REFERENCES sessions(id),
  FOREIGN KEY (last_patched_by_session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_spawn_predicates_owner
  ON spawn_predicates(owner_session_id, created_at DESC);
CREATE INDEX idx_spawn_predicates_status
  ON spawn_predicates(status, updated_at DESC);

CREATE TABLE spawn_predicate_patches (
  id TEXT PRIMARY KEY,
  spawn_comm_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  actor_session_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'sk', 'root')),
  tx_id TEXT,
  old_predicate_json TEXT,
  new_predicate_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (spawn_comm_id) REFERENCES spawn_predicates(spawn_comm_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_spawn_predicate_patches_comm
  ON spawn_predicate_patches(spawn_comm_id, created_at DESC);
CREATE INDEX idx_spawn_predicate_patches_actor
  ON spawn_predicate_patches(actor_session_id, created_at DESC);
