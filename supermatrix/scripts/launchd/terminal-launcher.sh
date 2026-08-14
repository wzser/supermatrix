#!/bin/bash
set -u
# terminal-launcher.sh — launchd helper
#
# launchd 调用这个脚本。它通过 Terminal.app 打开 localwatch.sh，
# 确保 SM 进程跑在交互式终端 session 里（有 macOS keychain 访问权限）。
# 如果 localwatch 进程消失，本脚本退出，launchd 会重新拉起。

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
WATCHDOG_SCRIPT="$REPO_DIR/scripts/localwatch.sh"
LOG_DIR="$REPO_DIR/logs"
LOG="$LOG_DIR/terminal-launcher.log"
mkdir -p "$LOG_DIR"

log() {
  echo "[terminal-launcher $(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

# If localwatch is already running, just monitor it
if pgrep -f 'localwatch\.sh' > /dev/null 2>&1; then
  log "localwatch already running, entering monitor mode"
else
  log "opening Terminal.app with localwatch.sh"
  osascript <<APPLESCRIPT
    set watchdogScript to "$WATCHDOG_SCRIPT"
    tell application "Terminal"
      activate
      do script quoted form of watchdogScript
    end tell
APPLESCRIPT
  sleep 5
fi

# Monitor: stay alive as long as localwatch is running.
# When it dies, exit so launchd restarts us (opens a new terminal).
while pgrep -f 'localwatch\.sh' > /dev/null 2>&1; do
  sleep 30
done

log "localwatch process gone, exiting for launchd restart"
exit 0
