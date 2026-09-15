#!/usr/bin/env bash
# Read-only schema gate for a user-owned session metadata table.
# Creation/registration remains the existing jianbiao + lark-cli schema-time
# path; this command proves the configured table matches the current catalog.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FP_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd -P)"
CONFIG="${SESSION_META_CONFIG:-}"
FIXTURE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="${2:-}"; shift 2 ;;
    --fixture) FIXTURE="${2:-}"; shift 2 ;;
    *) echo "usage: $0 --config /abs/config.json [--fixture /abs/schema.json]" >&2; exit 2 ;;
  esac
done
[[ -n "$CONFIG" && -f "$CONFIG" ]] || { echo "missing --config; public defaults are fail-closed" >&2; exit 64; }
PYTHON_BIN="${FP_PYTHON:-}"
[[ -x "$PYTHON_BIN" ]] || { echo "FP_PYTHON must name an executable Python 3.11" >&2; exit 64; }
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)' || { echo "FP_PYTHON must be Python 3.11" >&2; exit 64; }

BASE_TOKEN=""; TABLE_ID=""; LARK_BIN=""; LARK_AS=""
while IFS=$'\t' read -r key value; do
  case "$key" in
    base_token) BASE_TOKEN="$value" ;;
    table_id) TABLE_ID="$value" ;;
    lark_cli) LARK_BIN="$value" ;;
    lark_identity) LARK_AS="$value" ;;
  esac
done < <("$PYTHON_BIN" - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
for key in ("base_token", "table_id", "lark_cli", "lark_identity"):
    value = cfg.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"config field {key} is required")
    print(f"{key}\t{value}")
PY
)
[[ -n "$FIXTURE" || ( -x "$LARK_BIN" && -n "$BASE_TOKEN" && -n "$TABLE_ID" && -n "$LARK_AS" ) ]] || { echo "schema read requires explicit fixture or configured lark-cli coordinates" >&2; exit 64; }

RAW="$(mktemp -t public-session-meta-schema.XXXXXX.json)"
PAGE_FILES=()
cleanup() {
  rm -f "$RAW"
  for page in ${PAGE_FILES[@]-}; do [[ -n "$page" ]] && rm -f "$page"; done
}
trap cleanup EXIT
if [[ -n "$FIXTURE" ]]; then
  cp "$FIXTURE" "$RAW"
else
  offset=0
  while :; do
    page="$(mktemp -t public-session-meta-schema-page.XXXXXX.json)"
    PAGE_FILES+=("$page")
    "$LARK_BIN" base +field-list --as "$LARK_AS" --base-token "$BASE_TOKEN" \
      --table-id "$TABLE_ID" --format json --limit 200 --offset "$offset" > "$page"
    page_meta="$("$PYTHON_BIN" - "$page" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1], encoding="utf-8"))
data = raw.get("data", raw)
if not isinstance(data, dict):
    raise SystemExit("field-list response data is not an object")
fields = data.get("fields")
if fields is None:
    fields = data.get("items")
if not isinstance(fields, list):
    raise SystemExit("field-list response has no fields/items list")
has_more = data.get("has_more", raw.get("has_more"))
if has_more is not None and not isinstance(has_more, bool):
    raise SystemExit("field-list has_more must be boolean when present")
print(f"{len(fields)}\t{'' if has_more is None else str(has_more).lower()}")
PY
    )"
    IFS=$'\t' read -r page_count has_more <<< "$page_meta"
    if [[ "$has_more" == "true" ]]; then
      (( page_count > 0 )) || { echo "field-list reported has_more=true with an empty page" >&2; exit 1; }
      offset=$((offset + page_count))
      continue
    fi
    if [[ "$has_more" != "false" && "$page_count" -ge 200 ]]; then
      echo "field-list omitted has_more on a full page; refusing incomplete schema read" >&2
      exit 1
    fi
    "$PYTHON_BIN" - "$RAW" "${PAGE_FILES[@]}" <<'PY'
import json, sys

def fields_from(raw):
    data = raw.get("data", raw)
    if not isinstance(data, dict):
        raise SystemExit("field-list response data is not an object")
    fields = data.get("fields")
    if fields is None:
        fields = data.get("items")
    if not isinstance(fields, list):
        raise SystemExit("field-list response has no fields/items list")
    return fields

merged = []
for path in sys.argv[2:]:
    merged.extend(fields_from(json.load(open(path, encoding="utf-8"))))
json.dump({"ok": True, "data": {"fields": merged, "has_more": False}},
          open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
PY
    break
  done
fi

"$PYTHON_BIN" - "$FP_ROOT/config/public-bindings.json" "$FP_ROOT/config/session-meta-table.json" "$RAW" <<'PY'
import json, sys

bindings = json.load(open(sys.argv[1], encoding="utf-8"))
contract = json.load(open(sys.argv[2], encoding="utf-8"))
if contract.get("schema_source") != "config/public-bindings.json#/tables/session_meta/remote_fields":
    raise SystemExit("session-meta-table schema source is not public-bindings remote_fields")
binding_fields = bindings.get("tables", {}).get("session_meta", {}).get("remote_fields")
if not isinstance(binding_fields, list) or not all(isinstance(item, dict) for item in binding_fields):
    raise SystemExit("public-bindings session_meta remote_fields must define field shapes")
expected = [
    {
        "name": item.get("remote_name"),
        "native_type": item.get("native_type"),
        "required": item.get("required"),
        **({"options": item["options"]} if "options" in item else {}),
        **({"multiple": item["multiple"]} if "multiple" in item else {}),
    }
    for item in binding_fields
]
if any(not isinstance(item["name"], str) for item in expected):
    raise SystemExit("public-bindings contains a session field without remote_name")

raw = json.load(open(sys.argv[3], encoding="utf-8"))
data = raw.get("data", raw)
fields = data.get("fields") if isinstance(data, dict) else None
if fields is None and isinstance(data, dict):
    fields = data.get("items")
if not isinstance(fields, list) or not fields or not all(isinstance(item, dict) for item in fields):
    raise SystemExit("native field-list read-back must contain field objects, not names only")
has_more = data.get("has_more", raw.get("has_more")) if isinstance(data, dict) else raw.get("has_more")
if has_more is True:
    raise SystemExit("field-list read-back is incomplete (has_more=true)")
if has_more not in (None, False):
    raise SystemExit("field-list read-back has invalid has_more")

TYPE_NAMES = {
    "1": "text", "2": "number", "3": "single_select", "4": "multi_select",
    "5": "date_time", "7": "checkbox", "11": "user", "15": "attachment",
    "20": "auto_number",
}
TYPE_ALIASES = {
    "text": "text", "number": "number", "select": "single_select",
    "singleselect": "single_select", "single_select": "single_select",
    "multiselect": "multi_select", "multi_select": "multi_select",
    "datetime": "date_time", "date_time": "date_time", "date": "date_time",
    "checkbox": "checkbox", "user": "user", "attachment": "attachment",
    "autonumber": "auto_number", "auto_number": "auto_number",
}

def field_name(field):
    return field.get("name") or field.get("field_name") or field.get("fieldName")

def field_type(field):
    value = field.get("native_type", field.get("type"))
    key = str(value).strip().lower().replace(" ", "")
    return TYPE_NAMES.get(key, TYPE_ALIASES.get(key, key))

def property_object(field):
    value = field.get("property")
    return value if isinstance(value, dict) else {}

def required_value(field):
    prop = property_object(field)
    for key in ("required", "is_required", "isRequired"):
        if key in field:
            return field[key]
        if key in prop:
            return prop[key]
    return None

def multiple_value(field):
    prop = property_object(field)
    if "multiple" in field:
        return field["multiple"]
    return prop.get("multiple")

def option_names(field):
    prop = property_object(field)
    options = field.get("options", prop.get("options"))
    if not isinstance(options, list):
        return None
    names = []
    for option in options:
        if isinstance(option, str):
            names.append(option)
        elif isinstance(option, dict):
            name = option.get("name") or option.get("text") or option.get("value")
            if not isinstance(name, str):
                return None
            names.append(name)
        else:
            return None
    return names

actual_by_name = {}
for field in fields:
    name = field_name(field)
    if not isinstance(name, str) or not name.strip():
        raise SystemExit("native field-list contains a field without a name")
    if name in actual_by_name:
        raise SystemExit("native field-list contains duplicate field: " + name)
    actual_by_name[name] = field

if len(actual_by_name) != len(expected):
    raise SystemExit(
        f"schema field count mismatch: expected exactly {len(expected)}, "
        f"got {len(actual_by_name)}"
    )
missing = [item["name"] for item in expected if item["name"] not in actual_by_name]
if missing:
    raise SystemExit("schema read-back missing current-catalog fields: " + ", ".join(missing))
extra = sorted(set(actual_by_name) - {item["name"] for item in expected})
if extra:
    raise SystemExit("schema read-back contains unknown fields: " + ", ".join(extra))

for item in expected:
    name = item["name"]
    actual = actual_by_name[name]
    want_type = item.get("native_type")
    got_type = field_type(actual)
    if got_type != want_type:
        raise SystemExit(f"schema field {name} native type mismatch: expected {want_type}, got {got_type}")
    got_required = required_value(actual)
    if not isinstance(got_required, bool):
        raise SystemExit(f"schema field {name} missing boolean required flag")
    if got_required != item.get("required"):
        raise SystemExit(f"schema field {name} required mismatch: expected {item.get('required')}, got {got_required}")
    if "multiple" in item:
        got_multiple = multiple_value(actual)
        if not isinstance(got_multiple, bool) or got_multiple != item["multiple"]:
            raise SystemExit(f"schema field {name} multiple mismatch: expected {item['multiple']}, got {got_multiple}")
    if got_type in {"single_select", "multi_select"}:
        got_options = option_names(actual)
        if got_options is None:
            raise SystemExit(f"schema field {name} native select options are missing or malformed")
        want_options = item.get("options")
        if want_options is not None and set(got_options) != set(want_options):
            raise SystemExit(f"schema field {name} options mismatch: expected {want_options}, got {got_options}")

print(json.dumps({"ok": True, "field_count": len(actual_by_name), "checked_fields": len(expected)}, ensure_ascii=False))
PY
