# User-owned sync schema

This document describes the existing sync carrier's input contract. It does
not provision a table or grant permission.

## Sources asset

- Operation: `bitable_rows_upsert`
- Unique key: `source_id`
- Materialized fields: `source_id`, `title`, `author`, `source_url`, `raw_url`,
  `published`, `captured`, `content_type`, `language`, `license`, `tags`,
  `summary`, `local_path`
- Input: `kb/sources.jsonl`; one JSON object per line.

## Queries asset

- Operation: `bitable_rows_upsert`
- Unique key: `timestamp`
- Materialized fields: `timestamp`, `caller`, `intent`, `kb_state`, `prompt`,
  `concepts`, `sources`, `routing_target`, `answer_summary`, `notes`
- Input: `logs/queries/queries.jsonl`; timestamps must be non-empty and unique.

## Recipient permissions

The recipient's identity needs only the minimum access required by the chosen
operation: document overwrite for the two configured documents, wiki node
create/update if a new concept node is requested, and queue-mediated upsert on
the two recipient-owned table assets. No credential is stored in this package.
The queue worker remains the owner of terminal write/readback; this client only
submits the existing idempotent upsert request and reports accepted-pending.

All target names, URLs, node identifiers, asset identifiers, queue paths, and
credentials are required inputs. Empty or missing values fail closed for live
sync; `--dry-run` and stubs remain local-only.
