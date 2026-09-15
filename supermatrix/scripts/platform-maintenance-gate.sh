#!/bin/zsh
# Policy gate for deliberate SuperMatrix/localwatch lifecycle operations.
#
# This closes official and accidental same-uid paths; it is not an OS security
# boundary. A process running as the same macOS user can still forge environment
# values or send SIGKILL. Strong isolation belongs to a separate service identity.
#
# PLATFORM LIFECYCLE SAFETY / 平台生命周期红线：
# NEVER run kill -9/SIGKILL, pkill, or launchctl stop/kickstart directly against
# SuperMatrix or localwatch. Other sessions may still have active work. Submit
# the request through spawn2.0 target=codexroot; only codexroot may run this gate.

set -eu

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
DAILY_TASK_ID="c79b09c8-138a-4fd8-9377-ed93986b5e9f"
API_BASE="${SM_API_BASE:-http://127.0.0.1:3501}"
LOCALWATCH_IDENTITY_HELPER="$REPO_DIR/scripts/lib/localwatch-identity.sh"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[maintenance-denied] missing $ENV_FILE" >&2
  exit 2
fi

set -a
source "$ENV_FILE"
set +a
# shellcheck source=/dev/null
source "$LOCALWATCH_IDENTITY_HELPER"

DB_PATH="${SM_DB_PATH:?SM_DB_PATH not set}"
AUDIT_LOG="${SM_MAINTENANCE_AUDIT_LOG:-$(dirname "$DB_PATH")/platform-maintenance-audit.jsonl}"

operation="${1:-}"
[[ -n "$operation" ]] && shift || true
source_name=""
task_id=""
reason=""
force="false"
emergency="false"

while (( $# > 0 )); do
  case "$1" in
    --source)
      (( $# >= 2 )) || { echo "[maintenance-denied] --source needs a value" >&2; exit 2; }
      source_name="$2"
      shift 2
      ;;
    --task-id)
      (( $# >= 2 )) || { echo "[maintenance-denied] --task-id needs a value" >&2; exit 2; }
      task_id="$2"
      shift 2
      ;;
    --reason)
      (( $# >= 2 )) || { echo "[maintenance-denied] --reason needs a value" >&2; exit 2; }
      reason="$2"
      shift 2
      ;;
    --force)
      force="true"
      shift
      ;;
    --emergency)
      emergency="true"
      shift
      ;;
    *)
      echo "[maintenance-denied] unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$reason" || ${#reason} -gt 200 || "$reason" == *$'\n'* || "$reason" == *$'\r'* ]]; then
  echo "[maintenance-denied] --reason is required, single-line, and at most 200 characters" >&2
  exit 2
fi

audit() {
  local verdict="$1"
  local detail="$2"
  node -e '
    const fs = require("node:fs");
    const [path, operation, source, taskId, reason, force, emergency, verdict, detail, actor, sessionId] = process.argv.slice(1);
    fs.appendFileSync(path, JSON.stringify({
      at: new Date().toISOString(), operation, source, taskId, reason,
      force: force === "true", emergency: emergency === "true",
      verdict, detail, actor, sessionId, pid: process.ppid,
    }) + "\n", { mode: 0o600 });
  ' "$AUDIT_LOG" "$operation" "$source_name" "$task_id" "$reason" "$force" "$emergency" "$verdict" "$detail" "${owner_session:-unattested}" "${caller_session_id:-unknown}"
}

deny() {
  local detail="$1"
  audit "denied" "$detail" || true
  echo "[maintenance-denied] $detail" >&2
  exit 3
}

count_other_busy_sessions() {
  local query="SELECT COUNT(*) FROM sessions WHERE status = 'busy'"
  query+=" AND id != '$caller_session_id'"
  sqlite3 "$DB_PATH" "${query};"
}

LOCALWATCH_LOCK_DIR="$REPO_DIR/logs/.localwatch.lock"
LOCALWATCH_PID_FILE="$LOCALWATCH_LOCK_DIR/pid"
LOCALWATCH_CAPABILITY_FILE="$LOCALWATCH_LOCK_DIR/maintenance-gate-version"
LOCALWATCH_PROVENANCE_FILE="$LOCALWATCH_LOCK_DIR/provenance.json"
localwatch_identity_error=""

localwatch_identity_mismatch() {
  localwatch_identity_error="$1"
  return 1
}

localwatch_identity_matches() {
  local pid="$1" mode="$2"
  local expected_script="$REPO_DIR/scripts/localwatch.sh"
  local command_line process_cwd process_start process_epoch pid_file_epoch delta
  local capability stored_repo stored_script stored_cwd stored_start boot_id provenance

  localwatch_identity_error=""
  [[ "$pid" =~ '^[0-9]+$' ]] || { localwatch_identity_mismatch "invalid pid"; return 1; }
  kill -0 "$pid" 2>/dev/null || { localwatch_identity_mismatch "process is not alive"; return 1; }

  command_line=$(/bin/ps -p "$pid" -o command= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')
  localwatch_command_matches_script "$command_line" "$expected_script" \
    || { localwatch_identity_mismatch "command does not match"; return 1; }

  process_cwd=$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null \
    | /usr/bin/awk '/^n/ { print substr($0, 2); exit }')
  [[ "$process_cwd" == "$REPO_DIR" ]] || { localwatch_identity_mismatch "cwd does not match"; return 1; }

  process_start=$(LC_ALL=C /bin/ps -p "$pid" -o lstart= 2>/dev/null \
    | /usr/bin/awk '{$1=$1; print}')
  [[ -n "$process_start" ]] || { localwatch_identity_mismatch "process start is unavailable"; return 1; }
  process_epoch=$(LC_ALL=C /bin/date -j -f '%a %b %e %T %Y' "$process_start" '+%s' 2>/dev/null) \
    || { localwatch_identity_mismatch "process start is invalid"; return 1; }
  pid_file_epoch=$(/usr/bin/stat -f '%m' "$LOCALWATCH_PID_FILE" 2>/dev/null) \
    || { localwatch_identity_mismatch "pid file mtime is unavailable"; return 1; }
  [[ "$pid_file_epoch" =~ '^[0-9]+$' ]] || { localwatch_identity_mismatch "pid file mtime is invalid"; return 1; }
  delta=$(( pid_file_epoch - process_epoch ))
  (( delta < 0 )) && delta=$(( -delta ))
  (( delta <= 5 )) || { localwatch_identity_mismatch "pid file does not belong to this process start"; return 1; }

  capability=$(cat "$LOCALWATCH_CAPABILITY_FILE" 2>/dev/null || true)
  if [[ "$mode" == "active" || "$capability" == "platform-maintenance-gate-v1" ]]; then
    [[ "$capability" == "platform-maintenance-gate-v1" ]] \
      || { localwatch_identity_mismatch "maintenance capability is absent"; return 1; }
    stored_repo=$(cat "$LOCALWATCH_LOCK_DIR/repo-dir" 2>/dev/null || true)
    stored_script=$(cat "$LOCALWATCH_LOCK_DIR/script-path" 2>/dev/null || true)
    stored_cwd=$(cat "$LOCALWATCH_LOCK_DIR/cwd" 2>/dev/null || true)
    stored_start=$(cat "$LOCALWATCH_LOCK_DIR/process-start" 2>/dev/null || true)
    boot_id=$(cat "$LOCALWATCH_LOCK_DIR/boot-id" 2>/dev/null || true)
    provenance=$(cat "$LOCALWATCH_PROVENANCE_FILE" 2>/dev/null || true)
    [[ "$stored_repo" == "$REPO_DIR" ]] || { localwatch_identity_mismatch "stored repository does not match"; return 1; }
    [[ "$stored_script" == "$expected_script" ]] || { localwatch_identity_mismatch "stored script does not match"; return 1; }
    [[ "$stored_cwd" == "$REPO_DIR" ]] || { localwatch_identity_mismatch "stored cwd does not match"; return 1; }
    [[ "$stored_start" == "$process_start" ]] || { localwatch_identity_mismatch "stored process start does not match"; return 1; }
    [[ "$boot_id" =~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' ]] \
      || { localwatch_identity_mismatch "boot id is invalid"; return 1; }
    node -e '
      const value = JSON.parse(process.argv[1]);
      const [repo, script, cwd, start, boot] = process.argv.slice(2);
      if (value?.version !== 1 || value?.capability !== "platform-maintenance-gate-v1" ||
          value.repoDir !== repo || value.scriptPath !== script || value.cwd !== cwd ||
          value.processStart !== start || value.bootId !== boot) process.exit(2);
    ' "$provenance" "$REPO_DIR" "$expected_script" "$REPO_DIR" "$process_start" "$boot_id" \
      || { localwatch_identity_mismatch "lock provenance manifest is invalid"; return 1; }
  fi
  return 0
}

assert_localwatch_identity() {
  local pid="$1" mode="$2"
  localwatch_identity_matches "$pid" "$mode" \
    || deny "pid $pid does not match the exact localwatch identity for this repository: $localwatch_identity_error"
}

validate_scheduled_daily_policy() {
  [[ "$source_name" == "scheduled-daily" ]] || deny "operation requires the scheduled-daily source"
  [[ "$task_id" == "$DAILY_TASK_ID" ]] || deny "scheduled task id is not the approved daily-reload task"
  [[ "$force" == "false" && "$emergency" == "false" ]] || deny "scheduled-daily never permits force or emergency"
  local now_hhmm now_number
  now_hhmm="$(date +%H%M)"
  [[ "$now_hhmm" =~ '^[0-9]{4}$' ]] || deny "could not resolve the local maintenance time"
  now_number=$(( 10#$now_hhmm ))
  if (( now_number < 345 || now_number > 410 )); then
    deny "scheduled-daily is outside the 03:45-04:10 maintenance window"
  fi

  # The task id on argv is only a claim. Bind it to the durable spawn record
  # created by scheduler-v2: this exact caller child must come from scheduler,
  # target codexroot, remain in-flight, and carry SuperMatrix's normalized
  # scheduler:<task-id>:<run-id> origin. A manual codexroot run at 03:50 cannot
  # manufacture this row through the public command surface.
  local scheduler_origin_count
  scheduler_origin_count=$(sqlite3 "$DB_PATH" "
    SELECT COUNT(*)
      FROM cross_session_log c
      JOIN sessions f ON f.id = c.from_session_id
      JOIN sessions t ON t.id = c.to_session_id
     WHERE c.child_session_id = '$caller_session_id'
       AND c.status = 'pending'
       AND f.name = 'scheduler'
       AND t.name = 'codexroot'
       AND c.origin_run_id GLOB 'scheduler:${DAILY_TASK_ID}:?*';
  ") || deny "could not verify the scheduled-daily spawn origin"
  [[ "$scheduler_origin_count" == "1" ]] \
    || deny "scheduled-daily caller is not the child spawned by the approved scheduler task"
}

verify_supermatrix_health() {
  local health_json
  health_json=$(curl --noproxy '*' -fsS "$API_BASE/api/health") || deny "SuperMatrix health readback failed after localwatch restart"
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (value?.status !== "ok") process.exit(2);
  ' "$health_json" || deny "SuperMatrix health readback was not ok after localwatch restart"
}

activate_localwatch_gate() {
  validate_scheduled_daily_policy

  local old_pid
  old_pid=$(cat "$LOCALWATCH_PID_FILE" 2>/dev/null || true)
  [[ "$old_pid" =~ '^[0-9]+$' ]] || deny "localwatch pid could not be resolved from its lock"

  # Confirming an already-active gate is read-only and must not be blocked by a
  # short-lived business run. The busy guard remains mandatory below for the
  # legacy migration path, which could require a lifecycle operation.
  if [[ "$(cat "$LOCALWATCH_CAPABILITY_FILE" 2>/dev/null || true)" == "platform-maintenance-gate-v1" ]]; then
    assert_localwatch_identity "$old_pid" "active"
    audit "completed" "localwatch permit protocol already active at pid=$old_pid"
    echo "[localwatch-gate-active] pid=$old_pid"
    return 0
  fi

  local busy_count
  busy_count=$(count_other_busy_sessions) || deny "could not read the busy-session gate"
  [[ "$busy_count" == "0" ]] || deny "localwatch gate activation refused: $busy_count other session(s) are busy"

  local same_name_pids
  if ! same_name_pids=$(localwatch_same_script_pids "$REPO_DIR/scripts/localwatch.sh"); then
    deny "same-name localwatch process scan failed; no lifecycle action taken"
  fi
  if ! kill -0 "$old_pid" 2>/dev/null; then
    if [[ -n "$same_name_pids" ]]; then
      deny "stale localwatch lock pid=$old_pid with live same-name process pid(s)=$same_name_pids; identity cannot be proven, manual restart required"
    fi
    deny "stale localwatch lock pid=$old_pid has no live proven owner; manual bootstrap required"
  fi

  if localwatch_identity_matches "$old_pid" "legacy-or-active"; then
    deny "legacy localwatch pid=$old_pid has no maintenance capability; automatic lifecycle migration is disabled, manual restart required"
  fi
  deny "legacy localwatch identity is not proven: $localwatch_identity_error; no lifecycle action taken"
}

restart_localwatch() {
  [[ -z "$source_name" && -z "$task_id" && "$force" == "false" && "$emergency" == "false" ]] \
    || deny "restart-localwatch does not accept reload source, task id, force, or emergency"

  local busy_count
  busy_count=$(count_other_busy_sessions) || deny "could not read the busy-session gate"
  [[ "$busy_count" == "0" ]] || deny "restart-localwatch refused: $busy_count other session(s) are busy"

  local old_pid old_boot_id
  [[ "$(cat "$LOCALWATCH_CAPABILITY_FILE" 2>/dev/null || true)" == "platform-maintenance-gate-v1" ]] \
    || deny "live localwatch has not activated the maintenance permit protocol"
  old_pid=$(cat "$LOCALWATCH_PID_FILE" 2>/dev/null || true)
  [[ "$old_pid" =~ '^[0-9]+$' ]] || deny "localwatch pid could not be resolved from its lock"
  assert_localwatch_identity "$old_pid" "active"
  old_boot_id=$(cat "$LOCALWATCH_LOCK_DIR/boot-id" 2>/dev/null || true)

  local permit_path="$(dirname "$DB_PATH")/.localwatch-maintenance-permit.json"
  local permit_tmp="${permit_path}.tmp.$$"
  node -e '
    const fs = require("node:fs");
    const [target, operation, targetPid, targetBootId, actorSessionName, callerSessionId, reason] = process.argv.slice(1);
    fs.writeFileSync(target, JSON.stringify({
      version: 1,
      operation,
      requestedAtMs: Date.now(),
      requesterPid: process.ppid,
      targetPid: Number(targetPid),
      targetBootId,
      actorSessionName,
      callerSessionId,
      reason,
    }) + "\n", { mode: 0o600 });
  ' "$permit_tmp" "restart-localwatch" "$old_pid" "$old_boot_id" "$owner_session" "$caller_session_id" "$reason" \
    || deny "could not write the localwatch restart permit"
  mv -f "$permit_tmp" "$permit_path" || deny "could not publish the localwatch restart permit"

  audit "allowed" "policy checks passed; old localwatch pid=$old_pid"
  echo "[maintenance-allowed] operation=restart-localwatch actor=$owner_session old_pid=$old_pid"
  if ! localwatch_identity_matches "$old_pid" "active"; then
    rm -f "$permit_path"
    deny "localwatch identity changed before signal: $localwatch_identity_error"
  fi
  if [[ "$(cat "$LOCALWATCH_LOCK_DIR/boot-id" 2>/dev/null || true)" != "$old_boot_id" ]]; then
    rm -f "$permit_path"
    deny "localwatch boot identity changed before signal"
  fi
  if ! /bin/kill -TERM "$old_pid" 2>/dev/null; then
    rm -f "$permit_path"
    deny "failed to signal the exact localwatch pid $old_pid"
  fi

  local new_pid=""
  local attempt
  for attempt in {1..450}; do
    sleep 0.2
    new_pid=$(cat "$LOCALWATCH_PID_FILE" 2>/dev/null || true)
    if [[ "$new_pid" =~ '^[0-9]+$' && "$new_pid" != "$old_pid" ]] \
      && localwatch_identity_matches "$new_pid" "active"; then
      break
    fi
    new_pid=""
  done
  [[ -n "$new_pid" ]] || deny "localwatch replacement was not observed within 90 seconds"
  [[ ! -f "$permit_path" ]] || deny "localwatch did not consume its one-shot restart permit"

  verify_supermatrix_health

  audit "completed" "localwatch pid $old_pid -> $new_pid; SuperMatrix health ok"
  echo "[localwatch-restarted] old_pid=$old_pid new_pid=$new_pid health=ok"
}

caller_token="${SM_CALLER_ATTESTATION:-}"
if [[ ! "$caller_token" =~ '^smca_[A-Za-z0-9_-]+$' ]]; then
  deny "missing or malformed caller attestation"
fi

identity_json=$(curl --noproxy '*' -fsS \
  -X POST "$API_BASE/api/caller-identity" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"token\":\"$caller_token\"}") || deny "caller identity could not be resolved"

identity_fields=$(node -e '
  const value = JSON.parse(process.argv[1]);
  if (value?.ok !== true || value?.attested !== true) process.exit(2);
  process.stdout.write(`${value.ownerSessionName ?? ""}\t${value.sessionId ?? ""}`);
' "$identity_json") || deny "caller identity response was invalid"

owner_session="${identity_fields%%$'\t'*}"
caller_session_id="${identity_fields#*$'\t'}"
if [[ "$owner_session" != "codexroot" ]]; then
  deny "only codexroot may perform platform maintenance"
fi
if [[ ! "$caller_session_id" =~ '^[A-Za-z0-9_-]+$' ]]; then
  deny "resolved caller session id is invalid"
fi

case "$operation" in
  reload-supermatrix)
    case "$source_name" in
      scheduled-daily)
        validate_scheduled_daily_policy
        ;;
      codexroot-maintenance)
        [[ -z "$task_id" ]] || deny "manual codexroot maintenance must not claim a scheduler task id"
        if [[ "$force" == "true" && "$emergency" != "true" ]]; then
          deny "codexroot force requires --emergency and an incident-specific reason"
        fi
        if [[ "$force" != "true" && "$emergency" == "true" ]]; then
          deny "--emergency is only valid together with --force"
        fi
        ;;
      *)
        deny "reload source is not approved"
        ;;
    esac
    ;;
  restart-localwatch)
    restart_localwatch
    exit 0
    ;;
  activate-localwatch-gate)
    activate_localwatch_gate
    exit 0
    ;;
  stop-localwatch)
    deny "routine stop-localwatch is never permitted"
    ;;
  *)
    deny "unknown maintenance operation"
    ;;
esac

audit "allowed" "policy checks passed"
echo "[maintenance-allowed] operation=$operation source=$source_name actor=$owner_session"

export SM_MAINTENANCE_GATE_APPROVAL="platform-maintenance-gate-v1"
export SM_MAINTENANCE_CALLER_SESSION_ID="$caller_session_id"
export SM_CALLER_ATTESTATION="$caller_token"
export SM_RELOAD_SOURCE="$source_name"
export SM_MAINTENANCE_FORCE="$force"

set +e
"$SCRIPT_DIR/safe-reload.sh"
result=$?
set -e
audit "completed" "executor exit=$result"
exit "$result"
