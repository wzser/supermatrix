# {{name}}

This is the temporary onboarding stub. After collecting `alias`, `avatar`,
`category`, and `purpose`, run the existing public command below. It returns
both `CLAUDE.md` and `AGENTS.md`; write both files and remove this stub.

```sh
FP_ROOT="${FP_ROOT:?set FP_ROOT to this bundle}"
FP_PYTHON="${FP_PYTHON:?set FP_PYTHON to Python 3.11.15}"
"$FP_ROOT/bin/fp-generate-init" \
  --session-name "$SM_SESSION_NAME" \
  --alias "$ALIAS_VALUE" \
  --avatar "$AVATAR_VALUE" \
  --category "$CATEGORY_VALUE" \
  --purpose "$PURPOSE_VALUE" \
  --backend "${SM_BACKEND:-codex}" \
  --workdir "$PWD" > "$PWD/fp-init.json"
```

Use `jq` or another JSON reader to write both `config_files[].content` values
to their declared `filename`. Then link the public full-document directory:

```sh
ln -sfn "$FP_ROOT/full-docs" ./full-docs
"$FP_PYTHON" "$FP_ROOT/scripts/fp_assemble.py" \
  --session "$SM_SESSION_NAME" --workdir "$PWD" --write
```

The static path does not read or create a private runtime database. External
metadata remains pending until an approved queue owner supplies a binding and
terminal read-back; do not call a remote API directly.
