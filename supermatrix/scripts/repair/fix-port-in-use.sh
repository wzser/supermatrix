#!/usr/bin/env bash
set -u
# Read-only diagnosis for processes occupying SuperMatrix port (3501 only).
# Port 3500 (Scheduler v1) retired 2026-08-10 — do NOT resurrect it here; v2 is on 3502.

port=3501
pids=$(lsof -ti :"$port" 2>/dev/null || true)
if [[ -n "$pids" ]]; then
  echo "[maintenance-denied] Port $port occupied by PIDs: $pids; no process was signaled. Route lifecycle action through the codexroot maintenance gate." >&2
  exit 3
else
  echo "Port $port is free."
fi
