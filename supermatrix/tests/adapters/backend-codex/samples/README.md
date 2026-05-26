# Codex --json samples

Synthetic fixtures matching the codex exec --json format (as implemented by the old feishu project's streamParser at <HOME>/feishu/src/control-plane/codex/streamParser.ts).

| file | purpose |
|---|---|
| init.jsonl | thread started + final agent message |
| normal.jsonl | commentary + final agent message |
| tool_call.jsonl | synthesized tool use (codex does not natively emit these — parser should still handle the event gracefully) |
| long_task.jsonl | many commentary messages |
| error.jsonl | error event |
