#!/bin/zsh
# Safe reload: check all sessions are idle, then trigger /reload.
#
# Exit codes:
#   0 — handled successfully (reload fired OR busy-skip OR dedup-skip; all valid no-fault terminals).
#       Disambiguate via stdout markers, not exit code:
#         "[reload-fired]"        → /reload was dispatched to the root group
#         "[busy-skip] count=N"   → N busy sessions, no action taken this tick
#         "[dedup-skip] age=Ns"   → reload was already fired within the dedup window
#   2 — env/config error (real failure; safe to heal/alert)
#
# Why exit 0 on busy-skip: scheduler proofs (exit_zero) and idempotent retry models
# treat non-zero as "did not handle, retry/heal." A busy-skip handled the tick
# correctly — the answer was just "not now." Returning non-zero makes every direct
# caller wrap the script to absorb it (see watchdog/src/scripts/safe-reload-watch.sh
# for the historical wrapper). Lifting the absorption into the script itself keeps
# future consumers from re-discovering this footgun.
#
# Why dedup: two scheduler tasks (daily-reload, daily-reload-fallback) call this
# script. The fallback cron `*/5 4-7 * * *` re-fires every 5 min during a 4h window;
# without dedup, every idle tick re-issues /reload, causing 100+ restarts per window.
# The marker file records the timestamp of the last successful reload-fired and
# suppresses subsequent calls within SM_RELOAD_DEDUP_WINDOW_SEC (default 6h, wide
# enough that a 03:50 daily-reload silences fallback ticks all the way through 09:50,
# avoiding the boundary case where a marker would just barely age out at 07:55).
#
# Usage:
#   ./scripts/safe-reload.sh
#
# Designed to be called by scheduler's shell executor:
#   /bin/sh -c '/path/to/SuperMatrix/scripts/safe-reload.sh'

set -eu

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ missing $ENV_FILE" >&2
  exit 2
fi

set -a
source "$ENV_FILE"
set +a

DB_PATH="${SM_DB_PATH:?SM_DB_PATH not set}"
ROOT_GROUP="${SM_ROOT_GROUP_ID:?SM_ROOT_GROUP_ID not set}"
LARK_CLI="${SM_LARK_CLI_PATH:-$REPO_DIR/node_modules/.bin/lark-cli}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "❌ database not found: $DB_PATH" >&2
  exit 2
fi

# Dedup: if we already fired /reload within the dedup window, skip this tick.
# Marker lives next to scheduler.db / supermatrix.db in SuperMatrixRuntime/data so
# it survives logs/ rotation. Default 14400s (4h) covers the daily-reload (03:50)
# → fallback (04:00–07:55) overlap; one successful reload silences the whole window.
RELOAD_DEDUP_WINDOW_SEC="${SM_RELOAD_DEDUP_WINDOW_SEC:-21600}"
RELOAD_MARKER="$(dirname "$DB_PATH")/.last-reload-fired"

if [[ -f "$RELOAD_MARKER" ]]; then
  marker_mtime=$(stat -f %m "$RELOAD_MARKER" 2>/dev/null || stat -c %Y "$RELOAD_MARKER" 2>/dev/null || echo 0)
  marker_age=$(( $(date +%s) - marker_mtime ))
  if (( marker_age < RELOAD_DEDUP_WINDOW_SEC )); then
    echo "[dedup-skip] age=${marker_age}s window=${RELOAD_DEDUP_WINDOW_SEC}s"
    exit 0
  fi
fi

# Check for busy sessions
busy_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions WHERE status = 'busy';") || {
  echo "❌ sqlite3 query failed" >&2
  exit 2
}

if [[ "$busy_count" -gt 0 ]]; then
  echo "[busy-skip] count=$busy_count"
  echo "⏳ $busy_count busy session(s), skipping reload"
  exit 0
fi

# All idle — send /reload to root group
RELOAD_SOURCE="${SM_RELOAD_SOURCE:-scheduler}"
echo "✓ all sessions idle, triggering /reload --source $RELOAD_SOURCE"
result=$("$LARK_CLI" im +messages-send --as user --chat-id "$ROOT_GROUP" --text "/reload --source $RELOAD_SOURCE") || {
  echo "❌ lark-cli send failed" >&2
  exit 2
}

# Verify lark-cli returned ok
if ! echo "$result" | grep -q '"ok": true'; then
  echo "❌ lark-cli did not return ok: $result" >&2
  exit 2
fi

touch "$RELOAD_MARKER"
echo "[reload-fired]"
echo "✓ reload triggered"
exit 0
