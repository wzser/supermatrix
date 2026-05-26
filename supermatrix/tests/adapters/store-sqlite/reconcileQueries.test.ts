import { describe, expect, it } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { asAbsolutePath, asSessionId, asTimestamp, asMessageRunId, asLarkGroupId } from "../../../src/domain/ids.ts";

async function makeStore() {
  const store = new SqliteBindingStore(":memory:");
  await store.init();
  return store;
}

describe("reconcile queries", () => {
  it("findAllSessionsWithBackendSessionId returns only live sessions where backend_session_id IS NOT NULL", async () => {
    const store = await makeStore();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_a"),
      name: "alpha",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/tmp/a"),
      purpose: "",
      createdAt: now,
    });
    await store.createSession({
      id: asSessionId("sess_b"),
      name: "beta",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/tmp/b"),
      purpose: "",
      createdAt: now,
    });
    await store.createSession({
      id: asSessionId("sess_c"),
      name: "gamma",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/tmp/c"),
      purpose: "",
      createdAt: now,
    });
    // Attach a backend_session_id to sess_a and sess_c.
    await store.updateSessionBackendSessionId(asSessionId("sess_a"), "uuid-alpha");
    await store.updateSessionBackendSessionId(asSessionId("sess_c"), "uuid-gamma");
    // Soft-delete sess_c — the filter should exclude it.
    await store.updateSessionStatus(asSessionId("sess_c"), "deleted", now);
    const rows = await store.findAllSessionsWithBackendSessionId();
    expect(rows.map((r) => r.id)).toEqual(["sess_a"]);
    expect(rows[0].backendSessionId).toBe("uuid-alpha");
  });

  it("findRunningMessageRuns returns only rows with status='running'", async () => {
    const store = await makeStore();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_x"),
      name: "x",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/tmp/x"),
      purpose: "",
      createdAt: now,
    });
    await store.startMessageRun({
      id: asMessageRunId("mr_running"),
      sessionId: asSessionId("sess_x"),
      groupId: asLarkGroupId("g"),
      prompt: "hi",
      startedAt: now,
    });
    await store.startMessageRun({
      id: asMessageRunId("mr_done"),
      sessionId: asSessionId("sess_x"),
      groupId: asLarkGroupId("g"),
      prompt: "hi2",
      startedAt: now,
    });
    // finishMessageRun signature: (id, status, finalMessage?, error?) — positional args.
    await store.finishMessageRun(asMessageRunId("mr_done"), "completed", "ok");
    const rows = await store.findRunningMessageRuns();
    expect(rows.map((r) => r.id)).toEqual(["mr_running"]);
  });

  it("markMessageRunTimeout sets status=timeout with reason", async () => {
    const store = await makeStore();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_y"),
      name: "y",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/tmp/y"),
      purpose: "",
      createdAt: now,
    });
    await store.startMessageRun({
      id: asMessageRunId("mr_y"),
      sessionId: asSessionId("sess_y"),
      groupId: asLarkGroupId("g"),
      prompt: "hi",
      startedAt: now,
    });
    const timeoutAt = asTimestamp(2_000_000);
    await store.markMessageRunTimeout(
      asMessageRunId("mr_y"),
      "boot reconcile: orphan backend killed",
      timeoutAt,
    );
    // Verify it's no longer in the running set.
    const running = await store.findRunningMessageRuns();
    expect(running).toEqual([]);
    // Verify the persisted terminal state — a buggy implementation that
    // wrote the wrong status or dropped the reason would pass the first
    // assertion but fail here.
    const row = store.db
      .prepare("SELECT status, error_message, finished_at FROM message_runs WHERE id = ?")
      .get("mr_y") as { status: string; error_message: string; finished_at: number };
    expect(row.status).toBe("timeout");
    expect(row.error_message).toBe("boot reconcile: orphan backend killed");
    expect(row.finished_at).toBe(2_000_000);
  });

  it("markMessageRunTimeout is a no-op on terminal runs", async () => {
    const store = await makeStore();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_z"),
      name: "z",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/tmp/z"),
      purpose: "",
      createdAt: now,
    });
    await store.startMessageRun({
      id: asMessageRunId("mr_z"),
      sessionId: asSessionId("sess_z"),
      groupId: asLarkGroupId("g"),
      prompt: "hi",
      startedAt: now,
    });
    // Finish normally first — finishMessageRun writes final_message, not
    // error_message, so the terminal state we expect to survive is
    // status=completed + final_message='all good' + error_message=null.
    await store.finishMessageRun(asMessageRunId("mr_z"), "completed", "all good");
    // Then call markMessageRunTimeout — should be a no-op thanks to the
    // WHERE status = 'running' guard. Without the guard, this would
    // overwrite status to 'timeout' and clobber error_message.
    await store.markMessageRunTimeout(
      asMessageRunId("mr_z"),
      "boot reconcile: backend process gone",
      asTimestamp(2_000_000),
    );
    const row = store.db
      .prepare(
        "SELECT status, final_message, error_message FROM message_runs WHERE id = ?",
      )
      .get("mr_z") as {
        status: string;
        final_message: string | null;
        error_message: string | null;
      };
    expect(row.status).toBe("completed");
    expect(row.final_message).toBe("all good");
    expect(row.error_message).toBeNull();
  });
});
