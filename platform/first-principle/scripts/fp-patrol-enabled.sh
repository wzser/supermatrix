#!/usr/bin/env bash
# fp-patrol-enabled.sh — query the Bitable patrol on/off switch.
#
# Reads the "开关" checkbox where 配置项=patrol_enabled in:
#   base_token: $FP_PATROL_BASE_TOKEN
#   table_id:   $FP_PATROL_TABLE_ID
#   table name: FP 巡检配置
#
# Exit code:
#   0  enabled (or fail-open: switch unreadable → default to enabled)
#   1  explicitly disabled
#   (no exit >1; failures degrade to fail-open with a stderr warning)
#
# stdout:
#   enabled|disabled (one word)
#
# Why fail-open? If lark-cli or Bitable is down at 01:17 cron, we'd rather run
# the patrol than silently skip for days until someone notices. The reverse
# (fail-closed) would let infra outages mask the "patrol stopped working" signal.
#
# Usage:
#   if bash scripts/fp-patrol-enabled.sh >/dev/null; then
#     # run patrol
#   else
#     # emit REPORT: skipped=true and exit
#   fi

set -uo pipefail

BASE_TOKEN="${FP_PATROL_BASE_TOKEN:-FP_PATROL_BASE_TOKEN}"
TABLE_ID="${FP_PATROL_TABLE_ID:-FP_PATROL_TABLE_ID}"

raw=$(lark-cli base +record-list --as user \
  --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" \
  --limit 50 --format json 2>/dev/null) || {
  echo "warning: lark-cli call failed, fail-open to enabled" >&2
  echo "enabled"
  exit 0
}

# field_id_list is parallel to data rows. find indices of 配置项 and 开关.
key_idx=$(echo "$raw" | jq -r '.data.fields | to_entries[] | select(.value == "配置项") | .key')
val_idx=$(echo "$raw" | jq -r '.data.fields | to_entries[] | select(.value == "开关") | .key')

if [ -z "$key_idx" ] || [ -z "$val_idx" ]; then
  echo "warning: 配置项/开关 columns not found in table, fail-open to enabled" >&2
  echo "enabled"
  exit 0
fi

enabled=$(echo "$raw" | jq -r --argjson ki "$key_idx" --argjson vi "$val_idx" \
  '.data.data[] | select(.[$ki] == "patrol_enabled") | .[$vi]')

case "$enabled" in
  true)
    echo "enabled"
    exit 0
    ;;
  false)
    echo "disabled"
    exit 1
    ;;
  *)
    echo "warning: patrol_enabled row missing or value=$enabled, fail-open to enabled" >&2
    echo "enabled"
    exit 0
    ;;
esac
