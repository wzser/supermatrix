#!/usr/bin/env bash
set -euo pipefail

# Sync cross_session_log to Feishu Bitable through wendangwang's audited queue.
# The remote table contract is codexroot.platform.跨session通信记录 and its
# stable unique key is 关联ID, mapped from cross_session_log.id.

DB="${SM_DB_PATH:?SM_DB_PATH not set}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENQUEUE_BIN="${SM_FEISHU_SYNC_ENQUEUE_BIN:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/feishu-sync-enqueue}"
STATUS_BIN="${SM_FEISHU_SYNC_STATUS_BIN:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/feishu-sync-status}"
QUEUE_DB="${SM_FEISHU_SYNC_QUEUE_DB:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/data/sync-queue.sqlite}"
ASSET_ID="codexroot.platform.跨session通信记录"
FROM_SESSION="codexroot"

if [[ ! -f "$DB" ]]; then
  echo "ERROR: database not found: $DB" >&2
  exit 1
fi
if [[ ! -x "$ENQUEUE_BIN" ]]; then
  echo "ERROR: feishu-sync-enqueue not found: $ENQUEUE_BIN" >&2
  exit 1
fi
if [[ ! -x "$STATUS_BIN" ]]; then
  echo "ERROR: feishu-sync-status not found: $STATUS_BIN" >&2
  exit 1
fi

sqlite_with_timeout() {
  sqlite3 -cmd ".timeout 5000" "$@"
}

MAX_RETRIES=5
RETRY_BASE_SEC=2

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
        local delay=$((RETRY_BASE_SEC ** attempt))
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

public_receipt_id() {
  local key="$1"

  node -e '
const fs = require("node:fs");
const [key] = process.argv.slice(1);
let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(1);
}
if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.ok !== true || payload.found !== 1 || payload.terminal !== true || !Array.isArray(payload.jobs) || payload.jobs.length !== 1) {
  process.exit(1);
}
const [job] = payload.jobs;
if (!job || typeof job !== "object" || Array.isArray(job) || job.dedupe_key !== key || job.status !== "done" || job.terminal !== true || typeof job.receipt_ref !== "string" || !job.receipt_ref || typeof job.receipt_id !== "string" || !job.receipt_id || job.read_back_verified !== true || job.receipt_job_verified !== true) {
  process.exit(1);
}
process.stdout.write(job.receipt_id);
' "$key"
}

update_synced_at() {
  local source_rows_file="$1"
  local now="$2"

  SM_REPO_PACKAGE_JSON="$REPO_ROOT/package.json" node - "$DB" "$now" "$source_rows_file" <<'NODE'
const { createRequire } = require("node:module");
const { readFileSync } = require("node:fs");
const requireFromRepo = createRequire(process.env.SM_REPO_PACKAGE_JSON);
const Database = requireFromRepo("better-sqlite3");

const [, , dbPath, nowRaw, sourceRowsPath] = process.argv;
const now = Number(nowRaw);
const sourceRows = JSON.parse(readFileSync(sourceRowsPath, "utf8"));
const db = new Database(dbPath, { timeout: 5000 });
const sourceFields = [
  "id",
  "from_session_id",
  "to_session_id",
  "kind",
  "prompt",
  "child_session_id",
  "status",
  "result_preview",
  "error_message",
  "created_at",
  "finished_at",
  "client_request_id",
  "origin_run_id",
  "message_run_id",
];
const sourceCas = sourceFields.map((field) => `${field} IS @${field}`).join(" AND ");
const update = db.prepare(`UPDATE cross_session_log SET synced_at = @now WHERE ${sourceCas}`);
const tx = db.transaction((rows) => {
  const markedIds = [];
  for (const row of rows) {
    if (update.run({ ...row, now }).changes === 1) {
      markedIds.push(row.id);
    }
  }
  return markedIds;
});
const markedIds = tx(sourceRows);
db.close();
process.stdout.write(JSON.stringify({ marked_ids: markedIds }));
NODE
}

source_version() {
  local source_rows_file="$1"

  node - "$source_rows_file" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const [, , sourceRowsPath] = process.argv;
const sourceRows = JSON.parse(readFileSync(sourceRowsPath, "utf8"));
process.stdout.write(createHash("sha256").update(JSON.stringify(sourceRows)).digest("hex").slice(0, 16));
NODE
}

CHUNK_SIZE="${SM_BITABLE_CHUNK_SIZE:-200}"
if ! [[ "$CHUNK_SIZE" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARN: invalid SM_BITABLE_CHUNK_SIZE='$CHUNK_SIZE', falling back to 200" >&2
  CHUNK_SIZE=200
fi

ROW_CHUNK_JQ='
  def fmt(ts): if ts == null then "" else (ts/1000|floor|strflocaltime("%Y-%m-%d %H:%M:%S")) end;
  def chunks(n): . as $a | [range(0; ($a|length); n) | $a[.:(.+n)]];
  [ .[] | {
      comm: .id,
      source: {
        id: .id,
        from_session_id: .from_session_id,
        to_session_id: .to_session_id,
        kind: .kind,
        prompt: .prompt,
        child_session_id: .child_session_id,
        status: .status,
        result_preview: .result_preview,
        error_message: .error_message,
        created_at: .created_at,
        finished_at: .finished_at,
        client_request_id: .client_request_id,
        origin_run_id: .origin_run_id,
        message_run_id: .message_run_id
      },
      row: {
        "关联ID": .id,
        "发起方": (.from_name // .from_session_id // ""),
        "目标方": (.to_name // .to_session_id // ""),
        "类型": (.kind // ""),
        "Prompt": ((.prompt // "")[0:2000]),
        "状态": (.status // ""),
        "发起时间": fmt(.created_at),
        "请求ID": (.client_request_id // ""),
        "运行ID": (.origin_run_id // ""),
        "子运行ID": (.message_run_id // ""),
        "子Session": (.child_name // ""),
        "结果摘要": ((.result_preview // "")[0:2000]),
        "错误信息": (.error_message // ""),
        "完成时间": fmt(.finished_at)
      }
    } ]
  | chunks($CHUNK)
  | .[]
  | { comm_ids: [.[].comm], source_rows: [.[].source], rows: [.[].row] }
'

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/sm-sync-bitable.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT

enqueued=0
synced=0

while IFS= read -r chunk; do
  [[ -z "$chunk" ]] && continue

  rows_file="$tmpdir/rows-$enqueued.json"
  source_rows_file="$tmpdir/source-rows-$enqueued.json"
  printf '%s\n' "$chunk" | jq -c '.rows' > "$rows_file"
  printf '%s\n' "$chunk" | jq -c '.source_rows' > "$source_rows_file"
  row_count=$(printf '%s' "$chunk" | jq '.rows | length')
  first_id=$(printf '%s' "$chunk" | jq -r '.comm_ids[0]')
  last_id=$(printf '%s' "$chunk" | jq -r '.comm_ids[-1]')
  version=$(source_version "$source_rows_file")
  queue_key="codexroot.platform.cross-session-log:${first_id}:${last_id}:count-${row_count}:v-${version}"

  result=$("$ENQUEUE_BIN" \
    --asset "$ASSET_ID" \
    --from "$FROM_SESSION" \
    --key "$queue_key" \
    --op bitable_rows_upsert \
    --rows "$rows_file" \
    --db "$QUEUE_DB" \
    --drain-scope asset)

  accepted=$(printf '%s' "$result" | jq -r 'if type == "object" and .ok == true and .accepted == true and .status == "accepted" then "true" else "false" end' 2>/dev/null || true)
  if [[ "$accepted" != "true" ]]; then
    echo "ERROR: enqueue rejected for $queue_key" >&2
    echo "RESPONSE: $result" >&2
    exit 1
  fi

  public_status=$("$STATUS_BIN" --db "$QUEUE_DB" --key "$queue_key") || public_status=""
  receipt_id=$(printf '%s' "$public_status" | public_receipt_id "$queue_key") || receipt_id=""
  if [[ -z "$receipt_id" ]]; then
    echo "ERROR: queued job did not produce a verified public receipt for $queue_key" >&2
    echo "ENQUEUE_RESPONSE: $result" >&2
    echo "PUBLIC_STATUS: $public_status" >&2
    exit 1
  fi

  marked=$(update_synced_at "$source_rows_file" "$(date +%s000)")
  marked_count=$(printf '%s' "$marked" | jq '.marked_ids | length')
  enqueued=$((enqueued + 1))
  synced=$((synced + marked_count))
  if [[ "$marked_count" -ne "$row_count" ]]; then
    echo "STALE_SOURCE_SNAPSHOT key=$queue_key rows=$row_count marked=$marked_count; final source row remains eligible for next cycle" >&2
  fi
  echo "UPSERT_ENQUEUED key=$queue_key rows=$row_count receipt=$receipt_id source_marked=$marked_count"
done < <(
  retry_sqlite -json "$DB" "
  SELECT c.id, c.from_session_id, c.to_session_id, c.kind, c.prompt, c.status,
         c.client_request_id, c.origin_run_id, c.message_run_id,
         c.result_preview, c.error_message,
         c.child_session_id, c.created_at, c.finished_at,
         sf.name AS from_name, st.name AS to_name,
         sc.name AS child_name
  FROM cross_session_log c
  LEFT JOIN sessions sf ON sf.id = c.from_session_id
  LEFT JOIN sessions st ON st.id = c.to_session_id
  LEFT JOIN sessions sc ON sc.id = c.child_session_id
  WHERE c.synced_at IS NULL
     OR (c.finished_at IS NOT NULL AND c.synced_at < c.finished_at)
  ORDER BY c.created_at ASC
" | jq -c --argjson CHUNK "$CHUNK_SIZE" "$ROW_CHUNK_JQ"
)

echo "DONE: enqueued=$enqueued synced=$synced"
