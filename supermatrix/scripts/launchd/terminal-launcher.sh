#!/bin/bash
set -u
# terminal-launcher.sh — launchd helper
#
# launchd 调用这个脚本。它通过 Terminal.app 打开 localwatch.sh，
# 确保 SM 进程跑在交互式终端 session 里（有 macOS keychain 访问权限）。
# 如果 localwatch 进程消失，本脚本退出，launchd 会重新拉起。

REPO_DIR="/Users/LOCAL_USER/SuperMatrix"
LOCALWATCH_SCRIPT="$REPO_DIR/scripts/localwatch.sh"
LOCALWATCH_PID_FILE="$REPO_DIR/logs/.localwatch.lock/pid"
LOG="/Users/LOCAL_USER/SuperMatrix/logs/terminal-launcher.log"
IDENTITY_HELPER="$REPO_DIR/scripts/lib/localwatch-identity.sh"

if [[ ! -r "$IDENTITY_HELPER" ]]; then
  echo "[terminal-launcher] missing identity helper: $IDENTITY_HELPER" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$IDENTITY_HELPER"

log() {
  echo "[terminal-launcher $(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

localwatch_running() {
  local pid command_line process_cwd process_start stored_repo stored_script stored_cwd stored_start boot_id
  pid=$(cat "$LOCALWATCH_PID_FILE" 2>/dev/null || true)
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command_line=$(/bin/ps -p "$pid" -o command= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')
  localwatch_command_matches_script "$command_line" "$LOCALWATCH_SCRIPT" || return 1
  process_cwd=$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null \
    | /usr/bin/awk '/^n/ { print substr($0, 2); exit }')
  [[ "$process_cwd" == "$REPO_DIR" ]] || return 1
  [[ "$(cat "$REPO_DIR/logs/.localwatch.lock/maintenance-gate-version" 2>/dev/null || true)" == "platform-maintenance-gate-v1" ]] || return 1
  stored_repo=$(cat "$REPO_DIR/logs/.localwatch.lock/repo-dir" 2>/dev/null || true)
  stored_script=$(cat "$REPO_DIR/logs/.localwatch.lock/script-path" 2>/dev/null || true)
  stored_cwd=$(cat "$REPO_DIR/logs/.localwatch.lock/cwd" 2>/dev/null || true)
  boot_id=$(cat "$REPO_DIR/logs/.localwatch.lock/boot-id" 2>/dev/null || true)
  [[ "$stored_repo" == "$REPO_DIR" && "$stored_script" == "$LOCALWATCH_SCRIPT" && "$stored_cwd" == "$REPO_DIR" ]] || return 1
  [[ "$boot_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || return 1
  # LC_ALL=C to match the producer (scripts/localwatch.sh:51,975) and the gate
  # (scripts/platform-maintenance-gate.sh:137); `ps -o lstart=` is localized, so an interactive
  # zh_CN shell would otherwise never match the stored identity.
  process_start=$(LC_ALL=C /bin/ps -p "$pid" -o lstart= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')
  stored_start=$(cat "$REPO_DIR/logs/.localwatch.lock/process-start" 2>/dev/null || true)
  [[ -n "$process_start" && "$process_start" == "$stored_start" ]] || return 1
  jq -e --arg repo "$REPO_DIR" --arg script "$LOCALWATCH_SCRIPT" --arg start "$process_start" --arg boot "$boot_id" \
    'type == "object" and .version == 1 and .capability == "platform-maintenance-gate-v1" and .repoDir == $repo and .scriptPath == $script and .cwd == $repo and .processStart == $start and .bootId == $boot' \
    "$REPO_DIR/logs/.localwatch.lock/provenance.json" >/dev/null 2>&1
}

# If localwatch is already running, just monitor it
if localwatch_running; then
  log "localwatch already running, entering monitor mode"
elif ! same_name_pids=$(localwatch_same_script_pids "$LOCALWATCH_SCRIPT"); then
  log "same-name localwatch process scan failed; refusing bootstrap"
  exit 1
elif [[ -n "$same_name_pids" ]]; then
  log "unproven same-name localwatch is alive; refusing bootstrap and leaving lifecycle action to manual operator"
  exit 0
else
  log "opening Terminal.app with localwatch.sh"
  osascript <<APPLESCRIPT
    tell application "Terminal"
      activate
      do script "cd -- $REPO_DIR && exec $LOCALWATCH_SCRIPT"
    end tell
APPLESCRIPT
  sleep 5
fi

# Monitor: stay alive as long as localwatch is running.
# When it dies, exit so launchd restarts us (opens a new terminal).
while localwatch_running; do
  sleep 30
done

log "localwatch process gone, exiting for launchd restart"
exit 0
