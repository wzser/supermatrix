#!/usr/bin/env bash
# Append one skill-call tick to metrics/call-log.jsonl.
#
# Usage:   record-tick.sh <skill-name> [session-hint]
# Output:  one JSON line per call {ts, skill, session, cwd}
#
# Designed to be invoked silently from within a skill's SKILL.md at the moment
# of activation. Never fails loud — a failure here must not block the skill.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/../metrics/call-log.jsonl"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || exit 0

skill="${1:-unknown}"
session="${2:-}"
if [ -z "$session" ]; then
  # Best-effort: infer session from CWD (SM sessions live under
  # SuperMatrixRuntime/workspaces/<session>/...). Fallback: empty.
  case "$PWD" in
    */SuperMatrixRuntime/workspaces/*)
      session="$(echo "$PWD" | sed -E 's|.*/workspaces/([^/]+).*|\1|')"
      ;;
  esac
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"ts":"%s","skill":"%s","session":"%s","cwd":"%s"}\n' \
  "$ts" "$skill" "$session" "$PWD" >> "$LOG" 2>/dev/null || true

exit 0
