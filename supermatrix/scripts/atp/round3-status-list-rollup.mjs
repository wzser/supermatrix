#!/usr/bin/env -S node --experimental-strip-types
// Round 3 ATP: verify that /status and /list correctly roll up child-session
// token usage into their parent via the recursive CTE, rendered compactly.

import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";
import { createStatusHandler } from "../../src/app/commands/status.ts";
import { createListHandler } from "../../src/app/commands/listSessions.ts";

const hard = setTimeout(() => {
  console.error("FAIL: Round 3 ATP hit 30s hard timeout");
  process.exit(2);
}, 30_000);

const store = new SqliteBindingStore(":memory:");
await store.init();

const now = Date.now();
const clock = { now: () => now };

// Build tree: parent "user-sess" has two direct children (one claude, one codex).
await store.createSessionWithBinding(
  {
    id: "user-sess",
    name: "user-sess",
    scope: "user",
    backend: "claude",
    workdir: "/tmp/ws/user",
    purpose: "atp",
    createdAt: now - 3600_000,
  },
  "oc_user"
);
await store.createSession({
  id: "child-a",
  name: "child-a",
  scope: "child",
  backend: "claude",
  workdir: "/tmp/ws/user",
  purpose: "",
  createdAt: now - 1800_000,
  parentId: "user-sess",
  depth: 1,
});
await store.createSession({
  id: "child-b",
  name: "child-b",
  scope: "child",
  backend: "codex",
  workdir: "/tmp/ws/user",
  purpose: "",
  createdAt: now - 600_000,
  parentId: "user-sess",
  depth: 1,
});

// Parent run
await store.startMessageRun({
  id: "mr_parent_1",
  sessionId: "user-sess",
  groupId: "oc_user",
  prompt: "p",
  startedAt: now - 3000_000,
});
await store.recordTokenUsage({
  sessionId: "user-sess",
  messageRunId: "mr_parent_1",
  backend: "claude",
  model: "claude-opus-4-7",
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 5000,
  cacheWriteTokens: 2000,
  reasoningTokens: 0,
  rawUsageJson: null,
  createdAt: now - 3000_000,
});

// Child A run
await store.startMessageRun({
  id: "mr_a_1",
  sessionId: "child-a",
  groupId: "spawn:user-sess",
  prompt: "a",
  startedAt: now - 1700_000,
});
await store.recordTokenUsage({
  sessionId: "child-a",
  messageRunId: "mr_a_1",
  backend: "claude",
  model: "claude-opus-4-7",
  inputTokens: 200,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  rawUsageJson: null,
  createdAt: now - 1700_000,
});

// Child B run (Codex; reasoning nonzero to prove formatting)
await store.startMessageRun({
  id: "mr_b_1",
  sessionId: "child-b",
  groupId: "spawn:user-sess",
  prompt: "b",
  startedAt: now - 500_000,
});
await store.recordTokenUsage({
  sessionId: "child-b",
  messageRunId: "mr_b_1",
  backend: "codex",
  model: "gpt-5-codex",
  inputTokens: 300,
  outputTokens: 50,
  cacheReadTokens: 150,
  cacheWriteTokens: 0,
  reasoningTokens: 25,
  rawUsageJson: null,
  createdAt: now - 500_000,
});

const statusHandler = createStatusHandler({ store, clock });
const listHandler = createListHandler({ store, clock });

// /status user-sess — should show parent + both children aggregated
const statusRes = await statusHandler({
  args: { name: "user-sess" },
  scope: "root",
  msg: { groupId: "oc_root", text: "", userId: "u", messageId: "m" },
});
console.log("=== /status user-sess ===");
console.log(statusRes.replyText);
console.log();

// Expect: cumulative input = 1000 + 200 + 300 = 1500, output = 500+100+50 = 650,
// cache read = 5000+0+150 = 5150, cache write = 2000, reasoning = 25
const expectedCumulativeInput = 1500;
const expectedCumulativeOutput = 650;
if (!statusRes.replyText.includes("1.5k/650")) {
  console.error(`FAIL: /status missing expected cumulative '1.5k/650'; got: ${statusRes.replyText}`);
  process.exit(1);
}
if (!statusRes.replyText.includes("+25r")) {
  console.error(`FAIL: /status missing reasoning '+25r' (from codex child)`);
  process.exit(1);
}

// /status child-a — should show ONLY child-a (200/100), not sibling child-b
const childStatus = await statusHandler({
  args: { name: "child-a" },
  scope: "root",
  msg: { groupId: "oc_root", text: "", userId: "u", messageId: "m" },
});
if (!childStatus.replyText.includes("200/100")) {
  console.error(`FAIL: /status child-a should show only 200/100; got: ${childStatus.replyText}`);
  process.exit(1);
}
if (childStatus.replyText.includes("1.5k/650")) {
  console.error(`FAIL: /status child-a leaked parent's aggregate`);
  process.exit(1);
}

// /list — iterates all ACTIVE sessions; child sessions were created but status
// stays 'initializing' by default so they may not appear. Flip them to idle.
// Actually listActiveSessions returns any non-deleted scope IN (root,user),
// so children do NOT appear in /list — that's correct. Just check parent.
await store.updateSessionStatus("user-sess", "idle", now);
const listRes = await listHandler({
  args: {},
  scope: "root",
  msg: { groupId: "oc_root", text: "", userId: "u", messageId: "m" },
});
console.log("=== /list ===");
console.log(listRes.replyText);
console.log();

if (!listRes.replyText.includes("user-sess")) {
  console.error("FAIL: /list missing user-sess");
  process.exit(1);
}
if (!listRes.replyText.includes("1.5k/650")) {
  console.error("FAIL: /list user-sess should show rolled-up totals");
  process.exit(1);
}

await store.close();
console.log("PASS: /status and /list correctly roll up descendants via recursive CTE.");
clearTimeout(hard);
process.exit(0);
