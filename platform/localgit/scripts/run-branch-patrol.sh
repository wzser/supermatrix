#!/bin/bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${LOCALGIT_REPO_ROOT:-$SCRIPT_DIR/..}"
NODE="${NODE_BIN:-${LOCALGIT_NODE_BIN:-$(command -v node || true)}}"
TSX="node_modules/tsx/dist/cli.mjs"

[ -n "$NODE" ] || { echo "[wrapper] node is not on PATH; set NODE_BIN (or LOCALGIT_NODE_BIN)" >&2; exit 3; }
cd "$REPO_DIR" || { echo "[wrapper] cannot cd $REPO_DIR" >&2; exit 3; }
mkdir -p data/run-logs
LOG="data/run-logs/branch-patrol-$(date +%Y%m%d-%H%M%S).log"

# Failure report through the existing Console notify endpoint (§245) — same
# contract as run-daily-commit.sh: best-effort, never masks the exit code.
notify_failure() {
  local title="$1" body="$2"
  API_BASE="${LOCALGIT_API_BASE:-${SM_API_BASE:-http://127.0.0.1:${SM_API_PORT:-3501}}}"
  NOTIFY_ENDPOINT="${LOCALGIT_NOTIFY_ENDPOINT:-${API_BASE%/}/api/notify}"
  curl -sS --max-time 10 -X POST "$NOTIFY_ENDPOINT" \
    -H 'Content-Type: application/json' \
    -d "{\"source\":\"localgit\",\"level\":\"error\",\"title\":\"$title\",\"body\":\"$body\",\"metadata\":{\"log\":\"$REPO_DIR/$LOG\"}}" \
    >>"$LOG" 2>&1 || true
}

{
  echo "[wrapper] branch patrol start $(date -u +%FT%TZ) pid=$$ ppid=$PPID"
  "$NODE" "$TSX" src/scripts/branch-patrol.ts
  code=$?
  echo "[wrapper] branch patrol exit code=$code $(date -u +%FT%TZ)"
  if [ "$code" -ne 0 ]; then
    notify_failure "branch-patrol 运行失败" "巡检主程序退出码 ${code}，本轮分支未收敛。请按日志排障，修复后手动补跑：setsid nohup bash scripts/run-branch-patrol.sh >/dev/null 2>&1 &"
  fi
  "$NODE" "$TSX" src/scripts/branch-patrol-verify.ts
  verify_code=$?
  echo "[wrapper] branch patrol verifier exit code=$verify_code $(date -u +%FT%TZ)"
  if [ "$verify_code" -ne 0 ]; then
    notify_failure "branch-patrol 核验失败" "独立核验退出码 ${verify_code}，evidence 与 live ref 可能不一致，请按日志对账。"
  fi
  if [ "$code" -ne 0 ]; then exit "$code"; fi
  exit "$verify_code"
} >>"$LOG" 2>&1
