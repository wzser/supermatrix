#!/usr/bin/env bash
set -euo pipefail

# Sync cross_session_log to Feishu Bitable (incremental upsert)
# Triggered by Scheduler shell executor, runs independently of main process.

DB="${SM_DB_PATH:?SM_DB_PATH not set}"
BT="${SM_BITABLE_BASE_TOKEN:?SM_BITABLE_BASE_TOKEN not set}"
TID="${SM_BITABLE_TABLE_ID:?SM_BITABLE_TABLE_ID not set}"
LARK_CLI="$(dirname "$0")/../node_modules/.bin/lark-cli"

MAX_RETRIES=5
RETRY_BASE_SEC=2

if [[ ! -f "$DB" ]]; then
  echo "ERROR: database not found: $DB" >&2
  exit 1
fi
if [[ ! -x "$LARK_CLI" ]]; then
  echo "ERROR: lark-cli not found: $LARK_CLI" >&2
  exit 1
fi

# Wrapper for sqlite3 with busy_timeout so concurrent SM writes don't cause
# "database is locked" on read queries or non-retried writes.
sqlite_with_timeout() {
  sqlite3 -cmd "PRAGMA busy_timeout=5000;" "$@"
}

# Retry sqlite3 calls on "database is locked" (SQLITE_BUSY from concurrent SM writes).
# Accepts args to pass to sqlite3 (without the binary itself). Returns stdout on success.
retry_sqlite() {
  local attempt=0
  local rc=0
  local output=""

  while [[ $attempt -le $MAX_RETRIES ]]; do
    output=$(sqlite_with_timeout "$@" 2>&1) || rc=$?

    if [[ $rc -eq 0 ]]; then
      echo "$output"
      return 0
    fi

    if echo "$output" | grep -qi 'database.*locked\|SQLITE_BUSY'; then
      attempt=$((attempt + 1))
      if [[ $attempt -le $MAX_RETRIES ]]; then
        local delay=$(( RETRY_BASE_SEC ** attempt ))
        echo "WARN: sqlite3 lock contention (attempt $attempt/$MAX_RETRIES), retrying in ${delay}s" >&2
        sleep "$delay"
        rc=0
        continue
      fi
    fi

    break
  done

  echo "$output" >&2
  return 1
}

# Retry lark-cli call with exponential backoff for rate-limit errors (e.g. 800004135).
# Accepts lark-cli args (without the binary path) and returns stdout on success.
# Exits non-zero only after all retries are exhausted.
retry_lark_cli() {
  local attempt=0
  local rc=0
  local output=""

  while [[ $attempt -le $MAX_RETRIES ]]; do
    output=$("$LARK_CLI" "$@" 2>&1) || rc=$?

    if [[ $rc -eq 0 ]]; then
      echo "$output"
      return 0
    fi

    # Check if the error is a rate-limit error
    if echo "$output" | grep -qiE '800004135|rate.?limit|too many requests|429'; then
      attempt=$((attempt + 1))
      if [[ $attempt -le $MAX_RETRIES ]]; then
        local delay=$(( RETRY_BASE_SEC ** attempt ))
        # Add jitter: ±25%
        local jitter=$(( (RANDOM * delay) / (32768 * 4) ))
        delay=$(( delay - (delay / 4) + jitter ))
        echo "WARN: rate-limited (attempt $attempt/$MAX_RETRIES), retrying in ${delay}s" >&2
        sleep "$delay"
        rc=0
        continue
      fi
    fi

    # Non-retryable error or retries exhausted
    break
  done

  echo "$output" >&2
  return 1
}

inserted=0
updated=0

# --- 1. Insert unsynced records (bitable_record_id IS NULL) ---

while IFS= read -r row; do
  comm_id=$(echo "$row" | jq -r '.id')
  from_name=$(echo "$row" | jq -r '.from_name // .from_session_id')
  to_name=$(echo "$row" | jq -r '.to_name // .to_session_id')
  kind=$(echo "$row" | jq -r '.kind')
  prompt=$(echo "$row" | jq -r '(.prompt // "") | .[0:2000]')
  status=$(echo "$row" | jq -r '.status')
  child_name=$(echo "$row" | jq -r '.child_name // empty')
  result_preview=$(echo "$row" | jq -r '(.result_preview // "") | .[0:2000]')
  error_message=$(echo "$row" | jq -r '.error_message // empty')
  created_at=$(echo "$row" | jq -r '.created_at')
  finished_at=$(echo "$row" | jq -r '.finished_at // empty')

  # Build fields JSON
  fields=$(jq -n \
    --arg from "$from_name" \
    --arg to "$to_name" \
    --arg kind "$kind" \
    --arg prompt "$prompt" \
    --arg status "$status" \
    --arg created "$(date -r $((created_at / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$((created_at / 1000))" '+%Y-%m-%d %H:%M:%S')" \
    '{
      "发起方": $from,
      "目标方": $to,
      "类型": $kind,
      "Prompt": $prompt,
      "状态": $status,
      "发起时间": $created
    }')

  [[ -n "$child_name" ]] && fields=$(echo "$fields" | jq --arg v "$child_name" '. + {"子Session": $v}')
  [[ -n "$result_preview" ]] && fields=$(echo "$fields" | jq --arg v "$result_preview" '. + {"结果摘要": $v}')
  [[ -n "$error_message" ]] && fields=$(echo "$fields" | jq --arg v "$error_message" '. + {"错误信息": $v}')
  if [[ -n "$finished_at" && "$finished_at" != "null" ]]; then
    ft_str=$(date -r $((finished_at / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$((finished_at / 1000))" '+%Y-%m-%d %H:%M:%S')
    fields=$(echo "$fields" | jq --arg v "$ft_str" '. + {"完成时间": $v}')
  fi

  # Upsert to Bitable
  result=$(retry_lark_cli base +record-upsert \
    --base-token "$BT" \
    --table-id "$TID" \
    --json "$fields") || { echo "WARN: upsert failed for $comm_id after retries" >&2; continue; }

  record_id=$(echo "$result" | jq -r '.data.record.record_id_list[0] // empty')
  if [[ -n "$record_id" ]]; then
    retry_sqlite "$DB" "UPDATE cross_session_log SET bitable_record_id = '$record_id', synced_at = $(date +%s000) WHERE id = '$comm_id';" > /dev/null || echo "WARN: sqlite3 UPDATE failed for $comm_id after retries" >&2
    inserted=$((inserted + 1))
    echo "INSERT $comm_id -> $record_id"
  fi
done < <(
  $SQLITE -json "$DB" "
  SELECT c.id, c.kind, c.prompt, c.status,
         c.result_preview, c.error_message,
         c.child_session_id, c.created_at, c.finished_at,
         sf.name AS from_name, st.name AS to_name,
         sc.name AS child_name
  FROM cross_session_log c
  LEFT JOIN sessions sf ON sf.id = c.from_session_id
  LEFT JOIN sessions st ON st.id = c.to_session_id
  LEFT JOIN sessions sc ON sc.id = c.child_session_id
  WHERE c.bitable_record_id IS NULL
  ORDER BY c.created_at ASC
" | jq -c '.[]'
)

# --- 2. Update stale synced records (finished after last sync) ---

while IFS= read -r row; do
  comm_id=$(echo "$row" | jq -r '.id')
  record_id=$(echo "$row" | jq -r '.bitable_record_id')
  status=$(echo "$row" | jq -r '.status')
  child_name=$(echo "$row" | jq -r '.child_name // empty')
  result_preview=$(echo "$row" | jq -r '(.result_preview // "") | .[0:2000]')
  error_message=$(echo "$row" | jq -r '.error_message // empty')
  finished_at=$(echo "$row" | jq -r '.finished_at // empty')

  fields=$(jq -n --arg status "$status" '{"状态": $status}')
  [[ -n "$child_name" ]] && fields=$(echo "$fields" | jq --arg v "$child_name" '. + {"子Session": $v}')
  [[ -n "$result_preview" ]] && fields=$(echo "$fields" | jq --arg v "$result_preview" '. + {"结果摘要": $v}')
  [[ -n "$error_message" ]] && fields=$(echo "$fields" | jq --arg v "$error_message" '. + {"错误信息": $v}')
  if [[ -n "$finished_at" && "$finished_at" != "null" ]]; then
    ft_str=$(date -r $((finished_at / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$((finished_at / 1000))" '+%Y-%m-%d %H:%M:%S')
    fields=$(echo "$fields" | jq --arg v "$ft_str" '. + {"完成时间": $v}')
  fi

  result=$(retry_lark_cli base +record-upsert \
    --base-token "$BT" \
    --table-id "$TID" \
    --record-id "$record_id" \
    --json "$fields") || { echo "WARN: update failed for $comm_id after retries" >&2; continue; }

  retry_sqlite "$DB" "UPDATE cross_session_log SET synced_at = $(date +%s000) WHERE id = '$comm_id';" > /dev/null || echo "WARN: sqlite3 UPDATE failed for $comm_id after retries" >&2
  updated=$((updated + 1))
  echo "UPDATE $comm_id ($record_id)"
done < <(
  $SQLITE -json "$DB" "
  SELECT c.id, c.bitable_record_id, c.kind, c.prompt, c.status,
         c.result_preview, c.error_message,
         c.child_session_id, c.created_at, c.finished_at,
         sf.name AS from_name, st.name AS to_name,
         sc.name AS child_name
  FROM cross_session_log c
  LEFT JOIN sessions sf ON sf.id = c.from_session_id
  LEFT JOIN sessions st ON st.id = c.to_session_id
  LEFT JOIN sessions sc ON sc.id = c.child_session_id
  WHERE c.bitable_record_id IS NOT NULL
    AND c.finished_at IS NOT NULL
    AND (c.synced_at IS NULL OR c.synced_at < c.finished_at)
  ORDER BY c.created_at ASC
" | jq -c '.[]'
)

echo "DONE: inserted=$inserted updated=$updated"
