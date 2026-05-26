#!/usr/bin/env bash
set -u

# ============================================================================
# localwatch.sh — SuperMatrix process manager & health monitor
#
# Replaces dev-loop.sh. Manages SuperMatrix main process + Scheduler.
# Includes crash restart, crash-loop circuit breaker, health probes,
# auto-repair dispatch, and Lark/macOS alerting.
#
# Usage:
#   ./scripts/localwatch.sh
# ============================================================================

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd -- "$REPO_DIR/.." && pwd)"
ENV_FILE="${SM_ENV_FILE:-$PROJECT_ROOT/.env}"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

# Single-instance lock. mkdir is atomic on macOS, so the first watchdog to
# boot wins; any later invocation sees the lock and exits immediately.
# Prevents two watchdogs from fighting over the same SM child (the 20s
# SIGTERM ping-pong we saw on 2026-04-17).
LOCK_DIR="$LOG_DIR/.localwatch.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    echo "[localwatch] another instance already running (pid=$holder), exiting" >&2
    exit 0
  fi
  echo "[localwatch] stale lock from pid=${holder:-?}, reclaiming" >&2
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || { echo "[localwatch] failed to acquire lock" >&2; exit 1; }
fi
echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$REPO_DIR/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export LARK_CLI_NO_PROXY="${LARK_CLI_NO_PROXY:-1}"
LARK_CLI="${SM_LARK_CLI_PATH:-$REPO_DIR/node_modules/.bin/lark-cli}"
ROOT_GROUP="${SM_ROOT_GROUP_ID:-}"
LOCALWATCH_HEARTBEAT_GROUP="${LOCALWATCH_HEARTBEAT_GROUP:-}"
LOCALWATCH_SELFCHECK_TARGET="${LOCALWATCH_SELFCHECK_TARGET:-supermatrix-root}"
LOCALWATCH_SELFCHECK_FROM="${LOCALWATCH_SELFCHECK_FROM:-supermatrix-root}"
# Self-check 触发改走 /api/spawn target=$LOCALWATCH_SELFCHECK_TARGET
# (per console-principles 行 24-32 / 48 / 78 — session-to-session triggering uses /api/spawn).

SCHEDULER_CWD="${SCHEDULER_CWD:-$PROJECT_ROOT/platform/scheduler}"
SCHEDULER_BIN="${SCHEDULER_BIN:-$SCHEDULER_CWD/dist/main.js}"
SCHEDULER_PORT="${SCHEDULER_PORT:-3500}"

BUSINESS_SCREEN_CWD="${BUSINESS_SCREEN_CWD:-}"
BUSINESS_SCREEN_PORT="${BUSINESS_SCREEN_PORT:-4322}"
BUSINESS_SCREEN_HOST="${BUSINESS_SCREEN_HOST:-0.0.0.0}"

# --- Config ---
MIN_UPTIME_SECS=30
MAX_IDENTICAL_CRASHES=5
HEALTH_FAIL_THRESHOLD=3

# Per-call timeouts (seconds). These exist so a single hung external command
# (the 2026-04-22 SSH host-key prompt wedged lark-cli heartbeat indefinitely)
# cannot starve the main loop. Any value that trips 124 is a bug to investigate.
LARK_CALL_TIMEOUT=10
REPAIR_SCRIPT_TIMEOUT=60
PM2_QUERY_TIMEOUT=5
LSOF_QUERY_TIMEOUT=5
TYPECHECK_TIMEOUT=180

# --- State ---
sm_pid=0
sched_pid=0
sched_owned=false
bs_pid=0
sm_start_ts=0
sm_backoff=2
sm_stopped=false
last_fatal=""
identical_count=0
sm_health_fails=0
sched_health_fails=0
bs_health_fails=0
tick=0

# ============================================================================
# bounded — hard-timeout wrapper for external commands.
# Usage: bounded <secs> <cmd...> → command exit code, or 124 on timeout.
# Prefers GNU timeout (gtimeout via brew coreutils, or timeout if present),
# falls back to pure bash. macOS base install ships neither.
# ============================================================================

if command -v gtimeout >/dev/null 2>&1; then
  _TIMEOUT_BIN=gtimeout
elif command -v timeout >/dev/null 2>&1; then
  _TIMEOUT_BIN=timeout
else
  _TIMEOUT_BIN=""
fi

bounded() {
  local secs=$1; shift
  if [[ -n "$_TIMEOUT_BIN" ]]; then
    "$_TIMEOUT_BIN" --kill-after=2s "$secs" "$@"
    return $?
  fi
  "$@" &
  local cmd_pid=$!
  ( sleep "$secs" && kill -TERM "$cmd_pid" 2>/dev/null && sleep 2 && kill -KILL "$cmd_pid" 2>/dev/null ) &
  local killer_pid=$!
  wait "$cmd_pid" 2>/dev/null
  local rc=$?
  kill "$killer_pid" 2>/dev/null; wait "$killer_pid" 2>/dev/null
  if [[ $rc -eq 143 || $rc -eq 137 ]]; then return 124; fi
  return $rc
}

# ============================================================================
# Logging & Alerting
# ============================================================================

log() {
  echo "[localwatch $(date '+%H:%M:%S')] $*"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_DIR/localwatch.log"
}

send_alert() {
  local msg=$1
  if [[ -n "$ROOT_GROUP" ]] && bounded "$LARK_CALL_TIMEOUT" "$LARK_CLI" im +messages-send --as bot \
    --chat-id "$ROOT_GROUP" --text "$msg" 2>/dev/null; then
    return 0
  fi
  echo "[localwatch] ALERT (lark failed): $msg" >> "$LOG_DIR/localwatch.log"
  osascript -e "display notification \"$(echo "$msg" | head -c 200)\" with title \"SuperMatrix Local-Watchdog\"" 2>/dev/null || true
}

# Triggered after a force-restart event (SM or scheduler health fail). Spawns the
# configured root self-check session via /api/spawn's internal async kickoff.
# The target investigates root cause from logs / DB, fixes if mechanical, or
# files an issue via watchdog. Strict no-cascade — see prompt.
#
# Why /api/spawn and not lark-cli messages-send:
#   console-principles 行 24-32 / 48 / 78：session-to-session triggering must
#   go through /api/spawn (proper run lifecycle + childSessionId tracking).
#   lark-cli --as bot to a session group does not reliably wake the target
#   (dispatcher filters bot-origin messages on bound user-session groups).
notify_root_selfcheck() {
  local trigger=$1
  local sm_port="${SM_API_PORT:-3501}"
  local anchor="localwatch_$(date '+%s')"
  local db_path="${SM_DB_PATH:-$PROJECT_ROOT/.runtime/supermatrix.db}"
  # Build prompt as a JSON-safe string. Keep it short — references concrete log
  # paths and DB query so the self-check session reads source evidence directly.
  local prompt
  prompt=$(cat <<EOF
[localwatch self-check trigger]
${trigger}

[spawn_predicate_anchor] ${anchor}

请做一次 SuperMatrix 健康自查（不要 spawn 其它 session）：
1. 扫 $LOG_DIR/supermatrix.stdout.log 最近 200 行，找 level:50 的 error 与可能的根因（特别看强制重启前 5 分钟的 dispatcher / api error）
2. 查 sessions 表非 child 非 deleted 行的 timestamp 字段是否有 NULL / 非 integer：
   sqlite3 "$db_path" "SELECT name FROM sessions WHERE scope!='child' AND status!='deleted' AND (typeof(created_at)!='integer' OR typeof(updated_at)!='integer' OR created_at IS NULL OR updated_at IS NULL)"
3. curl http://localhost:${sm_port}/api/health 验证当前已恢复
4. 如根因是机械可修，直接修 SuperMatrix 源码 + commit；如需权衡，spawn POST localhost:${sm_port}/api/spawn target=watchdog 把分析作为 issue 草稿投递；如查无明确根因，回执 'no actionable finding' 即可

约束（per console-principles 行 77 platform→root delegation no-cascade）：仅本人执行，不要 spawn ATP / scheduler / 其它 session，不要触发 test run。
EOF
)
  # SM may still be in restart window — retry up to 6 times with 5s gaps (~30s).
  local payload
  payload=$(jq -nc --arg target "$LOCALWATCH_SELFCHECK_TARGET" --arg from "$LOCALWATCH_SELFCHECK_FROM" --arg prompt "$prompt" --arg anchor "$anchor" '{target:$target, from:$from, supermatrix_internal:{caller_invocation:"async_kickoff"}, prompt:$prompt, verification_predicate:{type:"inbox-message", session_name:$target, field:"prompt", contains_all:["localwatch self-check trigger",$anchor], expected_window_sec:600}}')
  local attempts=0
  while (( attempts < 6 )); do
    local resp
    resp=$(bounded "$LARK_CALL_TIMEOUT" curl -s -m 8 -X POST "http://localhost:${sm_port}/api/spawn" \
      -H "Content-Type: application/json" -d "$payload" 2>/dev/null)
    if echo "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
      local child_id
      child_id=$(echo "$resp" | jq -r '.childSessionId // empty')
      log "root self-check spawned (target=$LOCALWATCH_SELFCHECK_TARGET childSessionId=$child_id) — trigger: $trigger"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  log "WARN: failed to spawn root self-check after $attempts attempts — trigger: $trigger"
}

# ============================================================================
# Takeover — kill any previously running instances
# ============================================================================

takeover() {
  local my_pid=$$
  local -a pids=()
  local pid

  # Kill other watchdog/dev-loop instances
  while IFS= read -r pid; do
    [[ -z "$pid" || "$pid" == "$my_pid" ]] && continue
    pids+=("$pid")
  done < <(pgrep -f 'localwatch\.sh' 2>/dev/null || true)

  while IFS= read -r pid; do
    [[ -z "$pid" || "$pid" == "$my_pid" ]] && continue
    pids+=("$pid")
  done < <(pgrep -f 'dev-loop\.sh' 2>/dev/null || true)

  # Also kill stale SuperMatrix processes (children of previous watchdog/dev-loop)
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    pids+=("$pid")
  done < <(pgrep -f 'tsx.*src/cli/main\.ts' 2>/dev/null || true)

  # Also kill stale business-screen server (orphan from prior watchdog), if configured.
  if [[ -n "$BUSINESS_SCREEN_CWD" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      pids+=("$pid")
    done < <(pgrep -f "node .*${BUSINESS_SCREEN_CWD}/server\.js" 2>/dev/null || true)
  fi

  if (( ${#pids[@]} > 0 )); then
    log "takeover: killing existing pids: ${pids[*]}"
    for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
    sleep 2
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        log "takeover: force-killing pid=$pid"
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
  fi

  # Always clear stale pid file
  if [[ -n "${SM_DB_PATH:-}" ]]; then
    local pid_file
    pid_file="$(dirname "$SM_DB_PATH")/.bootstrap.pid"
    [[ -f "$pid_file" ]] && rm -f "$pid_file"
  fi
}

# ============================================================================
# Process Management — SuperMatrix
# ============================================================================

start_supermatrix() {
  # Kill any orphan SM child processes before starting
  local orphans
  orphans=$(pgrep -f 'tsx.*src/cli/main\.ts' 2>/dev/null || true)
  if [[ -n "$orphans" ]]; then
    log "killing orphan SM processes: $orphans"
    echo "$orphans" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    for pid in $orphans; do
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  # Clear stale pid file
  if [[ -n "${SM_DB_PATH:-}" ]]; then
    rm -f "$(dirname "$SM_DB_PATH")/.bootstrap.pid"
  fi

  log "starting SuperMatrix"
  cd "$REPO_DIR"
  "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/src/cli/main.ts" \
    >> "$LOG_DIR/supermatrix.stdout.log" 2> "$LOG_DIR/sm-crash.log" &
  sm_pid=$!
  sm_start_ts=$(date +%s)
  log "SuperMatrix started (pid=$sm_pid)"
}

handle_supermatrix_exit() {
  if [[ $sm_pid -eq 0 ]]; then return; fi
  if kill -0 "$sm_pid" 2>/dev/null; then return; fi

  wait "$sm_pid" 2>/dev/null
  local exit_code=$?
  local uptime=$(( $(date +%s) - sm_start_ts ))
  log "SuperMatrix exited (code=$exit_code, uptime=${uptime}s)"
  sm_pid=0

  if [[ "$sm_stopped" == "true" ]]; then
    return
  fi

  if [[ $exit_code -eq 0 ]]; then
    # Clean exit (source watcher reload)
    identical_count=0
    last_fatal=""
    sm_backoff=2
    sleep 1.5
    start_supermatrix
    return
  fi

  # Crash — analyze and handle
  local crash_log="$LOG_DIR/sm-crash.log"
  local current_fatal
  current_fatal=$(grep -m1 'fatal\|Error\|SQLITE\|Cannot find\|EADDRINUSE' "$crash_log" 2>/dev/null | head -c 200 || echo "unknown")

  if [[ "$current_fatal" == "$last_fatal" ]]; then
    identical_count=$((identical_count + 1))
  else
    identical_count=1
    last_fatal="$current_fatal"
  fi

  # Attempt auto-repair
  attempt_auto_repair "$current_fatal"

  if [[ $identical_count -ge $MAX_IDENTICAL_CRASHES ]]; then
    log "🔴 circuit breaker: $identical_count identical crashes"
    send_alert "🔴 SuperMatrix 连续 crash ${identical_count} 次，已停止重启。\nfatal: ${current_fatal}\n需要人工介入。"
    sm_stopped=true
    return
  fi

  # Exponential backoff for fast crashes
  if [[ $uptime -lt $MIN_UPTIME_SECS ]]; then
    [[ $sm_backoff -gt 60 ]] && sm_backoff=60
    log "backing off ${sm_backoff}s..."
    sleep "$sm_backoff"
    sm_backoff=$((sm_backoff * 2))

    # Pre-flight typecheck after crash
    if [[ $exit_code -ne 0 ]]; then
      log "running pre-flight typecheck..."
      local tc_backoff=2
      while ! bounded "$TYPECHECK_TIMEOUT" "$REPO_DIR/node_modules/.bin/tsc" --noEmit 2>/dev/null; do
        [[ $tc_backoff -gt 60 ]] && tc_backoff=60
        log "typecheck failing, retrying in ${tc_backoff}s..."
        sleep "$tc_backoff"
        tc_backoff=$((tc_backoff * 2))
      done
      log "typecheck passed"
      sm_backoff=2
    fi
  else
    sm_backoff=2
    sleep 1.5
  fi

  start_supermatrix
}

# ============================================================================
# Process Management — Scheduler
# ============================================================================

start_scheduler() {
  # If PM2 is managing the scheduler, defer to it
  local pm2_json=""
  if command -v pm2 >/dev/null 2>&1; then
    pm2_json=$(bounded "$PM2_QUERY_TIMEOUT" pm2 jlist 2>/dev/null) || pm2_json=""
  fi
  if [[ -n "$pm2_json" ]] && echo "$pm2_json" | jq -e '.[] | select(.name == "scheduler" and .pm2_env.status == "online")' >/dev/null 2>&1; then
    local pm2_pid
    pm2_pid=$(echo "$pm2_json" | jq -r '.[] | select(.name == "scheduler") | .pid')
    log "Scheduler managed by PM2 (pid=$pm2_pid), skipping direct management"
    sched_pid=0
    sched_owned=false
    return
  fi

  local port_holders
  port_holders=$(bounded "$LSOF_QUERY_TIMEOUT" lsof -nP -iTCP:"$SCHEDULER_PORT" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "$port_holders" ]]; then
    local resp
    resp=$(curl -s --max-time 5 "http://localhost:$SCHEDULER_PORT/health" 2>/dev/null || true)
    if echo "$resp" | jq -e '.status == "ok" and has("tasks")' >/dev/null 2>&1; then
      sched_pid=$(echo "$port_holders" | head -n 1)
      sched_owned=false
      log "Scheduler already healthy on port $SCHEDULER_PORT (pid=$sched_pid, pids: $port_holders), adopting existing instance"
      return
    fi

    log "Scheduler port $SCHEDULER_PORT busy but health failed (pids: $port_holders), clearing before start"
    echo "$port_holders" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    for pid in $port_holders; do
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    done
  fi

  if [[ ! -f "$SCHEDULER_BIN" ]]; then
    log "WARN: Scheduler binary not found at $SCHEDULER_BIN, skipping"
    return
  fi
  log "starting Scheduler (port=$SCHEDULER_PORT)"
  cd "$SCHEDULER_CWD"
  node "$SCHEDULER_BIN" >> "$LOG_DIR/scheduler.stdout.log" 2>> "$LOG_DIR/scheduler.stderr.log" &
  sched_pid=$!
  sched_owned=true
  cd "$REPO_DIR"
  log "Scheduler started (pid=$sched_pid)"
}

handle_scheduler_exit() {
  if [[ $sched_pid -eq 0 ]]; then return; fi
  if kill -0 "$sched_pid" 2>/dev/null; then return; fi

  if [[ "$sched_owned" == "true" ]]; then
    wait "$sched_pid" 2>/dev/null
  fi
  log "Scheduler exited, restarting in 5s..."
  sched_pid=0
  sched_owned=false
  sleep 5
  start_scheduler
}

# ============================================================================
# Process Management — business-screen (LAN HELLO screen, port 4322)
# ============================================================================

start_business_screen() {
  if [[ -z "$BUSINESS_SCREEN_CWD" ]]; then
    log "business-screen disabled (BUSINESS_SCREEN_CWD not set), skipping"
    return
  fi

  # If PM2 is ever used for business-screen, defer to it (mirrors scheduler pattern)
  local pm2_json=""
  if command -v pm2 >/dev/null 2>&1; then
    pm2_json=$(bounded "$PM2_QUERY_TIMEOUT" pm2 jlist 2>/dev/null) || pm2_json=""
  fi
  if [[ -n "$pm2_json" ]] && echo "$pm2_json" | jq -e '.[] | select(.name == "business-screen" and .pm2_env.status == "online")' >/dev/null 2>&1; then
    local pm2_pid
    pm2_pid=$(echo "$pm2_json" | jq -r '.[] | select(.name == "business-screen") | .pid')
    log "business-screen managed by PM2 (pid=$pm2_pid), skipping direct management"
    bs_pid=0
    return
  fi

  if [[ ! -f "$BUSINESS_SCREEN_CWD/server.js" ]]; then
    log "WARN: business-screen server.js not found at $BUSINESS_SCREEN_CWD, skipping"
    return
  fi

  # Kill anything else already listening on the target port (orphan from prior
  # run, or a manual `npm run start:lan` in the workspace). Otherwise our
  # launch will immediately exit with EADDRINUSE.
  local port_holders
  port_holders=$(bounded "$LSOF_QUERY_TIMEOUT" lsof -nP -iTCP:"$BUSINESS_SCREEN_PORT" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "$port_holders" ]]; then
    log "port $BUSINESS_SCREEN_PORT busy (pids: $port_holders), clearing before start"
    echo "$port_holders" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    for pid in $port_holders; do
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    done
  fi

  log "starting business-screen (port=$BUSINESS_SCREEN_PORT)"
  cd "$BUSINESS_SCREEN_CWD"
  HOST="$BUSINESS_SCREEN_HOST" PORT="$BUSINESS_SCREEN_PORT" \
    node "$BUSINESS_SCREEN_CWD/server.js" \
    >> "$LOG_DIR/business-screen.stdout.log" 2>> "$LOG_DIR/business-screen.stderr.log" &
  bs_pid=$!
  cd "$REPO_DIR"
  log "business-screen started (pid=$bs_pid)"
}

handle_business_screen_exit() {
  if [[ $bs_pid -eq 0 ]]; then return; fi
  if kill -0 "$bs_pid" 2>/dev/null; then return; fi

  wait "$bs_pid" 2>/dev/null
  log "business-screen exited, restarting in 5s..."
  bs_pid=0
  sleep 5
  start_business_screen
}

# ============================================================================
# Auto-Repair
# ============================================================================

attempt_auto_repair() {
  local fatal_msg=$1
  local repair_dir="$REPO_DIR/scripts/repair"

  if echo "$fatal_msg" | grep -qi "duplicate column"; then
    log "auto-repair: migration drift detected"
    if [[ -x "$repair_dir/fix-migration-drift.sh" ]]; then
      bounded "$REPAIR_SCRIPT_TIMEOUT" bash "$repair_dir/fix-migration-drift.sh" 2>&1 | while IFS= read -r line; do log "  repair: $line"; done
    fi
  elif echo "$fatal_msg" | grep -qi "EADDRINUSE"; then
    log "auto-repair: port in use detected"
    if [[ -x "$repair_dir/fix-port-in-use.sh" ]]; then
      bounded "$REPAIR_SCRIPT_TIMEOUT" bash "$repair_dir/fix-port-in-use.sh" 2>&1 | while IFS= read -r line; do log "  repair: $line"; done
    fi
  elif echo "$fatal_msg" | grep -qi "bootstrap.pid\|dual.*instance"; then
    log "auto-repair: stale pid detected"
    if [[ -x "$repair_dir/fix-stale-pid.sh" ]]; then
      bounded "$REPAIR_SCRIPT_TIMEOUT" bash "$repair_dir/fix-stale-pid.sh" 2>&1 | while IFS= read -r line; do log "  repair: $line"; done
    fi
  fi
}

# ============================================================================
# Health Checks
# ============================================================================

check_process_alive() {
  local name=$1 pid=$2
  if [[ $pid -ne 0 ]] && ! kill -0 "$pid" 2>/dev/null; then
    log "WARN: $name (pid=$pid) not alive"
  fi
}

check_sm_health() {
  if [[ $sm_pid -eq 0 || "$sm_stopped" == "true" ]]; then return; fi
  local resp
  # Port comes from .env (sourced above) — same single source bootstrap.ts
  # reads via SM_API_PORT. Hardcoding 3501 here previously crash-looped SM
  # whenever the user changed ports.
  resp=$(curl -s --max-time 5 "http://localhost:${SM_API_PORT:-3501}/api/health" 2>/dev/null)
  if [[ $? -ne 0 ]] || ! echo "$resp" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    sm_health_fails=$((sm_health_fails + 1))
    log "WARN: SuperMatrix health failed ($sm_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $sm_health_fails -ge $HEALTH_FAIL_THRESHOLD ]]; then
      send_alert "⚠️ SuperMatrix health 连续 ${sm_health_fails} 次不通，强制重启"
      kill -TERM "$sm_pid" 2>/dev/null
      pkill -TERM -f 'tsx.*src/cli/main\.ts' 2>/dev/null || true
      sleep 10
      kill -0 "$sm_pid" 2>/dev/null && kill -KILL "$sm_pid" 2>/dev/null
      sm_health_fails=0
      notify_root_selfcheck "SuperMatrix 在 $(date '+%Y-%m-%d %H:%M:%S') 被 localwatch 强制重启（连续 3 次 /api/health 不通）"
    fi
  else
    sm_health_fails=0
  fi
}

check_sched_health() {
  if [[ $sched_pid -eq 0 ]]; then return; fi
  local resp
  resp=$(curl -s --max-time 5 "http://localhost:$SCHEDULER_PORT/health" 2>/dev/null)
  if [[ $? -ne 0 ]] || ! echo "$resp" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    sched_health_fails=$((sched_health_fails + 1))
    log "WARN: Scheduler health failed ($sched_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $sched_health_fails -ge $HEALTH_FAIL_THRESHOLD ]]; then
      send_alert "⚠️ Scheduler health 连续 ${sched_health_fails} 次不通，强制重启"
      kill -TERM "$sched_pid" 2>/dev/null
      sleep 5
      kill -0 "$sched_pid" 2>/dev/null && kill -KILL "$sched_pid" 2>/dev/null
      sched_health_fails=0
      notify_root_selfcheck "Scheduler 在 $(date '+%Y-%m-%d %H:%M:%S') 被 localwatch 强制重启（连续 3 次 /health 不通）"
    fi
  else
    sched_health_fails=0
  fi
}

check_bs_health() {
  if [[ $bs_pid -eq 0 ]]; then return; fi
  local code
  code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$BUSINESS_SCREEN_PORT/" 2>/dev/null)
  if [[ "$code" != "200" ]]; then
    bs_health_fails=$((bs_health_fails + 1))
    log "WARN: business-screen health failed (code=$code, $bs_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $bs_health_fails -ge $HEALTH_FAIL_THRESHOLD ]]; then
      send_alert "⚠️ business-screen (port $BUSINESS_SCREEN_PORT) 健康检查连续 ${bs_health_fails} 次不通，强制重启"
      kill -TERM "$bs_pid" 2>/dev/null
      sleep 3
      kill -0 "$bs_pid" 2>/dev/null && kill -KILL "$bs_pid" 2>/dev/null
      bs_health_fails=0
    fi
  else
    bs_health_fails=0
  fi
}

check_lark_connectivity() {
  if [[ -z "$LOCALWATCH_HEARTBEAT_GROUP" ]]; then return; fi
  if ! bounded "$LARK_CALL_TIMEOUT" "$LARK_CLI" im +messages-send --as bot --chat-id "$LOCALWATCH_HEARTBEAT_GROUP" \
    --text "💓 localwatch heartbeat $(date '+%H:%M')" 2>/dev/null; then
    log "ERROR: Lark connectivity lost"
    osascript -e 'display notification "飞书连接异常" with title "SuperMatrix Local-Watchdog"' 2>/dev/null || true
  fi
}

# Reap orphan vitest workers. Root cause seen 2026-04-22: a session ran
# `npx vitest run ... | tail -80`; tail's early pipe-close SIGPIPE'd the
# vitest master, which exited without signalling its worker forks. Workers
# got reparented to launchd (ppid=1), each holding ~0.5-1.4GB RSS, and
# idled for ~6 minutes burning CPU before anyone noticed.
#
# This is a bandaid — the upstream fix is to stop piping vitest into
# head/tail/grep. See feedback_vitest_pipe_sigpipe memory. But since the
# pattern is easy to slip back into and the blast radius (GBs of RAM + CPU)
# is large, we reap generically here.
reap_orphan_vitest() {
  # macOS ps supports `etime` (format `[[DD-]HH:]MM:SS`), not Linux's `etimes`.
  # We filter in awk: `-` prefix → >=1 day; `HH:MM:SS` → >=1 hour; `MM:SS`
  # with MM>=5 → >=5 min. Anything under that threshold is too young to reap.
  local -a victims=()
  local pid
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    victims+=("$pid")
  done < <(ps -eo pid,ppid,etime,command 2>/dev/null \
    | awk '$2 == 1 && $0 ~ /node \(vitest/ {
        t = $3
        if (t ~ /-/ || t ~ /^[0-9]+:[0-9]+:[0-9]+$/) { print $1; next }
        split(t, p, ":"); if (int(p[1]) >= 5) print $1
      }')

  if (( ${#victims[@]} == 0 )); then return; fi

  log "reaping ${#victims[@]} orphan vitest worker(s): ${victims[*]}"
  for pid in "${victims[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in "${victims[@]}"; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
  send_alert "🧹 localwatch 清理了 ${#victims[@]} 个孤儿 vitest worker（ppid=1 / etime>5min）。常见根因：某会话跑了 \`vitest ... | tail/head/grep\`，pipe 早关 SIGPIPE 杀 master 留下孤儿。改用 \`tee /tmp/vt.log; tail /tmp/vt.log\` 或 vitest 的 --reporter=junit --outputFile=。"
}

# ============================================================================
# Signal handling
# ============================================================================

cleanup() {
  log "shutting down..."
  [[ $sm_pid -ne 0 ]] && kill -TERM "$sm_pid" 2>/dev/null
  [[ $sched_pid -ne 0 && "$sched_owned" == "true" ]] && kill -TERM "$sched_pid" 2>/dev/null
  [[ $bs_pid -ne 0 ]] && kill -TERM "$bs_pid" 2>/dev/null
  # Also kill orphan SM child processes
  pkill -TERM -f 'tsx.*src/cli/main\.ts' 2>/dev/null || true
  if [[ -n "$BUSINESS_SCREEN_CWD" ]]; then
    pkill -TERM -f "node .*${BUSINESS_SCREEN_CWD}/server\.js" 2>/dev/null || true
  fi
  wait 2>/dev/null
  log "stopped"
  exit 0
}

trap cleanup INT TERM

# ============================================================================
# Main
# ============================================================================

log "localwatch starting"
takeover

start_supermatrix
start_scheduler
start_business_screen

while true; do
  sleep 10
  tick=$((tick + 1))

  # Every tick (10s): check for process exits
  handle_supermatrix_exit
  handle_scheduler_exit
  handle_business_screen_exit

  # Every 30s (tick % 3): process alive check
  if (( tick % 3 == 0 )); then
    check_process_alive "supermatrix" "$sm_pid"
    check_process_alive "scheduler" "$sched_pid"
    check_process_alive "business-screen" "$bs_pid"
  fi

  # Every 3min (tick % 18): API health probe
  if (( tick % 18 == 0 )); then
    check_sm_health
    check_sched_health
    check_bs_health
  fi

  # Every 5min (tick % 30): reap orphan vitest workers (see reap_orphan_vitest)
  if (( tick % 30 == 0 )); then
    reap_orphan_vitest
  fi

  # Every 30min (tick % 180): Lark connectivity
  if (( tick % 180 == 0 )); then
    check_lark_connectivity
  fi
done
