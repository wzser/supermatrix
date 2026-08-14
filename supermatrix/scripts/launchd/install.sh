#!/bin/zsh
# Install the SuperMatrix localwatch launchd agent.
# Idempotent: unloads any prior version, renders the plist template, loads it.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${(%):-%x}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ROOT="$(cd -- "$REPO_DIR/.." && pwd)"
LABEL="com.supermatrix.localwatch"
PLIST_SOURCE="$SCRIPT_DIR/${LABEL}.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/${LABEL}.plist"
LAUNCH_SCRIPT="$SCRIPT_DIR/terminal-launcher.sh"
ENV_FILE="${SM_ENV_FILE:-$PROJECT_ROOT/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — run npm run init from $REPO_DIR first." >&2
  exit 1
fi

mkdir -p "$REPO_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"
chmod +x "$LAUNCH_SCRIPT"
chmod +x "$REPO_DIR/scripts/localwatch.sh"

escape_sed() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

# Unload any existing instance (ignored if not loaded).
if launchctl list | grep -q "$LABEL"; then
  echo "[install] unloading existing $LABEL..."
  launchctl unload "$PLIST_TARGET" 2>/dev/null || true
fi

echo "[install] rendering plist -> $PLIST_TARGET"
sed \
  -e "s#__TERMINAL_LAUNCHER__#$(escape_sed "$LAUNCH_SCRIPT")#g" \
  -e "s#__LOG_DIR__#$(escape_sed "$REPO_DIR/logs")#g" \
  -e "s#__HOME__#$(escape_sed "$HOME")#g" \
  "$PLIST_SOURCE" > "$PLIST_TARGET"

echo "[install] loading launchd agent..."
launchctl load "$PLIST_TARGET"

sleep 1
if launchctl list | grep -q "$LABEL"; then
  echo "SuperMatrix localwatch launchd agent installed and loaded."
  echo "  Logs: $REPO_DIR/logs/localwatch.log and terminal-launcher.{stdout,stderr}.log"
  echo "  Uninstall: $SCRIPT_DIR/uninstall.sh"
else
  echo "install failed — agent not in launchctl list. Check $REPO_DIR/logs/terminal-launcher.stderr.log" >&2
  exit 1
fi
