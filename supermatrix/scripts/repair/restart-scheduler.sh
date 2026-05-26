#!/usr/bin/env bash
set -u
# Auto-repair: restart the Scheduler process.
#
# Identification union:
#   (a) listener on 127.0.0.1:SCHEDULER_PORT  -> catches the live socket holder
#                                                regardless of how it was launched
#   (b) pgrep "dist/main.js" filtered by cwd  -> catches a booting scheduler that
#                                                hasn't bound the port yet, and
#                                                catches "node dist/main.js"
#                                                (relative argv) which an
#                                                argv-only pgrep on the absolute
#                                                path would miss.
# An earlier version pgrep'd "scheduler/dist/main.js" only and missed a stale
# scheduler launched with relative argv; the new fork then silently failed
# EADDRINUSE while the script reported success. Do not regress that.

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ROOT="$(cd -- "$PACKAGE_ROOT/.." && pwd)"

SCHEDULER_PORT="${SCHEDULER_PORT:-3500}"
SCHEDULER_CWD="${SCHEDULER_CWD:-$PROJECT_ROOT/platform/scheduler}"
SCHEDULER_BIN="${SCHEDULER_BIN:-$SCHEDULER_CWD/dist/main.js}"

collect_targets() {
  local port_pids pgrep_candidates pid cwd
  port_pids=$(lsof -ti :"$SCHEDULER_PORT" -sTCP:LISTEN 2>/dev/null || true)
  pgrep_candidates=$(pgrep -f "dist/main.js" 2>/dev/null || true)
  {
    [[ -n "$port_pids" ]] && printf '%s\n' $port_pids
    for pid in $pgrep_candidates; do
      cwd=$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | awk '/^n/ {print substr($0,2); exit}')
      [[ "$cwd" == "$SCHEDULER_CWD" ]] && printf '%s\n' "$pid"
    done
  } | awk 'NF && !seen[$0]++'
}

existing=$(collect_targets)
if [[ -n "$existing" ]]; then
  echo "Killing existing Scheduler (pids: $(echo $existing | tr '\n' ' '))..."
  echo "$existing" | xargs kill -TERM 2>/dev/null || true
  sleep 3
  for pid in $existing; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
fi

# Wait for the port to actually free, then escalate if anything is still on it.
for _ in 1 2 3 4 5; do
  lsof -ti :"$SCHEDULER_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
holdouts=$(lsof -ti :"$SCHEDULER_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$holdouts" ]]; then
  echo "Port $SCHEDULER_PORT still held by pids: $holdouts — force-killing..." >&2
  echo "$holdouts" | xargs kill -KILL 2>/dev/null || true
  sleep 1
fi
holdouts=$(lsof -ti :"$SCHEDULER_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$holdouts" ]]; then
  echo "ERROR: port $SCHEDULER_PORT still occupied by pids: $holdouts; aborting restart." >&2
  exit 1
fi

echo "Starting Scheduler..."
cd "$SCHEDULER_CWD"
node "$SCHEDULER_BIN" &
new_pid=$!

# Confirm the new process actually bound the port — otherwise we just leaked
# another orphan and the chat surface is still down.
bound=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$new_pid" 2>/dev/null; then
    echo "ERROR: scheduler pid=$new_pid exited before binding port $SCHEDULER_PORT." >&2
    exit 1
  fi
  if lsof -ti :"$SCHEDULER_PORT" -sTCP:LISTEN 2>/dev/null | grep -qx "$new_pid"; then
    bound=1
    break
  fi
  sleep 1
done
if [[ -z "$bound" ]]; then
  echo "WARN: scheduler pid=$new_pid is alive but has not bound port $SCHEDULER_PORT after 10s." >&2
fi

echo "Scheduler started (pid=$new_pid)."
