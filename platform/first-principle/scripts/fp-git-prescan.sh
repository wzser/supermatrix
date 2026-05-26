#!/usr/bin/env bash
# fp-git-prescan.sh — pre-scan workspaces by HEAD commit recency for Phase 1.1.
#
# Phase 1.1 used to run `git log --since='2 days ago'` against every FP管辖 session.
# Most sessions have no commits in the window, so the call returns empty but still
# costs context tokens. This helper does a cheap `git log -1 --format=%ct` (one unix
# timestamp) and emits only the sessions whose HEAD commit is within --days.
#
# Usage:
#   bash scripts/fp-git-prescan.sh                 # default --days 2, FP管辖 only, active only
#   bash scripts/fp-git-prescan.sh --days 7
#   bash scripts/fp-git-prescan.sh --all           # include stale rows too
#
# Output (tab-separated, sorted by most-recent commit first):
#   <session>\t<workdir>\t<head_commit_ts>\t<active|stale>

set -euo pipefail

DAYS=2
INCLUDE_STALE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2;;
    --all)  INCLUDE_STALE=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${SM_RUNTIME_ROOT:-<SM_RUNTIME_ROOT>}/data/supermatrix.db"
CUTOFF=$(( $(date +%s) - DAYS * 86400 ))

# FP管辖 names → pipe-separated for awk match
MANAGED_PIPE=$(bash "$SCRIPT_DIR/fp-managed-list.sh" | tr '\n' '|' | sed 's/|$//')

sqlite3 "$DB" "SELECT name||'|'||workdir FROM sessions WHERE status != 'deleted';" \
| awk -F'|' -v list="|$MANAGED_PIPE|" '{ if (index(list, "|"$1"|")>0) print $1"\t"$2 }' \
| while IFS=$'\t' read -r name workdir; do
    [ -d "$workdir/.git" ] || continue
    head_ts=$(git -C "$workdir" log -1 --format=%ct 2>/dev/null || echo "0")
    if [ "${head_ts:-0}" -ge "$CUTOFF" ]; then
      status="active"
    else
      status="stale"
    fi
    if [ "$status" = "active" ] || [ "$INCLUDE_STALE" = "1" ]; then
      printf "%s\t%s\t%s\t%s\n" "$name" "$workdir" "$head_ts" "$status"
    fi
  done \
| sort -t$'\t' -k3,3nr
