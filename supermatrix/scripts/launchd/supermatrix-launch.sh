#!/bin/zsh
# Legacy direct launch script for SuperMatrix, invoked by launchd.
# The default public setup uses terminal-launcher.sh -> localwatch.sh so Claude
# Code can read the macOS login keychain from an interactive Terminal session.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${(%):-%x}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ROOT="$(cd -- "$REPO_DIR/.." && pwd)"
ENV_FILE="${SM_ENV_FILE:-$PROJECT_ROOT/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[supermatrix-launch] missing env file: $ENV_FILE" >&2
  echo "[supermatrix-launch] run npm run init from $REPO_DIR first" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

for required_var in SM_ROOT_GROUP_ID SM_ROOT_USER_ID SM_WORKSPACE_ROOT SM_DB_PATH LARK_APP_ID; do
  if [[ -z "${(P)required_var:-}" ]]; then
    echo "[supermatrix-launch] missing required env var: $required_var" >&2
    exit 1
  fi
done

mkdir -p "$SM_WORKSPACE_ROOT"
mkdir -p "$(dirname "$SM_DB_PATH")"
mkdir -p "$REPO_DIR/logs"

exec "$REPO_DIR/scripts/localwatch.sh"
