# Public three-skill setup example

This example uses the existing sync, validation, and discovery commands. It
does not install a new launcher or enable any skill outside the public index.

```sh
export SKILL_MASTER_CANONICAL="$PWD/skills"
export SKILL_MASTER_ROOT="$PWD"
export SKILL_MASTER_INDEX="$PWD/docs/onboarding-v1-skill-index.md"
export SKILL_MASTER_CONFIG="$PWD/docs/onboarding-v1-skill-discovery.json"

PYTHON_BIN="${SKILL_MASTER_PYTHON:-}"
if [ -z "$PYTHON_BIN" ] && [ -x "$SKILL_MASTER_ROOT/.venv/bin/python" ]; then
  PYTHON_BIN="$SKILL_MASTER_ROOT/.venv/bin/python"
fi
if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "ERROR: Python 3.11.15 is required; set SKILL_MASTER_PYTHON to its executable" >&2
  exit 1
fi
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info[:3] == (3, 11, 15) else 1)' || {
  echo "ERROR: selected Python must be 3.11.15: $PYTHON_BIN" >&2
  exit 1
}
export SKILL_MASTER_PYTHON="$PYTHON_BIN"

bash scripts/sync-skills.sh
"$PYTHON_BIN" scripts/validate-skill-frontmatter.py \
  --canonical "$SKILL_MASTER_CANONICAL" \
  --index "$SKILL_MASTER_INDEX"
"$PYTHON_BIN" scripts/audit-skill-discovery.py \
  --config "$SKILL_MASTER_CONFIG" \
  --index "$SKILL_MASTER_INDEX" \
  --canonical "$SKILL_MASTER_CANONICAL" \
  --discovery-root "$HOME/.agents/skills" \
  --json
```

The index is the enablement allowlist. A receiving agent supplies its own
isolated `HOME` when testing and its own private mirror credentials only if it
chooses to configure the existing Feishu owner-side sync path.
