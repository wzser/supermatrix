#!/bin/zsh
# Dev supervisor: runs SuperMatrix in a restart-on-exit loop.
#
# SuperMatrix watches its own src/ and exits cleanly (process.exit(0))
# when any .ts file changes AND no sessions are busy. The /reload command
# does the same. This loop simply respawns after each exit.
#
# Usage (from repo root):
#   ./scripts/dev-loop.sh
#
# Ctrl+C to stop. The outer loop traps SIGINT and exits after the current
# child finishes, so stopping is still one keystroke.

set -u

SCRIPT_DIR="$(cd -- "$(dirname "${(%):-%x}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ missing $ENV_FILE — copy .env.local.example first" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export PATH="$HOME/.local/bin:$REPO_DIR/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export LARK_CLI_NO_PROXY="${LARK_CLI_NO_PROXY:-1}"

cd "$REPO_DIR"

# --- Takeover: kill any previously running dev-loop.sh and bootstrap ---
# Use case: operator runs this script in a foreground Terminal while a
# detached dev-loop (from nohup+disown, launchd, etc.) is still alive.
# Without takeover the new bootstrap fails dual-instance and spins in a
# crash loop. With takeover, the new supervisor cleanly displaces the
# old one.
#
# Matched patterns:
#   - `dev-loop.sh`                        → previous supervisor
#   - `tsx .*/src/cli/main\.ts` (via node) → previous bootstrap (tsx wrapper + child node)
typeset -a TAKEOVER_PIDS
TAKEOVER_PIDS=()
MY_PID=$$

for pid in ${(f)"$(pgrep -f 'dev-loop\.sh' 2>/dev/null)"}; do
  [[ -z "$pid" || "$pid" == "$MY_PID" ]] && continue
  TAKEOVER_PIDS+=("$pid")
done
for pid in ${(f)"$(pgrep -f 'src/cli/main\.ts' 2>/dev/null)"}; do
  [[ -z "$pid" ]] && continue
  TAKEOVER_PIDS+=("$pid")
done

if (( ${#TAKEOVER_PIDS[@]} > 0 )); then
  echo "[dev-loop] takeover: existing dev-loop/bootstrap PIDs: ${TAKEOVER_PIDS[*]}"
  for pid in "${TAKEOVER_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # Brief grace period for graceful shutdown, then SIGKILL any survivors.
  # main.ts signal handler starts a graceful path; sending SIGTERM to
  # both dev-loop and bootstrap means main.ts sees two signals and
  # short-circuits via its double-press path. Still, clamp with SIGKILL
  # as a hard backstop.
  sleep 2
  for pid in "${TAKEOVER_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "[dev-loop] takeover: force-killing pid=$pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  # Clear stale .bootstrap.pid (old dev-loop may not have cleaned it).
  if [[ -n "${SM_DB_PATH:-}" ]]; then
    pid_file="$(dirname "$SM_DB_PATH")/.bootstrap.pid"
    if [[ -f "$pid_file" ]]; then
      echo "[dev-loop] takeover: removing stale $pid_file"
      rm -f "$pid_file"
    fi
  fi
fi

# Propagate SIGINT to the child and exit the loop.
trap 'echo "[dev-loop] SIGINT — stopping"; kill -INT "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; exit 0' INT TERM

iteration=0
MIN_UPTIME_SECS=30
backoff=2
while true; do
  iteration=$((iteration + 1))
  echo "[dev-loop] iteration $iteration starting at $(date '+%H:%M:%S')"
  start_ts=$(date +%s)
  "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/src/cli/main.ts" &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  uptime=$(( $(date +%s) - start_ts ))
  if [[ $uptime -lt $MIN_UPTIME_SECS ]]; then
    [[ $backoff -gt 60 ]] && backoff=60
    echo "[dev-loop] iteration $iteration exited after ${uptime}s (code=$exit_code), backing off ${backoff}s..."
    sleep "$backoff"
    backoff=$((backoff * 2))
    # After a crash, wait for code to compile before restarting.
    # Clean reloads (exit 0) skip this since source watcher already
    # runs its own pre-flight typecheck.
    if [[ $exit_code -ne 0 ]]; then
      echo "[dev-loop] crash detected — running pre-flight typecheck..."
      while ! "$REPO_DIR/node_modules/.bin/tsc" --noEmit 2>/dev/null; do
        [[ $backoff -gt 60 ]] && backoff=60
        echo "[dev-loop] typecheck still failing, retrying in ${backoff}s..."
        sleep "$backoff"
        backoff=$((backoff * 2))
      done
      echo "[dev-loop] typecheck passed, safe to restart"
      backoff=2
    fi
  else
    backoff=2
    echo "[dev-loop] iteration $iteration exited code=$exit_code (uptime ${uptime}s), restarting in 1.5s..."
    # 1.5s gives Feishu's single-instance lock on event +subscribe time to
    # release. Too short and the next iteration's subscribe fails to acquire.
    sleep 1.5
  fi
done
