# Public KB Charter

This seed is a portable, citation-first knowledge base. The public root is
authoritative for the files included in the export; it contains no maintainer
records, credentials, runtime database, or remote-resource identifiers.

## Files and invariants

- `sources.jsonl` is the source index. Each `id` is stable and each `file` is a
  local source document with a pinned public URL, revision, license, and hash.
- `sources/*.md` contains frontmatter followed by the captured public source
  text. The source body is not rewritten into a summary.
- `concepts/*.md` contains synthesized claims and must cite only IDs present in
  `sources.jsonl`.
- `MAP.md` is the entry map. Read it before the concept and cited sources.
- `logs/queries/queries.jsonl` is an append-only query record. Use the existing
  `scripts/log-query.py` command and keep timestamps non-empty and unique.

## Scope

The seed covers agent workflow, context, and protocol boundaries. It does not
claim live provider access, a user's Feishu targets, deployment readiness, or
complete coverage of any protocol. Those require the recipient's own inputs.

## Sync safety

`scripts/sync-kb.sh` uses only recipient-supplied target configuration. Missing
configuration fails closed. `--dry-run` and test stubs are the supported local
verification path; they do not write remote documents, tables, queues, or
credentials.
