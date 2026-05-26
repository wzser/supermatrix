#!/bin/zsh
# One-shot setup: create a Feishu group "supermatrix root" and bind a
# session to the SuperMatrix repo itself so it can be iterated on via chat.
#
# This bypasses the normal /new flow (which would git-init a fresh workdir
# and scaffold it via a forward-biased transaction). Here we just create the
# group, stamp two rows into sqlite, and symlink the global session-catalog.json
# plus the three principles files into the repo root.
#
# Requires: .env.local sourced, lark-cli on PATH, python3.
#
# Idempotent-ish: if the session already exists, the script fails loudly
# rather than silently reusing it. Delete the session + group first if you
# want to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${(%):-%x}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

SESSION_NAME="${SESSION_NAME:-supermatrix-root}"
GROUP_DISPLAY_NAME="${GROUP_DISPLAY_NAME:-supermatrix root}"
LARK_CLI="${SM_LARK_CLI_PATH:-$REPO_DIR/node_modules/.bin/lark-cli}"

if [[ ! -x "$LARK_CLI" ]]; then
  echo "❌ lark-cli not found at $LARK_CLI" >&2
  exit 1
fi

if [[ ! -f "$SM_DB_PATH" ]]; then
  echo "❌ sqlite db not found at $SM_DB_PATH — start SuperMatrix once to init it, or run \`tsx src/cli/main.ts\` briefly." >&2
  exit 1
fi

existing=$(python3 - "$SM_DB_PATH" "$SESSION_NAME" <<'PY'
import sqlite3
import sys

db_path, session_name = sys.argv[1:3]
with sqlite3.connect(db_path) as conn:
    row = conn.execute(
        "SELECT id FROM sessions WHERE name = ? AND status != 'deleted' LIMIT 1",
        (session_name,),
    ).fetchone()
print(row[0] if row else "")
PY
)
if [[ -n "$existing" ]]; then
  echo "❌ session \"$SESSION_NAME\" already exists (id=$existing). Delete it first (/delete $SESSION_NAME)." >&2
  exit 1
fi

echo "[setup] creating Feishu group: $GROUP_DISPLAY_NAME"
CREATE_JSON=$(LARK_CLI_NO_PROXY=1 "$LARK_CLI" im +chat-create --as user --name "$GROUP_DISPLAY_NAME" --type private --bots "$LARK_APP_ID")
CHAT_ID=$(echo "$CREATE_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"]["chat_id"])')

if [[ -z "$CHAT_ID" ]]; then
  echo "❌ failed to parse chat_id from create response:" >&2
  echo "$CREATE_JSON" >&2
  exit 1
fi
echo "[setup] chat_id = $CHAT_ID"

SESSION_ID="sess_$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
NOW_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')

echo "[setup] inserting session + binding into $SM_DB_PATH"
python3 - "$SM_DB_PATH" "$SESSION_ID" "$SESSION_NAME" "$REPO_DIR" "$CHAT_ID" "$NOW_MS" <<'PY'
import sqlite3
import sys

db_path, session_id, session_name, repo_dir, chat_id, now_ms_raw = sys.argv[1:7]
now_ms = int(now_ms_raw)
purpose = "Iterate on SuperMatrix itself via chat"

with sqlite3.connect(db_path) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(
        """
        INSERT INTO sessions
          (id, name, scope, backend, workdir, backend_session_id, purpose, status, created_at, updated_at)
        VALUES
          (?, ?, 'user', 'claude', ?, NULL, ?, 'idle', ?, ?)
        """,
        (session_id, session_name, repo_dir, purpose, now_ms, now_ms),
    )
    conn.execute(
        "INSERT INTO bindings (group_id, session_id, created_at) VALUES (?, ?, ?)",
        (chat_id, session_id, now_ms),
    )
PY

echo "[setup] linking session-catalog.json and principles files"
WORKSPACE_ROOT="${SM_WORKSPACE_ROOT:-}"
CATALOG_PATH="${WORKSPACE_ROOT}/session-catalog.json"
PRINCIPLES_DIR="${WORKSPACE_ROOT}/first-principle/templates"

if [[ -f "$CATALOG_PATH" ]]; then
  ln -sf "$CATALOG_PATH" "$REPO_DIR/session-catalog.json"
  echo "  session-catalog.json → $CATALOG_PATH"
else
  echo "  ⚠ session-catalog.json not found at $CATALOG_PATH — symlink skipped"
fi

if [[ -d "$PRINCIPLES_DIR" ]]; then
  for f in console-principles.md coding-principles.md business-principles.md; do
    if [[ -f "$PRINCIPLES_DIR/$f" ]]; then
      ln -sf "$PRINCIPLES_DIR/$f" "$REPO_DIR/$f"
      echo "  $f → $PRINCIPLES_DIR/$f"
    fi
  done
else
  echo "  ⚠ principles templates dir not found at $PRINCIPLES_DIR — symlinks skipped"
fi

echo
echo "✓ supermatrix root session created"
echo "  chat_id:    $CHAT_ID"
echo "  session_id: $SESSION_ID"
echo "  workdir:    $REPO_DIR"
echo
echo "Next: send a prompt to the \"$GROUP_DISPLAY_NAME\" group."
