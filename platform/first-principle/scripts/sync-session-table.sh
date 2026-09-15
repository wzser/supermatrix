#!/usr/bin/env bash
# One-shot remote -> local session-meta mirror.
# It only calls lark-cli +record-list (or a controlled fixture) and writes an
# external NDJSON snapshot. It never opens SuperMatrix SQLite or writes remote.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FP_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd -P)"
CONFIG="${SESSION_META_CONFIG:-}"
FIXTURE=""
OUTPUT=""
SESSION_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="${2:-}"; shift 2 ;;
    --fixture) FIXTURE="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --session-name) SESSION_FILTER="${2:-}"; shift 2 ;;
    *) echo "usage: $0 --config /abs/config.json [--fixture /abs/remote.json] --output /abs/out.ndjson [--session-name NAME]" >&2; exit 2 ;;
  esac
done
[[ -n "$CONFIG" && -f "$CONFIG" ]] || { echo "missing --config; public defaults are fail-closed" >&2; exit 64; }
[[ -z "$FIXTURE" || -f "$FIXTURE" ]] || { echo "fixture not found: $FIXTURE" >&2; exit 64; }
PYTHON_BIN="${FP_PYTHON:-}"
[[ -x "$PYTHON_BIN" ]] || { echo "FP_PYTHON must name an executable Python 3.11" >&2; exit 64; }
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)' || { echo "FP_PYTHON must be Python 3.11" >&2; exit 64; }

BASE_TOKEN=""; TABLE_ID=""; LARK_BIN=""; LARK_AS=""; CONFIG_OUTPUT=""
while IFS=$'\t' read -r key value; do
  case "$key" in
    base_token) BASE_TOKEN="$value" ;;
    table_id) TABLE_ID="$value" ;;
    lark_cli) LARK_BIN="$value" ;;
    lark_identity) LARK_AS="$value" ;;
    output_path) CONFIG_OUTPUT="$value" ;;
  esac
done < <("$PYTHON_BIN" - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
for key in ("base_token", "table_id", "lark_cli", "lark_identity"):
    value = cfg.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"config field {key} is required")
    print(f"{key}\t{value}")
if isinstance(cfg.get("output_path"), str) and cfg["output_path"].strip():
    print(f"output_path\t{cfg['output_path']}")
PY
)
[[ -n "$OUTPUT" ]] || OUTPUT="$CONFIG_OUTPUT"
[[ -n "$OUTPUT" ]] || { echo "--output or config.output_path is required" >&2; exit 64; }
[[ -n "$FIXTURE" || ( -x "$LARK_BIN" && -n "$BASE_TOKEN" && -n "$TABLE_ID" && -n "$LARK_AS" ) ]] || { echo "live read requires executable lark-cli, explicit identity, base token, and table id" >&2; exit 64; }
OUTPUT="$($PYTHON_BIN -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve())' "$OUTPUT")"
case "$OUTPUT" in "$FP_ROOT"|"$FP_ROOT"/*) echo "output must be outside FP_ROOT" >&2; exit 64 ;; esac
mkdir -p "$(dirname "$OUTPUT")"

RAW="$(mktemp -t public-session-meta-sync.XXXXXX.json)"
PAGE_FILES=()
cleanup() {
  rm -f "$RAW"
  for page in "${PAGE_FILES[@]-}"; do [[ -n "$page" ]] && rm -f "$page"; done
  return 0
}
trap cleanup EXIT
if [[ -n "$FIXTURE" ]]; then
  cp "$FIXTURE" "$RAW"
else
  offset=0
  while :; do
    page="$(mktemp -t public-session-meta-sync-page.XXXXXX.json)"
    PAGE_FILES+=("$page")
    args=(base +record-list --as "$LARK_AS" --base-token "$BASE_TOKEN"
      --table-id "$TABLE_ID" --format json --limit 200 --offset "$offset")
    if [[ -n "$SESSION_FILTER" ]]; then
      filter_json="$("$PYTHON_BIN" - "$SESSION_FILTER" <<'PY'
import json, sys
print(json.dumps({"logic": "and", "conditions": [["Session", "==", sys.argv[1]]]}, ensure_ascii=False))
PY
      )"
      args+=(--filter-json "$filter_json")
    fi
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
      (( page_count > 0 )) || { echo "record-list reported has_more=true with an empty page" >&2; exit 1; }
      offset=$((offset + page_count))
      continue
    fi
    if [[ "$has_more" != "false" && "$page_count" -ge 200 ]]; then
      echo "record-list omitted has_more on a full page; refusing incomplete read" >&2
      exit 1
    fi
    "$PYTHON_BIN" - "$RAW" "${PAGE_FILES[@]}" <<'PY'
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
    break
  done
fi

"$PYTHON_BIN" - "$RAW" "$OUTPUT" "$SESSION_FILTER" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1], encoding="utf-8"))
data = raw.get("data", raw)
records = data.get("records") if isinstance(data, dict) else None
if records is None and isinstance(data, dict) and isinstance(data.get("data"), list):
    fields = data.get("fields") or []
    ids = data.get("record_id_list") or []
    records = [{"record_id": ids[n] if n < len(ids) else "", "fields": {fields[i]: value for i, value in enumerate(row) if i < len(fields)}} for n, row in enumerate(data["data"])]
if not isinstance(records, list):
    raise SystemExit("remote read-back has no records array")
has_more = data.get("has_more", raw.get("has_more")) if isinstance(data, dict) else raw.get("has_more")
if has_more is True:
    raise SystemExit("remote read-back is incomplete (has_more=true)")
if has_more not in (None, False):
    raise SystemExit("remote read-back has invalid has_more")
session_filter = sys.argv[3]
selected = []
for record in records:
    if not isinstance(record, dict) or not isinstance(record.get("fields"), dict):
        raise SystemExit("remote record has invalid fields")
    if session_filter and record["fields"].get("Session") != session_filter:
        continue
    if not record["fields"].get("Session"):
        raise SystemExit("remote record is missing required Session")
    selected.append({"record_id": record.get("record_id", ""), "Session": record["fields"]["Session"], "fields": record["fields"], "source": "fixture-or-remote-read"})
if session_filter and len(selected) != 1:
    raise SystemExit(f"expected exactly one Session row for {session_filter}, got {len(selected)}")
with open(sys.argv[2], "w", encoding="utf-8") as out:
    for row in selected:
        out.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
print(json.dumps({"ok": True, "rows": len(selected), "output": sys.argv[2]}, ensure_ascii=False))
PY
