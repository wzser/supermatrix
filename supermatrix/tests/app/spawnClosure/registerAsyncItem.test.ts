import { describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { registerAsyncItem } from "../../../src/app/spawnClosure/registerAsyncItem.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";

describe("registerAsyncItem", () => {
  test("writes a pending spawn_async_items row through BindingStore", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    try {
      await store.createSession({
        id: asSessionId("sess_caller"),
        name: "caller",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/tmp/caller"),
        purpose: "",
        createdAt: asTimestamp(1),
      });
      await store.createSession({
        id: asSessionId("sess_target"),
        name: "target",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/tmp/target"),
        purpose: "",
        createdAt: asTimestamp(1),
      });
      await store.logCrossSessionComm({
        id: "comm_async_test",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "hello",
        createdAt: asTimestamp(2),
      });

      const result = await registerAsyncItem({
        store,
        commId: "comm_async_test",
        callerSession: "caller",
        targetSession: "target",
        firstFailure: {
          phase: "execution",
          passed: false,
          reason: "child final message is empty",
          failureKind: "empty_output",
        },
        now: asTimestamp(3),
        idFactory: () => "async_test_ref",
      });

      expect(result).toEqual({ ref: "async_test_ref", status: "pending" });
      const row = store.db
        .prepare("SELECT * FROM spawn_async_items WHERE ref = ?")
        .get("async_test_ref") as Record<string, unknown>;
      expect(row).toMatchObject({
        ref: "async_test_ref",
        comm_id: "comm_async_test",
        caller_session: "caller",
        target_session: "target",
        failed_phase: "execution",
        failure_kind: "empty_output",
        attempt_count: 0,
        status: "pending",
        verdict: null,
        verdict_reason: null,
        created_at: 3,
        updated_at: 3,
        last_attempt_at: null,
      });
    } finally {
      await store.close();
    }
  });

  test("writes waiting_child status for timeout or late result follow-up", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    try {
      await store.createSession({
        id: asSessionId("sess_caller"),
        name: "caller",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/tmp/caller"),
        purpose: "",
        createdAt: asTimestamp(1),
      });
      await store.createSession({
        id: asSessionId("sess_target"),
        name: "target",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/tmp/target"),
        purpose: "",
        createdAt: asTimestamp(1),
      });
      await store.logCrossSessionComm({
        id: "comm_waiting_child",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "hello",
        createdAt: asTimestamp(2),
      });

      await registerAsyncItem({
        store,
        commId: "comm_waiting_child",
        callerSession: "caller",
        targetSession: "target",
        firstFailure: {
          phase: "execution",
          passed: false,
          reason: "sync caller stopped waiting while child is still running",
          failureKind: "run_timeout",
        },
        now: asTimestamp(3),
        idFactory: () => "async_waiting_child",
      });

      const row = store.db
        .prepare("SELECT status, failure_kind FROM spawn_async_items WHERE ref = ?")
        .get("async_waiting_child") as { status: string; failure_kind: string };
      expect(row).toEqual({
        status: "waiting_child",
        failure_kind: "run_timeout",
      });
    } finally {
      await store.close();
    }
  });
});
