#!/usr/bin/env bash
# Sync canonical skills under skill-master/skills/ into Claude's and Codex's
# discovery paths via symlinks, based on scope declared in INDEX.md.
#
# Idempotent: safe to run repeatedly. Uses `ln -sfn` so existing links are
# updated atomically. Missing canonical dirs are skipped with a warning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$(cd "$SCRIPT_DIR/../skills" && pwd)"
INDEX="$CANONICAL/INDEX.md"

CLAUDE_DIR="$HOME/.claude/skills"
AGENTS_DIR="$HOME/.agents/skills"

if [ ! -f "$INDEX" ]; then
  echo "ERROR: no INDEX.md at $INDEX" >&2
  exit 1
fi

mkdir -p "$CLAUDE_DIR" "$AGENTS_DIR"

linked=0
skipped=0
errors=0

# Parse the "## Skills" table. Rows look like:
#   | name | origin | scope | owner | purpose |
# Only rows with origin=skill-master AND scope ∈ {shared,claude-only,codex-only}
# result in a symlink. All other rows (claude-builtin / codex-builtin /
# inventory-only) are registration-only and ignored here.
while IFS=$'\t' read -r name scope; do
  [ -z "$name" ] && continue
  src="$CANONICAL/$name"
  if [ ! -d "$src" ]; then
    echo "skip  $name: canonical dir missing ($src)"
    skipped=$((skipped + 1))
    continue
  fi

  case "$scope" in
    shared)
      ln -sfn "$src" "$CLAUDE_DIR/$name"
      ln -sfn "$src" "$AGENTS_DIR/$name"
      echo "link  shared       $name -> ~/.claude/skills + ~/.agents/skills"
      ;;
    claude-only)
      ln -sfn "$src" "$CLAUDE_DIR/$name"
      # If a stale codex-side link exists from a previous scope, remove it.
      [ -L "$AGENTS_DIR/$name" ] && rm "$AGENTS_DIR/$name"
      echo "link  claude-only  $name -> ~/.claude/skills"
      ;;
    codex-only)
      ln -sfn "$src" "$AGENTS_DIR/$name"
      [ -L "$CLAUDE_DIR/$name" ] && rm "$CLAUDE_DIR/$name"
      echo "link  codex-only   $name -> ~/.agents/skills"
      ;;
    *)
      echo "skip  $name: unknown scope '$scope'"
      errors=$((errors + 1))
      continue
      ;;
  esac
  linked=$((linked + 1))
done < <(
  awk -F'|' '
    /^\|/ {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $4)
      if ($3 == "skill-master" && ($4 == "shared" || $4 == "claude-only" || $4 == "codex-only")) {
        print $2 "\t" $4
      }
    }
  ' "$INDEX"
)

echo
echo "Summary: $linked linked, $skipped skipped, $errors errors"
[ "$errors" -gt 0 ] && exit 2 || exit 0
