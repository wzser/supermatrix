#!/usr/bin/env -S node --experimental-strip-types
// Round 2 ATP: invoke Codex backend with a trivial prompt and confirm
// that the streamParser emits a `usage` AgentEvent carrying real token
// counts from a fresh codex-cli turn.completed event.

import { CodexBackend } from "../../src/adapters/backend-codex/index.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hardTimer = setTimeout(() => {
  console.error("FAIL: ATP hit 60s hard timeout");
  process.exit(2);
}, 60_000);

const workdir = await mkdtemp(join(tmpdir(), "atp-codex-token-usage-"));

const backend = new CodexBackend({});
const session = {
  id: "atp-sess",
  name: "atp-codex-token-usage",
  alias: "",
  avatar: "",
  scope: "user",
  backend: "codex",
  model: null,
  effort: null,
  thinking: false,
  workdir,
  backendSessionId: null,
  purpose: "atp",
  status: "idle",
  parentId: null,
  depth: 0,
  inactivityTimeoutS: 60,
  maxRuntimeS: 120,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const events = [];
let usageEvent = null;

for await (const event of backend.run({
  session,
  prompt: "Reply with exactly the word PONG and nothing else.",
})) {
  events.push(event.kind);
  if (event.kind === "usage") usageEvent = event;
}

console.log("events observed:", events.join(" → "));
if (!usageEvent) {
  console.error("FAIL: no usage event captured");
  process.exit(1);
}
console.log("usage event fields:", {
  model: usageEvent.model,
  inputTokens: usageEvent.inputTokens,
  outputTokens: usageEvent.outputTokens,
  cacheReadTokens: usageEvent.cacheReadTokens,
  cacheWriteTokens: usageEvent.cacheWriteTokens,
  reasoningTokens: usageEvent.reasoningTokens,
});
if (usageEvent.inputTokens === 0 && usageEvent.outputTokens === 0) {
  console.error("FAIL: usage event has zero tokens — parser likely missed the shape");
  process.exit(1);
}
console.log("PASS: Codex side emits usage event with non-zero tokens.");

const { collectStream } = await import("../../src/app/streamCollector.ts");
const { SqliteBindingStore } = await import("../../src/adapters/store-sqlite/index.ts");

const dbStore = new SqliteBindingStore(":memory:");
await dbStore.init();
await dbStore.createSessionWithBinding(
  {
    id: "atp-sess",
    name: "atp-codex-pipeline",
    scope: "user",
    backend: "codex",
    workdir,
    purpose: "atp",
    createdAt: Date.now(),
  },
  "oc_atp"
);
await dbStore.startMessageRun({
  id: "atp-run-1",
  sessionId: "atp-sess",
  groupId: "oc_atp",
  prompt: "pipeline test",
  startedAt: Date.now(),
});

async function* replay() {
  yield { kind: "started", backendSessionId: "bsid" };
  yield usageEvent;
  yield { kind: "completed", finalMessage: "PONG" };
}

const result = await collectStream(replay());
if (!result.usage) {
  console.error("FAIL: collectStream did not capture usage");
  process.exit(1);
}
await dbStore.recordTokenUsage({
  sessionId: "atp-sess",
  messageRunId: "atp-run-1",
  backend: "codex",
  model: result.usage.model,
  inputTokens: result.usage.inputTokens,
  outputTokens: result.usage.outputTokens,
  cacheReadTokens: result.usage.cacheReadTokens,
  cacheWriteTokens: result.usage.cacheWriteTokens,
  reasoningTokens: result.usage.reasoningTokens,
  rawUsageJson: result.usage.rawUsageJson,
  createdAt: Date.now(),
});
const row = dbStore.db
  .prepare("SELECT * FROM token_usage WHERE message_run_id = 'atp-run-1'")
  .get();
await dbStore.close();
if (!row) {
  console.error("FAIL: token_usage row not found");
  process.exit(1);
}
console.log("stored row:", {
  backend: row.backend,
  model: row.model,
  input_tokens: row.input_tokens,
  output_tokens: row.output_tokens,
  cache_read_tokens: row.cache_read_tokens,
  cache_write_tokens: row.cache_write_tokens,
  reasoning_tokens: row.reasoning_tokens,
});
if (row.input_tokens !== usageEvent.inputTokens || row.output_tokens !== usageEvent.outputTokens) {
  console.error("FAIL: stored counts do not match captured usage");
  process.exit(1);
}
console.log("PASS: full pipeline (parser → collectStream → recordTokenUsage → read-back) works end-to-end.");
clearTimeout(hardTimer);
process.exit(0);
