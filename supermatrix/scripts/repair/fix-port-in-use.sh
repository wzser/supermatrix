#!/usr/bin/env bash
set -u
# Auto-repair: kill stale processes occupying SuperMatrix port (3501 only).
# Port 3500 (Scheduler v1) retired 2026-08-10 — do NOT resurrect it here; v2 is on 3502.

port=3501
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
