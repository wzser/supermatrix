#!/usr/bin/env bash
set -u
# Auto-repair: schema_version drift (column exists but version not recorded)
# Called by localwatch when crash log contains "duplicate column"

DB="${SM_DB_PATH:?SM_DB_PATH not set}"

if [[ ! -f "$DB" ]]; then
  echo "ERROR: DB not found: $DB"
  exit 1
fi

echo "Scanning for unrecorded migration versions..."

max_recorded=$(sqlite3 "$DB" "SELECT COALESCE(MAX(version), 0) FROM schema_version;" 2>/dev/null)
echo "Highest recorded version: $max_recorded"

# Check if cross_session_log has bitable_record_id (migration 008's column)
has_bitable_col=$(sqlite3 "$DB" "PRAGMA table_info(cross_session_log);" 2>/dev/null | grep -c "bitable_record_id" || true)

if [[ "$has_bitable_col" -gt 0 && "$max_recorded" -lt 8 ]]; then
  echo "Migration 008 columns exist but version not recorded. Backfilling..."
  sqlite3 "$DB" "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (8, $(date +%s000));"
  echo "Done: version 8 recorded."
fi

# Clean up stale pid file
pid_file="$(dirname "$DB")/.bootstrap.pid"
if [[ -f "$pid_file" ]]; then
  echo "Removing stale pid file: $pid_file"
  rm -f "$pid_file"
fi

echo "Migration drift repair complete."
