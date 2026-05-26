#!/bin/zsh
# Uninstall the SuperMatrix console launchd agent.

set -euo pipefail

LABEL="com.supermatrix.localwatch"
PLIST_TARGET="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -f "$PLIST_TARGET" ]]; then
  echo "[uninstall] no plist at $PLIST_TARGET — nothing to do."
  exit 0
fi

echo "[uninstall] unloading launchd agent..."
launchctl unload "$PLIST_TARGET" 2>/dev/null || true

echo "[uninstall] removing plist..."
rm -f "$PLIST_TARGET"

# Note: stray lark-cli subscribers are cleaned up by the process itself
# on graceful stop. No broad pkill needed (risks killing unrelated processes).

echo "SuperMatrix localwatch launchd agent uninstalled."
