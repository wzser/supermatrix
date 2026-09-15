#!/usr/bin/env bash
# One-shot session metadata seed using the existing wendangwang queue.
#
# This is the public, parameterized form of the existing FP init consumer.  It
# owns no database and never performs a direct Bitable write.  It creates at
# most one row through bitable_rows_create_if_absent, then performs an
# independent read-back.  Existing rows are a verified skip: every remote
# field is treated as human/system authority and is preserved.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FP_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd -P)"
CONFIG="${SESSION_META_CONFIG:-}"
IDENTITY=""
FIXTURE=""

usage() {
  echo "usage: $0 --config /abs/config.json --identity-json /abs/identity.json [--fixture /abs/remote.json]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="${2:-}"; shift 2 ;;
    --identity-json) IDENTITY="${2:-}"; shift 2 ;;
    --fixture) FIXTURE="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$CONFIG" && -f "$CONFIG" ]] || { echo "missing --config; public defaults are fail-closed" >&2; exit 64; }
[[ -n "$IDENTITY" && -f "$IDENTITY" ]] || { echo "missing --identity-json" >&2; exit 64; }
[[ -z "$FIXTURE" || -f "$FIXTURE" ]] || { echo "fixture not found: $FIXTURE" >&2; exit 64; }

PYTHON_BIN="${FP_PYTHON:-}"
[[ -x "$PYTHON_BIN" ]] || { echo "FP_PYTHON must name an executable Python 3.11" >&2; exit 64; }
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)' || {
  echo "FP_PYTHON must be Python 3.11" >&2; exit 64;
}

ASSET_ID=""; BASE_TOKEN=""; TABLE_ID=""; FROM_SESSION=""; ENQUEUE_BIN=""; QUEUE_DB=""; REGISTRY_GLOB=""; LARK_BIN=""; LARK_AS=""; RECEIPT_PATH=""
while IFS=$'\t' read -r key value; do
  case "$key" in
    asset_id) ASSET_ID="$value" ;;
    base_token) BASE_TOKEN="$value" ;;
    table_id) TABLE_ID="$value" ;;
    from_session) FROM_SESSION="$value" ;;
    queue_entrypoint) ENQUEUE_BIN="$value" ;;
    queue_db) QUEUE_DB="$value" ;;
    registry_glob) REGISTRY_GLOB="$value" ;;
    lark_cli) LARK_BIN="$value" ;;
    lark_identity) LARK_AS="$value" ;;
    receipt_path) RECEIPT_PATH="$value" ;;
  esac
done < <("$PYTHON_BIN" - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
for key in ("asset_id", "base_token", "table_id", "from_session", "queue_entrypoint", "queue_db", "registry_glob", "lark_cli", "lark_identity", "receipt_path"):
    value = cfg.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"config field {key} is required")
    print(f"{key}\t{value}")
PY
)

for required in ASSET_ID BASE_TOKEN TABLE_ID FROM_SESSION ENQUEUE_BIN QUEUE_DB REGISTRY_GLOB LARK_BIN LARK_AS RECEIPT_PATH; do
  [[ -n "${!required}" ]] || { echo "config value $required is required" >&2; exit 64; }
done
[[ -x "$ENQUEUE_BIN" ]] || { echo "queue entrypoint is not executable: $ENQUEUE_BIN" >&2; exit 64; }
[[ -x "$LARK_BIN" ]] || { echo "lark-cli entrypoint is not executable: $LARK_BIN" >&2; exit 64; }
[[ "$QUEUE_DB" = /* ]] || { echo "queue_db must be an absolute user-owned path" >&2; exit 64; }
[[ "$REGISTRY_GLOB" = /* ]] || { echo "registry_glob must be an absolute user-owned glob" >&2; exit 64; }
case "$QUEUE_DB" in "$FP_ROOT"|"$FP_ROOT"/*) echo "queue_db must be outside FP_ROOT" >&2; exit 64 ;; esac
case "$REGISTRY_GLOB" in "$FP_ROOT"|"$FP_ROOT"/*) echo "registry_glob must be outside FP_ROOT" >&2; exit 64 ;; esac
mkdir -p "$(dirname "$QUEUE_DB")"
QUEUE_BIN_DIR="$(CDPATH= cd -- "$(dirname -- "$ENQUEUE_BIN")" && pwd -P)"
STATUS_BIN="$QUEUE_BIN_DIR/feishu-sync-status"
[[ -x "$STATUS_BIN" ]] || {
  echo "queue status entrypoint is missing beside queue entrypoint: $STATUS_BIN" >&2
  exit 64
}
if [[ ! -e "$QUEUE_DB" ]]; then
  echo "[bitable-init-sync] queue_db missing; initializing with native queue status" >&2
  if ! "$STATUS_BIN" --db "$QUEUE_DB" >/dev/null; then
    echo "queue status could not initialize queue_db: $QUEUE_DB" >&2
    exit 64
  fi
  [[ -s "$QUEUE_DB" ]] || {
    echo "queue status returned without initializing queue_db: $QUEUE_DB" >&2
    exit 64
  }
fi
RECEIPT_PATH="$($PYTHON_BIN -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve())' "$RECEIPT_PATH")"
case "$RECEIPT_PATH" in "$FP_ROOT"|"$FP_ROOT"/*) echo "receipt_path must be outside FP_ROOT" >&2; exit 64 ;; esac
mkdir -p "$(dirname "$RECEIPT_PATH")"

ROWS_JSON="$(mktemp -t public-session-meta-rows.XXXXXX.json)"
BEFORE_JSON="$(mktemp -t public-session-meta-before.XXXXXX.json)"
AFTER_JSON="$(mktemp -t public-session-meta-after.XXXXXX.json)"
RAW_BEFORE_JSON="$(mktemp -t public-session-meta-raw-before.XXXXXX.json)"
RAW_AFTER_JSON="$(mktemp -t public-session-meta-raw-after.XXXXXX.json)"
QUEUE_JSON="$(mktemp -t public-session-meta-queue.XXXXXX.json)"
PAGE_FILES=()
cleanup() {
  rm -f "$ROWS_JSON" "$BEFORE_JSON" "$AFTER_JSON" "$RAW_BEFORE_JSON" "$RAW_AFTER_JSON" "$QUEUE_JSON"
  for page in "${PAGE_FILES[@]-}"; do [[ -n "$page" ]] && rm -f "$page"; done
  return 0
}
trap cleanup EXIT

"$PYTHON_BIN" - "$IDENTITY" "$ROWS_JSON" <<'PY'
import json, sys
src = json.load(open(sys.argv[1], encoding="utf-8"))
required = ("session_name", "alias", "category", "purpose")
missing = [key for key in required if not isinstance(src.get(key), str) or not src[key].strip()]
if missing:
    raise SystemExit("identity missing required role data: " + ", ".join(missing))
if src["category"] not in {"业务", "知识", "平台", "工具", "外部", "员工"}:
    raise SystemExit("identity category is outside the current catalog")
affiliation = src.get("affiliation")
if src["category"] == "员工":
    if not isinstance(affiliation, str) or not affiliation.strip():
        raise SystemExit("identity missing required role data: affiliation (required for 员工)")
    affiliated = affiliation.strip()
else:
    affiliated = {"外部": "独立"}.get(src["category"], "first-principle")
row = {
    "Session": src["session_name"].strip(),
    "别称": src["alias"].strip(),
    "Purpose": src["purpose"].strip(),
    "分类": src["category"].strip(),
    "附属于": affiliated,
}
json.dump([row], open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
PY

read_remote() {
  local output="$1"
  local filter_json="${2:-}"
  if [[ -n "$FIXTURE" ]]; then
    cp "$FIXTURE" "$output"
  else
    local offset=0 page page_meta page_count has_more page_start
    page_start=${#PAGE_FILES[@]}
    while :; do
      page="$(mktemp -t public-session-meta-page.XXXXXX.json)"
      PAGE_FILES+=("$page")
      local -a args=(base +record-list --as "$LARK_AS" --base-token "$BASE_TOKEN"
        --table-id "$TABLE_ID" --format json --limit 200 --offset "$offset")
      [[ -n "$filter_json" ]] && args+=(--filter-json "$filter_json")
      "$LARK_BIN" "${args[@]}" > "$page"
      page_meta="$("$PYTHON_BIN" - "$page" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1], encoding="utf-8"))
data = raw.get("data", raw)
if not isinstance(data, dict):
    raise SystemExit("record-list response data is not an object")
records = data.get("records")
if records is None and isinstance(data.get("data"), list):
    records = data["data"]
if not isinstance(records, list):
    raise SystemExit("record-list response has no records/data list")
has_more = data.get("has_more", raw.get("has_more"))
if has_more is not None and not isinstance(has_more, bool):
    raise SystemExit("record-list has_more must be boolean when present")
print(f"{len(records)}\t{'' if has_more is None else str(has_more).lower()}")
PY
      )"
      IFS=$'\t' read -r page_count has_more <<< "$page_meta"
      if [[ "$has_more" == "true" ]]; then
        (( page_count > 0 )) || { echo "record-list reported has_more=true with an empty page" >&2; return 1; }
        offset=$((offset + page_count))
        continue
      fi
      if [[ "$has_more" != "false" && "$page_count" -ge 200 ]]; then
        echo "record-list omitted has_more on a full page; refusing incomplete read" >&2
        return 1
      fi
      local -a current_pages=("${PAGE_FILES[@]:page_start}")
      "$PYTHON_BIN" - "$output" "${current_pages[@]}" <<'PY'
import json, sys

def records_from(raw):
    data = raw.get("data", raw)
    records = data.get("records") if isinstance(data, dict) else None
    if records is not None:
        return records
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        fields = data.get("fields") or []
        ids = data.get("record_id_list") or []
        return [{"record_id": ids[n] if n < len(ids) else "", "fields": {
            fields[i]: value for i, value in enumerate(row) if i < len(fields)
        }} for n, row in enumerate(data["data"])]
    raise SystemExit("record-list response has no records array")

merged = []
for path in sys.argv[2:]:
    merged.extend(records_from(json.load(open(path, encoding="utf-8"))))
json.dump({"ok": True, "data": {"records": merged}}, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
PY
      return 0
    done
  fi
}

SESSION_FILTER_JSON="$("$PYTHON_BIN" - "$ROWS_JSON" <<'PY'
import json, sys
target = json.load(open(sys.argv[1], encoding="utf-8"))[0]["Session"]
print(json.dumps({"logic": "and", "conditions": [["Session", "==", target]]}, ensure_ascii=False))
PY
)"
read_remote "$RAW_BEFORE_JSON" "$SESSION_FILTER_JSON"
"$PYTHON_BIN" - "$ROWS_JSON" "$RAW_BEFORE_JSON" "$BEFORE_JSON" <<'PY'
import json, sys
identity_rows = json.load(open(sys.argv[1], encoding="utf-8"))
target = identity_rows[0]["Session"]
raw = json.load(open(sys.argv[2], encoding="utf-8"))
data = raw.get("data", raw)
records = data.get("records") if isinstance(data, dict) else None
if records is None and isinstance(data, dict) and isinstance(data.get("data"), list):
    fields = data.get("fields") or []
    ids = data.get("record_id_list") or []
    records = []
    for n, row in enumerate(data["data"]):
        records.append({"record_id": ids[n] if n < len(ids) else "", "fields": {
            fields[i]: value for i, value in enumerate(row) if i < len(fields)
        }})
if not isinstance(records, list):
    raise SystemExit("remote read-back has no records array")
has_more = data.get("has_more", raw.get("has_more")) if isinstance(data, dict) else raw.get("has_more")
if has_more is True:
    raise SystemExit("remote read-back is incomplete (has_more=true)")
if has_more not in (None, False):
    raise SystemExit("remote read-back has invalid has_more")
matches = [r for r in records if isinstance(r, dict) and (r.get("fields") or {}).get("Session") == target]
if len(matches) > 1:
    raise SystemExit(f"duplicate Session rows for {target}; refusing to enqueue")
json.dump(matches[0] if matches else None, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False)
PY

set +e
"$ENQUEUE_BIN" --skill-provenance bitable-ops --asset "$ASSET_ID" --from "$FROM_SESSION" \
  --db "$QUEUE_DB" --registry-glob "$REGISTRY_GLOB" \
  --key "$FROM_SESSION:session-init:$("$PYTHON_BIN" - "$ROWS_JSON" <<'PY'
import json,sys
print(json.load(open(sys.argv[1], encoding="utf-8"))[0]["Session"])
PY
):metadata" --rows "$ROWS_JSON" --op bitable_rows_create_if_absent --wait > "$QUEUE_JSON" 2>&1
QUEUE_RC=$?
set -e
if (( QUEUE_RC != 0 )); then
  echo "queue seed failed (exit $QUEUE_RC): $(tr '\n' ' ' < "$QUEUE_JSON")" >&2
  exit "$QUEUE_RC"
fi

"$PYTHON_BIN" - "$QUEUE_JSON" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
try:
    value = json.loads(raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"queue did not return JSON: {exc}")
if not isinstance(value, dict):
    raise SystemExit("queue did not return an object")

# The published wendangwang --wait contract keeps submission status separate
# from the terminal job snapshot: status=accepted,
# job_state_at_response=done, terminal=true, waited=true. Queue read-back
# proof is not exposed here; the independent record read-back below is the
# second, caller-side completion gate.
published_wait_done = (
    value.get("accepted") is True
    and value.get("status") == "accepted"
    and value.get("job_state_at_response") == "done"
    and value.get("terminal") is True
    and value.get("waited") is True
    and value.get("wait_timed_out") is not True
)
if not published_wait_done:
    raise SystemExit(
        "queue did not prove published --wait terminal done; "
        "independent record read-back was not attempted"
    )
PY

read_remote "$RAW_AFTER_JSON" "$SESSION_FILTER_JSON"
"$PYTHON_BIN" - "$ROWS_JSON" "$BEFORE_JSON" "$RAW_AFTER_JSON" "$AFTER_JSON" <<'PY'
import json, sys
target_row = json.load(open(sys.argv[1], encoding="utf-8"))[0]
before = json.load(open(sys.argv[2], encoding="utf-8"))
raw = json.load(open(sys.argv[3], encoding="utf-8"))
data = raw.get("data", raw)
records = data.get("records") if isinstance(data, dict) else None
if records is None and isinstance(data, dict) and isinstance(data.get("data"), list):
    fields = data.get("fields") or []
    ids = data.get("record_id_list") or []
    records = [{"record_id": ids[n] if n < len(ids) else "", "fields": {
        fields[i]: value for i, value in enumerate(row) if i < len(fields)
    }} for n, row in enumerate(data["data"])]
if not isinstance(records, list):
    raise SystemExit("remote read-back has no records array")
has_more = data.get("has_more", raw.get("has_more")) if isinstance(data, dict) else raw.get("has_more")
if has_more is True:
    raise SystemExit("remote read-back is incomplete (has_more=true)")
if has_more not in (None, False):
    raise SystemExit("remote read-back has invalid has_more")
matches = [r for r in records if isinstance(r, dict) and (r.get("fields") or {}).get("Session") == target_row["Session"]]
if len(matches) != 1:
    raise SystemExit(f"post-seed read-back expected one Session row, got {len(matches)}")
after = matches[0]
if before is None:
    for key, expected in target_row.items():
        if (after.get("fields") or {}).get(key) != expected:
            raise SystemExit(f"new row field mismatch for {key}")
else:
    before_fields = before.get("fields") or {}
    after_fields = after.get("fields") or {}
    if before_fields != {k: after_fields.get(k) for k in before_fields}:
        raise SystemExit("existing row changed; human/system fields were not preserved")
json.dump(after, open(sys.argv[4], "w", encoding="utf-8"), ensure_ascii=False)
PY

"$PYTHON_BIN" - "$IDENTITY" "$BEFORE_JSON" "$QUEUE_JSON" "$AFTER_JSON" "$RECEIPT_PATH" <<'PY'
import json, sys
identity = json.load(open(sys.argv[1], encoding="utf-8"))
before = json.load(open(sys.argv[2], encoding="utf-8"))
queue_raw = open(sys.argv[3], encoding="utf-8").read()
try:
    queue = json.loads(queue_raw)
except json.JSONDecodeError:
    queue = {"raw": queue_raw}
after = json.load(open(sys.argv[4], encoding="utf-8"))
receipt = {
    "ok": True,
    "operation": "bitable_rows_create_if_absent",
    "session": identity["session_name"],
    "preexisting": before is not None,
    "queue_terminal_read_back_verified": True,
    "remote_read_back_verified": True,
    "seed_allowlist": ["Session", "别称", "Purpose", "分类", "附属于"],
    "record_id": after.get("record_id"),
}
if isinstance(queue, dict):
    receipt["queue"] = queue
json.dump(receipt, open(sys.argv[5], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(sys.argv[5], "a", encoding="utf-8").write("\n")
print(json.dumps(receipt, ensure_ascii=False))
PY
