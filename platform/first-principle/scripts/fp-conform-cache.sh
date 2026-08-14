#!/usr/bin/env bash
# fp-conform-cache.sh — hash-based skip cache for Phase 3.1 (Conform).
#
# Phase 3.1 reads every session's CLAUDE.md + AGENTS.md against the category template
# every cycle, but most sessions don't change between cycles. Storing the sha256 of
# the session's two files PLUS the matching category template's sha lets us skip
# unchanged sessions without reading them into context.
#
# Cache file: data/.fp-conform-cache.json
# Per-session entry:
#   {
#     "claude_md_sha": "...",
#     "agents_md_sha": "...",
#     "template_sha":  "...",   # combined sha of claude-md-<cat>.md + agents-md-<cat>.md
#     "category":      "...",
#     "judgment":      "clean|no_action|deferred|accepted",
#     "last_judged_at":"<iso8601>"
#   }
#
# Usage:
#   should_skip <session> <workdir> <category>
#       exit 0 = hashes unchanged, caller may skip Phase 3.1 work for this session
#       exit 1 = cache miss or hash drift, caller must do full check
#       stdout: short reason
#   update <session> <workdir> <category> <judgment>
#       write/update cache row; judgment ∈ {clean,no_action,deferred,accepted}
#   invalidate_category <category>
#       drop all cache rows whose .category matches (use after Phase 2.1 touched the
#       category template — otherwise we'd skip sessions that should be re-checked)
#   invalidate <session>
#       drop one session's row
#   dump
#       print full cache as pretty JSON
#
# Idempotent and safe to call concurrently? No — uses temp-file rename, OK for the
# single-threaded patrol flow but not for parallel writers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_FILE="$FP_ROOT/data/.fp-conform-cache.json"
TEMPLATES_DIR="$FP_ROOT/templates"

ensure_cache() {
  [ -f "$CACHE_FILE" ] || echo '{}' > "$CACHE_FILE"
}

sha_of() {
  if [ -f "$1" ]; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

combined_template_sha() {
  local category="$1"
  local claude_tpl agents_tpl
  claude_tpl=$(sha_of "$TEMPLATES_DIR/claude-md-${category}.md")
  agents_tpl=$(sha_of "$TEMPLATES_DIR/agents-md-${category}.md")
  printf '%s%s' "$claude_tpl" "$agents_tpl" | shasum -a 256 | awk '{print $1}'
}

cmd="${1:-}"; shift || true

case "$cmd" in
  should_skip)
    session="$1"; workdir="$2"; category="$3"
    ensure_cache
    claude_sha=$(sha_of "$workdir/CLAUDE.md")
    agents_sha=$(sha_of "$workdir/AGENTS.md")
    tpl_combined=$(combined_template_sha "$category")
    cached=$(jq -c --arg s "$session" '.[$s] // empty' "$CACHE_FILE")
    if [ -z "$cached" ] || [ "$cached" = "null" ]; then
      echo "miss: no cache entry"
      exit 1
    fi
    c_claude=$(echo "$cached" | jq -r '.claude_md_sha // ""')
    c_agents=$(echo "$cached" | jq -r '.agents_md_sha // ""')
    c_tpl=$(echo "$cached" | jq -r '.template_sha // ""')
    if [ "$c_claude" = "$claude_sha" ] && [ "$c_agents" = "$agents_sha" ] && [ "$c_tpl" = "$tpl_combined" ]; then
      last_judgment=$(echo "$cached" | jq -r '.judgment // "no_action"')
      echo "skip: unchanged (last_judgment=$last_judgment)"
      exit 0
    fi
    drift=""
    [ "$c_claude" != "$claude_sha" ] && drift="${drift}claude_md,"
    [ "$c_agents" != "$agents_sha" ] && drift="${drift}agents_md,"
    [ "$c_tpl"    != "$tpl_combined" ] && drift="${drift}template,"
    echo "miss: drift=${drift%,}"
    exit 1
    ;;

  update)
    session="$1"; workdir="$2"; category="$3"; judgment="$4"
    case "$judgment" in
      clean|no_action|deferred|accepted) ;;
      *) echo "ERROR: judgment must be one of clean|no_action|deferred|accepted, got: $judgment" >&2; exit 2 ;;
    esac
    ensure_cache
    claude_sha=$(sha_of "$workdir/CLAUDE.md")
    agents_sha=$(sha_of "$workdir/AGENTS.md")
    tpl_combined=$(combined_template_sha "$category")
    now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    tmp=$(mktemp)
    jq --arg s "$session" --arg c "$claude_sha" --arg a "$agents_sha" \
       --arg t "$tpl_combined" --arg cat "$category" --arg j "$judgment" --arg ts "$now" \
       '.[$s] = {claude_md_sha:$c, agents_md_sha:$a, template_sha:$t, category:$cat, judgment:$j, last_judged_at:$ts}' \
       "$CACHE_FILE" > "$tmp" && mv "$tmp" "$CACHE_FILE"
    echo "updated $session: judgment=$judgment"
    ;;

  invalidate_category)
    category="$1"
    ensure_cache
    tmp=$(mktemp)
    jq --arg cat "$category" 'with_entries(select(.value.category != $cat))' "$CACHE_FILE" > "$tmp" && mv "$tmp" "$CACHE_FILE"
    echo "invalidated category=$category"
    ;;

  invalidate)
    session="$1"
    ensure_cache
    tmp=$(mktemp)
    jq --arg s "$session" 'del(.[$s])' "$CACHE_FILE" > "$tmp" && mv "$tmp" "$CACHE_FILE"
    echo "invalidated $session"
    ;;

  dump)
    ensure_cache
    jq . "$CACHE_FILE"
    ;;

  *)
    cat >&2 <<EOF
usage: $0 <command> [args...]
  should_skip <session> <workdir> <category>
  update <session> <workdir> <category> <judgment>
  invalidate_category <category>
  invalidate <session>
  dump
EOF
    exit 2
    ;;
esac
