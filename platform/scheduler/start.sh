#!/usr/bin/env bash
# Durable launcher for scheduler-v2 (port 3502).
# dist/ and node_modules/ are gitignored, so a fresh checkout has neither.
# This wrapper makes them on demand, then execs the service — giving any
# supervisor (localwatch.sh) one stable command that survives a clean tree.
set -euo pipefail
cd "$(dirname "$0")"

# Secrets/config (Feishu base token, v2 table id, ...) live in the gitignored
# canonical env file, not in this committed launcher. Source it so the service
# has its env no matter who starts us (localwatch, launchd, or a bare shell).
ENV_FILE="/Users/LOCAL_USER/SuperMatrix/.env.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

[ -d node_modules ] || npm install
[ -f dist/main.js ] || npm run build

exec node dist/main.js
