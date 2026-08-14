#!/bin/bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${LOCALGIT_REPO_ROOT:-$SCRIPT_DIR/..}"
NODE="${LOCALGIT_NODE_BIN:-$(command -v node || true)}"
TSX="node_modules/tsx/dist/cli.mjs"

[ -n "$NODE" ] || { echo "[wrapper] node is not on PATH; set LOCALGIT_NODE_BIN" >&2; exit 3; }
cd "$REPO_DIR" || { echo "[wrapper] cannot cd $REPO_DIR" >&2; exit 3; }
mkdir -p data/run-logs
LOG="data/run-logs/branch-patrol-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[wrapper] branch patrol start $(date -u +%FT%TZ) pid=$$ ppid=$PPID"
  "$NODE" "$TSX" src/scripts/branch-patrol.ts
  code=$?
  echo "[wrapper] branch patrol exit code=$code $(date -u +%FT%TZ)"
  if [ "$code" -ne 0 ]; then
    exit "$code"
  fi
  "$NODE" "$TSX" src/scripts/branch-patrol-verify.ts
  verify_code=$?
  echo "[wrapper] branch patrol verifier exit code=$verify_code $(date -u +%FT%TZ)"
  exit "$verify_code"
} >>"$LOG" 2>&1
