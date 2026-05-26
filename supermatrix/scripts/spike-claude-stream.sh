#!/usr/bin/env bash
set -euo pipefail
dest="${1:-tests/adapters/backend-claude/samples}"
mkdir -p "$dest"
echo "Recording init + simple completion..."
claude -p "say hi" --output-format stream-json --verbose > "$dest/init.jsonl"
echo "Recording normal completion..."
claude -p "what is 2+2?" --output-format stream-json --verbose > "$dest/normal.jsonl"
echo "Recording tool_call..."
claude -p "list files in this directory using the Bash tool" --output-format stream-json --verbose > "$dest/tool_call.jsonl"
echo "Recording long task..."
claude -p "count from 1 to 20, printing each number on its own line" --output-format stream-json --verbose > "$dest/long_task.jsonl"
echo "Recording error (empty prompt)..."
claude -p "" --output-format stream-json --verbose > "$dest/error.jsonl" || true
echo "Done. Sample lines:"
wc -l "$dest"/*.jsonl
