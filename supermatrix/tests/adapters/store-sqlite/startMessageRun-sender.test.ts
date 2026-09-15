import { describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { asMessageRunId, asSessionId, asLarkGroupId, asTimestamp } from "../../../src/domain/ids.ts";

async function makeStore() {
  const store = new SqliteBindingStore(":memory:");
  await store.init();
  (store as any).db
    .prepare(
      `INSERT INTO sessions (id, name, alias, avatar, category, scope, backend, workdir, status, created_at, updated_at)
       VALUES ('sess_1', 'test', '', '', '', 'user', 'claude', '/tmp', 'idle', 0, 0)`
    )
    .run();
  return store;
}

describe("startMessageRun with senderId", () => {
  test("stores senderId when provided", async () => {
    const store = await makeStore();
    await store.startMessageRun({
      id: asMessageRunId("run_1"),
      sessionId: asSessionId("sess_1"),
      groupId: asLarkGroupId("oc_test"),
      prompt: "hello",
      startedAt: asTimestamp(0),
      senderId: "ou_abc123",
    });

    const row = (store as any).db
      .prepare("SELECT sender_id FROM message_runs WHERE id = 'run_1'")
      .get() as { sender_id: string | null };
    expect(row.sender_id).toBe("ou_abc123");
  });

  test("senderId is optional — stores NULL when omitted", async () => {
    const store = await makeStore();
    await store.startMessageRun({
      id: asMessageRunId("run_2"),
      sessionId: asSessionId("sess_1"),
      groupId: asLarkGroupId("oc_test"),
      prompt: "hello",
      startedAt: asTimestamp(0),
      // senderId intentionally omitted
    });

    const row = (store as any).db
      .prepare("SELECT sender_id FROM message_runs WHERE id = 'run_2'")
      .get() as { sender_id: string | null };
    expect(row.sender_id).toBeNull();
  });
});
