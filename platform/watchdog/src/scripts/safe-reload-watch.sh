#!/bin/zsh
# Polled by scheduler every few minutes. Fires safe-reload.sh and, when reload
# is actually dispatched, self-disables the scheduler task via PATCH.
#
# Why exit 0 on busy-skip: the scheduler models a successful poll as exit 0;
# returning non-zero per tick triggers evidence_missing/heal proposals every
# 5 minutes. A busy-skip is a successful no-op tick, not a task failure.
#
# Why we self-disable instead of relying on oneshot=true: a oneshot task gets
# auto-disabled on the *first* successful run, but here most successful runs
# are busy-skip no-ops — only the reload-fired tick should terminate polling.
#
# safe-reload.sh now returns 0 for reload-fired, busy-skip, and dedup-skip.
# Disambiguate via stdout marker lines; exit 0 alone is not business success.
#
# Exit codes seen by the scheduler:
#   0 — tick handled normally (busy-skip, dedup-skip, OR reload fired and self-disabled)
#   2 — safe-reload.sh hit an env/config error, or returned 0 without a known marker

set -u

SAFE_RELOAD="${SAFE_RELOAD:-/Users/LOCAL_USER/SuperMatrix/scripts/safe-reload.sh}"
NOTIFY_URL="${NOTIFY_URL:-http://localhost:3501/api/notify}"
SCHEDULER_TASK_URL="${SCHEDULER_TASK_URL:-http://localhost:3500/tasks/920f43dd-0aa2-4d59-9999-14a5c61cc94c}"

export SM_RELOAD_SOURCE="${SM_RELOAD_SOURCE:-watchdog-busy-watch}"

stdout_file="$(mktemp "${TMPDIR:-/tmp}/safe-reload-watch.XXXXXX")" || exit 2
trap 'rm -f "$stdout_file"' EXIT

set +e
"$SAFE_RELOAD" >"$stdout_file"
rc=$?
set -e

cat "$stdout_file"

notify_error() {
  curl -s -X POST "$NOTIFY_URL" \
    -H "Content-Type: application/json" \
    -d "{\"source\":\"watchdog\",\"title\":\"safe-reload watch error\",\"body\":\"$1\",\"level\":\"warn\"}" \
    >/dev/null || true
}

if [[ "$rc" -ne 0 ]]; then
  notify_error "safe-reload.sh exited with code $rc — investigate."
  exit "$rc"
fi

if grep -Eq '^\[reload-fired\]$' "$stdout_file"; then
  curl -s -X POST "$NOTIFY_URL" \
    -H "Content-Type: application/json" \
    -d '{"source":"watchdog","title":"safe-reload watch fired","body":"All sessions idle. safe-reload.sh has dispatched /reload to the root group.","level":"info"}' \
    >/dev/null || true
  curl -s -X PATCH "$SCHEDULER_TASK_URL" \
    -H "Content-Type: application/json" \
    -d '{"enabled":false}' \
    >/dev/null || true
  exit 0
fi

if grep -Eq '^\[busy-skip\] count=[0-9]+$' "$stdout_file"; then
  exit 0
fi

if grep -Eq '^\[dedup-skip\] age=[0-9]+s window=[0-9]+s$' "$stdout_file"; then
  exit 0
fi

notify_error "safe-reload.sh exited 0 without a known marker — refusing to disable scheduler task."
exit 2
