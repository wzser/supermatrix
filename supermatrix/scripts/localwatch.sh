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

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd -P)"
DEFAULT_REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
REPO_DIR="${SM_LOCALWATCH_REPO_DIR:-$DEFAULT_REPO_DIR}"
if ! REPO_DIR="$(cd -- "$REPO_DIR" 2>/dev/null && pwd -P)"; then
  echo "[localwatch] failed to canonicalize repository root: $REPO_DIR" >&2
  exit 1
fi

canonicalize_localwatch_cwd() {
  cd -- "$REPO_DIR" 2>/dev/null
}

if ! canonicalize_localwatch_cwd; then
  echo "[localwatch] failed to enter canonical repository cwd: $REPO_DIR" >&2
  exit 1
fi

ENV_FILE="${SM_LOCALWATCH_ENV_FILE:-$REPO_DIR/.env.local}"
LOG_DIR="${SM_LOCALWATCH_LOG_DIR:-$REPO_DIR/logs}"
mkdir -p "$LOG_DIR"

# Single-instance lock. mkdir is atomic on macOS, so the first localwatch to
# boot wins; any later invocation sees the lock and exits immediately.
# Prevents two localwatch instances from fighting over the same SM child (the 20s
# SIGTERM ping-pong we saw on 2026-04-17).
LOCK_DIR="${SM_LOCALWATCH_LOCK_DIR:-$LOG_DIR/.localwatch.lock}"

LOCALWATCH_IDENTITY_HELPER="$SCRIPT_DIR/lib/localwatch-identity.sh"
if [[ ! -r "$LOCALWATCH_IDENTITY_HELPER" ]]; then
  echo "[localwatch] missing identity helper: $LOCALWATCH_IDENTITY_HELPER" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$LOCALWATCH_IDENTITY_HELPER"

localwatch_process_cwd_for_pid() {
  /usr/sbin/lsof -a -p "$1" -d cwd -Fn 2>/dev/null \
    | /usr/bin/awk '/^n/ { print substr($0, 2); exit }'
}

localwatch_process_start_for_pid() {
  LC_ALL=C /bin/ps -p "$1" -o lstart= 2>/dev/null \
    | /usr/bin/awk '{$1=$1; print}'
}

localwatch_lock_holder_matches() {
  local holder="$1" expected_script="$SCRIPT_DIR/localwatch.sh"
  local command_line process_cwd process_start process_epoch pid_file_epoch delta capability provenance
  [[ "$holder" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$holder" 2>/dev/null || return 1
  command_line=$(/bin/ps -p "$holder" -o command= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')
  localwatch_command_matches_script "$command_line" "$expected_script" || return 1
  process_cwd=$(localwatch_process_cwd_for_pid "$holder")
  [[ "$process_cwd" == "$REPO_DIR" ]] || return 1
  process_start=$(localwatch_process_start_for_pid "$holder")
  [[ -n "$process_start" ]] || return 1
  process_epoch=$(LC_ALL=C /bin/date -j -f '%a %b %e %T %Y' "$process_start" '+%s' 2>/dev/null) \
    || return 1
  pid_file_epoch=$(/usr/bin/stat -f '%m' "$LOCK_DIR/pid" 2>/dev/null) || return 1
  delta=$(( pid_file_epoch - process_epoch ))
  (( delta < 0 )) && delta=$(( -delta ))
  (( delta <= 5 )) || return 1

  capability=$(cat "$LOCK_DIR/maintenance-gate-version" 2>/dev/null || true)
  [[ "$capability" == "platform-maintenance-gate-v1" ]] || return 1
  [[ "$(cat "$LOCK_DIR/repo-dir" 2>/dev/null || true)" == "$REPO_DIR" ]] || return 1
  [[ "$(cat "$LOCK_DIR/script-path" 2>/dev/null || true)" == "$expected_script" ]] || return 1
  [[ "$(cat "$LOCK_DIR/cwd" 2>/dev/null || true)" == "$REPO_DIR" ]] || return 1
  [[ "$(cat "$LOCK_DIR/process-start" 2>/dev/null || true)" == "$process_start" ]] || return 1
  [[ "$(cat "$LOCK_DIR/boot-id" 2>/dev/null || true)" \
    =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || return 1
  provenance=$(cat "$LOCK_DIR/provenance.json" 2>/dev/null || true)
  jq -e --arg repo "$REPO_DIR" --arg script "$expected_script" --arg start "$process_start" \
    --arg boot "$(cat "$LOCK_DIR/boot-id" 2>/dev/null || true)" \
    '.version == 1 and .capability == "platform-maintenance-gate-v1" and .repoDir == $repo and .scriptPath == $script and .cwd == $repo and .processStart == $start and .bootId == $boot' \
    <<<"$provenance" >/dev/null 2>&1 || return 1
  return 0
}

localwatch_boot_id() {
  local raw digest
  if [[ -r /proc/sys/kernel/random/boot_id ]]; then
    raw=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)
    [[ "$raw" =~ ^[0-9A-Fa-f-]{36}$ ]] && { printf '%s\n' "$raw"; return 0; }
  fi
  raw=$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null || true)
  if [[ -n "$raw" ]]; then
    digest=$(printf '%s' "$raw" | /sbin/md5 -q 2>/dev/null || printf '%s' "$raw" | md5 -q 2>/dev/null || true)
    [[ "$digest" =~ ^[0-9A-Fa-f]{32}$ ]] && { printf '%s-%s-%s-%s-%s\n' "${digest:0:8}" "${digest:8:4}" "${digest:12:4}" "${digest:16:4}" "${digest:20:12}"; return 0; }
  fi
  /usr/bin/uuidgen 2>/dev/null || uuidgen 2>/dev/null
}

publish_localwatch_lock_provenance() {
  local process_start boot_id cwd temp_suffix
  process_start="$(localwatch_process_start_for_pid "$$")"
  boot_id="$(localwatch_boot_id || true)"
  cwd="$(pwd -P)"
  [[ -n "$process_start" && "$cwd" == "$REPO_DIR" \
    && "$boot_id" =~ ^[0-9A-Fa-f-]{36}$ ]] || return 1

  temp_suffix=".tmp.$$"
  printf '%s\n' "$REPO_DIR" > "$LOCK_DIR/repo-dir$temp_suffix" || return 1
  printf '%s\n' "$SCRIPT_DIR/localwatch.sh" > "$LOCK_DIR/script-path$temp_suffix" || return 1
  printf '%s\n' "$cwd" > "$LOCK_DIR/cwd$temp_suffix" || return 1
  printf '%s\n' "$process_start" > "$LOCK_DIR/process-start$temp_suffix" || return 1
  printf '%s\n' "$boot_id" > "$LOCK_DIR/boot-id$temp_suffix" || return 1
  printf '%s\n' "platform-maintenance-gate-v1" > "$LOCK_DIR/maintenance-gate-version$temp_suffix" || return 1
  jq -cn \
    --arg repo "$REPO_DIR" \
    --arg script "$SCRIPT_DIR/localwatch.sh" \
    --arg cwd "$cwd" \
    --arg processStart "$process_start" \
    --arg bootId "$boot_id" \
    '{version:1,capability:"platform-maintenance-gate-v1",repoDir:$repo,scriptPath:$script,cwd:$cwd,processStart:$processStart,bootId:$bootId}' \
    > "$LOCK_DIR/provenance.json$temp_suffix" || return 1
  mv -f "$LOCK_DIR/repo-dir$temp_suffix" "$LOCK_DIR/repo-dir" || return 1
  mv -f "$LOCK_DIR/script-path$temp_suffix" "$LOCK_DIR/script-path" || return 1
  mv -f "$LOCK_DIR/cwd$temp_suffix" "$LOCK_DIR/cwd" || return 1
  mv -f "$LOCK_DIR/process-start$temp_suffix" "$LOCK_DIR/process-start" || return 1
  mv -f "$LOCK_DIR/boot-id$temp_suffix" "$LOCK_DIR/boot-id" || return 1
  mv -f "$LOCK_DIR/maintenance-gate-version$temp_suffix" "$LOCK_DIR/maintenance-gate-version" || return 1
  mv -f "$LOCK_DIR/provenance.json$temp_suffix" "$LOCK_DIR/provenance.json" || return 1
}

publish_localwatch_owner_receipt() {
  local status="${1:-active}" process_start boot_id cwd receipt_path temp_path api_health scheduler_health
  receipt_path="${SM_LOCALWATCH_OWNER_RECEIPT_PATH:-$LOG_DIR/localwatch-owner-receipt.json}"
  process_start="$(localwatch_process_start_for_pid "$$")"
  boot_id="$(localwatch_boot_id || true)"
  cwd="$(pwd -P)"
  api_health="${SM_BASE_URL:-http://127.0.0.1:${SM_API_PORT:-3501}}/api/health"
  scheduler_health="${SM_SCHEDULER_HEALTH_URL:-http://127.0.0.1:${SCHEDULER_V2_PORT:-3502}/health}"
  [[ "$status" == "active" || "$status" == "stopped" ]] || return 1
  [[ -n "$process_start" && "$cwd" == "$REPO_DIR" && "$boot_id" =~ ^[0-9A-Fa-f-]{36}$ ]] || return 1
  mkdir -p "$(dirname "$receipt_path")" || return 1
  temp_path="${receipt_path}.tmp.$$"
  jq -cn \
    --arg status "$status" \
    --arg pid "$$" \
    --arg processStart "$process_start" \
    --arg bootId "$boot_id" \
    --arg repo "$REPO_DIR" \
    --arg script "$SCRIPT_DIR/localwatch.sh" \
    --arg cwd "$cwd" \
    --arg namespace "${SM_LOCALWATCH_INSTALLATION_NAMESPACE:-$REPO_DIR}" \
    --arg launcher "${SM_LOCALWATCH_LAUNCHER_PATH:-$SCRIPT_DIR/localwatch.sh}" \
    --arg api "$api_health" \
    --arg scheduler "$scheduler_health" \
    --arg publishedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{version:1,kind:"localwatch-owner",status:$status,pid:($pid|tonumber),processStart:$processStart,bootId:$bootId,repoDir:$repo,scriptPath:$script,cwd:$cwd,installationNamespace:$namespace,launcherPath:$launcher,healthEndpoints:{api:$api,scheduler:$scheduler},publishedAt:$publishedAt}' \
    > "$temp_path" || return 1
  if [[ "$status" == "stopped" ]]; then
    jq --arg stoppedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" '. + {stoppedAt:$stoppedAt}' "$temp_path" > "${temp_path}.stopped" || return 1
    mv -f "${temp_path}.stopped" "$temp_path" || return 1
  fi
  mv -f "$temp_path" "$receipt_path" || return 1
}

# Returns 0 when this process owns a fresh lock, 10 when an exact existing
# localwatch owns it, and 1 when a stale lock cannot be safely reclaimed.
acquire_localwatch_lock() {
  local holder conflicts
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid" || return 1
    if ! conflicts=$(localwatch_same_script_pids "$SCRIPT_DIR/localwatch.sh" "$$"); then
      echo "[localwatch] refusing startup: same-name process scan unavailable" >&2
      rm -rf "$LOCK_DIR"
      return 2
    fi
    if [[ -n "$conflicts" ]]; then
      echo "[localwatch] refusing startup: unproven same-name localwatch pid(s)=$conflicts" >&2
      rm -rf "$LOCK_DIR"
      return 2
    fi
    return 0
  fi
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if localwatch_lock_holder_matches "$holder"; then
    echo "[localwatch] another exact instance already running (pid=$holder), exiting" >&2
    return 10
  fi
  if ! conflicts=$(localwatch_same_script_pids "$SCRIPT_DIR/localwatch.sh" "$$"); then
    echo "[localwatch] refusing stale-lock migration: same-name process scan unavailable" >&2
    return 2
  fi
  if [[ -n "$conflicts" ]]; then
    echo "[localwatch] refusing stale-lock migration: unproven same-name localwatch pid(s)=$conflicts" >&2
    return 2
  fi
  echo "[localwatch] stale or mismatched lock from pid=${holder:-?}, reclaiming" >&2
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || { echo "[localwatch] failed to acquire lock" >&2; return 1; }
  printf '%s\n' "$$" > "$LOCK_DIR/pid" || return 1
  if ! conflicts=$(localwatch_same_script_pids "$SCRIPT_DIR/localwatch.sh" "$$"); then
    echo "[localwatch] refusing startup: same-name process scan unavailable" >&2
    rm -rf "$LOCK_DIR"
    return 2
  fi
  if [[ -n "$conflicts" ]]; then
    echo "[localwatch] refusing startup: unproven same-name localwatch pid(s)=$conflicts" >&2
    rm -rf "$LOCK_DIR"
    return 2
  fi
  return 0
}

acquire_localwatch_lock
lock_status=$?
if (( lock_status == 10 )); then
  exit 0
fi
if (( lock_status != 0 )); then
  echo "[localwatch] failed to acquire exact single-instance lock" >&2
  exit 1
fi
trap 'publish_localwatch_owner_receipt stopped || true; rm -rf "$LOCK_DIR"' EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a
SCHEDULER_PID_FILE="${SM_LOCALWATCH_SCHEDULER_PID_FILE:-}"

if ! publish_localwatch_lock_provenance || ! publish_localwatch_owner_receipt active; then
  echo "[localwatch] failed to publish exact process identity; refusing startup" >&2
  rm -rf "$LOCK_DIR"
  exit 1
fi

LOCALWATCH_MANAGED_COMPONENTS="${LOCALWATCH_MANAGED_COMPONENTS:-all}"
if [[ "$LOCALWATCH_MANAGED_COMPONENTS" != "core,scheduler-v2" ]]; then
  export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$REPO_DIR/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
fi
export LARK_CLI_NO_PROXY="${LARK_CLI_NO_PROXY:-1}"
LARK_CLI="${SM_LARK_CLI_PATH:-$REPO_DIR/node_modules/.bin/lark-cli}"
ROOT_GROUP="${SM_ROOT_GROUP_ID:-}"
LOCALWATCH_HEARTBEAT_GROUP="${LOCALWATCH_HEARTBEAT_GROUP:-oc_REDACTEDCHATID}"
LOCALWATCH_MANAGED_SERVICES_CONFIG="${LOCALWATCH_MANAGED_SERVICES_CONFIG:-/Users/LOCAL_USER/SuperMatrixRuntime/config/localwatch-services.json}"
LOCALWATCH_MANAGED_SERVICES_STATE="${LOCALWATCH_MANAGED_SERVICES_STATE:-/Users/LOCAL_USER/SuperMatrixRuntime/data/localwatch-managed-services.state.json}"
# T800_GROUP 已废弃：self-check 触发改走 /api/spawn2.0 target=codexroot
# (per console-principles 行 24-32 / 48 / 78 — session-to-session triggering uses HTTP spawn).

# Scheduler v1 (port 3500) retired 2026-08-10; v2 on 3502 is the only supervised scheduler.
SCHEDULER_V2_START="${SCHEDULER_V2_START:-${SM_SCHEDULER_START:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/scheduler/v2/start.sh}}"
SCHEDULER_V2_PORT="${SCHEDULER_V2_PORT:-${SM_SCHEDULER_PORT:-3502}}"
CARD_ASK_BROKER_CWD="${CARD_ASK_BROKER_CWD:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/larkc/card-callback}"
CARD_ASK_BROKER_START="${CARD_ASK_BROKER_START:-$CARD_ASK_BROKER_CWD/src/broker.js}"
CARD_ASK_BROKER_PORT="${BROKER_PORT:-8787}"
CARD_ASK_BROKER_KEYCHAIN_SERVICE="${CARD_ASK_BROKER_KEYCHAIN_SERVICE:-SuperMatrix card-ask broker}"
CARD_ASK_BROKER_KEYCHAIN_ACCOUNT="${CARD_ASK_BROKER_KEYCHAIN_ACCOUNT:-${LARK_APP_ID:-}}"

BUSINESS_SCREEN_CWD="${BUSINESS_SCREEN_CWD:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/business-screen}"
BUSINESS_SCREEN_PORT="${BUSINESS_SCREEN_PORT:-4322}"
BUSINESS_SCREEN_HOST="${BUSINESS_SCREEN_HOST:-0.0.0.0}"
BUSINESS_SCREEN_ARCHITECTURE_ENABLED="${BUSINESS_SCREEN_ARCHITECTURE_ENABLED:-0}"
BUSINESS_SCREEN_ARCHITECTURE_START="${BUSINESS_SCREEN_ARCHITECTURE_START:-$BUSINESS_SCREEN_CWD/server-session-architecture.js}"
BUSINESS_SCREEN_ARCHITECTURE_PORT="${BUSINESS_SCREEN_ARCHITECTURE_PORT:-4323}"

HEARTBEAT_WORKSPACE="${HEARTBEAT_WORKSPACE:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat}"
HEARTBEAT_TODO_WATCH_SCRIPT="${HEARTBEAT_TODO_WATCH_SCRIPT:-$HEARTBEAT_WORKSPACE/scripts/heartbeat-todo-watch}"
HEARTBEAT_TODO_WATCH_DB="${HEARTBEAT_TODO_WATCH_DB:-$HEARTBEAT_WORKSPACE/data/heartbeat.sqlite}"
HEARTBEAT_TODO_WATCH_LOG_DIR="${HEARTBEAT_TODO_WATCH_LOG_DIR:-$HEARTBEAT_WORKSPACE/data/enqueue-triggers}"
HEARTBEAT_TODO_WATCH_ENABLED="${HEARTBEAT_TODO_WATCH_ENABLED:-1}"
HEARTBEAT_PYTHON="${HEARTBEAT_PYTHON:-python3}"

# --- Config ---
MIN_UPTIME_SECS=30
MAX_IDENTICAL_CRASHES=5
HEALTH_FAIL_THRESHOLD=3

# Per-call timeouts (seconds). These exist so a single hung external command
# (the 2026-04-22 SSH host-key prompt wedged lark-cli heartbeat indefinitely)
# cannot starve the main loop. Any value that trips 124 is a bug to investigate.
LARK_CALL_TIMEOUT=10
MANAGED_SERVICES_CHECK_TIMEOUT=20
PROCESS_OBSERVE_ENABLED="${PROCESS_OBSERVE_ENABLED:-1}"
PROCESS_OBSERVE_TIMEOUT="${PROCESS_OBSERVE_TIMEOUT:-8}"
REPAIR_SCRIPT_TIMEOUT=60
PM2_QUERY_TIMEOUT=5
LSOF_QUERY_TIMEOUT=5
TYPECHECK_TIMEOUT=180
BACKEND_API_CHECK_TIMEOUT=180
BACKEND_API_CHECK_FAIL_THRESHOLD=2
# The in-process Lark SDK WebSocket is distinct from process /api/health.
# Count only its terminal/expired-grace responses before alerting an operator.
LARK_WS_HEALTH_FAIL_THRESHOLD="${LARK_WS_HEALTH_FAIL_THRESHOLD:-2}"
CLAUDE_AUTH_CHECK_TIMEOUT=20
QUOTA_STATUS_NOTIFY_ENABLED="${QUOTA_STATUS_NOTIFY_ENABLED:-1}"
LOCALWATCH_MANAGED_COMPONENTS="${LOCALWATCH_MANAGED_COMPONENTS:-all}"
QUOTA_STATUS_NOTIFY_TIMEOUT="${QUOTA_STATUS_NOTIFY_TIMEOUT:-90}"
MEMORY_GUARD_ENABLED="${MEMORY_GUARD_ENABLED:-1}"
MEMORY_GUARD_WARN_CONSECUTIVE="${MEMORY_GUARD_WARN_CONSECUTIVE:-2}"
MEMORY_GUARD_ACTION_CONSECUTIVE="${MEMORY_GUARD_ACTION_CONSECUTIVE:-3}"
MEMORY_GUARD_ALERT_COOLDOWN_SECS="${MEMORY_GUARD_ALERT_COOLDOWN_SECS:-600}"
MEMORY_GUARD_TERM_GRACE_SECS="${MEMORY_GUARD_TERM_GRACE_SECS:-10}"
MEMORY_GUARD_SM_WARN_MB="${MEMORY_GUARD_SM_WARN_MB:-900}"
MEMORY_GUARD_SM_ACTION_MB="${MEMORY_GUARD_SM_ACTION_MB:-1500}"
MEMORY_GUARD_SCHED_WARN_MB="${MEMORY_GUARD_SCHED_WARN_MB:-600}"
MEMORY_GUARD_SCHED_ACTION_MB="${MEMORY_GUARD_SCHED_ACTION_MB:-900}"
MEMORY_GUARD_CARD_ASK_WARN_MB="${MEMORY_GUARD_CARD_ASK_WARN_MB:-400}"
MEMORY_GUARD_CARD_ASK_ACTION_MB="${MEMORY_GUARD_CARD_ASK_ACTION_MB:-700}"
MEMORY_GUARD_BUSINESS_SCREEN_WARN_MB="${MEMORY_GUARD_BUSINESS_SCREEN_WARN_MB:-600}"
MEMORY_GUARD_BUSINESS_SCREEN_ACTION_MB="${MEMORY_GUARD_BUSINESS_SCREEN_ACTION_MB:-900}"

# --- State ---
sm_pid=0
sm_adopted=false
sched_v2_pid=0
sched_v2_owned=false
sched_v2_process_start=""
card_ask_broker_pid=0
card_ask_broker_owned=false
card_ask_broker_process_start=""
bs_pid=0
bs_process_start=""
bs_architecture_pid=0
bs_architecture_process_start=""
sm_start_ts=0
sm_backoff=2
sm_stopped=false
last_fatal=""
identical_count=0
sm_health_fails=0
sched_v2_health_fails=0
card_ask_broker_health_fails=0
bs_health_fails=0
bs_architecture_health_fails=0
backend_api_claude_health_fails=0
backend_api_codex_health_fails=0
backend_api_kimi_health_fails=0
lark_ws_health_fails=0
lark_connectivity_abnormal_fails=0
managed_services_heartbeat_abnormal=""
memory_guard_sm_warn_hits=0
memory_guard_sm_action_hits=0
memory_guard_sched_v2_warn_hits=0
memory_guard_sched_v2_action_hits=0
memory_guard_card_ask_warn_hits=0
memory_guard_card_ask_action_hits=0
memory_guard_bs_warn_hits=0
memory_guard_bs_action_hits=0
memory_guard_bs_architecture_warn_hits=0
memory_guard_bs_architecture_action_hits=0
memory_guard_last_alert_ts=0
tick=0

localwatch_is_onboarding() {
  [[ "$LOCALWATCH_MANAGED_COMPONENTS" == "core,scheduler-v2" ]]
}

write_scheduler_pid() {
  [[ -n "$SCHEDULER_PID_FILE" ]] || return 0
  printf '%s\n' "$1" > "$SCHEDULER_PID_FILE"
}

# ============================================================================
# bounded — hard-timeout wrapper for external commands.
# Usage: bounded <secs> <cmd...> → command exit code, or 124 on timeout.
# Prefers GNU timeout (gtimeout via brew coreutils, or timeout if present),
# falls back to pure bash. macOS base install ships neither.
# Scope warning: the fallback KILL below is only for the exact transient command
# spawned by bounded(). It is not permission to signal SuperMatrix, localwatch,
# or another session; platform lifecycle requests go to codexroot's gate.
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

# Persist one structured, one-shot restart intent before signalling SuperMatrix.
# bootstrap consumes it on the next boot and carries it into both the startup
# notice and every run terminalized by boot reconciliation.
record_supermatrix_restart_provenance() {
  local source=$1 reason=$2 trigger_path=$3 signal=${4:-SIGTERM} target_pid=${5:-${sm_pid:-0}} preserve_existing=${6:-false}
  if [[ -z "${SM_DB_PATH:-}" ]]; then
    log "WARN: cannot record restart provenance: SM_DB_PATH is unset"
    return 1
  fi

  local requested_at_ms restart_id marker temp existing_at existing_age_ms
  requested_at_ms=$(( $(date +%s) * 1000 ))
  restart_id="smr-${requested_at_ms}-$$"
  marker="$(dirname "$SM_DB_PATH")/.restart-provenance.json"
  if [[ "$preserve_existing" == "true" && -f "$marker" ]]; then
    existing_at=$(jq -r '.requestedAtMs // empty' "$marker" 2>/dev/null || true)
    if [[ "$existing_at" =~ ^[0-9]+$ ]]; then
      existing_age_ms=$(( requested_at_ms - existing_at ))
      if (( existing_age_ms >= -60000 && existing_age_ms <= 600000 )); then
        log "preserving registered restart provenance before $source (age_ms=$existing_age_ms)"
        return 0
      fi
    fi
  fi
  temp="${marker}.tmp.$$"
  if ! jq -cn \
    --arg restartId "$restart_id" \
    --argjson requestedAtMs "$requested_at_ms" \
    --arg source "$source" \
    --arg reason "$reason" \
    --arg path "$trigger_path" \
    --arg signal "$signal" \
    --argjson requesterPid "$$" \
    --argjson targetPid "$target_pid" \
    '{version:1,restartId:$restartId,requestedAtMs:$requestedAtMs,source:$source,reason:$reason,path:$path,signal:$signal,requesterPid:$requesterPid,targetPid:$targetPid}' \
    > "$temp"; then
    rm -f "$temp"
    log "WARN: failed to serialize restart provenance source=$source path=$trigger_path"
    return 1
  fi
  mv -f "$temp" "$marker"
  log "restart provenance recorded: restart_id=$restart_id source=$source reason=$reason path=$trigger_path signal=$signal target_pid=$target_pid"
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

send_backend_api_alert() {
  local msg=$1
  if [[ -n "$LOCALWATCH_HEARTBEAT_GROUP" ]] && bounded "$LARK_CALL_TIMEOUT" "$LARK_CLI" im +messages-send --as bot \
    --chat-id "$LOCALWATCH_HEARTBEAT_GROUP" --text "$msg" 2>/dev/null; then
    return 0
  fi
  send_alert "$msg"
}

# Hot-read the constrained managed-service registry every 30 seconds. The
# TypeScript helper owns schema validation, probe state, cooldowns and the only
# permitted macOS actions; localwatch only surfaces its structured result.
check_managed_services() {
  local output rc
  output=$(bounded "$MANAGED_SERVICES_CHECK_TIMEOUT" "$REPO_DIR/node_modules/.bin/tsx" \
    "$REPO_DIR/scripts/localwatch-managed-services.ts" check 2>&1)
  rc=$?

  if ! printf '%s\n' "$output" | jq -e '
    type == "object" and
    (.abnormalLabels | type == "array") and
    (.notifications | type == "array")
  ' >/dev/null 2>&1; then
    managed_services_heartbeat_abnormal="managed-services helper"
    log "ERROR: managed-services helper returned no structured JSON (rc=$rc): ${output:0:300}"
    send_backend_api_alert "⚠️ localwatch managed-services helper failed; service state is unknown."
    return 0
  fi

  managed_services_heartbeat_abnormal=$(printf '%s\n' "$output" | jq -r '[.abnormalLabels[]?] | join(", ")')
  if [[ $rc -ne 0 ]]; then
    log "WARN: managed-services helper completed abnormal (rc=$rc)"
  fi

  local kind label message marker
  while IFS=$'\037' read -r kind label message; do
    [[ -z "$kind" || -z "$message" ]] && continue
    if [[ "$kind" == "recovered" ]]; then
      marker="✅"
    else
      marker="⚠️"
    fi
    if [[ -n "$label" ]]; then
      log "managed service $kind: $label: $message"
      send_backend_api_alert "$marker localwatch managed service $kind: $label: $message"
    else
      log "managed service $kind: $message"
      send_backend_api_alert "$marker localwatch managed service $kind: $message"
    fi
  done < <(printf '%s\n' "$output" | jq -r '.notifications[]? | [(.kind // ""), (.label // ""), (.message // "")] | join("\u001f")')
}

# Observe platform-owned process instances through the existing 30-second
# localwatch tick. This is intentionally record-only: it never starts, stops,
# blocks, or classifies a process as authorized. The seven-day report is the
# human decision input for a later registry and launch-gate rollout.
observe_platform_processes() {
  [[ "$PROCESS_OBSERVE_ENABLED" == "0" ]] && return 0
  local output rc
  output=$(bounded "$PROCESS_OBSERVE_TIMEOUT" "$REPO_DIR/node_modules/.bin/tsx" \
    "$REPO_DIR/scripts/process-observe.ts" observe 2>&1)
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "WARN: process observer: rc=$rc output=${output:0:500}"
    return 0
  fi
  if printf '%s\n' "$output" | jq -e '((.started // 0) + (.changed // 0) + (.exited // 0)) > 0' >/dev/null 2>&1; then
    log "process observer: $output"
  fi
}

append_managed_services_heartbeat_abnormal() {
  if [[ -n "${managed_services_heartbeat_abnormal:-}" ]]; then
    abnormal+=("$managed_services_heartbeat_abnormal")
  fi
}

# Triggered after a force-restart event (SM or scheduler health fail). Spawns
# codexroot (T800) via /api/spawn2.0 todo-pool closure for a one-shot self-check.
# T800 investigates root cause from logs / DB, fixes if mechanical, or files
# an issue via watchdog. Strict no-cascade — see prompt.
#
# Why /api/spawn2.0 and not lark-cli messages-send:
#   console-principles 行 24-32 / 48 / 78：session-to-session triggering must
#   go through HTTP spawn (proper run lifecycle + childSessionId tracking).
#   lark-cli --as bot to a session group does not reliably wake the target
#   (dispatcher filters bot-origin messages on bound user-session groups).
notify_t800_selfcheck() {
  local trigger=$1
  local sm_port="${SM_API_PORT:-3501}"
  local anchor="localwatch_$(date '+%s')"
  # Build prompt as a JSON-safe string. Keep it short — references absolute log paths
  # and DB query so T800 reads the source rather than working from a summary.
  local prompt
  prompt=$(cat <<EOF
[localwatch self-check trigger]
${trigger}

[spawn_predicate_anchor] ${anchor}

请做一次 SuperMatrix 健康自查（不要 spawn 其它 session）：
1. 扫 /Users/LOCAL_USER/SuperMatrix/logs/supermatrix.stdout.log 最近 200 行，找 level:50 的 error 与可能的根因（特别看强制重启前 5 分钟的 dispatcher / api error）
2. 查 sessions 表非 child 非 deleted 行的 timestamp 字段是否有 NULL / 非 integer：
   sqlite3 /Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db "SELECT name FROM sessions WHERE scope!='child' AND status!='deleted' AND (typeof(created_at)!='integer' OR typeof(updated_at)!='integer' OR created_at IS NULL OR updated_at IS NULL)"
3. curl http://localhost:${sm_port}/api/health 验证当前已恢复
4. 如根因是机械可修，直接修 SuperMatrix 源码 + commit；如需权衡，POST localhost:${sm_port}/api/spawn2.0 target=watchdog closure.target=todo_pool 把分析作为 issue 草稿投递；如查无明确根因，回执 'no actionable finding' 即可

约束（per console-principles 行 77 platform→root delegation no-cascade）：仅本人执行，不要 spawn ATP / scheduler / 其它 session，不要触发 test run。
EOF
)
  # SM may still be in restart window — retry up to 6 times with 5s gaps (~30s).
  local payload
  local client_request_id
  client_request_id="$(TZ=Asia/Shanghai date '+%Y-%m-%d'):localwatch:${anchor}"
  payload=$(jq -nc --arg target "codexroot" --arg from "supermatrix-root" --arg prompt "$prompt" --arg anchor "$anchor" --arg client_request_id "$client_request_id" '{target:$target, from:$from, prompt:$prompt, client_request_id:$client_request_id, closure:{kind:"message",target:{type:"todo_pool"}}, verification_predicate:{type:"inbox-message", session_name:$target, field:"prompt", contains_all:["localwatch self-check trigger",$anchor], expected_window_sec:600}}')
  local attempts=0
  while (( attempts < 6 )); do
    local resp
    resp=$(bounded "$LARK_CALL_TIMEOUT" curl --noproxy '*' -s -m 8 -X POST "http://localhost:${sm_port}/api/spawn2.0" \
      -H "Content-Type: application/json" -d "$payload" 2>/dev/null)
    if echo "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
      local child_id
      child_id=$(echo "$resp" | jq -r '.childSessionId // empty')
      log "T800 self-check spawned (childSessionId=$child_id) — trigger: $trigger"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  log "WARN: failed to spawn T800 self-check after $attempts attempts — trigger: $trigger"
}

# ============================================================================
# Memory Guard
# ============================================================================

memory_guard_rss_mb() {
  local pid=$1
  local rss_mb
  rss_mb=$(ps -o rss= -p "$pid" 2>/dev/null | awk 'NR == 1 { print int(($1 + 1023) / 1024) }')
  if [[ -z "$rss_mb" ]]; then
    printf '0\n'
  else
    printf '%s\n' "$rss_mb"
  fi
}

send_memory_guard_alert() {
  local msg=$1
  local now
  now=$(date +%s)
  if (( memory_guard_last_alert_ts > 0 && now - memory_guard_last_alert_ts < MEMORY_GUARD_ALERT_COOLDOWN_SECS )); then
    log "memory guard alert suppressed by cooldown: $msg"
    return 0
  fi
  memory_guard_last_alert_ts=$now
  send_alert "$msg"
}

log_memory_top_snapshot() {
  log "memory guard top RSS snapshot:"
  ps -axo pid=,ppid=,rss=,command= 2>/dev/null \
    | sort -nrk3 \
    | head -10 \
    | while read -r pid ppid rss_kb command; do
        [[ -z "$pid" ]] && continue
        local rss_mb=$(( (rss_kb + 1023) / 1024 ))
        log "  pid=$pid ppid=$ppid rss=${rss_mb}MB cmd=${command:0:220}"
      done
}

report_supermatrix_memory_guard() {
  local rss_mb=$1 threshold_mb=$2
  if [[ $sm_pid -eq 0 || "$sm_stopped" == "true" ]]; then
    log "WARN: memory guard hit but SuperMatrix is not running"
    return 1
  fi

  log_memory_top_snapshot
  send_memory_guard_alert "⚠️ memory guard: SuperMatrix RSS ${rss_mb}MB exceeded ${threshold_mb}MB for ${MEMORY_GUARD_ACTION_CONSECUTIVE} checks; automatic reload is disabled. Route any maintenance request to codexroot."
  log "automatic SuperMatrix reload suppressed by policy (trigger=memory-guard rss=${rss_mb}MB)"
  return 0
}

restart_supervised_process_for_memory_guard() {
  local label=$1 pid=$2 rss_mb=$3 threshold_mb=$4 kind expected_start
  if [[ "$pid" -eq 0 ]]; then return 0; fi

  case "$label" in
    "Scheduler v2") kind="scheduler-v2"; expected_start="$sched_v2_process_start" ;;
    "card-ask broker") kind="card-ask"; expected_start="$card_ask_broker_process_start" ;;
    "business-screen") kind="business-screen"; expected_start="$bs_process_start" ;;
    "business-screen-architecture") kind="business-screen-architecture"; expected_start="$bs_architecture_process_start" ;;
    *)
      log "maintenance denied: memory guard has no exact identity contract for $label pid=$pid"
      return 1
      ;;
  esac

  log_memory_top_snapshot
  send_memory_guard_alert "memory guard: $label pid=$pid RSS ${rss_mb}MB exceeded ${threshold_mb}MB for ${MEMORY_GUARD_ACTION_CONSECUTIVE} checks; requesting exact-identity self-heal."
  signal_managed_component_for_restart \
    "$kind" "$pid" "$expected_start" "$MEMORY_GUARD_TERM_GRACE_SECS" "$label"
}

memory_guard_check_process() {
  local label=$1 pid=$2 owned=$3 warn_mb=$4 action_mb=$5 warn_var=$6 action_var=$7 action_kind=$8
  if [[ "$pid" -eq 0 ]]; then
    eval "$warn_var=0"
    eval "$action_var=0"
    return 0
  fi

  local rss_mb
  rss_mb=$(memory_guard_rss_mb "$pid")
  if [[ "$rss_mb" -le 0 ]]; then
    eval "$warn_var=0"
    eval "$action_var=0"
    return 0
  fi

  if [[ "$owned" != "true" ]]; then
    eval "$warn_var=0"
    eval "$action_var=0"
    if [[ "$rss_mb" -ge "$action_mb" ]]; then
      log "memory guard: skipping $label pid=$pid because localwatch does not own it (rss=${rss_mb}MB action=${action_mb}MB)"
    fi
    return 0
  fi

  local warn_hits action_hits
  eval "warn_hits=\${$warn_var:-0}"
  eval "action_hits=\${$action_var:-0}"

  if [[ "$rss_mb" -ge "$action_mb" ]]; then
    action_hits=$((action_hits + 1))
    warn_hits=0
    log "memory guard: $label rss=${rss_mb}MB exceeded action=${action_mb}MB (${action_hits}/${MEMORY_GUARD_ACTION_CONSECUTIVE})"
    if [[ "$action_hits" -ge "$MEMORY_GUARD_ACTION_CONSECUTIVE" ]]; then
      action_hits=0
      if [[ "$action_kind" == "supermatrix" ]]; then
        report_supermatrix_memory_guard "$rss_mb" "$action_mb"
      else
        restart_supervised_process_for_memory_guard "$label" "$pid" "$rss_mb" "$action_mb"
      fi
    fi
  elif [[ "$rss_mb" -ge "$warn_mb" ]]; then
    warn_hits=$((warn_hits + 1))
    action_hits=0
    log "memory guard: $label rss=${rss_mb}MB exceeded warn=${warn_mb}MB (${warn_hits}/${MEMORY_GUARD_WARN_CONSECUTIVE})"
    if [[ "$warn_hits" -ge "$MEMORY_GUARD_WARN_CONSECUTIVE" ]]; then
      log_memory_top_snapshot
      warn_hits=0
    fi
  else
    warn_hits=0
    action_hits=0
  fi

  eval "$warn_var=$warn_hits"
  eval "$action_var=$action_hits"
}

check_memory_guard() {
  if [[ "$MEMORY_GUARD_ENABLED" == "0" ]]; then return; fi

  memory_guard_check_process "SuperMatrix" "$sm_pid" "true" \
    "$MEMORY_GUARD_SM_WARN_MB" "$MEMORY_GUARD_SM_ACTION_MB" \
    memory_guard_sm_warn_hits memory_guard_sm_action_hits supermatrix

  memory_guard_check_process "Scheduler v2" "$sched_v2_pid" "$sched_v2_owned" \
    "$MEMORY_GUARD_SCHED_WARN_MB" "$MEMORY_GUARD_SCHED_ACTION_MB" \
    memory_guard_sched_v2_warn_hits memory_guard_sched_v2_action_hits supervised

  memory_guard_check_process "card-ask broker" "$card_ask_broker_pid" "$card_ask_broker_owned" \
    "$MEMORY_GUARD_CARD_ASK_WARN_MB" "$MEMORY_GUARD_CARD_ASK_ACTION_MB" \
    memory_guard_card_ask_warn_hits memory_guard_card_ask_action_hits supervised

  memory_guard_check_process "business-screen" "$bs_pid" "true" \
    "$MEMORY_GUARD_BUSINESS_SCREEN_WARN_MB" "$MEMORY_GUARD_BUSINESS_SCREEN_ACTION_MB" \
    memory_guard_bs_warn_hits memory_guard_bs_action_hits supervised

  if [[ "${BUSINESS_SCREEN_ARCHITECTURE_ENABLED:-0}" != "0" ]]; then
    memory_guard_check_process "business-screen-architecture" "$bs_architecture_pid" "true" \
      "$MEMORY_GUARD_BUSINESS_SCREEN_WARN_MB" "$MEMORY_GUARD_BUSINESS_SCREEN_ACTION_MB" \
      memory_guard_bs_architecture_warn_hits memory_guard_bs_architecture_action_hits supervised
  fi
}

# ============================================================================
# Process Management — heartbeat todo-watch workers
# ============================================================================

heartbeat_todo_watch_pids() {
  ps -eo pid=,comm=,args= 2>/dev/null \
    | awk '($2 ~ /python/ || $2 ~ /Python/) && $0 ~ /heartbeat-todo-watch/ && $0 ~ /--session/ { print $1 }'
}

# ============================================================================
# Successor adoption — never kill a live SuperMatrix during localwatch startup
# ============================================================================

is_repo_supermatrix_launcher_identity() {
  local command_line="$1" process_cwd="$2"
  local tsx_path="$REPO_DIR/node_modules/.bin/tsx"
  local main_path="$REPO_DIR/src/cli/main.ts"
  [[ "$process_cwd" == "$REPO_DIR" ]] || return 1
  [[ "$command_line" == "node $tsx_path $main_path" \
    || "$command_line" == */node" $tsx_path $main_path" ]]
}

is_repo_dev_loop_identity() {
  local command_line="$1" process_cwd="$2"
  local dev_loop_path="$REPO_DIR/scripts/dev-loop.sh"
  [[ "$process_cwd" == "$REPO_DIR" ]] || return 1
  [[ "$command_line" == "bash $dev_loop_path" \
    || "$command_line" == "/bin/bash $dev_loop_path" ]]
}

repo_process_pids_matching() {
  local matcher="$1" required_fragment="$2" line pid command_line process_cwd
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -n "$line" ]] || continue
    pid="${line%%[[:space:]]*}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    command_line="${line#"$pid"}"
    command_line="${command_line#"${command_line%%[![:space:]]*}"}"
    [[ "$command_line" == *"$required_fragment"* ]] || continue
    process_cwd="$(localwatch_process_cwd_for_pid "$pid")"
    if "$matcher" "$command_line" "$process_cwd"; then
      printf '%s\n' "$pid"
    fi
  done < <(/bin/ps -ax -o pid=,command= 2>/dev/null)
}

repo_supermatrix_launcher_pids() {
  repo_process_pids_matching is_repo_supermatrix_launcher_identity "$REPO_DIR/src/cli/main.ts"
}

repo_dev_loop_pids() {
  repo_process_pids_matching is_repo_dev_loop_identity "$REPO_DIR/scripts/dev-loop.sh"
}

adopt_existing_supermatrix() {
  local dev_loop_pids existing_pids pid count=0
  dev_loop_pids=$(repo_dev_loop_pids || true)
  if [[ -n "$dev_loop_pids" ]]; then
    log "ERROR: legacy dev-loop is running (pids: ${dev_loop_pids//$'\n'/,}); refusing destructive takeover"
    send_alert "🛑 localwatch 检测到 legacy dev-loop，已拒绝 takeover；请交由 codexroot 处理。" || true
    return 1
  fi

  existing_pids=$(repo_supermatrix_launcher_pids || true)
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    count=$((count + 1))
    sm_pid="$pid"
  done <<< "$existing_pids"

  if (( count > 1 )); then
    log "ERROR: multiple SuperMatrix processes found (${existing_pids//$'\n'/,}); refusing destructive takeover"
    send_alert "🛑 localwatch 检测到多个 SuperMatrix 进程，已拒绝 takeover；请交由 codexroot 处理。" || true
    sm_pid=0
    return 1
  fi
  if (( count == 1 )); then
    kill -0 "$sm_pid" 2>/dev/null || { sm_pid=0; return 0; }
    sm_start_ts=$(date +%s)
    sm_adopted=true
    log "adopting existing SuperMatrix process pid=$sm_pid without signaling it"
  fi
  return 0
}

# ============================================================================
# Process Management — SuperMatrix
# ============================================================================

start_supermatrix() {
  # Refuse to create a dual instance. A successor localwatch adopts one healthy
  # existing SuperMatrix during startup; every other collision is review-only.
  local orphans
  orphans=$(repo_supermatrix_launcher_pids || true)
  if [[ -n "$orphans" ]]; then
    log "ERROR: refusing to start a second SuperMatrix; existing pids: ${orphans//$'\n'/,}"
    send_alert "🛑 localwatch 拒绝启动第二个 SuperMatrix；现有 PID：${orphans//$'\n'/,}。请交由 codexroot 处理。" || true
    return 1
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
  sm_adopted=false
  sm_start_ts=$(date +%s)
  log "SuperMatrix started (pid=$sm_pid)"
}

extract_crash_signature() {
  local crash_log="${1:-}"
  local line=""
  local first_nonempty=""
  local boot_header=""
  local signature=""
  local in_boot_report=false

  if [[ -r "$crash_log" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ -z "$first_nonempty" && -n "${line//[[:space:]]/}" ]]; then
        first_nonempty="$line"
      fi

      if [[ "$line" == *"[supermatrix] boot 自检失败"* ]]; then
        in_boot_report=true
        boot_header="$line"
        continue
      fi

      if [[ "$in_boot_report" == "true" ]]; then
        if [[ "$line" == *"❌"* ]]; then
          signature="$line"
          break
        fi
        if [[ "$line" == *"[supermatrix] 终止启动"* ]]; then
          signature="$boot_header"
          break
        fi
        continue
      fi

      case "$line" in
        *fatal*|*Error*|*SQLITE*|*"Cannot find"*|*EADDRINUSE*)
          signature="$line"
          break
          ;;
      esac
    done < "$crash_log"
  fi

  signature="${signature:-${boot_header:-$first_nonempty}}"
  signature="${signature#"${signature%%[![:space:]]*}"}"
  signature="${signature%"${signature##*[![:space:]]}"}"

  if [[ -z "$signature" ]]; then
    printf '%s\n' "unknown"
  else
    printf '%s\n' "${signature:0:200}"
  fi
}

handle_supermatrix_exit() {
  if [[ $sm_pid -eq 0 ]]; then return; fi
  if kill -0 "$sm_pid" 2>/dev/null; then return; fi

  wait "$sm_pid" 2>/dev/null
  local exit_code=$?
  local uptime=$(( $(date +%s) - sm_start_ts ))
  log "SuperMatrix exited (code=$exit_code, uptime=${uptime}s)"
  local was_adopted="$sm_adopted"
  sm_pid=0
  sm_adopted=false

  if [[ "$sm_stopped" == "true" ]]; then
    return
  fi

  if [[ "$was_adopted" == "true" ]]; then
    log "previously adopted SuperMatrix exited; restarting without destructive cleanup"
    sleep 1.5
    start_supermatrix || sm_stopped=true
    return
  fi

  if [[ $exit_code -eq 0 ]]; then
    # Clean exit after an authorized /reload (manual or scheduled-daily).
    identical_count=0
    last_fatal=""
    sm_backoff=2
    sleep 1.5
    start_supermatrix || sm_stopped=true
    return
  fi

  # Crash — analyze and handle
  local crash_log="$LOG_DIR/sm-crash.log"
  local current_fatal
  current_fatal=$(extract_crash_signature "$crash_log")

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

  record_supermatrix_restart_provenance \
    "localwatch-crash-restart" \
    "previous SuperMatrix exited code=$exit_code uptime=${uptime}s fatal=$current_fatal" \
    "scripts/localwatch.sh:handle_supermatrix_exit" \
    "PROCESS_EXIT" \
    "0" \
    "true" || true
  start_supermatrix || sm_stopped=true
}

# ============================================================================
# Exact identity for LocalWatch-managed auxiliary services
# ============================================================================

managed_component_expected_cwd() {
  case "$1" in
    scheduler-v2) dirname "$SCHEDULER_V2_START" ;;
    card-ask) printf '%s\n' "$CARD_ASK_BROKER_CWD" ;;
    business-screen|business-screen-architecture) printf '%s\n' "$BUSINESS_SCREEN_CWD" ;;
    *) return 1 ;;
  esac
}

managed_component_expected_entry() {
  case "$1" in
    scheduler-v2) printf '%s\n' "$(dirname "$SCHEDULER_V2_START")/dist/main.js" ;;
    card-ask) printf '%s\n' "$CARD_ASK_BROKER_START" ;;
    business-screen) printf '%s\n' "$BUSINESS_SCREEN_CWD/server.js" ;;
    business-screen-architecture) printf '%s\n' "$BUSINESS_SCREEN_ARCHITECTURE_START" ;;
    *) return 1 ;;
  esac
}

managed_component_process_start() {
  LC_ALL=C /bin/ps -p "$1" -o lstart= 2>/dev/null \
    | /usr/bin/awk '{$1=$1; print}'
}

managed_component_command_matches() {
  local kind="$1" command_line="$2"
  local executable argument expected_entry expected_cwd
  [[ "$command_line" == *" "* ]] || return 1
  executable="${command_line%% *}"
  argument="${command_line#* }"
  [[ "$executable" == "node" || "$executable" == */node ]] || return 1
  expected_entry=$(managed_component_expected_entry "$kind") || return 1
  expected_cwd=$(managed_component_expected_cwd "$kind") || return 1
  if [[ "$kind" == "scheduler-v2" ]]; then
    [[ "$argument" == "dist/main.js" || "$argument" == "$expected_entry" ]]
    return
  fi
  [[ "$argument" == "$expected_entry" ]]
}

managed_component_identity_matches() {
  local kind="$1" pid="$2" expected_start="${3:-}"
  local command_line process_cwd process_start expected_cwd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command_line=$(/bin/ps -p "$pid" -o command= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')
  managed_component_command_matches "$kind" "$command_line" || return 1
  process_cwd=$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null \
    | /usr/bin/awk '/^n/ { print substr($0, 2); exit }')
  expected_cwd=$(managed_component_expected_cwd "$kind") || return 1
  [[ "$process_cwd" == "$expected_cwd" ]] || return 1
  process_start=$(managed_component_process_start "$pid")
  [[ -n "$process_start" ]] || return 1
  [[ -z "$expected_start" || "$process_start" == "$expected_start" ]]
}

managed_component_captured_start() {
  case "$1" in
    scheduler-v2) printf '%s\n' "$sched_v2_process_start" ;;
    card-ask) printf '%s\n' "$card_ask_broker_process_start" ;;
    business-screen) printf '%s\n' "$bs_process_start" ;;
    business-screen-architecture) printf '%s\n' "$bs_architecture_process_start" ;;
    *) return 1 ;;
  esac
}

remember_managed_component_start() {
  local kind="$1" pid="$2" process_start
  process_start=$(managed_component_process_start "$pid")
  [[ -n "$process_start" ]] || return 1
  case "$kind" in
    scheduler-v2) sched_v2_process_start="$process_start" ;;
    card-ask) card_ask_broker_process_start="$process_start" ;;
    business-screen) bs_process_start="$process_start" ;;
    business-screen-architecture) bs_architecture_process_start="$process_start" ;;
    *) return 1 ;;
  esac
}

# Resolve exactly one listener only when it is the expected service executable
# in the expected workspace. This helper is read-only: an unproven port holder
# is reported by the caller and is never cleared automatically.
resolve_managed_port_holder() {
  local kind="$1" raw_holders="$2" normalized count pid
  normalized=$(printf '%s\n' "$raw_holders" \
    | /usr/bin/awk '/^[0-9]+$/ { if (!seen[$1]++) print $1 }')
  count=$(printf '%s\n' "$normalized" | /usr/bin/awk 'NF { count++ } END { print count + 0 }')
  [[ "$count" == "1" ]] || return 1
  pid="$normalized"
  managed_component_identity_matches "$kind" "$pid" "" || return 1
  printf '%s\n' "$pid"
}

# This helper is limited to localwatch-owned auxiliary component self-healing;
# it must never be reused to stop/restart SuperMatrix or localwatch itself.
# TERM is sent only after exact identity proof. If the process survives the
# grace period, identity is checked again before KILL so PID reuse cannot turn
# a component self-heal into a cross-session interruption.
signal_managed_component_for_restart() {
  local kind="$1" pid="$2" expected_start="$3" grace="$4" label="$5"
  if [[ -z "$expected_start" ]] \
    || ! managed_component_identity_matches "$kind" "$pid" "$expected_start"; then
    log "maintenance denied: $label pid=$pid exact managed identity is not proven; no signal sent"
    send_alert "🛑 $label 自动恢复被拒绝：PID $pid 的精确托管身份无法证明；未发送信号，请交由 codexroot。" || true
    return 1
  fi
  kill -TERM "$pid" 2>/dev/null || {
    log "maintenance denied: failed to signal exact $label pid=$pid"
    return 1
  }
  sleep "$grace"
  if kill -0 "$pid" 2>/dev/null; then
    if ! managed_component_identity_matches "$kind" "$pid" "$expected_start"; then
      log "maintenance denied: $label pid=$pid identity changed after TERM; KILL suppressed"
      send_alert "🛑 $label PID $pid 在 TERM 后身份发生变化；已拒绝 KILL，请交由 codexroot。" || true
      return 1
    fi
    kill -KILL "$pid" 2>/dev/null || return 1
  fi
  return 0
}

recover_heartbeat_managed_component() {
  local kind="$1" pid="$2" expected_start="$3" grace="$4" label="$5" start_fn="$6"
  if [[ "$pid" -ne 0 ]]; then
    signal_managed_component_for_restart \
      "$kind" "$pid" "$expected_start" "$grace" "$label" || true
  fi
  "$start_fn"
}

# ============================================================================
# Process Management — Scheduler v2 (v1 port 3500 retired 2026-08-10)
# ============================================================================

start_scheduler_v2() {
  # If PM2 is managing scheduler-v2, defer to it.
  local pm2_json=""
  if ! localwatch_is_onboarding && command -v pm2 >/dev/null 2>&1; then
    pm2_json=$(bounded "$PM2_QUERY_TIMEOUT" pm2 jlist 2>/dev/null) || pm2_json=""
  fi
  if [[ -n "$pm2_json" ]] && echo "$pm2_json" | jq -e '.[] | select(.name == "scheduler-v2" and .pm2_env.status == "online")' >/dev/null 2>&1; then
    local pm2_pid
    pm2_pid=$(echo "$pm2_json" | jq -r '.[] | select(.name == "scheduler-v2") | .pid')
    log "Scheduler v2 managed by PM2 (pid=$pm2_pid), skipping direct management"
    sched_v2_pid=0
    sched_v2_owned=false
    sched_v2_process_start=""
    return
  fi

  local port_holders
  if localwatch_is_onboarding; then
    port_holders=$(/usr/sbin/lsof -nP -iTCP:"$SCHEDULER_V2_PORT" -sTCP:LISTEN -t 2>/dev/null \
      | /usr/bin/sort -u || true)
  else
    port_holders=$(bounded "$LSOF_QUERY_TIMEOUT" lsof -nP -iTCP:"$SCHEDULER_V2_PORT" -sTCP:LISTEN -t 2>/dev/null \
      | /usr/bin/sort -u || true)
  fi
  if [[ -n "$port_holders" ]]; then
    local resp adopted_pid
    resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:$SCHEDULER_V2_PORT/health" 2>/dev/null || true)
    adopted_pid=$(resolve_managed_port_holder "scheduler-v2" "$port_holders" 2>/dev/null || true)
    if echo "$resp" | jq -e '.ok == true and .service == "scheduler-v2"' >/dev/null 2>&1 \
      && [[ -n "$adopted_pid" ]]; then
      sched_v2_pid="$adopted_pid"
      sched_v2_owned=false
      remember_managed_component_start "scheduler-v2" "$sched_v2_pid" || {
        sched_v2_pid=0
        sched_v2_process_start=""
        log "maintenance denied: Scheduler v2 process start could not be captured; refusing adoption"
        return 1
      }
      write_scheduler_pid "$sched_v2_pid"
      log "Scheduler v2 already healthy on port $SCHEDULER_V2_PORT (pid=$sched_v2_pid, pids: $port_holders), adopting existing instance"
      return
    fi

    sched_v2_pid=0
    sched_v2_owned=false
    sched_v2_process_start=""
    log "maintenance denied: Scheduler v2 port $SCHEDULER_V2_PORT has unproven listener(s): $port_holders; no signal sent"
    send_alert "🛑 Scheduler v2 端口 $SCHEDULER_V2_PORT 被未证明身份的 PID 占用：${port_holders}；LocalWatch 未发送信号，请交由 codexroot。" || true
    return 1
  fi

  if [[ ! -f "$SCHEDULER_V2_START" ]]; then
    log "WARN: Scheduler v2 launcher not found at $SCHEDULER_V2_START, skipping"
    return
  fi
  log "starting Scheduler v2 (port=$SCHEDULER_V2_PORT)"
  bash "$SCHEDULER_V2_START" >> "$LOG_DIR/scheduler-v2.stdout.log" 2>> "$LOG_DIR/scheduler-v2.stderr.log" &
  sched_v2_pid=$!
  sched_v2_owned=true
  write_scheduler_pid "$sched_v2_pid"
  remember_managed_component_start "scheduler-v2" "$sched_v2_pid" \
    || log "WARN: Scheduler v2 pid=$sched_v2_pid process start unavailable; destructive self-heal will fail closed"
  log "Scheduler v2 started (pid=$sched_v2_pid)"
}

handle_scheduler_v2_exit() {
  if [[ $sched_v2_pid -eq 0 ]]; then return; fi
  if kill -0 "$sched_v2_pid" 2>/dev/null; then return; fi

  if [[ "$sched_v2_owned" == "true" ]]; then
    wait "$sched_v2_pid" 2>/dev/null
  fi
  log "Scheduler v2 exited, restarting in 5s..."
  sched_v2_pid=0
  sched_v2_owned=false
  sched_v2_process_start=""
  sleep 5
  start_scheduler_v2
}

# ============================================================================
# Process Management — card-ask broker (larkc HTTP-only /ask + /click)
# ============================================================================

read_card_ask_broker_secret() {
  if [[ -n "${LARK_APP_SECRET:-}" ]]; then
    printf '%s' "$LARK_APP_SECRET"
    return 0
  fi
  if [[ -n "${CARD_ASK_BROKER_APP_SECRET:-}" ]]; then
    printf '%s' "$CARD_ASK_BROKER_APP_SECRET"
    return 0
  fi
  if [[ -n "$CARD_ASK_BROKER_KEYCHAIN_ACCOUNT" ]] && command -v security >/dev/null 2>&1; then
    bounded 5 security find-generic-password \
      -s "$CARD_ASK_BROKER_KEYCHAIN_SERVICE" \
      -a "$CARD_ASK_BROKER_KEYCHAIN_ACCOUNT" \
      -w 2>/dev/null || true
  fi
}

start_card_ask_broker() {
  local port_holders
  port_holders=$(bounded "$LSOF_QUERY_TIMEOUT" lsof -nP -iTCP:"$CARD_ASK_BROKER_PORT" -sTCP:LISTEN -t 2>/dev/null \
    | /usr/bin/sort -u || true)
  if [[ -n "$port_holders" ]]; then
    local resp adopted_pid
    resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:$CARD_ASK_BROKER_PORT/health" 2>/dev/null || true)
    adopted_pid=$(resolve_managed_port_holder "card-ask" "$port_holders" 2>/dev/null || true)
    if [[ "$resp" == "ok" && -n "$adopted_pid" ]]; then
      card_ask_broker_pid="$adopted_pid"
      card_ask_broker_owned=false
      remember_managed_component_start "card-ask" "$card_ask_broker_pid" || {
        card_ask_broker_pid=0
        card_ask_broker_process_start=""
        log "maintenance denied: card-ask process start could not be captured; refusing adoption"
        return 1
      }
      log "Card ask broker already healthy on port $CARD_ASK_BROKER_PORT (pid=$card_ask_broker_pid, pids: $port_holders), adopting existing instance"
      return
    fi

    card_ask_broker_pid=0
    card_ask_broker_owned=false
    card_ask_broker_process_start=""
    log "maintenance denied: card-ask port $CARD_ASK_BROKER_PORT has unproven listener(s): $port_holders; no signal sent"
    send_alert "🛑 card-ask 端口 $CARD_ASK_BROKER_PORT 被未证明身份的 PID 占用：${port_holders}；LocalWatch 未发送信号，请交由 codexroot。" || true
    return 1
  fi

  if [[ ! -f "$CARD_ASK_BROKER_START" ]]; then
    log "WARN: card-ask broker not found at $CARD_ASK_BROKER_START, skipping"
    return
  fi

  local broker_app_id="${CARD_ASK_BROKER_APP_ID:-${LARK_APP_ID:-}}"
  local broker_secret
  broker_secret="$(read_card_ask_broker_secret)"
  if [[ -z "$broker_app_id" || -z "$broker_secret" ]]; then
    log "WARN: LARK_APP_ID / LARK_APP_SECRET missing, skipping card-ask broker"
    return
  fi

  log "starting card-ask broker (port=$CARD_ASK_BROKER_PORT)"
  (
    cd "$CARD_ASK_BROKER_CWD"
    export BROKER_PORT="$CARD_ASK_BROKER_PORT"
    export LARK_APP_ID="$broker_app_id"
    export LARK_APP_SECRET="$broker_secret"
    [[ -n "${LARK_FAKE:-}" ]] && export LARK_FAKE
    [[ -n "${ASK_TIMEOUT_MS:-}" ]] && export ASK_TIMEOUT_MS
    exec node "$CARD_ASK_BROKER_START"
  ) >> "$LOG_DIR/card-ask-broker.stdout.log" 2>> "$LOG_DIR/card-ask-broker.stderr.log" &
  card_ask_broker_pid=$!
  card_ask_broker_owned=true
  remember_managed_component_start "card-ask" "$card_ask_broker_pid" \
    || log "WARN: card-ask pid=$card_ask_broker_pid process start unavailable; destructive self-heal will fail closed"
  log "card-ask broker started (pid=$card_ask_broker_pid)"
}

handle_card_ask_broker_exit() {
  if [[ $card_ask_broker_pid -eq 0 ]]; then return; fi
  if kill -0 "$card_ask_broker_pid" 2>/dev/null; then return; fi

  if [[ "$card_ask_broker_owned" == "true" ]]; then
    wait "$card_ask_broker_pid" 2>/dev/null
  fi
  log "card-ask broker exited, restarting in 5s..."
  card_ask_broker_pid=0
  card_ask_broker_owned=false
  card_ask_broker_process_start=""
  sleep 5
  start_card_ask_broker
}

# ============================================================================
# Process Management — business-screen (LAN HELLO screen, port 4322)
# ============================================================================

start_business_screen() {
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
    bs_process_start=""
    return
  fi

  if [[ ! -f "$BUSINESS_SCREEN_CWD/server.js" ]]; then
    log "WARN: business-screen server.js not found at $BUSINESS_SCREEN_CWD, skipping"
    return
  fi

  local port_holders
  port_holders=$(bounded "$LSOF_QUERY_TIMEOUT" lsof -nP -iTCP:"$BUSINESS_SCREEN_PORT" -sTCP:LISTEN -t 2>/dev/null \
    | /usr/bin/sort -u || true)
  if [[ -n "$port_holders" ]]; then
    local code adopted_pid
    code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$BUSINESS_SCREEN_PORT/" 2>/dev/null || true)
    adopted_pid=$(resolve_managed_port_holder "business-screen" "$port_holders" 2>/dev/null || true)
    if [[ "$code" == "200" && -n "$adopted_pid" ]]; then
      bs_pid="$adopted_pid"
      remember_managed_component_start "business-screen" "$bs_pid" || {
        bs_pid=0
        bs_process_start=""
        log "maintenance denied: business-screen process start could not be captured; refusing adoption"
        return 1
      }
      log "business-screen already healthy on port $BUSINESS_SCREEN_PORT (pid=$bs_pid), adopting exact instance"
      return 0
    fi
    bs_pid=0
    bs_process_start=""
    log "maintenance denied: business-screen port $BUSINESS_SCREEN_PORT has unproven listener(s): $port_holders; no signal sent"
    send_alert "🛑 business-screen 端口 $BUSINESS_SCREEN_PORT 被未证明身份的 PID 占用：${port_holders}；LocalWatch 未发送信号，请交由 codexroot。" || true
    return 1
  fi

  log "starting business-screen (port=$BUSINESS_SCREEN_PORT)"
  cd "$BUSINESS_SCREEN_CWD"
  HOST="$BUSINESS_SCREEN_HOST" PORT="$BUSINESS_SCREEN_PORT" \
    node "$BUSINESS_SCREEN_CWD/server.js" \
    >> "$LOG_DIR/business-screen.stdout.log" 2>> "$LOG_DIR/business-screen.stderr.log" &
  bs_pid=$!
  remember_managed_component_start "business-screen" "$bs_pid" \
    || log "WARN: business-screen pid=$bs_pid process start unavailable; destructive self-heal will fail closed"
  cd "$REPO_DIR"
  log "business-screen started (pid=$bs_pid)"
}

handle_business_screen_exit() {
  if [[ $bs_pid -eq 0 ]]; then return; fi
  if kill -0 "$bs_pid" 2>/dev/null; then return; fi

  wait "$bs_pid" 2>/dev/null
  log "business-screen exited, restarting in 5s..."
  bs_pid=0
  bs_process_start=""
  sleep 5
  start_business_screen
}

start_business_screen_architecture() {
  if [[ "${BUSINESS_SCREEN_ARCHITECTURE_ENABLED:-0}" == "0" ]]; then return; fi
  if [[ ! -f "$BUSINESS_SCREEN_ARCHITECTURE_START" ]]; then
    log "WARN: business-screen architecture server not found at $BUSINESS_SCREEN_ARCHITECTURE_START, skipping"
    return
  fi

  local port_holders
  port_holders=$(bounded "$LSOF_QUERY_TIMEOUT" lsof -nP -iTCP:"$BUSINESS_SCREEN_ARCHITECTURE_PORT" -sTCP:LISTEN -t 2>/dev/null \
    | /usr/bin/sort -u || true)
  if [[ -n "$port_holders" ]]; then
    local code adopted_pid
    code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$BUSINESS_SCREEN_ARCHITECTURE_PORT/" 2>/dev/null || true)
    adopted_pid=$(resolve_managed_port_holder "business-screen-architecture" "$port_holders" 2>/dev/null || true)
    if [[ "$code" == "200" && -n "$adopted_pid" ]]; then
      bs_architecture_pid="$adopted_pid"
      remember_managed_component_start "business-screen-architecture" "$bs_architecture_pid" || {
        bs_architecture_pid=0
        bs_architecture_process_start=""
        log "maintenance denied: business-screen architecture process start could not be captured; refusing adoption"
        return 1
      }
      log "business-screen architecture already healthy on port $BUSINESS_SCREEN_ARCHITECTURE_PORT (pid=$bs_architecture_pid), adopting exact instance"
      return 0
    fi
    bs_architecture_pid=0
    bs_architecture_process_start=""
    log "maintenance denied: business-screen architecture port $BUSINESS_SCREEN_ARCHITECTURE_PORT has unproven listener(s): $port_holders; no signal sent"
    send_alert "🛑 business-screen architecture 端口 $BUSINESS_SCREEN_ARCHITECTURE_PORT 被未证明身份的 PID 占用：${port_holders}；LocalWatch 未发送信号，请交由 codexroot。" || true
    return 1
  fi

  log "starting business-screen architecture (port=$BUSINESS_SCREEN_ARCHITECTURE_PORT)"
  cd "$BUSINESS_SCREEN_CWD"
  HOST="$BUSINESS_SCREEN_HOST" PORT="$BUSINESS_SCREEN_ARCHITECTURE_PORT" \
    node "$BUSINESS_SCREEN_ARCHITECTURE_START" \
    >> "$LOG_DIR/business-screen-architecture.stdout.log" 2>> "$LOG_DIR/business-screen-architecture.stderr.log" &
  bs_architecture_pid=$!
  remember_managed_component_start "business-screen-architecture" "$bs_architecture_pid" \
    || log "WARN: business-screen architecture pid=$bs_architecture_pid process start unavailable; destructive self-heal will fail closed"
  cd "$REPO_DIR"
  log "business-screen architecture started (pid=$bs_architecture_pid)"
}

handle_business_screen_architecture_exit() {
  if [[ "${BUSINESS_SCREEN_ARCHITECTURE_ENABLED:-0}" == "0" ]]; then return; fi
  if [[ $bs_architecture_pid -eq 0 ]]; then return; fi
  if kill -0 "$bs_architecture_pid" 2>/dev/null; then return; fi

  wait "$bs_architecture_pid" 2>/dev/null
  log "business-screen architecture exited, restarting in 5s..."
  bs_architecture_pid=0
  bs_architecture_process_start=""
  sleep 5
  start_business_screen_architecture
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
  # Port comes from .env.local (sourced above) — same single source bootstrap.ts
  # reads via SM_API_PORT. Hardcoding 3501 here previously crash-looped SM
  # whenever the user changed ports.
  resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:${SM_API_PORT:-3501}/api/health" 2>/dev/null)
  if [[ $? -ne 0 ]] || ! echo "$resp" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    sm_health_fails=$((sm_health_fails + 1))
    log "WARN: SuperMatrix health failed ($sm_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $sm_health_fails -eq $HEALTH_FAIL_THRESHOLD ]]; then
      send_alert "⚠️ SuperMatrix health 连续 ${sm_health_fails} 次不通；自动 reload 已按策略禁用，请交由 codexroot maintenance gate 裁决。"
      log "automatic SuperMatrix reload suppressed by policy (trigger=health-failure count=$sm_health_fails)"
    fi
  else
    sm_health_fails=0
  fi
}

check_lark_ws_health() {
  # Legacy ingress is still checked by the external-process fallback in the
  # 30-minute connectivity heartbeat. Only app-secret mode owns an in-process
  # SDK WS whose health cannot be inferred from /api/health.
  if [[ -z "${LARK_APP_SECRET:-}" || $sm_pid -eq 0 || "$sm_stopped" == "true" ]]; then
    lark_ws_health_fails=0
    return 0
  fi

  local resp rc state
  resp=$(curl --noproxy '*' -s --max-time 5 "http://127.0.0.1:${SM_API_PORT:-3501}/api/health/lark-ws" 2>/dev/null)
  rc=$?
  if [[ $rc -eq 0 ]] && echo "$resp" | jq -e '
    .status == "ok" and .ingress == "node-sdk-ws" and .state == "connected" and
    (.reconnectAttempts | type == "number" and . >= 0)
  ' >/dev/null 2>&1; then
    if [[ $lark_ws_health_fails -gt 0 ]]; then
      log "Lark SDK WS health recovered after $lark_ws_health_fails failed probe(s)"
    fi
    lark_ws_health_fails=0
    return 0
  fi

  if [[ $rc -eq 0 ]] && echo "$resp" | jq -e '
    .status == "grace" and .ingress == "node-sdk-ws" and
    (.state == "idle" or .state == "connecting" or .state == "reconnecting")
  ' >/dev/null 2>&1; then
    if [[ $lark_ws_health_fails -gt 0 ]]; then
      log "Lark SDK WS health entered bounded grace; clearing prior failure count"
    fi
    lark_ws_health_fails=0
    return 0
  fi

  state=$(printf '%s\n' "$resp" | jq -r 'if (.state | type) == "string" then .state else "unknown" end' 2>/dev/null || printf 'unknown')
  state="${state:-unknown}"
  lark_ws_health_fails=$((lark_ws_health_fails + 1))
  log "WARN: Lark SDK WS health failed ($lark_ws_health_fails/$LARK_WS_HEALTH_FAIL_THRESHOLD, state=$state)"
  if [[ $lark_ws_health_fails -lt $LARK_WS_HEALTH_FAIL_THRESHOLD ]]; then
    return 0
  fi

  if [[ $lark_ws_health_fails -eq $LARK_WS_HEALTH_FAIL_THRESHOLD ]]; then
    send_backend_api_alert "⚠️ Lark SDK WS 连续 ${lark_ws_health_fails} 次健康失败；自动 reload 已按策略禁用，请交由 codexroot maintenance gate 裁决。"
    log "automatic SuperMatrix reload suppressed by policy (trigger=lark-ws-health count=$lark_ws_health_fails state=$state)"
  fi
  return 0
}

check_sched_v2_health() {
  if [[ $sched_v2_pid -eq 0 ]]; then return; fi
  local resp
  resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:$SCHEDULER_V2_PORT/health" 2>/dev/null)
  if [[ $? -ne 0 ]] || ! echo "$resp" | jq -e '.ok == true and .service == "scheduler-v2"' >/dev/null 2>&1; then
    sched_v2_health_fails=$((sched_v2_health_fails + 1))
    log "WARN: Scheduler v2 health failed ($sched_v2_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $sched_v2_health_fails -ge $HEALTH_FAIL_THRESHOLD ]]; then
      if signal_managed_component_for_restart \
        "scheduler-v2" "$sched_v2_pid" "$sched_v2_process_start" 5 "Scheduler v2"; then
        send_alert "⚠️ Scheduler v2 health 连续 ${sched_v2_health_fails} 次不通；精确身份复核通过，已重启。"
        notify_t800_selfcheck "Scheduler v2 在 $(date '+%Y-%m-%d %H:%M:%S') 被 localwatch 重启（连续 3 次 /health 不通，精确身份已复核）"
      fi
      sched_v2_health_fails=0
    fi
  else
    sched_v2_health_fails=0
  fi
}

check_card_ask_broker_health() {
  if [[ $card_ask_broker_pid -eq 0 ]]; then return; fi
  local resp
  resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:$CARD_ASK_BROKER_PORT/health" 2>/dev/null)
  local rc=$?
  if [[ $rc -ne 0 || "$resp" != "ok" ]]; then
    card_ask_broker_health_fails=$((card_ask_broker_health_fails + 1))
    log "WARN: card-ask broker health failed ($card_ask_broker_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $card_ask_broker_health_fails -ge $HEALTH_FAIL_THRESHOLD ]]; then
      if signal_managed_component_for_restart \
        "card-ask" "$card_ask_broker_pid" "$card_ask_broker_process_start" 5 "card-ask broker"; then
        send_alert "⚠️ card-ask broker health 连续 ${card_ask_broker_health_fails} 次不通；精确身份复核通过，已重启。"
      fi
      card_ask_broker_health_fails=0
    fi
  else
    card_ask_broker_health_fails=0
  fi
}

check_bs_health() {
  if [[ $bs_pid -eq 0 ]]; then return; fi
  local code
  code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$BUSINESS_SCREEN_PORT/" 2>/dev/null)
  if [[ "$code" != "200" ]]; then
    bs_health_fails=$((bs_health_fails + 1))
    log "WARN: business-screen health failed (code=$code, $bs_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $bs_health_fails -ge $HEALTH_FAIL_THRESHOLD ]]; then
      if signal_managed_component_for_restart \
        "business-screen" "$bs_pid" "$bs_process_start" 3 "business-screen"; then
        send_alert "⚠️ business-screen (port $BUSINESS_SCREEN_PORT) 健康检查连续 ${bs_health_fails} 次不通；精确身份复核通过，已重启。"
      fi
      bs_health_fails=0
    fi
  else
    bs_health_fails=0
  fi
}

check_bs_architecture_health() {
  if [[ "${BUSINESS_SCREEN_ARCHITECTURE_ENABLED:-0}" == "0" ]]; then return; fi
  if [[ $bs_architecture_pid -eq 0 ]]; then return; fi
  local code
  code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$BUSINESS_SCREEN_ARCHITECTURE_PORT/" 2>/dev/null)
  if [[ "$code" != "200" ]]; then
    bs_architecture_health_fails=$((bs_architecture_health_fails + 1))
    log "WARN: business-screen architecture health failed (code=$code, $bs_architecture_health_fails/$HEALTH_FAIL_THRESHOLD)"
    if [[ $bs_architecture_health_fails -ge $HEALTH_FAIL_THRESHOLD ]]; then
      if signal_managed_component_for_restart \
        "business-screen-architecture" "$bs_architecture_pid" "$bs_architecture_process_start" 3 "business-screen architecture"; then
        send_alert "⚠️ business-screen architecture (port $BUSINESS_SCREEN_ARCHITECTURE_PORT) 健康检查连续 ${bs_architecture_health_fails} 次不通；精确身份复核通过，已重启。"
      fi
      bs_architecture_health_fails=0
    fi
  else
    bs_architecture_health_fails=0
  fi
}

report_supermatrix_backend_api_issue() {
  local reason=$1 source=${2:-localwatch-backend-api-repair} trigger_path=${3:-scripts/localwatch.sh:report_supermatrix_backend_api_issue}
  if [[ $sm_pid -eq 0 || "$sm_stopped" == "true" ]]; then
    log "WARN: backend API repair requested codexroot maintenance but SuperMatrix is not running: $reason"
    return 1
  fi

  log "automatic SuperMatrix reload suppressed by policy (source=$source path=$trigger_path): $reason"
  send_backend_api_alert "⚠️ ${reason}；自动 reload 已按策略禁用，请交由 codexroot maintenance gate 裁决。"
  return 0
}

check_claude_auth_on_startup() {
  local output
  output=$(bounded "$CLAUDE_AUTH_CHECK_TIMEOUT" "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/scripts/backend-api-connectivity.ts" --auth-only 2>&1)
  local rc=$?
  if [[ -n "$output" ]]; then
    log "Claude auth startup check: $output"
  fi
  if printf '%s\n' "$output" \
    | jq -e '.probes[]? | select(.backend == "claude" and .failureKind == "auth")' >/dev/null 2>&1; then
    backend_api_claude_health_fails=1
    send_backend_api_alert "⚠️ Claude Code 登录态无效（凭证缺少所需 OAuth scope 或已失效）。localwatch 不会自动 logout/login，也不会为此重启 SuperMatrix。请在交互式终端运行：claude auth login --claudeai"
  elif [[ $rc -ne 0 ]]; then
    log "WARN: Claude auth startup check failed without a confirmed auth diagnosis (rc=$rc)"
  else
    backend_api_claude_health_fails=0
  fi
  return 0
}

check_backend_api_connectivity() {
  local output
  output=$(bounded "$BACKEND_API_CHECK_TIMEOUT" "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/scripts/backend-api-connectivity.ts" --repair 2>&1)
  local rc=$?
  if [[ -n "$output" ]]; then
    log "backend API connectivity: $output"
  fi
  if printf '%s\n' "$output" | jq -e '.manualReloadRequired == true or .restartRecommended == true' >/dev/null 2>&1; then
    report_supermatrix_backend_api_issue \
      "backend API repair changed local configuration" \
      "localwatch-backend-api-repair" \
      "scripts/localwatch.sh:check_backend_api_connectivity"
  fi

  local probe_count
  probe_count=$(printf '%s\n' "$output" | jq -r '[.probes[]?] | length' 2>/dev/null || true)
  [[ "$probe_count" =~ ^[0-9]+$ ]] || probe_count=0

  backend_api_probe_state() {
    local backend=$1
    printf '%s\n' "$output" \
      | jq -r --arg backend "$backend" '[.probes[]? | select(.backend == $backend)][0] as $probe | if $probe == null then "missing" elif $probe.ok == true then "ok" else "failed" end' 2>/dev/null \
      || printf 'missing\n'
  }

  backend_api_probe_detail() {
    local backend=$1 field=$2 fallback=$3
    printf '%s\n' "$output" \
      | jq -r --arg backend "$backend" --arg field "$field" --arg fallback "$fallback" '[.probes[]? | select(.backend == $backend)][0] as $probe | if $probe == null then $fallback else ($probe[$field] // $fallback) end' 2>/dev/null \
      || printf '%s\n' "$fallback"
  }

  backend_api_update_backend_health() {
    local backend=$1 label=$2 fail_var=$3
    local state
    state=$(backend_api_probe_state "$backend")

    if [[ "$state" == "ok" ]]; then
      local existing
      eval "existing=\${$fail_var:-0}"
      if [[ $existing -gt 0 ]]; then
        log "$label backend API connectivity recovered"
      fi
      eval "$fail_var=0"
      return 0
    fi

    # A malformed wrapper failure does not prove the shared Kimi ACP is down.
    # Only the explicit HTTP probe may advance Kimi's incident counter.
    if [[ "$backend" == "kimi" && "$state" == "missing" ]]; then
      log "WARN: Kimi ACP health probe missing from backend connectivity output; not counting an unconfirmed Kimi failure"
      return 0
    fi

    if [[ "$state" == "missing" && ( $rc -eq 0 || $probe_count -gt 0 ) ]]; then
      return 0
    fi

    if [[ $rc -eq 0 ]]; then
      return 0
    fi

    local count failure_kind model
    eval "count=\${$fail_var:-0}"
    count=$((count + 1))
    eval "$fail_var=$count"
    failure_kind=$(backend_api_probe_detail "$backend" "failureKind" "unknown")
    model=$(backend_api_probe_detail "$backend" "model" "unknown")
    log "WARN: $label backend API connectivity failed ($count/$BACKEND_API_CHECK_FAIL_THRESHOLD, kind=$failure_kind, model=$model)"
    if [[ "$backend" == "claude" && "$failure_kind" == "auth" ]]; then
      if [[ $count -eq 1 ]]; then
        send_backend_api_alert "⚠️ Claude Code 登录态无效（凭证缺少所需 OAuth scope 或已失效）。localwatch 不会自动 logout/login，也不会为此重启 SuperMatrix。请在交互式终端运行：claude auth login --claudeai"
      fi
      return 0
    fi

    if [[ "$backend" == "kimi" ]]; then
      if [[ $count -lt $BACKEND_API_CHECK_FAIL_THRESHOLD ]]; then
        return 0
      fi

      if [[ $count -eq $BACKEND_API_CHECK_FAIL_THRESHOLD ]]; then
        send_backend_api_alert "⚠️ Kimi ACP 连续 ${count} 次健康失败；自动 reload 已按策略禁用，请交由 codexroot maintenance gate 裁决。"
        log "automatic SuperMatrix reload suppressed by policy (trigger=kimi-acp-health count=$count)"
      fi
      return 0
    fi

    if [[ $count -ge $BACKEND_API_CHECK_FAIL_THRESHOLD ]]; then
      send_backend_api_alert "⚠️ ${label} API 连通性连续 ${count} 次失败；localwatch 已尝试机械自修复，仍需检查认证、代理或模型权限。"
      notify_t800_selfcheck "${label} API connectivity 在 $(date '+%Y-%m-%d %H:%M:%S') 连续 ${count} 次失败；请检查 backend-api-connectivity 输出、认证/keychain、代理与模型权限。"
      eval "$fail_var=0"
    fi
  }

  backend_api_update_backend_health "claude" "Claude" backend_api_claude_health_fails
  backend_api_update_backend_health "codex" "Codex" backend_api_codex_health_fails
  backend_api_update_backend_health "kimi" "Kimi ACP" backend_api_kimi_health_fails
}

list_heartbeat_todo_watch_sessions() {
  if [[ ! -f "$HEARTBEAT_TODO_WATCH_DB" ]]; then
    return 0
  fi

  "$HEARTBEAT_PYTHON" - "$HEARTBEAT_TODO_WATCH_DB" <<'PY'
import sqlite3
import sys
from datetime import datetime, timezone

db_path = sys.argv[1]
try:
    conn = sqlite3.connect(db_path)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = conn.execute(
        """
        SELECT DISTINCT candidates.target_session
        FROM (
          SELECT target_session
          FROM action_claims
          WHERE action_type = 'todo_watch'
            AND logical_key = 'watch'
            AND status = 'claimed'
          UNION
          SELECT target_session
          FROM session_todos
          WHERE status = 'pending'
        ) AS candidates
        WHERE candidates.target_session IS NOT NULL
          AND candidates.target_session != ''
          AND NOT EXISTS (
            SELECT 1
            FROM heartbeat_pauses AS pause
            WHERE pause.session_name = candidates.target_session
              AND pause.status IN ('paused', 'permanent')
              AND (pause.expires_at IS NULL OR pause.expires_at > ?)
          )
        ORDER BY candidates.target_session
        """,
        (now,),
    ).fetchall()
except sqlite3.Error:
    rows = []
finally:
    try:
        conn.close()
    except Exception:
        pass

for (target_session,) in rows:
    print(target_session)
PY
}

heartbeat_todo_watch_pid_for_session() {
  local session=$1
  ps -eo pid=,comm=,args= 2>/dev/null \
    | awk -v session="$session" '($2 ~ /python/ || $2 ~ /Python/) && $0 ~ /heartbeat-todo-watch/ && (index($0, "--session " session) || index($0, "--session=" session)) { print $1; exit }'
}

release_heartbeat_todo_watch_claim() {
  local session=$1
  "$HEARTBEAT_PYTHON" - "$HEARTBEAT_WORKSPACE" "$HEARTBEAT_TODO_WATCH_DB" "$session" <<'PY'
from pathlib import Path
import sys

workspace = Path(sys.argv[1])
db_path = Path(sys.argv[2])
target_session = sys.argv[3]
sys.path.insert(0, str(workspace))

from heartbeat_patrol.state import HeartbeatState

HeartbeatState.open_existing(db_path).release_todo_watch(target_session)
PY
}

start_heartbeat_todo_watch() {
  local session=$1
  mkdir -p "$HEARTBEAT_TODO_WATCH_LOG_DIR"
  local log_path="$HEARTBEAT_TODO_WATCH_LOG_DIR/${session}.log"
  (
    cd "$HEARTBEAT_WORKSPACE"
    HEARTBEAT_STATE_DB="$HEARTBEAT_TODO_WATCH_DB" \
      HEARTBEAT_ENQUEUE_TRIGGER_LOG_DIR="$HEARTBEAT_TODO_WATCH_LOG_DIR" \
      "$HEARTBEAT_TODO_WATCH_SCRIPT" --session "$session"
  ) >> "$log_path" 2>&1 &
  log "heartbeat todo watcher started (session=$session pid=$!)"
}

check_heartbeat_todo_watchers() {
  if [[ "$HEARTBEAT_TODO_WATCH_ENABLED" == "0" ]]; then
    return
  fi
  if [[ ! -x "$HEARTBEAT_TODO_WATCH_SCRIPT" ]]; then
    log "WARN: heartbeat todo watcher script not executable at $HEARTBEAT_TODO_WATCH_SCRIPT, skipping"
    return
  fi

  local sessions
  sessions=$(list_heartbeat_todo_watch_sessions 2>/dev/null || true)
  if [[ -z "$sessions" ]]; then
    return
  fi

  local session pid
  while IFS= read -r session; do
    [[ -z "$session" ]] && continue
    pid=$(heartbeat_todo_watch_pid_for_session "$session" || true)
    if [[ -n "$pid" ]]; then
      continue
    fi

    log "heartbeat todo watcher missing for session=$session; restarting under localwatch"
    if ! release_heartbeat_todo_watch_claim "$session"; then
      log "WARN: failed to release heartbeat todo watcher claim for session=$session"
      continue
    fi
    start_heartbeat_todo_watch "$session"
  done <<< "$sessions"
}

has_forced_lark_subscriber() {
  ps -eo pid=,comm=,args= 2>/dev/null \
    | awk '($2 == "node" || $2 ~ /lark-cli/) && $0 ~ /lark-cli event \+subscribe/ && $0 ~ /--as bot/ && $0 ~ /--force/ { print $1 }' \
    | grep -q .
}

report_unsafe_lark_subscribers() {
  local -a victims=()
  local pid
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    victims+=("$pid")
  done < <(ps -eo pid=,comm=,args= 2>/dev/null \
    | awk '($2 == "node" || $2 ~ /lark-cli/) && $0 ~ /lark-cli event \+subscribe/ && $0 ~ /--as bot/ && $0 ~ /--force/ { print $1 }')

  if (( ${#victims[@]} == 0 )); then return; fi

  log "unsafe Lark subscriber(s) detected but not signalled: ${victims[*]}"
  send_alert "🛑 localwatch 发现 ${#victims[@]} 个 unsafe Lark subscriber：${victims[*]}。为防跨 session 误杀，本机监督只报告、不发信号；请交由 codexroot 按进程 owner 裁决。"
}

restart_launchd_label() {
  local label=$1
  local domain="gui/$(id -u)"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"

  if launchctl print "${domain}/${label}" >/dev/null 2>&1; then
    log "connectivity repair: kickstart $label"
    bounded 20 launchctl kickstart -k "${domain}/${label}" >/dev/null 2>&1 || true
    return 0
  fi

  if [[ -f "$plist" ]]; then
    log "connectivity repair: bootstrap $label"
    bounded 20 launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || true
    bounded 20 launchctl kickstart -k "${domain}/${label}" >/dev/null 2>&1 || true
    return 0
  fi

  log "WARN: connectivity repair cannot find launchd plist for $label"
  return 1
}

# Compose the heartbeat text by running seven cheap bounded probes:
#   1. localwatch/launchd   2. SuperMatrix API   3. shared Kimi ACP
#   4. Lark event subscriber 5. business-screen 6. architecture 7. autobitable
# (Scheduler v1 probe removed 2026-08-10 with v1 retirement; v2 is supervised
# separately by check_sched_v2_health.)
# Normal path stays compact ("一切正常"); abnormal path lists component names
# only — detail-free by design. Excludes web-access/cdp-proxy on purpose.
check_lark_connectivity() {
  if [[ -z "$LOCALWATCH_HEARTBEAT_GROUP" ]]; then return; fi

  local -a abnormal=()

  # 1. localwatch/launchd — heartbeat firing implies this script is alive;
  # also accept launchd label as evidence we are under supervision.
  if ! launchctl list 2>/dev/null | grep -q 'com\.LOCAL_USER\.localwatch' \
    && ! kill -0 "$$" 2>/dev/null; then
    abnormal+=("localwatch")
  fi

  # 2. SuperMatrix /api/health
  local sm_resp
  sm_resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:${SM_API_PORT:-3501}/api/health" 2>/dev/null)
  if ! echo "$sm_resp" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    report_supermatrix_backend_api_issue \
      "SuperMatrix heartbeat /api/health failed" \
      "localwatch-heartbeat-repair" \
      "scripts/localwatch.sh:check_lark_connectivity"
    sleep 5
    sm_resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:${SM_API_PORT:-3501}/api/health" 2>/dev/null)
    if ! echo "$sm_resp" | jq -e '.status == "ok"' >/dev/null 2>&1; then
      abnormal+=("SuperMatrix")
    fi
  fi

  # 3. The process-owned Kimi backend must complete its own bounded no-turn
  # session/list roundtrip. Do not run a standalone Kimi CLI here: that cannot
  # prove the shared ACP serving real sessions is healthy. Kimi remediation is
  # handled by check_backend_api_connectivity through safe reload, never PID kill.
  local kimi_acp_resp
  kimi_acp_resp=$(curl --noproxy '*' -s --max-time 15 "http://127.0.0.1:${SM_API_PORT:-3501}/api/health/kimi-acp" 2>/dev/null)
  if ! echo "$kimi_acp_resp" | jq -e '
    .status == "ok" and .backend == "kimi" and .state == "ready" and
    (.pid | type == "number" and . > 0) and
    (.roundtrip.ok == true) and
    (.roundtrip.rttMs | type == "number" and . >= 0)
  ' >/dev/null 2>&1; then
    abnormal+=("Kimi ACP")
  fi

  # 4. Lark event subscriber.
  # When LARK_APP_SECRET is set (the live dogfood path — bootstrap.ts requires it),
  # SuperMatrix runs the Feishu subscriber IN-PROCESS via the node-sdk WSClient
  # (realClient.ts startWsClient). There is NO standalone `lark-cli event
  # +subscribe` process in that mode. `check_lark_ws_health` owns the dedicated
  # lifecycle probe every three minutes; reflect only its confirmed threshold here
  # rather than pgrep'ing an external process. The external-process check only
  # applies to legacy mode (no app secret → realClient spawnOne()). A second
  # `--force` subscriber splits Feishu events server-side in ANY mode, so flag it
  # regardless.
  if has_forced_lark_subscriber; then
    report_unsafe_lark_subscribers
    if has_forced_lark_subscriber; then
      abnormal+=("Lark subscriber --force")
    fi
  elif [[ -n "${LARK_APP_SECRET:-}" ]]; then
    if [[ ${lark_ws_health_fails:-0} -ge ${LARK_WS_HEALTH_FAIL_THRESHOLD:-2} ]]; then
      abnormal+=("Lark SDK WS")
    fi
  elif [[ -z "${LARK_APP_SECRET:-}" ]] && ! pgrep -f 'lark-cli event \+subscribe.*--as bot' >/dev/null 2>&1; then
    report_supermatrix_backend_api_issue \
      "legacy Lark subscriber missing" \
      "localwatch-legacy-lark-repair" \
      "scripts/localwatch.sh:check_lark_connectivity"
    sleep 5
    if ! pgrep -f 'lark-cli event \+subscribe.*--as bot' >/dev/null 2>&1; then
      abnormal+=("Lark subscriber")
    fi
  fi

  # 5. business-screen HTTP 200
  local bs_code
  bs_code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$BUSINESS_SCREEN_PORT/" 2>/dev/null)
  if [[ "$bs_code" != "200" ]]; then
    log "connectivity repair: requesting exact-identity business-screen restart after heartbeat failure"
    recover_heartbeat_managed_component \
      "business-screen" "$bs_pid" "$bs_process_start" 3 "business-screen" start_business_screen || true
    sleep 5
    bs_code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$BUSINESS_SCREEN_PORT/" 2>/dev/null)
    if [[ "$bs_code" != "200" ]]; then
      abnormal+=("business-screen")
    fi
  fi

  # 6. business-screen architecture HTTP 200
  local architecture_code architecture_port="${BUSINESS_SCREEN_ARCHITECTURE_PORT:-4323}"
  architecture_code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$architecture_port/" 2>/dev/null)
  if [[ "${BUSINESS_SCREEN_ARCHITECTURE_ENABLED:-0}" != "0" && "$architecture_code" != "200" ]]; then
    log "connectivity repair: requesting exact-identity business-screen architecture restart after heartbeat failure"
    recover_heartbeat_managed_component \
      "business-screen-architecture" "$bs_architecture_pid" "$bs_architecture_process_start" 3 \
      "business-screen architecture" start_business_screen_architecture || true
    sleep 5
    architecture_code=$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$architecture_port/" 2>/dev/null)
    if [[ "$architecture_code" != "200" ]]; then
      abnormal+=("business-screen architecture")
    fi
  fi

  # 7. autobitable webhook — status ok AND registryLoaded true
  local ab_resp
  ab_resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:3510/health" 2>/dev/null)
  if ! echo "$ab_resp" | jq -e '.status == "ok" and .registryLoaded == true' >/dev/null 2>&1; then
    restart_launchd_label "com.supermatrix.autobitable-adapter"
    sleep 5
    ab_resp=$(curl --noproxy '*' -s --max-time 5 "http://localhost:3510/health" 2>/dev/null)
    if ! echo "$ab_resp" | jq -e '.status == "ok" and .registryLoaded == true' >/dev/null 2>&1; then
      abnormal+=("autobitable")
    fi
  fi

  # Managed desktop services are checked every 30s above. Never call an open
  # attempt a recovery here: only the helper's later all-green probe clears this
  # list, so a current app/bridge failure cannot produce "一切正常".
  if declare -F append_managed_services_heartbeat_abnormal >/dev/null 2>&1; then
    append_managed_services_heartbeat_abnormal
  fi

  local msg
  if (( ${#abnormal[@]} == 0 )); then
    if [[ $lark_connectivity_abnormal_fails -gt 0 ]]; then
      log "Lark connectivity recovered after $lark_connectivity_abnormal_fails failed heartbeat probe(s)"
    fi
    lark_connectivity_abnormal_fails=0
    msg="💓 localwatch heartbeat $(date '+%H:%M')｜一切正常"
  else
    lark_connectivity_abnormal_fails=$((lark_connectivity_abnormal_fails + 1))
    local joined
    joined=$(IFS=,; echo "${abnormal[*]}")
    if [[ $lark_connectivity_abnormal_fails -lt 2 ]]; then
      log "Lark connectivity abnormal after repair ($lark_connectivity_abnormal_fails/2): ${joined//,/, }"
      return 0
    fi
    msg="💓 localwatch heartbeat $(date '+%H:%M')｜异常：${joined//,/, }"
  fi

  if ! bounded "$LARK_CALL_TIMEOUT" "$LARK_CLI" im +messages-send --as bot --chat-id "$LOCALWATCH_HEARTBEAT_GROUP" \
    --text "$msg" 2>/dev/null; then
    log "ERROR: Lark connectivity lost"
    osascript -e 'display notification "飞书连接异常" with title "SuperMatrix Local-Watchdog"' 2>/dev/null || true
  fi
}

send_quota_status() {
  if [[ "$QUOTA_STATUS_NOTIFY_ENABLED" == "0" ]]; then return; fi
  if [[ -z "$LOCALWATCH_HEARTBEAT_GROUP" ]]; then return; fi

  local output
  output="$(
    export SM_QUOTA_STATUS_CHAT_ID="$LOCALWATCH_HEARTBEAT_GROUP"
    bounded "$QUOTA_STATUS_NOTIFY_TIMEOUT" "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/scripts/quota-status-notify.ts" 2>&1
  )"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    log "WARN: quota status notify failed rc=$rc output=${output:0:500}"
  fi
}

# Report orphan vitest workers. Root cause seen 2026-04-22: a session ran
# `npx vitest run ... | tail -80`; tail's early pipe-close SIGPIPE'd the
# vitest master, which exited without signalling its worker forks. Workers
# got reparented to launchd (ppid=1), each holding ~0.5-1.4GB RSS, and
# idled for ~6 minutes burning CPU before anyone noticed.
#
# This is a bandaid — the upstream fix is to stop piping vitest into
# head/tail/grep. See feedback_vitest_pipe_sigpipe memory. But since the
# pattern is easy to slip back into and the blast radius (GBs of RAM + CPU)
# is large, we surface candidates here. LocalWatch no longer signals them:
# ownership belongs to the originating session or an explicit codexroot action.
report_orphan_vitest() {
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

  log "orphan vitest worker(s) detected but not signalled: ${victims[*]}"
  send_alert "🛑 localwatch 发现 ${#victims[@]} 个疑似孤儿 vitest worker（ppid=1 / etime>5min）：${victims[*]}。为防跨 session 误杀，只报告、不发信号；请交由 codexroot 核对 owner。"
}

# ============================================================================
# Signal handling
# ============================================================================

# PLATFORM LIFECYCLE SAFETY / 平台生命周期红线：do not kill -9/SIGKILL,
# pkill, or launchctl stop/kickstart this process. Such signals bypass this
# permit check and can interrupt every managed session. Send the request through
# spawn2.0 target=codexroot; only the maintenance gate may authorize a restart.

localwatch_maintenance_permit_path() {
  [[ -n "${SM_DB_PATH:-}" ]] || return 1
  printf '%s\n' "$(dirname "$SM_DB_PATH")/.localwatch-maintenance-permit.json"
}

# A TERM/INT has no caller identity. Accept it only when the codexroot gate has
# just written a one-shot permit bound to this exact localwatch PID. This is a
# same-uid policy boundary (not protection against a deliberate SIGKILL).
consume_localwatch_restart_permit() {
  local permit_path raw version operation requested_at_ms target_pid target_boot_id actor now_ms age_ms current_boot_id
  permit_path="$(localwatch_maintenance_permit_path)" || return 1
  [[ -f "$permit_path" ]] || return 1
  raw=$(cat "$permit_path" 2>/dev/null || true)
  rm -f "$permit_path"

  version=$(printf '%s\n' "$raw" | jq -r '.version // empty' 2>/dev/null || true)
  operation=$(printf '%s\n' "$raw" | jq -r '.operation // empty' 2>/dev/null || true)
  requested_at_ms=$(printf '%s\n' "$raw" | jq -r '.requestedAtMs // empty' 2>/dev/null || true)
  target_pid=$(printf '%s\n' "$raw" | jq -r '.targetPid // empty' 2>/dev/null || true)
  target_boot_id=$(printf '%s\n' "$raw" | jq -r '.targetBootId // empty' 2>/dev/null || true)
  actor=$(printf '%s\n' "$raw" | jq -r '.actorSessionName // empty' 2>/dev/null || true)
  current_boot_id=$(cat "$LOCK_DIR/boot-id" 2>/dev/null || true)

  [[ "$version" == "1" ]] || return 1
  [[ "$operation" == "restart-localwatch" ]] || return 1
  [[ "$actor" == "codexroot" ]] || return 1
  [[ "$target_pid" == "$$" ]] || return 1
  [[ "$target_boot_id" == "$current_boot_id" ]] || return 1
  [[ "$current_boot_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || return 1
  [[ "$requested_at_ms" =~ ^[0-9]+$ ]] || return 1
  now_ms=$(( $(date +%s) * 1000 ))
  age_ms=$(( now_ms - requested_at_ms ))
  (( age_ms >= -60000 && age_ms <= 120000 )) || return 1
  return 0
}

cleanup() {
  if localwatch_is_onboarding; then
    trap - INT TERM
    log "onboarding localwatch shutdown; leaving process-tree cleanup to its owner"
    exit 0
  fi
  if ! consume_localwatch_restart_permit; then
    log "unauthorized INT/TERM ignored; use the codexroot maintenance gate"
    send_alert "🛑 localwatch 拒绝了未授权的 INT/TERM；如需重启，请交由 codexroot maintenance gate。" || true
    return 0
  fi

  trap - INT TERM
  log "authorized restart; leaving managed children running for successor adoption"
  exit 0
}

trap cleanup INT TERM

# ============================================================================
# Main
# ============================================================================

log "localwatch starting"
log "Scheduler v1 (port 3500) retired 2026-08-10; v2 ($SCHEDULER_V2_PORT) is the only supervised scheduler"
if ! adopt_existing_supermatrix; then
  log "startup stopped: existing process topology requires codexroot review"
  exit 1
fi

if ! localwatch_is_onboarding; then
  check_claude_auth_on_startup
fi
if [[ $sm_pid -eq 0 ]]; then
  start_supermatrix || exit 1
fi
start_scheduler_v2
if ! localwatch_is_onboarding; then
  start_card_ask_broker
  start_business_screen
  start_business_screen_architecture
  report_unsafe_lark_subscribers
  check_heartbeat_todo_watchers
  check_managed_services
  observe_platform_processes
fi

while true; do
  sleep 10
  tick=$((tick + 1))

  # Every tick (10s): check for process exits
  handle_supermatrix_exit
  handle_scheduler_v2_exit
  if ! localwatch_is_onboarding; then
    handle_card_ask_broker_exit
    handle_business_screen_exit
    handle_business_screen_architecture_exit
  fi

  # Every 30s (tick % 3): process alive check
  if (( tick % 3 == 0 )); then
    check_process_alive "supermatrix" "$sm_pid"
    check_process_alive "scheduler-v2" "$sched_v2_pid"
    if ! localwatch_is_onboarding; then
      check_process_alive "card-ask-broker" "$card_ask_broker_pid"
      check_process_alive "business-screen" "$bs_pid"
      check_process_alive "business-screen-architecture" "$bs_architecture_pid"
      check_memory_guard
      report_unsafe_lark_subscribers
      check_heartbeat_todo_watchers
      check_managed_services
      observe_platform_processes
    fi
  fi

  # Every 3min (tick % 18): API health probe
  if (( tick % 18 == 0 )); then
    check_sm_health
    check_sched_v2_health
    if ! localwatch_is_onboarding; then
      check_lark_ws_health
      check_card_ask_broker_health
      check_bs_health
      check_bs_architecture_health
    fi
  fi

  # Every 5min (tick % 30): report orphan vitest workers without signalling them.
  if (( tick % 30 == 0 )) && ! localwatch_is_onboarding; then
    report_orphan_vitest
  fi

  # Every 30min (tick % 180): Lark connectivity
  if (( tick % 180 == 0 )) && ! localwatch_is_onboarding; then
    check_backend_api_connectivity
    check_lark_connectivity
  fi

  # Every 60min (tick % 360): AI quota status to the localwatch status group
  if (( tick % 360 == 0 )) && ! localwatch_is_onboarding; then
    send_quota_status
  fi
done
