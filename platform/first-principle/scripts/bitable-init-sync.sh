#!/usr/bin/env bash
# Push session metadata (alias / Purpose / 分类 / 头像) to the Feishu Bitable
# session table. Called by new sessions during init step 8 — see the
# "bitable_metadata_sync" instruction emitted by bin/fp-generate-init.
#
# Idempotent. Safe to rerun on already-synced sessions.
set -euo pipefail

BASE_TOKEN="${FP_SESSION_BASE_TOKEN:-FP_SESSION_BASE_TOKEN}"
TABLE_ID="${FP_SESSION_TABLE_ID:-FP_SESSION_TABLE_ID}"

SESSION_NAME=""
ALIAS=""
PURPOSE=""
CATEGORY=""
AVATAR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-name) SESSION_NAME="${2:-}"; shift 2 ;;
    --alias)        ALIAS="${2:-}"; shift 2 ;;
    --purpose)      PURPOSE="${2:-}"; shift 2 ;;
    --category)     CATEGORY="${2:-}"; shift 2 ;;
    --avatar)       AVATAR="${2:-}"; shift 2 ;;
    *) echo "[bitable-init-sync] unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SESSION_NAME" || -z "$ALIAS" || -z "$PURPOSE" || -z "$CATEGORY" ]]; then
  echo "[bitable-init-sync] missing required args (--session-name --alias --purpose --category)" >&2
  exit 1
fi

export SESSION_NAME ALIAS PURPOSE CATEGORY AVATAR BASE_TOKEN TABLE_ID

# 1. Ensure only this session's Bitable record exists, then push init metadata.
#    Do not call sync-session-table.sh here: the full-table sync also touches
#    unrelated rows, group names, and group avatars, so any historical bad row or
#    hung Feishu API call can make a new session init report a soft failure.
RID=$(python3 - <<'PY'
import json
import os
import subprocess
import sys

base_token = os.environ["BASE_TOKEN"]
table_id = os.environ["TABLE_ID"]
session_name = os.environ["SESSION_NAME"]
payload = {
    "Session": session_name,
    "别称": os.environ["ALIAS"],
    "Purpose": os.environ["PURPOSE"],
    "分类": os.environ["CATEGORY"],
    "FP管辖": True,
    "Daily Commit": True,
}


def run_lark(args, *, json_payload=None, timeout=45):
    cmd = ["lark-cli", *args]
    if json_payload is not None:
        cmd += ["--json", json.dumps(json_payload, ensure_ascii=False)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"[bitable-init-sync] lark-cli timed out after {timeout}s: {' '.join(cmd[:4])} ...", file=sys.stderr)
        raise SystemExit(1)
    if res.returncode != 0:
        print(f"[bitable-init-sync] lark-cli failed rc={res.returncode}: {' '.join(cmd[:4])} ...", file=sys.stderr)
        print(f"  stdout: {res.stdout[:600]}", file=sys.stderr)
        print(f"  stderr: {res.stderr[:600]}", file=sys.stderr)
        raise SystemExit(1)
    return res.stdout


def parse_json(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        print(f"[bitable-init-sync] lark-cli response is not JSON: {text[:600]}", file=sys.stderr)
        raise SystemExit(1)


print(f"[bitable-init-sync] finding Bitable row for {session_name} ...", file=sys.stderr)
resp = parse_json(run_lark([
    "base", "+record-list",
    "--base-token", base_token,
    "--table-id", table_id,
    "--format", "json",
    "--limit", "500",
    "--field-id", "Session",
]))
data = resp.get("data") or {}
fields = data.get("fields") or []
rids = data.get("record_id_list") or []
rows = data.get("data") or []
rid = ""
if "Session" in fields:
    si = fields.index("Session")
    for i, row in enumerate(rows):
        if row[si] == session_name:
            rid = rids[i]
            break

args = ["base", "+record-upsert", "--base-token", base_token, "--table-id", table_id]
if rid:
    args += ["--record-id", rid]
    print(f"[bitable-init-sync] pushing metadata -> record {rid} ...", file=sys.stderr)
else:
    print(f"[bitable-init-sync] creating Bitable row for {session_name} ...", file=sys.stderr)

upsert_resp = parse_json(run_lark(args, json_payload=payload))
if not rid:
    upsert_data = upsert_resp.get("data") or {}
    rec = upsert_data.get("record") or {}
    # On the create branch (no --record-id) lark-cli returns the new id under
    # record.record_id_list, NOT record.record_id — keep both as fallbacks.
    rid = (rec.get("record_id")
           or (rec.get("record_id_list") or [None])[0]
           or upsert_data.get("record_id")
           or (upsert_data.get("record_id_list") or [None])[0]
           or "")
if not rid:
    print(f"[bitable-init-sync] cannot determine Bitable record_id for {session_name}", file=sys.stderr)
    raise SystemExit(1)
print(rid)
PY
)
export RID

# 4. Upload avatar (HIGH-1 contract 2026-05-06): accepts local file path OR URL OR
#    base64 data URI. Emoji-form avatars are explicitly REJECTED — Bitable's 头像
#    column must hold a real image so sync-session-table.sh can push to the Feishu
#    group avatar (which can't be an emoji). Avatar materialization happens here so
#    new sessions don't need their own download/decode logic.
#
#    Note: sessions.avatar (SQLite) MUST NOT be written by callers — only by
#    sync-session-table.sh after pulling the file_token from Bitable. See
#    rules/session-meta-fields.md and templates/{claude,agents}-md-base.md step 7.
#
#    Idempotency: skip when an attachment with the same filename is already on the
#    row (Feishu attachment fields are server-side append-only).
if [[ -n "$AVATAR" ]]; then
  AV_LOCAL=""
  AV_TMP=""

  case "$AVATAR" in
    emoji:*|🟢*|🔴*|🟡*|🔵*|🟠*|🟣*|⚪*|⚫*|🟤*|❓*|❗*|🌟*|💡*|📈*|📊*|🕵*|🤖*|🧠*|🎨*|🎵*|🎯*|💻*|🛠*|🪛*|🔧*|🔍*|📚*|🗂*|📋*|📌*|📁*|📄*|📃*|📑*|🗃*|🗄*|🗒*|🧪*|🧬*|🪙*|💰*|💵*|💸*|💳*|🏦*|📦*|🛒*|🛍*|🎁*|🚚*|🚀*|🛰*|🛸*|⚙*|🔩*|🪪*|🧾*|📜*|🖼*|🖥*|⌨*|🖱*|💾*|💿*|📀*|🧮*|📡*|📞*|📨*|📩*|📬*|📭*|📮*|✉*)
      echo "[bitable-init-sync] REJECT emoji-form avatar '$AVATAR' — Bitable + Feishu group avatar require a real image. Provide a local file path, an HTTPS URL, or a base64 data URI." >&2
      exit 1
      ;;
    https://*|http://*)
      AV_TMP="$(mktemp -t fp-avatar-XXXXXX.bin)"
      echo "[bitable-init-sync] downloading URL → $AV_TMP ..."
      if ! curl -sSL --max-time 30 -o "$AV_TMP" "$AVATAR"; then
        echo "[bitable-init-sync] curl failed for $AVATAR" >&2
        rm -f "$AV_TMP"; exit 1
      fi
      AV_LOCAL="$AV_TMP"
      ;;
    data:image/*\;base64,*)
      AV_TMP="$(mktemp -t fp-avatar-XXXXXX.bin)"
      export AV_TMP
      echo "[bitable-init-sync] decoding base64 data URI → $AV_TMP ..."
      python3 -c "
import base64, os
src = os.environ['AVATAR']
data = src.split(',', 1)[1]
open(os.environ['AV_TMP'], 'wb').write(base64.b64decode(data))
" || { echo "[bitable-init-sync] base64 decode failed" >&2; rm -f "$AV_TMP"; exit 1; }
      AV_LOCAL="$AV_TMP"
      ;;
    /*|./*|../*)
      [[ -f "$AVATAR" ]] || { echo "[bitable-init-sync] avatar file not found: $AVATAR" >&2; exit 1; }
      AV_LOCAL="$AVATAR"
      ;;
    *)
      echo "[bitable-init-sync] unknown avatar form '$AVATAR' — must be local file path, https?:// URL, or data:image base64 data URI." >&2
      exit 1
      ;;
  esac

  # Pick a stable filename for idempotency (use session name + extension inferred from content).
  EXT=$(python3 -c "
import sys
sig = open(sys.argv[1], 'rb').read(16)
if sig.startswith(b'\\x89PNG'):
    print('png')
elif sig.startswith(b'\\xff\\xd8\\xff'):
    print('jpg')
elif sig.startswith(b'GIF87a') or sig.startswith(b'GIF89a'):
    print('gif')
elif sig.startswith(b'RIFF') and sig[8:12] == b'WEBP':
    print('webp')
else:
    print('bin')
" "$AV_LOCAL")
  export AV_NAME="${SESSION_NAME}.${EXT}"

  HAS=$(lark-cli base +record-list \
          --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" \
          --format json \
          --limit 500 --field-id Session --field-id 头像 2>/dev/null | \
        python3 -c '
import json, sys, os
d = json.load(sys.stdin).get("data", {})
fields = d.get("fields", []); rows = d.get("data", [])
if "Session" not in fields or "头像" not in fields: sys.exit(0)
si = fields.index("Session"); ai = fields.index("头像")
target = os.environ["SESSION_NAME"]; want = os.environ["AV_NAME"]
for r in rows:
    if r[si] == target:
        for a in (r[ai] or []):
            if a.get("name") == want:
                print("1"); sys.exit(0)
        break
')

  if [[ "$HAS" != "1" ]]; then
    echo "[bitable-init-sync] uploading avatar $AV_NAME → record $RID ..."
    UP_DIR="$(dirname "$AV_LOCAL")"
    UP_BASE="$(basename "$AV_LOCAL")"
    # Rename in place to AV_NAME for stable idempotency name on Bitable
    if [[ "$UP_BASE" != "$AV_NAME" ]]; then
      cp "$AV_LOCAL" "$UP_DIR/$AV_NAME"
      UP_BASE="$AV_NAME"
    fi
    cd "$UP_DIR"
    lark-cli base +record-upload-attachment \
      --as user \
      --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" \
      --record-id "$RID" \
      --field-id 头像 \
      --file "$UP_BASE" >/dev/null
    [[ -n "$AV_TMP" ]] && rm -f "$AV_TMP" "$UP_DIR/$AV_NAME" 2>/dev/null || true
  else
    echo "[bitable-init-sync] avatar $AV_NAME already on record; skip"
    [[ -n "$AV_TMP" ]] && rm -f "$AV_TMP"
  fi
fi

echo "[bitable-init-sync] done for $SESSION_NAME"
