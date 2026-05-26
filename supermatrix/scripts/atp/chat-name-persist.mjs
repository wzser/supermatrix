#!/usr/bin/env -S node --experimental-strip-types
// ATP: verify FP v1.0 session-meta contract §4 option (a) for `chat_name`.
//
// Contract: workspaces/first-principle/rules/session-meta-fields.md
//   - `--chat-name <foo>` MUST still set the Feishu group name at creation
//     (the in-memory chatNamePrefix builds `{foo}-{name}-{backend}`).
//   - The lifecycle MUST NOT persist chat_name. The DB column stays NULL
//     for new rows; existing rows are grandfathered (red line: no UPDATE).
//   - Once FP `sync-session-table.sh` runs, the group is renamed to follow
//     `sessions.alias` (alias='' → fallback to `{name}-{backend}`). Users
//     who want a sticky name set alias in Bitable; --chat-name is now an
//     init-only convenience.
//
// Strategy:
// 1. Boot an in-memory SqliteBindingStore (applies migrations).
// 2. Drive the app-layer `createSessionLifecycle` with a fake LarkGateway.
// 3. lifecycle.create({ chatName: "测试群X" }) — asserts:
//      - fake Lark received createGroup with "测试群X-{name}-{backend}" prefix.
//      - sessions.chat_name row is NULL (option a — no new writers).
// 4. Negative case: a second session without --chat-name gets the legacy
//    `${name}-${backend}` group name; chat_name still NULL.

import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";
import { createSessionLifecycle } from "../../src/app/sessionLifecycle.ts";
import { asAbsolutePath } from "../../src/domain/ids.ts";

const hard = setTimeout(() => {
  console.error("FAIL: chat-name-persist ATP hit 30s hard timeout");
  process.exit(2);
}, 30_000);

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const store = new SqliteBindingStore(":memory:");
const mig = await store.init();
assert(mig.degraded.length === 0, `migrations degraded: ${JSON.stringify(mig.degraded)}`);

const now = Date.now();
const clock = { now: () => now };

// Minimal fake Lark gateway — records calls, returns group ids.
const larkCalls = [];
const lark = {
  async createGroup({ name }) {
    larkCalls.push({ op: "createGroup", name });
    return `oc_${Math.random().toString(36).slice(2, 10)}`;
  },
  async inviteUser() {},
  async dissolveGroup() {},
  async sendMessage() {},
  async updateGroupName(groupId, name) {
    larkCalls.push({ op: "updateGroupName", groupId, name });
  },
};

// Minimal fake WorkspaceFs — everything succeeds, nothing is written.
const fs = {
  async exists() { return false; },
  async mkdir() {},
  async rmrf() {},
  async writeFile() {},
  async readFile() { return ""; },
  async copyFile() {},
  async symlink() {},
  async gitInit() {},
  async gitCommit() {},
};

const TMP = "/tmp/atp-chat-name-persist";
const lifecycle = createSessionLifecycle({
  store,
  fs,
  lark,
  clock,
  workspaceRoot: asAbsolutePath(TMP),
  templatePath: asAbsolutePath(`${TMP}/template`),
  principlesTemplatesDir: asAbsolutePath(`${TMP}/principles-tpl`),
  claudeMdTemplatePath: asAbsolutePath(`${TMP}/CLAUDE.md.tpl`),
  agentsMdTemplatePath: asAbsolutePath(`${TMP}/AGENTS.md.tpl`),
  gitignorePath: asAbsolutePath(`${TMP}/.gitignore.tpl`),
  ownerUserId: "ou_test_owner",
});

// Case 1: /new with --chat-name still drives the Lark group name on creation,
// but the DB column stays NULL (option a — no new chat_name writers).
const { session: custom } = await lifecycle.create({
  backend: "claude",
  name: "s-custom",
  purpose: "",
  chatName: "测试群X",
});
assert(custom.chatName === null, `chat_name must NOT be persisted (got ${custom.chatName})`);
const createCall1 = larkCalls.find(
  (c) => c.op === "createGroup" && c.name === "测试群X-s-custom-claude",
);
assert(createCall1, "Lark createGroup must use the in-memory chatNamePrefix");

// Belt + braces: read the column directly and confirm it is NULL.
const row = store.db.prepare("SELECT chat_name FROM sessions WHERE id = ?").get(custom.id);
assert(row.chat_name === null, `DB chat_name must be NULL, got ${JSON.stringify(row)}`);

// Case 2: /new without --chat-name falls back to {name}-{backend}; chat_name NULL.
const { session: fallback } = await lifecycle.create({
  backend: "claude",
  name: "s-default",
  purpose: "",
});
assert(fallback.chatName === null, `fallback chatName should be null, got ${fallback.chatName}`);
const createCall2 = larkCalls.find((c) => c.op === "createGroup" && c.name === "s-default-claude");
assert(createCall2, "Lark createGroup fallback should be `${name}-${backend}`");

console.log(
  "PASS: --chat-name still drives Lark group name on creation; chat_name stays NULL (FP v1.0 §4 option a)",
);
clearTimeout(hard);
await store.close();
