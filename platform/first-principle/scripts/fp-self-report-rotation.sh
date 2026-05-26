#!/usr/bin/env bash
# fp-self-report-rotation.sh — bucket rotation for Phase 1.2 daily self-report.
#
# Phase 1.2 used to spawn every FP管辖 session every cycle (~96 sessions × cron 隔日).
# Most reports add no new info. We split sessions into N buckets (default 3) and only
# query one bucket per cycle, rotating through them. Coverage shifts from "every 2
# days" to "every ~6 days" but spawn token cost drops to 1/3.
#
# Selection is "least-recently-reported first" — any session newly added (no cursor
# row) is treated as epoch 0 and prioritized, so new sessions are picked up immediately
# rather than waiting 6 days.
#
# Cursor file: data/.fp-self-report-cursor.json
# Format: { "<session>": "<iso8601 timestamp of last self-report>" }
#
# Usage:
#   select [--bucket-count N]   # default 3; prints ceil(managed/N) session names, one per line
#   mark <session>              # update cursor after self-report finished
#   dump                        # print cursor as pretty JSON
#   stats                       # bucket sizes, never-reported, most-overdue (top 5)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CURSOR_FILE="$FP_ROOT/data/.fp-self-report-cursor.json"

ensure_cursor() {
  [ -f "$CURSOR_FILE" ] || echo '{}' > "$CURSOR_FILE"
}

iso_to_epoch() {
  # macOS BSD date; falls back to 0 if input doesn't parse
  date -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || echo 0
}

managed_list() {
  # FP管辖=true, excluding first-principle itself (it never self-reports to itself)
  bash "$SCRIPT_DIR/fp-managed-list.sh" | grep -v '^first-principle$' || true
}

cmd="${1:-}"; shift || true

case "$cmd" in
  select)
    BUCKET_COUNT=3
    while [ $# -gt 0 ]; do
      case "$1" in
        --bucket-count) BUCKET_COUNT="$2"; shift 2;;
        *) shift;;
      esac
    done
    ensure_cursor
    sessions=$(managed_list)
    total=$(echo "$sessions" | grep -c . || true)
    [ "$total" -eq 0 ] && exit 0
    bucket_size=$(( (total + BUCKET_COUNT - 1) / BUCKET_COUNT ))
    # Sort by last_reported epoch ascending (least-recent first), then take top bucket_size
    echo "$sessions" | while read -r s; do
      [ -z "$s" ] && continue
      ts=$(jq -r --arg s "$s" '.[$s] // "1970-01-01T00:00:00Z"' "$CURSOR_FILE")
      epoch=$(iso_to_epoch "$ts")
      printf '%s\t%s\n' "${epoch:-0}" "$s"
    done | sort -n | head -n "$bucket_size" | awk '{print $2}'
    ;;

  mark)
    session="$1"
    if [ -z "$session" ] || printf '%s' "$session" | grep -q '[[:space:]]'; then
      echo "ERROR: mark expects exactly one session name, got: '$session'" >&2
      exit 2
    fi
    ensure_cursor
    now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    tmp=$(mktemp)
    jq --arg s "$session" --arg ts "$now" '.[$s] = $ts' "$CURSOR_FILE" > "$tmp" && mv "$tmp" "$CURSOR_FILE"
    echo "marked $session at $now"
    ;;

  dump)
    ensure_cursor
    jq . "$CURSOR_FILE"
    ;;

  stats)
    ensure_cursor
    sessions=$(managed_list)
    total=$(echo "$sessions" | grep -c . || true)
    cursor_entries=$(jq 'length' "$CURSOR_FILE")
    echo "Total FP-managed sessions (excl. first-principle): $total"
    echo "Cursor entries: $cursor_entries"
    echo "Default bucket size (3 buckets): $(( (total + 2) / 3 ))"
    echo
    echo "Never reported:"
    echo "$sessions" | while read -r s; do
      [ -z "$s" ] && continue
      val=$(jq -r --arg s "$s" '.[$s] // empty' "$CURSOR_FILE")
      [ -z "$val" ] && echo "  $s"
    done | head -10
    echo
    echo "Most overdue (top 5, oldest cursor first):"
    echo "$sessions" | while read -r s; do
      [ -z "$s" ] && continue
      ts=$(jq -r --arg s "$s" '.[$s] // "1970-01-01T00:00:00Z"' "$CURSOR_FILE")
      printf '%s\t%s\n' "$ts" "$s"
    done | sort | head -5
    ;;

  *)
    cat >&2 <<EOF
usage: $0 <command> [args...]
  select [--bucket-count N]
  mark <session>
  dump
  stats
EOF
    exit 2
    ;;
esac
