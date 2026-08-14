#!/bin/zsh

set -euo pipefail
set +x +v 2>/dev/null || true
unsetopt xtrace verbose 2>/dev/null || true

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

API_BASE="${SM_API_BASE:-http://127.0.0.1:3501}"
SUPERMATRIX_ROOT="${SM_REVIEW_SUPERMATRIX_ROOT:-/Users/LOCAL_USER/SuperMatrix}"
WORKSPACES_ROOT="${SM_REVIEW_WORKSPACES_ROOT:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces}"
REVIEW_DATE="${1:-$(TZ=Asia/Shanghai date '+%Y-%m-%d')}"
SPAWN_TIMEOUT_S="${SM_REVIEW_SPAWN_TIMEOUT_S:-1800}"
SPAWN_START_TIMEOUT_S="${SM_REVIEW_SPAWN_START_TIMEOUT_S:-60}"
RESULT_POLL_INTERVAL_S="${SM_REVIEW_RESULT_POLL_INTERVAL_S:-5}"
RESULT_POLL_HTTP_TIMEOUT_S="${SM_REVIEW_RESULT_POLL_HTTP_TIMEOUT_S:-30}"
CANCEL_TIMEOUT_S="${SM_REVIEW_CANCEL_TIMEOUT_S:-30}"

ROOT_DOC="$SUPERMATRIX_ROOT/$REVIEW_DATE-weekly-review.md"
WORKSPACES_DOC="$WORKSPACES_ROOT/$REVIEW_DATE-weekly-review.md"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/weekly-review-${REVIEW_DATE}-XXXXXX")"
ENV_FILE="$REPO_DIR/.env.local"

typeset -a CHILD_SESSION_NAMES=()
typeset -a CHILD_SESSION_TARGETS=()
CANCEL_CLEANUP_DONE=0
SPAWN_LAST_CHILD_NAME=""
SPAWN_LAST_CHILD_ID=""
SPAWN_LAST_BACKEND_SESSION_ID=""
ROOT_GROUP_ID=""
LARK_CLI=""
CANCEL_LAST_STATUS=0
CANCEL_LAST_RESULT=""

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

log() {
  printf '[weekly-review] %s\n' "$*"
}

init_cancel_control() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    source "$ENV_FILE"
    set +a
  else
    log "cancel control env not found: $ENV_FILE"
  fi

  ROOT_GROUP_ID="${SM_ROOT_GROUP_ID:-}"
  LARK_CLI="${SM_LARK_CLI_PATH:-$REPO_DIR/node_modules/.bin/lark-cli}"
}

has_lark_cli() {
  local cli="$1"
  if [[ "$cli" == */* ]]; then
    [[ -x "$cli" ]]
  else
    command -v "$cli" >/dev/null 2>&1
  fi
}

run_cancel_command_with_timeout() {
  local child_name="$1"
  local result_file="$TMP_DIR/cancel-${child_name}.json"
  local cmd_status
  local result

  set +e
  LARK_CLI="$LARK_CLI" ROOT_GROUP_ID="$ROOT_GROUP_ID" CHILD_NAME="$child_name" CANCEL_TIMEOUT_S="$CANCEL_TIMEOUT_S" node - <<'EOF' > "$result_file"
const { spawn } = require("child_process");

const cli = process.env.LARK_CLI || "";
const chatId = process.env.ROOT_GROUP_ID || "";
const childName = process.env.CHILD_NAME || "";
const timeoutSec = Number(process.env.CANCEL_TIMEOUT_S || "30");
const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.floor(timeoutSec * 1000) : 30000;
const args = ["im", "+messages-send", "--as", "user", "--chat-id", chatId, "--text", `/cancel ${childName}`];

let stdout = "";
let stderr = "";
let done = false;
let timedOut = false;

const proc = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const timer = setTimeout(() => {
  if (done) return;
  timedOut = true;
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (!done) proc.kill("SIGKILL");
  }, 1000).unref();
}, timeoutMs);
timer.unref();

proc.on("error", (err) => {
  done = true;
  clearTimeout(timer);
  console.log(JSON.stringify({ ok: false, timedOut: false, responseOk: false, error: String(err), stdout, stderr }));
  process.exit(1);
});

proc.on("close", (code, signal) => {
  done = true;
  clearTimeout(timer);
  const responseOk = /"ok"\s*:\s*true/.test(`${stdout}\n${stderr}`);
  const ok = !timedOut && code === 0 && responseOk;
  console.log(JSON.stringify({
    ok,
    timedOut,
    responseOk,
    code: code === null ? null : code,
    signal: signal === null ? null : signal,
    stdout,
    stderr,
  }));
  process.exit(timedOut ? 124 : (code === null ? 1 : code));
});
EOF
  cmd_status=$?
  set -e

  result="$(cat "$result_file" 2>/dev/null || true)"
  CANCEL_LAST_STATUS="$cmd_status"
  CANCEL_LAST_RESULT="$result"
}

build_payload() {
  TARGET_SESSION="$1" PROMPT_TEXT="$2" node <<'EOF'
const target = process.env.TARGET_SESSION || "";
const promptText = process.env.PROMPT_TEXT || "";
const anchor = `weekly_review_${Date.now()}`;
const prompt = `${promptText}\n\n[spawn_predicate_anchor] ${anchor}`;
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

process.stdout.write(JSON.stringify({
  target,
  from: "supermatrix-root",
  prompt,
  client_request_id: `${date}:weekly-review:${target}:${anchor}`,
  closure: { kind: "message", target: { type: "todo_pool" } },
  verification_predicate: {
    type: "inbox-message",
    session_name: target,
    field: "prompt",
    contains_all: ["spawn_predicate_anchor", anchor],
    expected_window_sec: 3600,
  },
}));
EOF
}

build_review_skeleton() {
  cat <<EOF
# ${REVIEW_DATE} Weekly Review

## 1) 是否达到变更目的
TEMP_PLACEHOLDER

## 2) 功能是否正常、是否有缺陷
TEMP_PLACEHOLDER

## 3) 是否存在安全隐患
TEMP_PLACEHOLDER
EOF
}

build_reviewer_prompt() {
  local reviewer="$1"
  local assigned_root="$2"
  local output_path="$3"
  local skeleton=""
  skeleton="$(build_review_skeleton)"
  cat <<EOF
你是被调度的子会话 reviewer ${reviewer}。这里是单任务、单文件写入，不是开放式讨论。

请只 review ${assigned_root} 最近约 7 天的变更，并从“是否达到变更目的、功能是否正常/是否有缺陷、是否存在安全隐患”三个角度写一份简洁周评审，保持范围收敛，不做全仓深挖。

硬性约束：
1. 跳过 brainstorming / writing-plans / broad review workflow / 任何无关技能流程。
2. 除目标 markdown 文件外不要新增或修改其它文件，也不要改代码。
3. 先立刻把下面这份骨架写入 ${output_path}，再继续完成分析；在回复 DONE 前，必须把 TEMP_PLACEHOLDER 全部替换为真实正文：

${skeleton}

4. 三个 ## 小节都必须保留，且每节至少有一段真实正文。
5. 完成后请先自行确认 ${output_path} 已存在且三节都有真实正文，再只回复一行 ${reviewer}_DONE ${output_path}。
EOF
}

build_watchdog_prompt() {
  cat <<EOF
你是被调度的子会话 verifier V1。这里是单任务、只读核验，不是开放式讨论。

请评估以下两份周 review 文档是否正确，是否存在对 SuperMatrix 整体框架的误解：
- ${ROOT_DOC}
- ${WORKSPACES_DOC}

硬性约束：
1. 本次 scheduled run 只读：严禁修改任何代码或文件。
2. 只做核验与结论，不执行修复。
3. 跳过 brainstorming / writing-plans / broad review workflow / 任何无关技能流程。
4. 回复必须严格只有 3 段：
   1) Verdict: 正确 / 部分正确 / 不正确
   2) Misunderstandings: 列出误解点，没有则写 none
   3) Action: 是否建议修复、建议范围与理由（仅建议，不执行）
EOF
}

build_watchdog_notify_payload() {
  local spawn_file="$1"
  REVIEW_DATE="$REVIEW_DATE" ROOT_DOC="$ROOT_DOC" WORKSPACES_DOC="$WORKSPACES_DOC" SPAWN_FILE="$spawn_file" node - <<'EOF'
const fs = require("fs");

const reviewDate = process.env.REVIEW_DATE || "";
const rootDoc = process.env.ROOT_DOC || "";
const workspacesDoc = process.env.WORKSPACES_DOC || "";
const spawnFile = process.env.SPAWN_FILE || "";
const pathSummary = `- R1 (SuperMatrix): ${rootDoc}\n- R2 (workspaces): ${workspacesDoc}`;

let finalMessage = "";
try {
  const text = fs.readFileSync(spawnFile, "utf8");
  const response = JSON.parse(text);
  if (typeof response.finalMessage === "string") {
    finalMessage = response.finalMessage.trim();
  }
} catch {}

let verdict = "verdict unavailable";
let body = pathSummary;
if (finalMessage) {
  const firstLine = finalMessage.split(/\r?\n/, 1)[0].trim();
  const match = firstLine.match(/^Verdict:\s*(正确|部分正确|不正确)\s*$/);
  if (match) {
    verdict = match[1];
  }
  body = `${pathSummary}\n\nWatchdog 核验:\n${finalMessage}`;
}

process.stdout.write(JSON.stringify({
  source: "weekly-review-watchdog",
  title: `Weekly Review ${reviewDate} — Verdict: ${verdict}`,
  body,
  level: "info",
}));
EOF
}

notify_watchdog_report() {
  local spawn_file="$TMP_DIR/V1.spawn.json"
  local payload=""
  local response_file="$TMP_DIR/V1.notify.response.json"
  local err_file="$TMP_DIR/V1.notify.err"
  local http_code=""
  local http_code_num=0
  local curl_status=0
  local curl_err=""

  if ! payload="$(build_watchdog_notify_payload "$spawn_file")"; then
    log "WARNING: failed to build watchdog notify payload from $spawn_file"
    return 0
  fi

  set +e
  http_code="$(curl --silent --show-error --max-time 30 \
    -X POST "http://localhost:3501/api/notify" \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" \
    --output "$response_file" \
    --write-out '%{http_code}' 2> "$err_file")"
  curl_status=$?
  set -e

  curl_err="$(sed -n '1,2p' "$err_file" 2>/dev/null || true)"
  if [[ "$http_code" == <-> ]]; then
    http_code_num="$http_code"
  fi

  if [[ "$curl_status" -ne 0 ]]; then
    log "WARNING: failed to send watchdog notify (curl exit $curl_status, err=${curl_err:-none})"
    return 0
  fi
  if [[ "$http_code_num" -lt 200 || "$http_code_num" -ge 300 ]]; then
    log "WARNING: failed to send watchdog notify (http ${http_code:-unknown})"
    return 0
  fi
}

best_effort_cancel_children() {
  local cleanup_reason="${1:-failure}"
  local total="${#CHILD_SESSION_NAMES[@]}"
  local i
  local child_name
  local send_out=""
  local send_status=0
  local cancel_parse=""
  local cancel_ok="0"
  local cancel_timed_out="0"
  local cancel_response_ok="0"

  if [[ "$CANCEL_CLEANUP_DONE" -eq 1 ]]; then
    log "best-effort cancel skipped: already attempted"
    return 0
  fi
  CANCEL_CLEANUP_DONE=1

  if [[ "$total" -eq 0 ]]; then
    log "best-effort cancel skipped: no child session names available from prior spawn responses"
    return 0
  fi

  if [[ -z "$ROOT_GROUP_ID" ]]; then
    log "best-effort cancel skipped: SM_ROOT_GROUP_ID is unavailable"
    return 0
  fi
  if ! has_lark_cli "$LARK_CLI"; then
    log "best-effort cancel skipped: lark-cli unavailable at $LARK_CLI"
    return 0
  fi

  for ((i = 1; i <= total; i++)); do
    child_name="${CHILD_SESSION_NAMES[$i]}"

    if [[ -z "$child_name" ]]; then
      continue
    fi

    log "best-effort cancel attempt for child session: $child_name (reason=$cleanup_reason)"
    run_cancel_command_with_timeout "$child_name"
    send_status="$CANCEL_LAST_STATUS"
    send_out="$CANCEL_LAST_RESULT"

    if cancel_parse="$(SEND_OUT="$send_out" node - <<'EOF'
let parsed = {};
try {
  parsed = JSON.parse(process.env.SEND_OUT || "{}");
} catch {
  process.exit(1);
}
const ok = parsed.ok ? "1" : "0";
const timedOut = parsed.timedOut ? "1" : "0";
const responseOk = parsed.responseOk ? "1" : "0";
process.stdout.write(`${ok}\t${timedOut}\t${responseOk}`);
EOF
)"; then
      cancel_ok="${cancel_parse%%$'\t'*}"
      cancel_parse="${cancel_parse#*$'\t'}"
      cancel_timed_out="${cancel_parse%%$'\t'*}"
      cancel_response_ok="${cancel_parse#*$'\t'}"
    else
      cancel_ok="0"
      cancel_timed_out="0"
      cancel_response_ok="0"
    fi

    if [[ "$cancel_timed_out" == "1" || "$send_status" -eq 124 ]]; then
      log "best-effort cancel command timed out for $child_name after ${CANCEL_TIMEOUT_S}s"
      continue
    fi
    if [[ "$send_status" -ne 0 ]]; then
      log "best-effort cancel command failed for $child_name (exit=$send_status)"
      continue
    fi
    if [[ "$cancel_ok" == "1" && "$cancel_response_ok" == "1" ]]; then
      log "best-effort cancel request accepted for $child_name"
    else
      log "best-effort cancel request not confirmed for $child_name"
    fi
  done
}

fail_and_exit() {
  local exit_code="$1"
  local message="$2"
  log "ERROR: $message"
  best_effort_cancel_children "failure"
  exit "$exit_code"
}

handle_signal() {
  local signal_name="$1"
  local exit_code="$2"
  log "received signal $signal_name"
  best_effort_cancel_children "signal-$signal_name"
  exit "$exit_code"
}

trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
trap 'handle_signal HUP 129' HUP

remember_child_session() {
  local child_name="$1"
  local target="$2"
  local existing
  local i
  local total="${#CHILD_SESSION_NAMES[@]}"

  if [[ -z "$child_name" ]]; then
    return 0
  fi

  for ((i = 1; i <= total; i++)); do
    existing="${CHILD_SESSION_NAMES[$i]}"
    if [[ "$existing" == "$child_name" ]]; then
      return 0
    fi
  done

  CHILD_SESSION_NAMES+=("$child_name")
  CHILD_SESSION_TARGETS+=("$target")
}

parse_result_response_file() {
  local response_file="$1"
  RESPONSE_FILE="$response_file" node - <<'EOF'
const fs = require("fs");
const path = process.env.RESPONSE_FILE;
if (!path) process.exit(1);
let text = "";
try {
  text = fs.readFileSync(path, "utf8");
} catch {
  process.exit(1);
}
if (!text.trim()) process.exit(1);
let response;
try {
  response = JSON.parse(text);
} catch {
  process.exit(1);
}
if (!response.ok) process.exit(2);
const status = typeof response.status === "string" ? response.status.trim() : "";
const childName = typeof response.childSessionName === "string" ? response.childSessionName.trim() : "";
const childId = typeof response.childSessionId === "string" ? response.childSessionId.trim() : "";
const backendSessionId = typeof response.backendSessionId === "string" ? response.backendSessionId.trim() : "";
if (!status || !childName || !childId) process.exit(3);
process.stdout.write(`${status}\t${childName}\t${childId}\t${backendSessionId}\n`);
EOF
}

review_doc_is_complete() {
  local doc_path="$1"
  local report=""
  local counts=""

  if [[ ! -s "$doc_path" ]]; then
    return 1
  fi

  if ! report="$(DOC_PATH="$doc_path" awk '
BEGIN {
  section = 0;
  title = 0;
}
/^# [0-9]{4}-[0-9]{2}-[0-9]{2} Weekly Review$/ {
  title = 1;
  next;
}
/^## 1\) 是否达到变更目的$/ {
  section = 1;
  seen1 = 1;
  next;
}
/^## 2\) 功能是否正常、是否有缺陷$/ {
  section = 2;
  seen2 = 1;
  next;
}
/^## 3\) 是否存在安全隐患$/ {
  section = 3;
  seen3 = 1;
  next;
}
/^## / {
  section = 0;
  next;
}
{
  line = $0;
  gsub(/^[[:space:]]+|[[:space:]]+$/, "", line);
  if (line == "") next;
  if (line ~ /TEMP_PLACEHOLDER|待补充|TODO|TBD/) {
    bad = 1;
  }
  if (section >= 1 && section <= 3) {
    body[section]++;
  }
}
END {
  if (!title || !seen1 || !seen2 || !seen3) {
    exit 1;
  }
  if (bad || body[1] < 1 || body[2] < 1 || body[3] < 1) {
    exit 2;
  }
  printf("%d\t%d\t%d", body[1], body[2], body[3]);
}
' "$doc_path" 2>/dev/null)"; then
    return 1
  fi

  counts="${report//$'\t'/, }"
  log "validated review doc: $doc_path (section bodies: $counts)"
  return 0
}

start_spawn_session() {
  local label="$1"
  local target="$2"
  local prompt="$3"
  local response
  local response_file="$TMP_DIR/${label}.spawn.json"
  local child_hint=""
  local parsed=""
  local child_name=""
  local child_id=""
  local backend_session_id=""
  local http_code_file="$TMP_DIR/${label}.http_code"
  local curl_err_file="$TMP_DIR/${label}.curl.err"
  local curl_status
  local http_code=""
  local http_code_num=0
  local curl_err=""

  SPAWN_LAST_CHILD_NAME=""
  SPAWN_LAST_CHILD_ID=""
  SPAWN_LAST_BACKEND_SESSION_ID=""

  set +e
  : > "$response_file"
  : > "$http_code_file"
  : > "$curl_err_file"
  curl --silent --show-error --max-time "$SPAWN_START_TIMEOUT_S" \
    -X POST "$API_BASE/api/spawn2.0" \
    -H 'Content-Type: application/json' \
    --data-binary "$(build_payload "$target" "$prompt")" \
    --output "$response_file" \
    --write-out '%{http_code}' > "$http_code_file" 2> "$curl_err_file"
  curl_status=$?
  set -e

  http_code="$(cat "$http_code_file" 2>/dev/null || true)"
  if [[ "$http_code" == <-> ]]; then
    http_code_num="$http_code"
  fi
  curl_err="$(sed -n '1,2p' "$curl_err_file" 2>/dev/null || true)"
  response="$(cat "$response_file" 2>/dev/null || true)"

  if [[ "$curl_status" -ne 0 ]]; then
    fail_and_exit "$curl_status" "$label async spawn kickoff failed for target=$target (curl exit $curl_status, http=${http_code:-unknown}, err=${curl_err:-none})"
  fi
  if [[ "$http_code_num" -lt 200 || "$http_code_num" -ge 300 ]]; then
    fail_and_exit 1 "$label async spawn kickoff failed for target=$target (http ${http_code:-unknown}, response=${response:-empty})"
  fi

  if ! parsed="$(RESPONSE_JSON="$response" node - <<'EOF'
const response = JSON.parse(process.env.RESPONSE_JSON || "{}");
if (!response.ok) {
  console.error(JSON.stringify(response));
  process.exit(1);
}
const childName = typeof response.childSessionName === "string" ? response.childSessionName.trim() : "";
const childId = typeof response.childSessionId === "string" ? response.childSessionId.trim() : "";
const backendSessionId = typeof response.backendSessionId === "string" ? response.backendSessionId.trim() : "";
if (!childName || !childId) process.exit(2);
process.stdout.write(`${childName}\t${childId}\t${backendSessionId}`);
EOF
)"; then
    fail_and_exit 1 "$label async spawn kickoff returned invalid response: $response_file"
  fi

  child_name="${parsed%%$'\t'*}"
  child_hint="${parsed#*$'\t'}"
  child_id="${child_hint%%$'\t'*}"
  backend_session_id="${child_hint#*$'\t'}"
  remember_child_session "$child_name" "$target"

  SPAWN_LAST_CHILD_NAME="$child_name"
  SPAWN_LAST_CHILD_ID="$child_id"
  SPAWN_LAST_BACKEND_SESSION_ID="$backend_session_id"

  log "$label started (target=$target child=${child_name:-unknown} id=${child_id:-unknown})"
}

wait_for_spawn_result() {
  local label="$1"
  local target="$2"
  local child_id="$3"
  local response_file="$TMP_DIR/${label}.spawn.json"
  local result_file="$TMP_DIR/${label}.result.json"
  local curl_err_file="$TMP_DIR/${label}.result.err"
  local http_code=""
  local http_code_num=0
  local curl_status=0
  local curl_err=""
  local parsed=""
  local status_value=""
  local child_hint=""
  local child_name=""
  local parsed_child_id=""
  local backend_session_id=""
  local deadline=$((SECONDS + SPAWN_TIMEOUT_S))
  local last_wait_log=0

  while true; do
    set +e
    : > "$result_file"
    : > "$curl_err_file"
    http_code="$(curl --silent --show-error --max-time "$RESULT_POLL_HTTP_TIMEOUT_S" \
      "$API_BASE/api/sessions/$child_id/result" \
      --output "$result_file" \
      --write-out '%{http_code}' 2> "$curl_err_file")"
    curl_status=$?
    set -e

    http_code_num=0
    if [[ "$http_code" == <-> ]]; then
      http_code_num="$http_code"
    fi
    curl_err="$(sed -n '1,2p' "$curl_err_file" 2>/dev/null || true)"

    if [[ "$curl_status" -eq 0 && "$http_code_num" -eq 200 ]]; then
      cp "$result_file" "$response_file"
      if ! parsed="$(parse_result_response_file "$response_file" 2>/dev/null)"; then
        fail_and_exit 1 "$label result response was invalid for target=$target child=$child_id"
      fi
      status_value="${parsed%%$'\t'*}"
      child_hint="${parsed#*$'\t'}"
      child_name="${child_hint%%$'\t'*}"
      child_hint="${child_hint#*$'\t'}"
      parsed_child_id="${child_hint%%$'\t'*}"
      backend_session_id="${child_hint#*$'\t'}"
      if [[ "$status_value" == "completed" ]]; then
        log "$label completed (target=$target child=${child_name:-unknown} id=${parsed_child_id:-unknown} backendSessionId=${backend_session_id:-unknown})"
        return 0
      fi
      fail_and_exit 1 "$label child finished with status=$status_value (target=$target child=${child_name:-unknown} id=${parsed_child_id:-$child_id})"
    fi

    if [[ "$curl_status" -eq 0 && "$http_code_num" -eq 202 ]]; then
      if (( SECONDS - last_wait_log >= 60 )); then
        log "$label still running (target=$target child=$child_id)"
        last_wait_log="$SECONDS"
      fi
    elif [[ "$curl_status" -ne 0 ]]; then
      log "WARNING: $label result poll failed (curl exit $curl_status, err=${curl_err:-none})"
    else
      fail_and_exit 1 "$label result poll failed for target=$target child=$child_id (http ${http_code:-unknown})"
    fi

    if (( SECONDS >= deadline )); then
      fail_and_exit 124 "$label timed out waiting for async child after ${SPAWN_TIMEOUT_S}s (target=$target child=$child_id)"
    fi
    sleep "$RESULT_POLL_INTERVAL_S"
  done
}

spawn_session() {
  local label="$1"
  local target="$2"
  local prompt="$3"
  local child_id=""

  start_spawn_session "$label" "$target" "$prompt"
  child_id="$SPAWN_LAST_CHILD_ID"
  wait_for_spawn_result "$label" "$target" "$child_id"
}

main() {
  local r1_child_id=""
  local r2_child_id=""

  init_cancel_control

  log "remove stale expected output docs for this run"
  rm -f "$ROOT_DOC" "$WORKSPACES_DOC"

  R1_PROMPT="$(build_reviewer_prompt "R1" "$SUPERMATRIX_ROOT" "$ROOT_DOC")"
  R2_PROMPT="$(build_reviewer_prompt "R2" "$WORKSPACES_ROOT" "$WORKSPACES_DOC")"
  WATCHDOG_PROMPT="$(build_watchdog_prompt)"

  log "start reviewers R1/R2 (target=codexroot)"
  start_spawn_session "R1" "codexroot" "$R1_PROMPT"
  r1_child_id="$SPAWN_LAST_CHILD_ID"
  start_spawn_session "R2" "codexroot" "$R2_PROMPT"
  r2_child_id="$SPAWN_LAST_CHILD_ID"

  log "wait reviewer R1 (target=codexroot child=$r1_child_id)"
  wait_for_spawn_result "R1" "codexroot" "$r1_child_id"
  if ! review_doc_is_complete "$ROOT_DOC"; then
    fail_and_exit 1 "R1 completed but expected review doc is missing/incomplete: $ROOT_DOC"
  fi

  log "wait reviewer R2 (target=codexroot child=$r2_child_id)"
  wait_for_spawn_result "R2" "codexroot" "$r2_child_id"
  if ! review_doc_is_complete "$WORKSPACES_DOC"; then
    fail_and_exit 1 "R2 completed but expected review doc is missing/incomplete: $WORKSPACES_DOC"
  fi

  log "start verifier V1 (target=watchdog)"
  spawn_session "V1" "watchdog" "$WATCHDOG_PROMPT"
  notify_watchdog_report

  log "review docs ready:"
  printf '%s\n' "$ROOT_DOC" "$WORKSPACES_DOC"
}

if [[ "${ZSH_EVAL_CONTEXT:-}" != *:file ]]; then
  main "$@"
fi
