#!/usr/bin/env bash
# fp-managed-list.sh — list session names where Bitable's FP管辖 checkbox is checked.
#
# Source of truth: Feishu Bitable session table ($FP_SESSION_BASE_TOKEN / $FP_SESSION_TABLE_ID).
# Field "FP管辖" (checkbox) governs whether FP touches a session in patrols / conform checks /
# self-report polling. Unchecked = FP completely skips it; sync-session-table.sh still mirrors
# the row for visibility.
#
# v2: Cross-references with local sessions DB to exclude status='deleted' sessions.
#     Deleted sessions with stale FP管辖=true in Bitable are silently skipped.
#
# Usage:
#   bash scripts/fp-managed-list.sh           # newline-separated session names (FP管辖=true, not deleted)
#   bash scripts/fp-managed-list.sh | grep -qx "<name>" && echo managed || echo skip
#
# Exit codes: 0 on success, non-zero on Bitable / lark-cli failure.
set -euo pipefail

BASE_TOKEN="${FP_SESSION_BASE_TOKEN:-FP_SESSION_BASE_TOKEN}"
TABLE_ID="${FP_SESSION_TABLE_ID:-FP_SESSION_TABLE_ID}"

SM_DB="${SM_RUNTIME_ROOT:-$HOME/.supermatrix}/data/supermatrix.db"

bitable_managed=$(lark-cli base +record-list \
  --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" \
  --limit 500 --field-id Session --field-id FP管辖 --format json 2>/dev/null \
| python3 -c '
import json, sys
d = json.load(sys.stdin).get("data", {})
fields = d.get("fields", [])
if "Session" not in fields or "FP管辖" not in fields:
    sys.stderr.write("[fp-managed-list] missing field projection\n")
    sys.exit(2)
si = fields.index("Session")
fi = fields.index("FP管辖")
for row in d.get("data", []):
    if row[fi] is True:
        print(row[si])
')

# Cross-reference: exclude sessions whose DB status is 'deleted'
if [ -n "$bitable_managed" ] && [ -r "$SM_DB" ]; then
  echo "$bitable_managed" | while read -r name; do
    [ -z "$name" ] && continue
    status=$(sqlite3 "$SM_DB" "SELECT status FROM sessions WHERE name='$name';" 2>/dev/null || echo "")
    if [ "$status" != "deleted" ]; then
      echo "$name"
    fi
  done
else
  # fallback: Bitable list without cross-reference (DB unreachable)
  echo "$bitable_managed"
fi
