#!/usr/bin/env bash
set -euo pipefail

# Sync local KB → Feishu wiki (single-direction, local authoritative)
# - CHARTER.md → wiki docx (overwrite)
# - MAP.md → wiki docx (overwrite)
# - concepts/*.md → wiki docx each (auto-create on first sync; manifest in kb/.feishu-manifest.json)
# - sources.jsonl → wiki bitable "Sources" (enqueue upsert by source_id)
# - logs/queries/queries.jsonl → wiki bitable "Queries" (enqueue upsert by timestamp)
#
# Usage:
#   ./scripts/sync-kb.sh                 # sync everything
#   ./scripts/sync-kb.sh charter         # charter only
#   ./scripts/sync-kb.sh map             # map only
#   ./scripts/sync-kb.sh concepts        # all concepts/*.md (auto-create missing)
#   ./scripts/sync-kb.sh concept <slug>  # single concept
#   ./scripts/sync-kb.sh table           # sources bitable only
#   ./scripts/sync-kb.sh queries         # queries bitable only

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KB_ROOT="${MYTHOS_KB_ROOT:-$PROJECT_ROOT}"
MYTHOS_PYTHON="${MYTHOS_PYTHON:-$PROJECT_ROOT/.venv/bin/python}"
KB_DIR="$KB_ROOT/kb"
CONCEPTS_DIR="$KB_DIR/concepts"
MANIFEST="${MYTHOS_FEISHU_MANIFEST:-$KB_DIR/.feishu-manifest.json}"
ENQUEUE_BIN="${MYTHOS_ENQUEUE_BIN:-}"
# Public terminal-state probe (the ONLY sanctioned way to learn a job's final state).
# Never read the private queue db / receipt ndjson; never inline-drain; never write Feishu directly.
ENQUEUE_STATUS_BIN="${MYTHOS_ENQUEUE_STATUS_BIN:-feishu-sync-status}"
SOURCES_ASSET="${MYTHOS_SOURCES_ASSET:-mythos.kb.sources}"
QUERIES_ASSET="${MYTHOS_QUERIES_ASSET:-mythos.kb.queries}"
SYNC_OWNER="${MYTHOS_SYNC_OWNER:-mythos}"
LARK_CLI="${MYTHOS_LARK_CLI:-lark-cli}"

CHARTER_URL="${MYTHOS_CHARTER_URL:-}"
MAP_URL="${MYTHOS_MAP_URL:-}"
QUERIES_LOG="$KB_ROOT/logs/queries/queries.jsonl"
PARENT_NODE_TOKEN="${MYTHOS_PARENT_NODE_TOKEN:-}"
SPACE_ID="${MYTHOS_SPACE_ID:-}"
WIKI_URL_PREFIX="${MYTHOS_WIKI_URL_PREFIX:-}"
DRY_RUN=0

# Dependency checks live in main() so this file can be `source`d for unit tests
# without executing any sync dispatch (see the __main__ guard at the bottom).

validate_python() {
  local version
  if [[ ! -x "$MYTHOS_PYTHON" ]]; then
    echo "ERROR: MYTHOS_PYTHON is not executable: $MYTHOS_PYTHON" >&2
    return 1
  fi
  if ! version=$("$MYTHOS_PYTHON" --version 2>&1); then
    echo "ERROR: MYTHOS_PYTHON could not report its version: $MYTHOS_PYTHON" >&2
    return 1
  fi
  if ! "$MYTHOS_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)' >/dev/null 2>&1; then
    echo "ERROR: MYTHOS_PYTHON must be Python 3.11 ($MYTHOS_PYTHON; $version)" >&2
    return 1
  fi
}

# Strip leading YAML frontmatter (--- ... ---) if present. No-op otherwise.
strip_frontmatter() {
  "$MYTHOS_PYTHON" -c 'import re, sys; sys.stdout.write(re.sub(r"\A---\n.*?\n---\n\s*", "", sys.stdin.read(), count=1, flags=re.S))'
}

init_manifest() {
  if [[ ! -f "$MANIFEST" ]]; then
    jq -n --arg p "$PARENT_NODE_TOKEN" --arg s "$SPACE_ID" \
      '{parent_node_token: $p, space_id: $s, concepts: {}}' > "$MANIFEST"
  fi
}

sync_charter() {
  local file="$KB_DIR/CHARTER.md"
  [[ ! -f "$file" ]] && { echo "SKIP: $file not found"; return 1; }
  if (( DRY_RUN )); then
    echo "DRY-RUN charter source=$file target=${CHARTER_URL:-<unset>}"
    return 0
  fi
  [[ -n "$CHARTER_URL" ]] || { echo "ERROR: MYTHOS_CHARTER_URL is required for live sync" >&2; return 1; }
  echo "SYNC charter → $CHARTER_URL"
  strip_frontmatter < "$file" | "$LARK_CLI" docs +update --doc "$CHARTER_URL" --content - --doc-format markdown --command overwrite > /dev/null
  echo "  OK: charter synced"
}

sync_map() {
  local file="$KB_DIR/MAP.md"
  [[ ! -f "$file" ]] && { echo "SKIP: $file not found"; return 1; }
  if (( DRY_RUN )); then
    echo "DRY-RUN map source=$file target=${MAP_URL:-<unset>}"
    return 0
  fi
  [[ -n "$MAP_URL" ]] || { echo "ERROR: MYTHOS_MAP_URL is required for live sync" >&2; return 1; }
  echo "SYNC map → $MAP_URL"
  strip_frontmatter < "$file" | "$LARK_CLI" docs +update --doc "$MAP_URL" --content - --doc-format markdown --command overwrite > /dev/null
  echo "  OK: map synced"
}

# Create wiki docx node for a concept slug, return node_token.
provision_concept_node() {
  local slug="$1"
  local title="KB / concepts / ${slug}"
  echo "  PROVISION: creating wiki docx node for '$slug'..." >&2
  local resp
  resp=$("$LARK_CLI" wiki +node-create --as user \
    --space-id "$SPACE_ID" \
    --parent-node-token "$PARENT_NODE_TOKEN" \
    --obj-type docx \
    --title "$title" 2>/dev/null)
  local node_token
  node_token=$(echo "$resp" | jq -r '.data.node_token // empty' 2>/dev/null)
  if [[ -z "$node_token" ]]; then
    echo "ERROR: failed to create node for $slug" >&2
    echo "$resp" >&2
    return 1
  fi
  local doc_url="${WIKI_URL_PREFIX}${node_token}"
  # update manifest atomically
  local tmp
  tmp=$(mktemp)
  jq --arg slug "$slug" --arg nt "$node_token" --arg url "$doc_url" \
    '.concepts[$slug] = {node_token: $nt, doc_url: $url}' "$MANIFEST" > "$tmp"
  mv "$tmp" "$MANIFEST"
  echo "  PROVISION: $slug → $doc_url" >&2
  echo "$doc_url"
}

sync_one_concept() {
  local slug="$1"
  local file="$CONCEPTS_DIR/${slug}.md"
  [[ ! -f "$file" ]] && { echo "SKIP: concept '$slug' not found at $file"; return 1; }

  if (( DRY_RUN )); then
    echo "DRY-RUN concept/$slug source=$file target=${WIKI_URL_PREFIX:-<unset>}"
    return 0
  fi
  if [[ -z "$SPACE_ID" || -z "$PARENT_NODE_TOKEN" || -z "$WIKI_URL_PREFIX" ]]; then
    echo "ERROR: MYTHOS_SPACE_ID, MYTHOS_PARENT_NODE_TOKEN, and MYTHOS_WIKI_URL_PREFIX are required for live concept sync" >&2
    return 1
  fi

  init_manifest
  local doc_url
  doc_url=$(jq -r --arg s "$slug" '.concepts[$s].doc_url // empty' "$MANIFEST")
  if [[ -z "$doc_url" ]]; then
    doc_url=$(provision_concept_node "$slug") || return 1
  fi

  echo "SYNC concept/$slug → $doc_url"
  strip_frontmatter < "$file" | "$LARK_CLI" docs +update --doc "$doc_url" --content - --doc-format markdown --command overwrite > /dev/null
  echo "  OK: concept/$slug synced"
}

sync_all_concepts() {
  [[ ! -d "$CONCEPTS_DIR" ]] && { echo "SKIP: $CONCEPTS_DIR not found"; return 0; }
  local count=0
  for f in "$CONCEPTS_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    local slug
    slug=$(basename "$f" .md)
    sync_one_concept "$slug"
    count=$((count + 1))
  done
  echo "  concepts total: $count"
}

# Interpret a feishu-sync-enqueue *accept-only* result. Reads the enqueue JSON on stdin;
# $1 = the idempotency key.
#
# Accept-only contract: exit 0 + accepted (or a chunked
# receipt) means the job is QUEUED, not yet written — drained.done=0 is the normal steady
# state, NOT a failure or a stuck queue. So we surface `accepted_pending` as the headline and
# point at the only sanctioned terminal-state probe (feishu-sync-status). We never require
# drained.done>=1, never treat drained.skipped as failure, and never read the private queue
# db / receipt ndjson, inline-drain, or write Feishu directly.
report_enqueue_result() {
  local key="${1:-}"
  local json accepted status job_id duplicate job_state chunks
  json="$(cat)"
  accepted=$(printf '%s\n' "$json" | jq -r 'if (.accepted == true or .chunked == true) then "true" else "false" end' 2>/dev/null)
  status=$(printf '%s\n' "$json" | jq -r '.status // "unknown"' 2>/dev/null)
  duplicate=$(printf '%s\n' "$json" | jq -r '.duplicate // false' 2>/dev/null)
  job_state=$(printf '%s\n' "$json" | jq -r '.job_state_at_response // "unknown"' 2>/dev/null)
  job_id=$(printf '%s\n' "$json" | jq -r '.job_id // (if (.job_ids | type) == "array" then (.job_ids | join(",")) else "" end)' 2>/dev/null)
  chunks=$(printf '%s\n' "$json" | jq -r '.chunks // empty' 2>/dev/null)

  if [[ "$accepted" != "true" ]]; then
    echo "    enqueue NOT accepted (real failure): status=$status job_id=$job_id" >&2
    printf '%s\n' "$json" >&2
    return 1
  fi

  echo "    accepted_pending: enqueue received — queued, NOT yet written (normal for accept-only)."
  echo "      job_id=$job_id status=$status duplicate=$duplicate job_state_at_response=$job_state${chunks:+ chunks=$chunks}"
  echo "      terminal state → $ENQUEUE_STATUS_BIN --key \"$key\""
  return 0
}

sync_table() {
  local jsonl="$KB_DIR/sources.jsonl"
  [[ ! -f "$jsonl" ]] && { echo "SKIP: $jsonl not found"; return 1; }

  echo "SYNC table → $SOURCES_ASSET via feishu-sync-enqueue"
  echo "  [1/2] Materializing source rows..."

  local rows_file
  rows_file=$(mktemp "${TMPDIR:-/tmp}/mythos-kb-sources-rows.XXXXXX.json")
  jq -cs '[.[] | {
    source_id: (.id // ""),
    title: (.title // ""),
    author: (.author // ""),
    source_url: (.source_url // ""),
    raw_url: (.raw_url // ""),
    published: (.published // ""),
    captured: (if (.captured // "") == "" or .captured == "unknown" then null else ((.captured + "T00:00:00Z") | fromdateiso8601 * 1000) end),
    content_type: (.content_type // ""),
    language: (.language // ""),
    license: (.license // ""),
    tags: ((.tags // []) | join(", ")),
    summary: (.summary // ""),
    local_path: (.file // "")
  }]' "$jsonl" > "$rows_file"

  local count
  count=$(jq 'length' "$rows_file")
  if [[ "$count" == "0" ]]; then
    rm -f "$rows_file"
    echo "    no rows to push"
    return 0
  fi
  echo "    prepared $count source rows"

  if (( DRY_RUN )); then
    echo "DRY-RUN sources asset=${SOURCES_ASSET:-<unset>} rows=$count"
    rm -f "$rows_file"
    return 0
  fi
  [[ -n "$SOURCES_ASSET" && -n "$ENQUEUE_BIN" ]] || {
    echo "ERROR: MYTHOS_SOURCES_ASSET and MYTHOS_ENQUEUE_BIN are required for live source sync" >&2
    rm -f "$rows_file"
    return 1
  }

  local digest key result status
  digest=$("$MYTHOS_PYTHON" - "$jsonl" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest()[:16])
PY
)
  key="$(date +%F):mythos:${SOURCES_ASSET}:sha256-${digest}"

  echo "  [2/2] Enqueueing upsert job..."
  if result=$("$ENQUEUE_BIN" \
    --asset "$SOURCES_ASSET" \
    --from "$SYNC_OWNER" \
    --key "$key" \
    --op bitable_rows_upsert \
    --rows "$rows_file" 2>&1); then
    :
  else
    status=$?
    rm -f "$rows_file"
    echo "    enqueue failed" >&2
    printf '%s\n' "$result" >&2
    return "$status"
  fi
  rm -f "$rows_file"

  printf '%s\n' "$result" | report_enqueue_result "$key"
}

# Queries mirror: materialize object rows and hand them to the configured queue as a
# timestamp-idempotent upsert. NEVER delete-all + batch-create via lark-cli (that opened
# an audit sampling blind window that read as "phantom drift") and never inline-drain /
# read the private queue db. Accept-only: report_enqueue_result treats accepted as done.
# The row-level unique key is `timestamp` (set by log-query.py, microsecond precision,
# non-empty + unique), which the asset contract must declare as unique_key=["timestamp"].
sync_queries() {
  if [[ ! -f "$QUERIES_LOG" ]]; then
    echo "SKIP: $QUERIES_LOG not found"; return 0
  fi
  if (( DRY_RUN )); then
    local count
    count=$(jq -s 'length' "$QUERIES_LOG")
    echo "DRY-RUN queries asset=${QUERIES_ASSET:-<unset>} rows=$count log=$QUERIES_LOG"
    return 0
  fi
  if [[ ! -x "$ENQUEUE_BIN" ]]; then
    echo "ERROR: enqueue bin not found/executable: $ENQUEUE_BIN" >&2
    echo "    the Queries mirror requires the configured queue; register/repair the table before live use." >&2
    echo "    NOT falling back to lark-cli record mutation." >&2
    return 1
  fi

  echo "SYNC queries → $QUERIES_ASSET via feishu-sync-enqueue"
  echo "  [1/2] Materializing query-log rows (timestamp-idempotent upsert)..."

  local rows_file
  rows_file=$(mktemp "${TMPDIR:-/tmp}/mythos-kb-queries-rows.XXXXXX.json")
  jq -cs '[.[] | {
    timestamp: (.timestamp // ""),
    caller: (.caller // "unknown"),
    intent: (.intent // "unknown"),
    kb_state: (.kb_state // "none"),
    prompt: (.prompt // ""),
    concepts: ((.concepts // []) | join(", ")),
    sources: ((.sources // []) | join(", ")),
    routing_target: (.routing_target // ""),
    answer_summary: (.answer_summary // ""),
    notes: (.notes // "")
  }]' "$QUERIES_LOG" > "$rows_file"

  local count
  count=$(jq 'length' "$rows_file")
  if [[ "$count" == "0" ]]; then
    rm -f "$rows_file"
    echo "    no rows to push (empty log)"
    return 0
  fi
  echo "    prepared $count query rows"

  local digest key result status
  digest=$("$MYTHOS_PYTHON" - "$QUERIES_LOG" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest()[:16])
PY
)
  key="$(date +%F):mythos:${QUERIES_ASSET}:sha256-${digest}"

  echo "  [2/2] Enqueueing upsert job..."
  if result=$("$ENQUEUE_BIN" \
    --asset "$QUERIES_ASSET" \
    --from "$SYNC_OWNER" \
    --key "$key" \
    --op bitable_rows_upsert \
    --rows "$rows_file" 2>&1); then
    :
  else
    status=$?
    rm -f "$rows_file"
    echo "    enqueue failed — table may be unregistered or missing a timestamp unique_key." >&2
    echo "    repair the recipient-owned table registration / contract before retrying;" >&2
    echo "    NOT falling back to lark-cli record mutation." >&2
    printf '%s\n' "$result" >&2
    return "$status"
  fi
  rm -f "$rows_file"

  printf '%s\n' "$result" | report_enqueue_result "$key"
}

main() {
  local command="all"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1; shift ;;
      -h|--help)
        echo "Usage: $0 [--dry-run] [charter|map|concepts|concept <slug>|table|queries|all]"
        return 0
        ;;
      *) command="$1"; shift; break ;;
    esac
  done
  if ! command -v jq &>/dev/null; then
    echo "ERROR: jq not found in PATH" >&2; exit 1
  fi
  validate_python || exit 1
  if (( ! DRY_RUN )) && ! command -v "$LARK_CLI" &>/dev/null; then
    echo "ERROR: configured lark CLI not found: $LARK_CLI" >&2; exit 1
  fi

  case "$command" in
    charter)  sync_charter ;;
    map)      sync_map ;;
    concepts) sync_all_concepts ;;
    concept)
      [[ $# -lt 1 ]] && { echo "Usage: $0 concept <slug>" >&2; exit 1; }
      sync_one_concept "$1"
      ;;
    table)    sync_table ;;
    queries)  sync_queries ;;
    all)
      sync_charter
      sync_map
      sync_all_concepts
      sync_table
      sync_queries
      ;;
    *)
      echo "Usage: $0 [--dry-run] [charter|map|concepts|concept <slug>|table|queries|all]" >&2
      exit 1
      ;;
  esac

  echo "DONE"
}

# Only dispatch when executed directly; a `source` (unit tests) defines functions only.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
