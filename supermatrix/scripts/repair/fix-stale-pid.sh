#!/usr/bin/env bash
set -u
# Auto-repair: remove stale .bootstrap.pid file

DB="${SM_DB_PATH:?SM_DB_PATH not set}"
pid_file="$(dirname "$DB")/.bootstrap.pid"

if [[ ! -f "$pid_file" ]]; then
  echo "No pid file found."
  exit 0
fi

stale_pid=$(cat "$pid_file" 2>/dev/null)
if [[ -n "$stale_pid" ]] && kill -0 "$stale_pid" 2>/dev/null; then
  echo "PID $stale_pid is still alive — not removing."
  exit 1
fi

echo "Removing stale pid file (pid=$stale_pid not alive): $pid_file"
rm -f "$pid_file"
echo "Done."
