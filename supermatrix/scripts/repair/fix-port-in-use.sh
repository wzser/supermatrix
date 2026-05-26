#!/usr/bin/env bash
set -u
# Auto-repair: kill stale processes occupying the configured SuperMatrix API port.
# Port 3500 (Scheduler) is managed by PM2 — do NOT touch it here.

port="${SM_API_PORT:-3501}"
pids=$(lsof -ti :"$port" 2>/dev/null || true)
if [[ -n "$pids" ]]; then
  echo "Port $port occupied by PIDs: $pids — killing..."
  echo "$pids" | xargs kill -TERM 2>/dev/null || true
  sleep 2
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force-killing pid=$pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  echo "Port $port freed."
else
  echo "Port $port is free."
fi
