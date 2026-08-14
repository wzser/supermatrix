#!/bin/zsh
# Safe reload: check all sessions are idle, then trigger /reload.
#
# Exit codes:
#   0 — handled successfully (reload fired OR busy-skip OR dedup-skip OR claim-contended;
#       all valid no-fault terminals). Disambiguate via stdout markers, not exit code:
#         "[reload-fired]"        → /reload was dispatched to the root group
#         "[busy-skip] count=N"   → N busy sessions, no action taken this tick
#         "[dedup-skip] age=Ns"   → reload was already fired within the dedup window
#         "[claim-contended]"     → a concurrent tick owns the claim; it dispatches, not us
#   2 — env/config error, or an ambiguous dispatch (real failure; safe to alert).
#       "[dispatch-ambiguous]" on stderr means the /reload may already have been
#       delivered; the claim is retained so no later tick re-sends it.
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
# The marker file records the timestamp at which a tick claimed the dispatch and
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
#
# The marker is a CLAIM, written before the lark-cli dispatch — not a receipt
# written after it. Writing it after left a window where a delivered /reload was
# never recorded: lark-cli exiting non-zero after the send, an `ok` shape the grep
# missed, or the process dying between send and touch all left the marker absent,
# so the next `*/5` fallback tick re-sent /reload and the box entered a reload loop
# (incident watchdog-kimi-acp-982f503). Claiming first makes dispatch at-most-once:
# once a tick owns the window, every later ambiguity fails CLOSED (exit 2, claim
# retained) instead of handing the next tick a fresh permit.
RELOAD_DEDUP_WINDOW_SEC="${SM_RELOAD_DEDUP_WINDOW_SEC:-21600}"
RELOAD_SOURCE="${SM_RELOAD_SOURCE:-scheduler}"
RELOAD_MARKER="$(dirname "$DB_PATH")/.last-reload-fired"
RELOAD_CLAIM_LOCK="${RELOAD_MARKER}.claim.lock"
# The claim critical section is a stat plus a write, so it never legitimately
# spans minutes; a lock older than this can only be a crashed section. Without the
# breaker a single SIGKILL would wedge safe reload permanently.
RELOAD_CLAIM_LOCK_STALE_SEC="${SM_RELOAD_CLAIM_LOCK_STALE_SEC:-300}"

file_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# Exits the script on a live claim; returns 0 when this tick may claim the window.
dedup_skip_if_claimed() {
  [[ -f "$RELOAD_MARKER" ]] || return 0
  local marker_age
  marker_age=$(( $(date +%s) - $(file_mtime "$RELOAD_MARKER") ))
  if (( marker_age < RELOAD_DEDUP_WINDOW_SEC )); then
    echo "[dedup-skip] age=${marker_age}s window=${RELOAD_DEDUP_WINDOW_SEC}s"
    exit 0
  fi
  return 0
}

# Fast path: answer the common "already reloaded today" tick without taking the
# lock or querying sqlite. Re-checked under the lock before claiming.
dedup_skip_if_claimed

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

# Claim the window. The lock only serializes check-and-claim so two ticks that both
# saw an aged-out marker cannot both dispatch; it is released before the send, so a
# dispatcher killed mid-send cannot wedge later ticks. What suppresses them is the
# claim, not the lock.
if [[ -d "$RELOAD_CLAIM_LOCK" ]]; then
  lock_age=$(( $(date +%s) - $(file_mtime "$RELOAD_CLAIM_LOCK") ))
  if (( lock_age > RELOAD_CLAIM_LOCK_STALE_SEC )); then
    echo "⚠️ breaking stale claim lock (age=${lock_age}s)" >&2
    rmdir "$RELOAD_CLAIM_LOCK" 2>/dev/null || true
  fi
fi

if ! mkdir "$RELOAD_CLAIM_LOCK" 2>/dev/null; then
  echo "[claim-contended] another safe-reload tick is claiming this window"
  exit 0
fi
trap 'rmdir "$RELOAD_CLAIM_LOCK" 2>/dev/null || true' EXIT

# Whoever held the lock may have just claimed the window under us.
dedup_skip_if_claimed

# Persist the claim BEFORE the side effect. Write-then-rename so a torn write can
# never surface as a valid-looking marker; flush so a crash cannot resurrect the
# permit and let the next tick re-send.
claim_tmp="${RELOAD_MARKER}.claim.$$"
printf 'claimed_at=%s source=%s\n' "$(date +%s)" "$RELOAD_SOURCE" > "$claim_tmp"
mv -f "$claim_tmp" "$RELOAD_MARKER"
sync 2>/dev/null || true

rmdir "$RELOAD_CLAIM_LOCK" 2>/dev/null || true
trap - EXIT

# All idle and window claimed — send /reload to root group. From here on there is
# no bookkeeping left to lose: every failure below keeps the claim.
echo "✓ all sessions idle, triggering /reload --source $RELOAD_SOURCE"
result=$("$LARK_CLI" im +messages-send --as user --chat-id "$ROOT_GROUP" --text "/reload --source $RELOAD_SOURCE") || {
  echo "[dispatch-ambiguous] lark-cli exited non-zero; the message may already be delivered" >&2
  echo "❌ lark-cli send failed; claim retained, no tick will re-send this window" >&2
  exit 2
}

# Verify lark-cli returned ok
if ! echo "$result" | grep -q '"ok": true'; then
  echo "[dispatch-ambiguous] lark-cli did not return ok; the message may already be delivered" >&2
  echo "❌ claim retained, no tick will re-send this window: $result" >&2
  exit 2
fi

echo "[reload-fired]"
echo "✓ reload triggered"
exit 0
