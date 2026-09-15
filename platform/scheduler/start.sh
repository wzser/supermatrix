#!/usr/bin/env bash
# Durable launcher for scheduler-v2 (port 3502).
# dist/ and node_modules/ are gitignored, so a fresh checkout has neither.
# This wrapper makes them on demand, then execs the service — giving any
# supervisor (localwatch.sh) one stable command that survives a clean tree.
set -euo pipefail
cd "$(dirname "$0")"

# The caller may provide a local, untracked environment file. Do not bake a
# maintainer path or credentials into this launcher.
ENV_FILE="${SM_ENV_FILE:-}"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

[ -d node_modules ] || npm ci
[ -f dist/main.js ] || npm run build

exec node dist/main.js
