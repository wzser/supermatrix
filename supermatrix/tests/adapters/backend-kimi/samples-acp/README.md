# Kimi ACP samples

Captured with kimi-cli 1.37.0 + @zed-industries/agent-client-protocol@0.4.5
on 2026-05-08 via `scripts/probe-kimi-acp.mjs`.

Each line is one JSON object wrapped with `{ _dir, _type, ... }` so fixtures
can be parsed without depending on the ACP package. The eventTranslator
reads only `params.update` from `_type==="notif"` lines.

## Files

- `acp-init.jsonl` — initialize roundtrip only. 1 line / 638 bytes.
- `acp-prompt.jsonl` — initialize + new session + single prompt "Reply with: hello world". 28 lines / 7KB.
  Streaming updates: agent_thought_chunk chunks → agent_message_chunk chunks → end_of_turn (stopReason="end_turn").
- `acp-resume.jsonl` — same as prompt + second prompt reusing sessionId. 115 lines / 24KB.
- `acp-cancel.jsonl` — initialize + new session + long prompt + cancel after 800ms. 3 lines / 2KB.
  The 800ms cancel fired before kimi sent any prompt content — fixture contains only init-resp, available_commands_update notif, and new-session-resp.
- `acp-tool.jsonl` — initialize + new session + prompt that triggers a tool use. 33 lines / 10KB.

## Schema observations

| Slot | `params.update.sessionUpdate` value | Key field(s) in the update object |
|---|---|---|
| Assistant text chunk | `agent_message_chunk` | `update.content.text` (string), `update.content.type = "text"` |
| Agent thinking chunk | `agent_thought_chunk` | `update.content.text` (string), `update.content.type = "text"` |
| Tool call start | `tool_call` | `update.toolCallId`, `update.title`, `update.status = "in_progress"`, `update.content[]` |
| Tool call arguments streaming | `tool_call_update` | `update.toolCallId`, `update.status = "in_progress" \| "failed"`, `update.content[].content.text` |
| Session commands update | `available_commands_update` | `update.availableCommands[]` (array of {name, description}) |
| Final / end of turn | prompt-resp line `result.stopReason` | `result.stopReason = "end_turn"` |
| Token usage | not observed | — |
| Error | not observed in notif; tool rejection via `tool_call_update` with `status="failed"` | `update.status = "failed"`, `update.content[].content.text` describes rejection |

Observed `sessionUpdate` values across all fixtures:
- `available_commands_update` — always first notif after newSession
- `agent_thought_chunk` — thinking text streamed before answer
- `agent_message_chunk` — answer text streamed
- `tool_call` — tool invocation initiated
- `tool_call_update` — tool argument streaming / status update

## Cancel observation

acp-cancel.jsonl: the 800ms cancel timeout fired before kimi sent any prompt-level events. The kimi acp process accepted the cancel notification and terminated cleanly (exit code 0). No prompt-resp or prompt-err line was recorded — the promptP promise resolved via the connection closing rather than an explicit cancelled stopReason. In production, the cancel will more often interleave with streaming updates if the model is already generating.

## Resume observation

acp-resume.jsonl: calling `prompt` a second time with the same `sessionId` does preserve conversation history. The model's actual reply to "What did I just ask you?" was: "You asked me: 'Reply with: hello world'" — confirming kimi maintains session context across prompt calls on the same sessionId.

## requestPermission observation

acp-tool.jsonl: kimi sends `requestPermission` with `options = [{optionId:"approve",...}, {optionId:"approve_for_session",...}, {optionId:"reject",...}]`. The probe auto-selects the first option (`"approve"`). Note: the probe script uses `params.options?.[0]?.optionId` which correctly picks `"approve"` — however the first probe attempt used a hardcoded `"allow"` fallback which caused kimi to reject the tool call with `status="failed"`. The fixture captures this rejected path.
