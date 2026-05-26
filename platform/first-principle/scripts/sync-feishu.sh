#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIKI_BASE_URL="${FEISHU_WIKI_BASE_URL:-https://YOUR_TENANT.feishu.cn/wiki}"

ALL_DOCS="console-principles coding-principles business-principles claude-md-业务 claude-md-工具 claude-md-平台 claude-md-知识 claude-md-外部 claude-md-all-categories update-judgment wiki-management periodic-review-operation-manual session-meta-fields"

if ! command -v lark-cli &>/dev/null; then
  echo "ERROR: lark-cli not found in PATH"
  exit 1
fi

url_for() {
  case "$1" in
    console-principles)               echo "${WIKI_BASE_URL}/${FP_CONSOLE_PRINCIPLES_NODE_TOKEN:-CONSOLE_PRINCIPLES_NODE_TOKEN}" ;;
    coding-principles)                echo "${WIKI_BASE_URL}/${FP_CODING_PRINCIPLES_NODE_TOKEN:-CODING_PRINCIPLES_NODE_TOKEN}" ;;
    business-principles)              echo "${WIKI_BASE_URL}/${FP_BUSINESS_PRINCIPLES_NODE_TOKEN:-BUSINESS_PRINCIPLES_NODE_TOKEN}" ;;
    claude-md-业务)                   echo "${WIKI_BASE_URL}/${FP_CLAUDE_MD_BUSINESS_NODE_TOKEN:-CLAUDE_MD_BUSINESS_NODE_TOKEN}" ;;
    claude-md-工具)                   echo "${WIKI_BASE_URL}/${FP_CLAUDE_MD_TOOL_NODE_TOKEN:-CLAUDE_MD_TOOL_NODE_TOKEN}" ;;
    claude-md-平台)                   echo "${WIKI_BASE_URL}/${FP_CLAUDE_MD_PLATFORM_NODE_TOKEN:-CLAUDE_MD_PLATFORM_NODE_TOKEN}" ;;
    claude-md-知识)                   echo "${WIKI_BASE_URL}/${FP_CLAUDE_MD_KNOWLEDGE_NODE_TOKEN:-CLAUDE_MD_KNOWLEDGE_NODE_TOKEN}" ;;
    claude-md-外部)                   echo "${WIKI_BASE_URL}/${FP_CLAUDE_MD_EXTERNAL_NODE_TOKEN:-CLAUDE_MD_EXTERNAL_NODE_TOKEN}" ;;
    claude-md-all-categories)         echo "${WIKI_BASE_URL}/${FP_CLAUDE_MD_ALL_CATEGORIES_NODE_TOKEN:-CLAUDE_MD_ALL_CATEGORIES_NODE_TOKEN}" ;;
    update-judgment)                  echo "${WIKI_BASE_URL}/${FP_UPDATE_JUDGMENT_NODE_TOKEN:-UPDATE_JUDGMENT_NODE_TOKEN}" ;;
    wiki-management)                  echo "${WIKI_BASE_URL}/${FP_WIKI_MANAGEMENT_NODE_TOKEN:-WIKI_MANAGEMENT_NODE_TOKEN}" ;;
    periodic-review-operation-manual) echo "${WIKI_BASE_URL}/${FP_PERIODIC_REVIEW_NODE_TOKEN:-PERIODIC_REVIEW_NODE_TOKEN}" ;;
    session-meta-fields)              echo "${WIKI_BASE_URL}/${FP_SESSION_META_FIELDS_NODE_TOKEN:-SESSION_META_FIELDS_NODE_TOKEN}" ;;
    *) return 1 ;;
  esac
}

file_for() {
  case "$1" in
    console-principles|coding-principles|business-principles) echo "templates/$1.md" ;;
    claude-md-业务|claude-md-工具|claude-md-平台|claude-md-知识|claude-md-外部) echo "templates/$1.md" ;;
    claude-md-all-categories)         echo "__composite__" ;;
    update-judgment)                  echo "rules/update-judgment.md" ;;
    wiki-management)                  echo "rules/wiki-management.md" ;;
    periodic-review-operation-manual) echo "sop/periodic-review-operation-manual.md" ;;
    session-meta-fields)              echo "rules/session-meta-fields.md" ;;
    *) return 1 ;;
  esac
}

# Render body for claude-md-all-categories by concatenating the 5 category templates.
# Each template's first-line H1 (`# {session-name}`) is stripped; replaced by a banner H1.
render_all_categories() {
  local cat cn_name en_name banner
  for cat in 业务 工具 平台 知识 外部; do
    case "$cat" in
      业务) en_name="Business" ;;
      工具) en_name="Tool" ;;
      平台) en_name="Platform" ;;
      知识) en_name="Knowledge" ;;
      外部) en_name="External" ;;
    esac
    banner="# ${cat}（${en_name}）Category — CLAUDE.md Reference"
    echo "$banner"
    echo
    tail -n +2 "$REPO_ROOT/templates/claude-md-${cat}.md"
    echo
    echo "---"
    echo
  done
}

# Prepend a header note for non-Principles wiki pages to set context
header_note_for() {
  local name="$1"
  case "$name" in
    claude-md-业务|claude-md-工具|claude-md-平台|claude-md-知识|claude-md-外部)
      local cat="${name#claude-md-}"
      local cat_en
      case "$cat" in
        业务) cat_en="business" ;;
        工具) cat_en="tool" ;;
        平台) cat_en="platform" ;;
        知识) cat_en="knowledge" ;;
        外部) cat_en="external" ;;
      esac
      echo "> **Reference template for ${cat_en}-category session CLAUDE.md.** Maintained by first-principle. FP will not force-overwrite your file — this template is advisory. FP patrols will compare your CLAUDE.md against this template and notify you via spawn when conflicts or redundancy are found; you decide how to adapt. Keep your CLAUDE.md and AGENTS.md (if any) in sync. The corresponding \`agents-md-${cat}.md\` (for Codex backend) has an identical body. Source of truth is the git repo (first-principle/templates/); this wiki page is synced on update."
      echo
      ;;
    agents-md-业务|agents-md-工具|agents-md-平台|agents-md-知识|agents-md-外部)
      local cat="${name#agents-md-}"
      local cat_en
      case "$cat" in
        业务) cat_en="business" ;;
        工具) cat_en="tool" ;;
        平台) cat_en="platform" ;;
        知识) cat_en="knowledge" ;;
        外部) cat_en="external" ;;
      esac
      echo "> **Reference template for ${cat_en}-category session AGENTS.md (Codex backend).** Maintained by first-principle. FP will not force-overwrite your file — this template is advisory. FP patrols will compare your AGENTS.md against this template and notify you via spawn when conflicts or redundancy are found; you decide how to adapt. Keep your AGENTS.md and CLAUDE.md (if any) in sync. The corresponding \`claude-md-${cat}.md\` (for Claude backend) has an identical body. Source of truth is the git repo (first-principle/templates/); this wiki page is synced on update."
      echo
      ;;
    claude-md-all-categories)
      echo "> **Reference template — combined view of all five category CLAUDE.md references (业务/工具/平台/知识/外部).** Maintained by first-principle. FP will not force-overwrite session files — these templates are advisory; FP patrols will compare against them and notify you via spawn when conflicts or redundancy are found; the session decides how to adapt. Keep your CLAUDE.md and AGENTS.md (if any) in sync. Source of truth for each section is \`first-principle/templates/claude-md-{业务,工具,平台,知识,外部}.md\` (per-category wiki pages mirror the same sources); this wiki page is synced on every update."
      echo
      ;;
    update-judgment)
      echo "> This page mirrors \`rules/update-judgment.md\` from the first-principle workspace. FP uses these rules to decide whether to accept / reject / split / defer each incoming Principles update request. Source of truth is the git repo; this wiki page is synced on update."
      echo
      ;;
    wiki-management)
      echo "> This page mirrors \`rules/wiki-management.md\` from the first-principle workspace. FP uses these rules when other sessions or the user request a new wiki node placement under the Supermatrix root. Covers the four-bucket taxonomy, naming conventions, three-tier approval, and \`agent临时\` triage. Source of truth is the git repo; this wiki page is synced on update."
      echo
      ;;
    periodic-review-operation-manual)
      echo "> This page mirrors \`sop/periodic-review-operation-manual.md\` from the first-principle workspace. It is FP's periodic-review playbook (Gather → Synthesize → Conform → Sync), triggered by scheduler at 01:17 every other day (odd days of month, cron \`17 1 */2 * *\`). Source of truth is the git repo; this wiki page is synced on update."
      echo
      ;;
    session-meta-fields)
      echo "> This page mirrors \`rules/session-meta-fields.md\` from the first-principle workspace. It is the **single source of truth** for the format / writer / sync direction / authoritative source / validation of every session-meta column on the SuperMatrix \`sessions\` SQLite table (\`avatar\`, \`alias\`, \`category\`, \`chat_name\`, \`heartbeat_enabled\`). Implementations in \`SuperMatrix/src/\` and the heartbeat workspace MUST conform; contract revisions go through \`/first-principle\` or HTTP spawn to FP. Source of truth is the git repo; this wiki page is synced on update."
      echo
      ;;
    *) ;;
  esac
}

sync_one() {
  local name="$1"
  local url rel file
  url="$(url_for "$name")"   || { echo "ERROR: unknown document '$name'. Valid: $ALL_DOCS"; return 1; }
  rel="$(file_for "$name")"  || { echo "ERROR: no file mapping for '$name'"; return 1; }

  if [[ "$rel" == "__composite__" ]]; then
    echo "SYNC: $name (composite) → $url"
    {
      header_note_for "$name"
      case "$name" in
        claude-md-all-categories) render_all_categories ;;
        *) echo "ERROR: unknown composite '$name'"; return 1 ;;
      esac
    } | python3 "$REPO_ROOT/scripts/translate-md.py" | lark-cli docs +update \
      --doc "$url" \
      --markdown - \
      --mode overwrite
    echo "  OK: $name synced"
    return 0
  fi

  file="$REPO_ROOT/$rel"

  if [[ ! -f "$file" ]]; then
    echo "SKIP: $file not found"
    return 1
  fi

  echo "SYNC: $name ($rel) → $url"
  {
    header_note_for "$name"
    cat "$file"
  } | python3 "$REPO_ROOT/scripts/translate-md.py" | lark-cli docs +update \
    --doc "$url" \
    --markdown - \
    --mode overwrite

  echo "  OK: $name synced"
}

if [[ $# -eq 0 ]]; then
  echo "Syncing all principles + rules + SOPs to Feishu wiki..."
  failed=0
  for name in $ALL_DOCS; do
    sync_one "$name" || ((failed++))
  done
  echo "Done. Failures: $failed"
  exit $failed
else
  for name in "$@"; do
    sync_one "$name"
  done
fi
