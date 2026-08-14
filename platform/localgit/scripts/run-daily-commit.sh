#!/bin/bash
# Detached entrypoint for localgit daily-commit.
#
# Runs the FULL loop AND the post-loop tail (writeLog / owner-routing / Bitable
# sync / notify / reload) as ONE process that is NOT tied to any agent-session turn.
#
# Why this exists (2026-07-06..09 incident, 4 nights): the scheduler task was
# type=session, which spawned a child localgit agent that launched the run inside
# its turn (raw `&` background, then harness-tracked run_in_background). Both variants
# were SIGKILL'd when the child's turn ended, killing the tsx run mid-loop — so
# per-repo ledger entries persisted but the tail never ran (governance never closed;
# 0 owner hints sent; reload only survived via the separate 03:50 task).
#
# Fix: scheduler runs THIS script as a type=script task (its own detached process,
# owned by scheduler, not by an agent turn) so the run completes end-to-end.
# Also usable manually for a supervised catch-up:
#   setsid nohup bash scripts/run-daily-commit.sh >/dev/null 2>&1 &
#
# PATH-independent on purpose: node/tsx resolved by absolute path so a bare
# scheduler env (no shell profile) still works. lark-cli / codex / git / sqlite3
# are already absolute-pathed inside daily-commit.ts.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${LOCALGIT_REPO_ROOT:-$SCRIPT_DIR/..}"
NODE="${LOCALGIT_NODE_BIN:-$(command -v node || true)}"
TSX="node_modules/tsx/dist/cli.mjs"

[ -n "$NODE" ] || { echo "[wrapper] node is not on PATH; set LOCALGIT_NODE_BIN" >&2; exit 3; }
cd "$REPO_DIR" || { echo "[wrapper] cannot cd $REPO_DIR" >&2; exit 3; }
mkdir -p data/run-logs
LOG="data/run-logs/daily-commit-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[wrapper] start $(date -u +%FT%TZ) pid=$$ ppid=$PPID"
  "$NODE" "$TSX" src/scripts/daily-commit.ts
  code=$?
  echo "[wrapper] daily-commit exit code=$code $(date -u +%FT%TZ)"
  if [ "$code" -ne 0 ]; then
    exit "$code"
  fi
  "$NODE" "$TSX" src/scripts/daily-commit-verify.ts
  verify_code=$?
  echo "[wrapper] daily-commit verifier exit code=$verify_code $(date -u +%FT%TZ)"
  exit "$verify_code"
} >>"$LOG" 2>&1
