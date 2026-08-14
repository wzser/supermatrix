#!/usr/bin/env bash
# Sync canonical skills under skill-master/skills/ into the active discovery
# paths via symlinks, based on scope declared in INDEX.md.
#
# Claude Code discovers shared/claude-only skills from ~/.claude/skills.
# Codex discovers shared/codex-only skills from ~/.agents/skills.
# Kimi Code 0.29+ natively discovers user skills from
# ${KIMI_CODE_HOME:-~/.kimi-code}/skills. Keep ~/.kimi/skills as a legacy
# mirror for existing direct-CLI callers while maintaining the native location
# used by ACP, whose current upstream implementation can ignore --skills-dir.
#
# Idempotent: safe to run repeatedly. Uses `ln -sfn` so existing links are
# updated atomically. Missing canonical dirs are skipped with a warning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CANONICAL="$(cd "$SCRIPT_DIR/../skills" && pwd)"
CANONICAL="$(cd "${SKILL_MASTER_CANONICAL:-$DEFAULT_CANONICAL}" && pwd)"
INDEX="${SKILL_MASTER_INDEX:-$CANONICAL/INDEX.md}"
FRONTMATTER_VALIDATOR="$SCRIPT_DIR/validate-skill-frontmatter.py"

CLAUDE_DIR="$HOME/.claude/skills"
AGENTS_DIR="$HOME/.agents/skills"
KIMI_LEGACY_DIR="$HOME/.kimi/skills"
KIMI_CODE_ROOT="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
KIMI_NATIVE_DIR="$KIMI_CODE_ROOT/skills"

if [ ! -f "$INDEX" ]; then
  echo "ERROR: no INDEX.md at $INDEX" >&2
  exit 1
fi

python3 "$FRONTMATTER_VALIDATOR" --canonical "$CANONICAL" --index "$INDEX"

mkdir -p "$CLAUDE_DIR" "$AGENTS_DIR" "$KIMI_LEGACY_DIR" "$KIMI_NATIVE_DIR"

linked=0
skipped=0
errors=0
hidden=0

remove_managed_link() {
  local path="$1"
  local expected_target="$2"
  if [ -L "$path" ] && [ "$(readlink "$path")" = "$expected_target" ]; then
    rm "$path"
  fi
}

# Parse the "## Skills" table. Rows look like:
#   | name | origin | scope | owner | purpose |
# Active rows result in symlinks. Origin=skill-master inventory-only rows remove
# only symlinks that still point at this canonical directory.
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
      ln -sfn "$src" "$KIMI_LEGACY_DIR/$name"
      ln -sfn "$src" "$KIMI_NATIVE_DIR/$name"
      echo "link  shared       $name -> ~/.claude/skills + ~/.agents/skills + $KIMI_NATIVE_DIR (+ legacy ~/.kimi/skills)"
      ;;
    claude-only)
      ln -sfn "$src" "$CLAUDE_DIR/$name"
      # If stale non-Claude links exist from a previous scope, remove them.
      [ -L "$AGENTS_DIR/$name" ] && rm "$AGENTS_DIR/$name"
      [ -L "$KIMI_LEGACY_DIR/$name" ] && rm "$KIMI_LEGACY_DIR/$name"
      [ -L "$KIMI_NATIVE_DIR/$name" ] && rm "$KIMI_NATIVE_DIR/$name"
      echo "link  claude-only  $name -> ~/.claude/skills"
      ;;
    codex-only)
      ln -sfn "$src" "$AGENTS_DIR/$name"
      [ -L "$CLAUDE_DIR/$name" ] && rm "$CLAUDE_DIR/$name"
      [ -L "$KIMI_LEGACY_DIR/$name" ] && rm "$KIMI_LEGACY_DIR/$name"
      [ -L "$KIMI_NATIVE_DIR/$name" ] && rm "$KIMI_NATIVE_DIR/$name"
      echo "link  codex-only   $name -> ~/.agents/skills"
      ;;
    inventory-only)
      remove_managed_link "$CLAUDE_DIR/$name" "$src"
      remove_managed_link "$AGENTS_DIR/$name" "$src"
      remove_managed_link "$KIMI_LEGACY_DIR/$name" "$src"
      remove_managed_link "$KIMI_NATIVE_DIR/$name" "$src"
      echo "hide  inventory    $name (canonical source retained)"
      hidden=$((hidden + 1))
      continue
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
      if ($3 == "skill-master" && ($4 == "shared" || $4 == "claude-only" || $4 == "codex-only" || $4 == "inventory-only")) {
        print $2 "\t" $4
      }
    }
  ' "$INDEX"
)

echo
echo "Summary: $linked linked, $hidden hidden, $skipped skipped, $errors errors"
[ "$errors" -gt 0 ] && exit 2 || exit 0
