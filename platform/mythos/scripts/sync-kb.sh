#!/usr/bin/env bash
set -euo pipefail

# Sync local KB → Feishu wiki (single-direction, local authoritative)
# - CHARTER.md → wiki docx (overwrite)
# - MAP.md → wiki docx (overwrite)
# - concepts/*.md → wiki docx each (auto-create on first sync; manifest in kb/.feishu-manifest.json)
# - sources.jsonl → wiki bitable "Sources" (delete all + batch insert)
# - logs/queries/queries.jsonl → wiki bitable "Queries" (delete all + batch insert)
#
# Usage:
#   ./scripts/sync-kb.sh                 # sync everything
#   ./scripts/sync-kb.sh charter         # charter only
#   ./scripts/sync-kb.sh map             # map only
#   ./scripts/sync-kb.sh concepts        # all concepts/*.md (auto-create missing)
#   ./scripts/sync-kb.sh concept <slug>  # single concept
#   ./scripts/sync-kb.sh table           # sources bitable only
#   ./scripts/sync-kb.sh queries         # queries bitable only

KB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KB_DIR="$KB_ROOT/kb"
CONCEPTS_DIR="$KB_DIR/concepts"
MANIFEST="$KB_DIR/.feishu-manifest.json"

WIKI_BASE_URL="${FEISHU_WIKI_BASE_URL:-https://YOUR_TENANT.feishu.cn/wiki}"
CHARTER_URL="${MYTHOS_CHARTER_WIKI_URL:-${WIKI_BASE_URL}/${MYTHOS_CHARTER_NODE_TOKEN:-MYTHOS_CHARTER_NODE_TOKEN}}"
MAP_URL="${MYTHOS_MAP_WIKI_URL:-${WIKI_BASE_URL}/${MYTHOS_MAP_NODE_TOKEN:-MYTHOS_MAP_NODE_TOKEN}}"
BASE_TOKEN="${MYTHOS_FEISHU_BASE_TOKEN:-MYTHOS_BASE_TOKEN}"
TABLE_ID="${MYTHOS_SOURCES_TABLE_ID:-MYTHOS_SOURCES_TABLE_ID}"
QUERIES_TABLE_ID="${MYTHOS_QUERIES_TABLE_ID:-MYTHOS_QUERIES_TABLE_ID}"
QUERIES_LOG="$KB_ROOT/logs/queries/queries.jsonl"
PARENT_NODE_TOKEN="${MYTHOS_PARENT_NODE_TOKEN:-MYTHOS_PARENT_NODE_TOKEN}"
SPACE_ID="${MYTHOS_FEISHU_SPACE_ID:-MYTHOS_SPACE_ID}"
WIKI_URL_PREFIX="${WIKI_BASE_URL}/"

if ! command -v lark-cli &>/dev/null; then
  echo "ERROR: lark-cli not found in PATH" >&2; exit 1
fi
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq not found in PATH" >&2; exit 1
fi
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found in PATH" >&2; exit 1
fi

# Strip leading YAML frontmatter (--- ... ---) if present. No-op otherwise.
strip_frontmatter() {
  python3 -c 'import re, sys; sys.stdout.write(re.sub(r"\A---\n.*?\n---\n\s*", "", sys.stdin.read(), count=1, flags=re.S))'
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
  echo "SYNC charter → $CHARTER_URL"
  strip_frontmatter < "$file" | lark-cli docs +update --doc "$CHARTER_URL" --markdown - --mode overwrite > /dev/null
  echo "  OK: charter synced"
}

sync_map() {
  local file="$KB_DIR/MAP.md"
  [[ ! -f "$file" ]] && { echo "SKIP: $file not found"; return 1; }
  echo "SYNC map → $MAP_URL"
  strip_frontmatter < "$file" | lark-cli docs +update --doc "$MAP_URL" --markdown - --mode overwrite > /dev/null
  echo "  OK: map synced"
}

# Create wiki docx node for a concept slug, return node_token.
provision_concept_node() {
  local slug="$1"
  local title="KB / concepts / ${slug}"
  echo "  PROVISION: creating wiki docx node for '$slug'..." >&2
  local resp
  resp=$(lark-cli wiki +node-create --as user \
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

  init_manifest
  local doc_url
  doc_url=$(jq -r --arg s "$slug" '.concepts[$s].doc_url // empty' "$MANIFEST")
  if [[ -z "$doc_url" ]]; then
    doc_url=$(provision_concept_node "$slug") || return 1
  fi

  echo "SYNC concept/$slug → $doc_url"
  strip_frontmatter < "$file" | lark-cli docs +update --doc "$doc_url" --markdown - --mode overwrite > /dev/null
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

sync_table() {
  local jsonl="$KB_DIR/sources.jsonl"
  [[ ! -f "$jsonl" ]] && { echo "SKIP: $jsonl not found"; return 1; }

  echo "SYNC table ← $jsonl"

  # Step 1: clear existing records (paginated)
  echo "  [1/2] Clearing existing records..."
  local deleted=0
  while true; do
    local ids
    ids=$(lark-cli base +record-list --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --limit 100 2>/dev/null \
      | jq -r '.data.record_id_list[]? // empty' 2>/dev/null)
    [[ -z "$ids" ]] && break
    for rid in $ids; do
      lark-cli base +record-delete --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --record-id "$rid" --yes >/dev/null 2>&1 \
        && deleted=$((deleted + 1)) || true
    done
  done
  echo "    cleared $deleted records"

  # Step 2: batch insert
  echo "  [2/2] Pushing records..."
  local rows
  rows=$(jq -cs '[.[] | [
    (.id // ""),
    (.title // ""),
    (.author // ""),
    (.source_url // ""),
    (.raw_url // ""),
    (.published // ""),
    (if (.captured // "") == "" or .captured == "unknown" then null
     else ((.captured + "T00:00:00Z") | fromdateiso8601 * 1000) end),
    (.content_type // ""),
    (.language // ""),
    (.license // ""),
    ((.tags // []) | join(", ")),
    (.summary // ""),
    (.file // "")
  ]]' "$jsonl")

  local count
  count=$(echo "$rows" | jq 'length')
  if [[ "$count" == "0" ]]; then
    echo "    no rows to push"; return 0
  fi

  local payload
  payload=$(jq -cn --argjson rows "$rows" '{
    fields: ["source_id","title","author","source_url","raw_url","published","captured","content_type","language","license","tags","summary","local_path"],
    rows: $rows
  }')

  # Push in chunks of 100 to respect rate limits
  local total=0
  local i=0
  while [[ $i -lt $count ]]; do
    local chunk
    chunk=$(echo "$payload" | jq -c --argjson start "$i" '{fields: .fields, rows: (.rows[$start:$start+100])}')
    local result
    result=$(lark-cli base +record-batch-create --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --json "$chunk" 2>&1)
    local pushed
    pushed=$(echo "$result" | jq '.data.record_id_list | length' 2>/dev/null || echo 0)
    total=$((total + pushed))
    i=$((i + 100))
  done
  echo "    pushed $total records"
}

sync_queries() {
  if [[ ! -f "$QUERIES_LOG" ]]; then
    echo "SKIP: $QUERIES_LOG not found"; return 0
  fi

  echo "SYNC queries ← $QUERIES_LOG"

  # Step 1: clear existing records (paginated)
  echo "  [1/2] Clearing existing records..."
  local deleted=0
  while true; do
    local ids
    ids=$(lark-cli base +record-list --as user --base-token "$BASE_TOKEN" --table-id "$QUERIES_TABLE_ID" --limit 100 2>/dev/null \
      | jq -r '.data.record_id_list[]? // empty' 2>/dev/null)
    [[ -z "$ids" ]] && break
    for rid in $ids; do
      lark-cli base +record-delete --as user --base-token "$BASE_TOKEN" --table-id "$QUERIES_TABLE_ID" --record-id "$rid" --yes >/dev/null 2>&1 \
        && deleted=$((deleted + 1)) || true
    done
  done
  echo "    cleared $deleted records"

  # Step 2: batch insert
  echo "  [2/2] Pushing records..."
  local rows
  rows=$(jq -cs '[.[] | [
    (.timestamp // ""),
    (.caller // "unknown"),
    (.intent // "unknown"),
    (.kb_state // "none"),
    (.prompt // ""),
    ((.concepts // []) | join(", ")),
    ((.sources // []) | join(", ")),
    (.routing_target // ""),
    (.answer_summary // ""),
    (.notes // "")
  ]]' "$QUERIES_LOG")

  local count
  count=$(echo "$rows" | jq 'length')
  if [[ "$count" == "0" ]]; then
    echo "    no rows to push (empty log)"; return 0
  fi

  local payload
  payload=$(jq -cn --argjson rows "$rows" '{
    fields: ["timestamp","caller","intent","kb_state","prompt","concepts","sources","routing_target","answer_summary","notes"],
    rows: $rows
  }')

  local total=0
  local i=0
  while [[ $i -lt $count ]]; do
    local chunk
    chunk=$(echo "$payload" | jq -c --argjson start "$i" '{fields: .fields, rows: (.rows[$start:$start+100])}')
    local result
    result=$(lark-cli base +record-batch-create --as user --base-token "$BASE_TOKEN" --table-id "$QUERIES_TABLE_ID" --json "$chunk" 2>&1)
    local pushed
    pushed=$(echo "$result" | jq '.data.record_id_list | length' 2>/dev/null || echo 0)
    total=$((total + pushed))
    i=$((i + 100))
  done
  echo "    pushed $total records"
}

case "${1:-all}" in
  charter)  sync_charter ;;
  map)      sync_map ;;
  concepts) sync_all_concepts ;;
  concept)
    [[ -z "${2:-}" ]] && { echo "Usage: $0 concept <slug>" >&2; exit 1; }
    sync_one_concept "$2"
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
    echo "Usage: $0 [charter|map|concepts|concept <slug>|table|queries|all]" >&2
    exit 1
    ;;
esac

echo "DONE"
