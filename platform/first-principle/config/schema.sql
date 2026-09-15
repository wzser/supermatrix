PRAGMA foreign_keys = ON;

-- These are small local state/shape tables for the static bundle only.
-- They are not the complete remote Session / patrol / Principles governance
-- schemas. The remote native fields and authority live in public-bindings.json.

-- The public generator consumes the fields below indirectly through its
-- command arguments and session-init.ndjson. No public command reads this
-- SQLite table; it is a portable local shape for an owner-side carrier.
CREATE TABLE IF NOT EXISTS session_meta (
  session_name TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  avatar TEXT,
  category TEXT NOT NULL CHECK (category IN ('业务','知识','平台','工具','外部','员工')),
  purpose TEXT NOT NULL,
  backend TEXT NOT NULL,
  workdir TEXT NOT NULL,
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  feishu_sync_ok INTEGER CHECK (feishu_sync_ok IN (0,1) OR feishu_sync_ok IS NULL)
);

-- The public bundle starts patrol disabled and fail-closed locally. The live
-- owner control is the separate Feishu-authoritative FP 巡检配置 table read by
-- first-principle/scripts/fp-patrol-enabled.sh; this table is not its mirror.
CREATE TABLE IF NOT EXISTS patrol_state (
  scope TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  missing_state_policy TEXT NOT NULL DEFAULT 'closed' CHECK (missing_state_policy = 'closed'),
  last_run_id TEXT,
  updated_at TEXT NOT NULL
);

-- The public assembler reads data/module-manifest.json, not this reduced SQL
-- table. This table is only a local audit shape; it must not be treated as a
-- complete remote Principles table or as an authority for assembly.
CREATE TABLE IF NOT EXISTS principle_modules (
  module TEXT PRIMARY KEY,
  section_no INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
);

-- Queue binding metadata is local contract metadata, not a remote table.
CREATE TABLE IF NOT EXISTS queue_bindings (
  binding_key TEXT PRIMARY KEY,
  table_name TEXT NOT NULL UNIQUE,
  queue_entrypoint TEXT NOT NULL,
  write_mode TEXT NOT NULL CHECK (write_mode IN ('owner-queue-only','read-only')),
  read_back_required INTEGER NOT NULL DEFAULT 1 CHECK (read_back_required IN (0,1)),
  remote_asset_id TEXT NOT NULL
);

INSERT OR IGNORE INTO patrol_state
  (scope, enabled, missing_state_policy, updated_at)
VALUES
  ('public-default', 0, 'closed', '1970-01-01T00:00:00Z');
