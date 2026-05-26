#!/usr/bin/env bash
# lookup-session.sh — query SuperMatrix DB for live session binding info.
#
# Source of truth: $SM_RUNTIME_ROOT/data/supermatrix.db (sessions + bindings tables).
# Always reads live, never caches. Cross-session log only stores sess_xxx ids;
# this helper resolves them back to name / alias / purpose / backend.
#
# Usage:
#   lookup-session.sh by-id <sess_xxx>          → one row (TSV: name|alias|backend|category|status|purpose)
#   lookup-session.sh by-name <name>            → one row, matches name OR alias
#   lookup-session.sh all-active                → all non-child non-deleted sessions
#   lookup-session.sh resolve-child <sess_child_xxx>  → child id → parent name
#   lookup-session.sh count-by-backend          → how many active per backend
#
# Output is pipe-separated to make `cut -d'|'` parsing straightforward.

set -euo pipefail

RUNTIME_ROOT="${SM_RUNTIME_ROOT:-${HOME}/SuperMatrixRuntime}"
DB="${SM_DB_PATH:-${RUNTIME_ROOT}/data/supermatrix.db}"

if [[ ! -f "$DB" ]]; then
  echo "ERROR: DB not found at $DB" >&2
  exit 1
fi

cmd="${1:-}"
arg="${2:-}"

case "$cmd" in
  by-id)
    [[ -z "$arg" ]] && { echo "usage: $0 by-id <sess_xxx>" >&2; exit 2; }
    sqlite3 "$DB" -separator '|' \
      "SELECT name, COALESCE(alias,''), backend, COALESCE(category,''), status, COALESCE(purpose,'')
       FROM sessions WHERE id = '$arg' LIMIT 1;"
    ;;
  by-name)
    [[ -z "$arg" ]] && { echo "usage: $0 by-name <name-or-alias>" >&2; exit 2; }
    sqlite3 "$DB" -separator '|' \
      "SELECT id, name, COALESCE(alias,''), backend, COALESCE(category,''), status, COALESCE(purpose,'')
       FROM sessions
       WHERE (name = '$arg' OR alias = '$arg') AND scope != 'child' AND status != 'deleted'
       LIMIT 1;"
    ;;
  all-active)
    sqlite3 "$DB" -separator '|' -header \
      "SELECT id, name, COALESCE(alias,'') AS alias, backend, COALESCE(category,'') AS category,
              status, COALESCE(purpose,'') AS purpose
       FROM sessions
       WHERE scope != 'child' AND status != 'deleted'
       ORDER BY category, name;"
    ;;
  resolve-child)
    [[ -z "$arg" ]] && { echo "usage: $0 resolve-child <sess_child_xxx>" >&2; exit 2; }
    sqlite3 "$DB" -separator '|' \
      "SELECT s.id AS child_id, s.name AS child_name, p.id AS parent_id, p.name AS parent_name
       FROM sessions s LEFT JOIN sessions p ON s.parent_id = p.id
       WHERE s.id = '$arg';"
    ;;
  count-by-backend)
    sqlite3 "$DB" -separator '|' -header \
      "SELECT backend, COUNT(*) AS n
       FROM sessions
       WHERE scope != 'child' AND status != 'deleted'
       GROUP BY backend;"
    ;;
  *)
    sed -n '4,17p' "$0" >&2
    exit 2
    ;;
esac
