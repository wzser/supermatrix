# Claude stream-json samples

**Status:** These are SYNTHETIC fixtures authored during implementation. They match the shape documented in the claude CLI `--output-format stream-json` reference but have not yet been validated against a live claude run. Re-record with `scripts/spike-claude-stream.sh` and replace these once a live claude CLI is available.

Used as test fixtures for `src/adapters/backend-claude/streamParser.ts`.

| file | purpose |
|---|---|
| init.jsonl | minimal startup + first session_id + trivial completion |
| normal.jsonl | simple Q&A with streamed deltas + final result |
| tool_call.jsonl | a tool_use event interleaved with assistant output |
| long_task.jsonl | many streamed deltas |
| error.jsonl | error event mid-stream |

## Observed schema (documented, synthetic)

Each line is one JSON record. Top-level `type` identifies the event kind.

- `{"session_id": "<id>"}` — emitted first; establishes the backend session id.
- `{"type":"message_delta","delta":"<chunk>"}` — streamed assistant text chunks.
- `{"type":"tool_use","name":"<tool>","input":{...}}` — tool call start.
- `{"type":"tool_result","name":"<tool>","result":{...}}` — tool result.
- `{"type":"result","result":"<final text>"}` — final assistant message / completion.
- `{"type":"error","message":"<text>"}` — error.
