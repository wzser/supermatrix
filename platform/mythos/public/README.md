# Public mythos knowledge seed

This directory is a small, self-contained public knowledge-base seed. It is
intentionally separate from the maintainer's larger local KB: only the files
listed here are suitable for a public export.

## Use

The recipient agent uses the existing commands; there is no dedicated
installer. The repository declares Python `3.11.15` in `.python-version` and
supports `>=3.11,<3.12`. From the repository root, use the project interpreter
and verify its complete version output before running the checks:

```bash
export MYTHOS_KB_ROOT="$PWD/public"
PYTHON="$PWD/.venv/bin/python"
"$PYTHON" --version  # Python 3.11.15
"$PYTHON" scripts/build-index.py
"$PYTHON" scripts/rebuild-map.py --check
"$PYTHON" -m pytest tests/test_public_seed.py
```

The first command writes the derived reverse index to `public/_index/`.
The public query fixture is `public/fixtures/query-fixture.jsonl`; its expected
citation paths are checked by the public-seed test.

The export preserves the `public/` prefix. It excludes
`public/logs/queries/queries.jsonl` (recipient-local query history) and the
derived `public/_index/`; verification creates those two controlled runtime
artifacts only when needed. A fresh export therefore remains complete without
shipping local history or generated state.

## Optional Feishu sync configuration

Copy `public/config/sync.example.env` to a user-owned, ignored file and fill
every required value. The example contains placeholders only. An unset or
incomplete target fails closed; no maintainer wiki, table, space, token, queue
path, or runtime database is a fallback.

```bash
set -a
. ./public/config/sync.example.env
set +a
MYTHOS_KB_ROOT="$PWD/public" ./scripts/sync-kb.sh --dry-run all
```

For a real sync, remove `--dry-run` only after the recipient has configured
their own targets and approved credentials. The command uses the existing
`lark-cli` and `feishu-sync-enqueue` interfaces; it does not create a service,
queue, or installer.

## Public source and export boundary

The closed allowlist is the `public/` tree plus these existing portable
carriers:

- `scripts/build-index.py`
- `scripts/rebuild-map.py`
- `scripts/log-query.py`
- `scripts/sync-kb.sh`
- `tests/test_public_seed.py`
- `pyproject.toml`

Do not export the repository's top-level `kb/`, `logs/`, `kb/.feishu-manifest.json`,
or any local symlink. The public seed has no private records and no live
remote-resource identifiers.

Third-party source licensing and the exact captured-source hashes are recorded
in [`public/THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The source bodies
are retained verbatim; the seed adds only local provenance frontmatter and the
notice records the packaging modification.
