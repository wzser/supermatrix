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
# Exit codes seen by the scheduler:
#   0 — tick handled normally (busy-skip OR reload fired and self-disabled)
#   2 — safe-reload.sh hit an env/config error (real failure → heal proposal)

set -u

: "${SM_REPO_ROOT:?set SM_REPO_ROOT to the Super Matrix source root}"
SAFE_RELOAD="${WATCHDOG_SAFE_RELOAD_PATH:-${SM_REPO_ROOT}/scripts/safe-reload.sh}"
NOTIFY_URL="${WATCHDOG_NOTIFY_URL:-http://localhost:3501/api/notify}"
SCHEDULER_TASK_URL="${WATCHDOG_SAFE_RELOAD_TASK_URL:-}"

export SM_RELOAD_SOURCE="${SM_RELOAD_SOURCE:-watchdog-busy-watch}"

set +e
"$SAFE_RELOAD"
rc=$?
set -e

case "$rc" in
  0)
    curl -s -X POST "$NOTIFY_URL" \
      -H "Content-Type: application/json" \
      -d '{"source":"watchdog","title":"safe-reload watch fired","body":"All sessions idle. safe-reload.sh has dispatched /reload to the root group.","level":"info"}' \
      >/dev/null || true
    if [[ -n "$SCHEDULER_TASK_URL" ]]; then
      curl -s -X PATCH "$SCHEDULER_TASK_URL" \
        -H "Content-Type: application/json" \
        -d '{"enabled":false}' \
        >/dev/null || true
    fi
    exit 0
    ;;
  1)
    exit 0
    ;;
  *)
    curl -s -X POST "$NOTIFY_URL" \
      -H "Content-Type: application/json" \
      -d "{\"source\":\"watchdog\",\"title\":\"safe-reload watch error\",\"body\":\"safe-reload.sh exited with code $rc — investigate.\",\"level\":\"warn\"}" \
      >/dev/null || true
    exit "$rc"
    ;;
esac
