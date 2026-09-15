# Local configuration contract

The agent supplies these values from its own environment. Do not commit them
or place real values in this directory.

| Variable | Required | Meaning |
|---|---:|---|
| `SM_SESSION_NAME` | yes | The local sender identity used as Spawn2.0 `from`. |
| `SM_SPAWN_URL` | yes | Local Spawn2.0 endpoint, normally `http://127.0.0.1:3501/api/spawn2.0`. |
| `JUDGMENT_JOURNAL` | yes | A local append-only JSONL path owned by this agent. |
| `EXCEPTION_LEDGER` | yes | A local append-only JSONL path for exception transactions. |
| `JUDGMENT_TABLE_ASSET` | only for real sync | The recipient's already-registered table-sync asset name. |
| `JUDGMENT_SYNC_COMMAND` | only for real sync | The recipient's existing idempotent table-sync command. |

The package does not resolve or embed a table token, table ID, field ID, chat
ID, tenant ID, user name, product name, private path, or credential. The agent
must resolve those locally through its approved configuration mechanism.

## Runtime dependencies

- Node.js `>=20.0.0`; the verification probe uses only Node built-ins.
- No npm dependencies.
- JSON Schema Draft 2020-12 for the schemas in `schemas/`.
- A host-provided Spawn2.0 v2 endpoint for real interviews or exception
  handoff. The local probe does not call it.
- A host-provided, idempotent table-sync command for real judgment rows. The
  local probe writes only a temporary JSONL projection.

## Table contract

The logical table has one machine key and two authority partitions:

| Field | Type | Authority | Write rule |
|---|---|---|---|
| `judgment_id` | string | local/program | unique key; required on every upsert |
| `ts` | integer | local/program | epoch milliseconds copied from the journal event's stamped `ts_ms` |
| `theme` | enum | local/program | `communication_gap`, `wrong_owner`, `false_success`, `duplicate_work`, `other` |
| `user_visible_symptom` | string | local/program | frequency plus visible symptom |
| `function_loss` | string | local/program | lost function, time, or trust |
| `evidence` | object | local/program | source reference plus A/B interview summaries |
| `confidence` | enum | local/program | `high`, `medium`, or `low` |
| `gray_zone_hit` | string | local/program | `none` or a local rule reference |
| `applied_to_rule` | string or null | local/program | local rule pointer, nullable |
| `user_verdict` | enum or null | human | `accurate`, `partly_accurate`, `misclassified`; program never writes it |
| `user_note` | string or null | human | human feedback; program never writes it |

The provider-generated `record_id` is a receipt field, not the upsert key and
is not copied into the public package. See `schemas/judgment-table.schema.json`
for the machine-readable form.

To append one local journal event, pass one JSON object on stdin; the command
stamps an ISO append time and epoch `ts_ms` instead of trusting caller-supplied
timestamps. The table projection copies that stamped `ts_ms` into its integer
`ts` field:

```bash
printf '%s\n' '{"kind":"pending","judgment_id":"judg-2099-01-02-001","reason":"interview unavailable"}' \
  | node scripts/append-journal.mjs "$JUDGMENT_JOURNAL"
```

For a real table write, use the configured host command with a single row from
`schemas/judgment-table.schema.json`, keyed by `judgment_id`. Do not replace it
with a direct provider API call; the host command owns idempotency and the
read-back receipt.

## Permission boundary

The agent may read its own configured journal, approved local rule files, and
the evidence returned by the host Spawn2.0/result APIs. It may append its own
ledger and submit a judgment projection through the existing idempotent sync
command. It must not write human fields, mutate schemas, copy runtime databases,
send real messages during the local acceptance probe, or create a second queue
or watcher.
