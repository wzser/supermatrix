import { describe, expect, test } from "vitest";
import { asAbsolutePath, asMessageRunId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/cross-session-log"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore cross_session_log", () => {
  test("persists client_request_id on new comm rows", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });

      await store.logCrossSessionComm({
        id: "comm_client_request_1",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "do work",
        clientRequestId: "biz-request-store-123",
        createdAt: asTimestamp(1_700_000_100_000),
      } as Parameters<typeof store.logCrossSessionComm>[0] & { clientRequestId: string });

      const rows = await store.listAllCrossSessionComms();
      expect(rows).toHaveLength(1);
      expect((rows[0] as { clientRequestId?: string | null }).clientRequestId).toBe("biz-request-store-123");
    } finally {
      await cleanup();
    }
  });

  test("persists origin_run_id on new comm rows and async item lookups", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });

      await store.logCrossSessionComm({
        id: "comm_origin_run_1",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "do work",
        originRunId: asMessageRunId("mr_caller_batch_1"),
        createdAt: asTimestamp(1_700_000_100_000),
      });
      await store.registerSpawnAsyncItem({
        ref: "async_origin_ref",
        commId: "comm_origin_run_1",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "delivery",
        failureKind: "late_result",
        createdAt: asTimestamp(1_700_000_101_000),
        updatedAt: asTimestamp(1_700_000_101_000),
      });

      const rows = await store.listAllCrossSessionComms();
      const item = await store.getSpawnAsyncItem("async_origin_ref");

      expect(rows[0]?.originRunId).toBe("mr_caller_batch_1");
      expect(item?.originRunId).toBe("mr_caller_batch_1");
    } finally {
      await cleanup();
    }
  });

  test("resolves spawn async items through their cross-session comm", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "scheduler", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "socail-king", ...BASE });

      await store.logCrossSessionComm({
        id: "comm_async_1",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "daily review",
        createdAt: asTimestamp(1_700_000_100_000),
      });
      await store.registerSpawnAsyncItem({
        ref: "async_test_ref",
        commId: "comm_async_1",
        callerSession: "scheduler",
        targetSession: "socail-king",
        failedPhase: "execution",
        failureKind: "run_timeout",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_101_000),
        updatedAt: asTimestamp(1_700_000_101_000),
      });
      await store.finishCrossSessionComm(
        "comm_async_1",
        "completed",
        "sess_child_done",
        "REPORT: done",
        undefined,
        "REPORT: done",
        asMessageRunId("mr_done"),
      );

      const item = await store.getSpawnAsyncItem("async_test_ref");

      expect(item).toMatchObject({
        ref: "async_test_ref",
        commId: "comm_async_1",
        status: "waiting_child",
        childSessionId: "sess_child_done",
        commStatus: "completed",
        finalMessage: "REPORT: done",
        messageRunId: "mr_done",
      });
    } finally {
      await cleanup();
    }
  });
});


describe("SqliteBindingStore spawn async consumption ledger", () => {
  async function seedCompletedComm(store: Awaited<ReturnType<typeof createTempStore>>["store"]) {
    await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
    await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });
    await store.logCrossSessionComm({
      id: "comm_ledger_1",
      fromSessionId: asSessionId("sess_caller"),
      toSessionId: asSessionId("sess_target"),
      kind: "spawn",
      prompt: "do work",
      createdAt: asTimestamp(1_700_000_100_000),
    });
    await store.finishCrossSessionComm(
      "comm_ledger_1",
      "completed",
      "sess_child_done",
      "REPORT: done",
      undefined,
      "REPORT: done",
      asMessageRunId("mr_done"),
    );
  }

  test("closeSpawnAsyncItemConsumed CAS-closes an open item with caller_consumed verdict", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedCompletedComm(store);
      await store.registerSpawnAsyncItem({
        ref: "async_ledger_1",
        commId: "comm_ledger_1",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "execution",
        failureKind: "run_timeout",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_101_000),
        updatedAt: asTimestamp(1_700_000_101_000),
      });

      const consumed = await store.closeSpawnAsyncItemConsumed(
        "async_ledger_1",
        "result taken via take endpoint",
        asTimestamp(1_700_000_102_000),
      );

      expect(consumed).toBe(true);
      const item = await store.getSpawnAsyncItem("async_ledger_1");
      expect(item).toMatchObject({
        status: "closed",
        verdict: "caller_consumed",
        verdictReason: "result taken via take endpoint",
      });
      // The push path can no longer claim it.
      expect(await store.claimSpawnAsyncItemForDelivery("async_ledger_1", asTimestamp(1_700_000_103_000))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("closeSpawnAsyncItemConsumed steals delivering items; closed remains a no-op", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedCompletedComm(store);
      await store.registerSpawnAsyncItem({
        ref: "async_ledger_2",
        commId: "comm_ledger_1",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "execution",
        failureKind: "run_timeout",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_101_000),
        updatedAt: asTimestamp(1_700_000_101_000),
      });

      // Push claim wins first → take is still allowed to steal the in-flight push.
      expect(await store.claimSpawnAsyncItemForDelivery("async_ledger_2", asTimestamp(1_700_000_102_000))).not.toBeNull();
      expect(
        await store.closeSpawnAsyncItemConsumed("async_ledger_2", "late take", asTimestamp(1_700_000_103_000)),
      ).toBe(true);
      let item = await store.getSpawnAsyncItem("async_ledger_2");
      expect(item).toMatchObject({
        status: "closed",
        verdict: "caller_consumed",
        verdictReason: "late take",
      });
      // Subsequent push finalize / re-claim must both fail.
      expect(await store.claimSpawnAsyncItemForDelivery("async_ledger_2", asTimestamp(1_700_000_104_000))).toBeNull();
      expect(
        await store.markSpawnAsyncItemDelivered(
          "async_ledger_2",
          { verdict: "delivered", reason: "should not apply after take steal" },
          asTimestamp(1_700_000_104_000),
        ),
      ).toBe(false);

      // Already consumed → second take is a no-op.
      await store.registerSpawnAsyncItem({
        ref: "async_ledger_3",
        commId: "comm_ledger_1",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "execution",
        failureKind: "run_timeout",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_105_000),
        updatedAt: asTimestamp(1_700_000_105_000),
      });
      expect(
        await store.closeSpawnAsyncItemConsumed("async_ledger_3", "first take", asTimestamp(1_700_000_106_000)),
      ).toBe(true);
      expect(
        await store.closeSpawnAsyncItemConsumed("async_ledger_3", "second take", asTimestamp(1_700_000_107_000)),
      ).toBe(false);
      item = await store.getSpawnAsyncItem("async_ledger_3");
      expect(item?.verdictReason).toBe("first take");
    } finally {
      await cleanup();
    }
  });

  test("closeSpawnAsyncItemSyncDelivered closes open statuses and leaves terminal/adjudication alone", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedCompletedComm(store);
      const reason = "sync_inline response written; caller received the result over HTTP";
      const now = asTimestamp(1_700_000_200_000);

      for (const [index, status] of (["pending", "waiting_child"] as const).entries()) {
        const ref = `async_sync_${status}`;
        const commId = `comm_sync_${status}`;
        await store.logCrossSessionComm({
          id: commId,
          fromSessionId: asSessionId("sess_caller"),
          toSessionId: asSessionId("sess_target"),
          kind: "spawn",
          prompt: "do work",
          createdAt: asTimestamp(1_700_000_100_000 + index),
        });
        await store.finishCrossSessionComm(commId, "completed", undefined, "done", undefined, "full result");
        await store.registerSpawnAsyncItem({
          ref,
          commId,
          callerSession: "caller",
          targetSession: "target",
          failedPhase: "execution",
          failureKind: "run_timeout",
          status,
          createdAt: asTimestamp(1_700_000_101_000 + index),
          updatedAt: asTimestamp(1_700_000_101_000 + index),
        });
        expect(await store.closeSpawnAsyncItemSyncDelivered(commId, reason, now)).toBe(1);
        expect(await store.getSpawnAsyncItem(ref)).toMatchObject({
          status: "closed",
          verdict: "delivered",
          verdictReason: reason,
        });
      }

      // delivering: claim first, then sync-close wins.
      await store.logCrossSessionComm({
        id: "comm_sync_delivering",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "do work",
        createdAt: asTimestamp(1_700_000_110_000),
      });
      await store.finishCrossSessionComm("comm_sync_delivering", "completed", undefined, "done", undefined, "full result");
      await store.registerSpawnAsyncItem({
        ref: "async_sync_delivering",
        commId: "comm_sync_delivering",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "execution",
        failureKind: "run_timeout",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_111_000),
        updatedAt: asTimestamp(1_700_000_111_000),
      });
      expect(
        await store.claimSpawnAsyncItemForDelivery("async_sync_delivering", asTimestamp(1_700_000_112_000)),
      ).not.toBeNull();
      expect(await store.closeSpawnAsyncItemSyncDelivered("comm_sync_delivering", reason, now)).toBe(1);
      expect(await store.getSpawnAsyncItem("async_sync_delivering")).toMatchObject({
        status: "closed",
        verdict: "delivered",
        verdictReason: reason,
      });

      // closed / parked / re_driving must not move.
      for (const [index, status] of (["closed", "parked", "re_driving"] as const).entries()) {
        const ref = `async_sync_skip_${status}`;
        const commId = `comm_sync_skip_${status}`;
        await store.logCrossSessionComm({
          id: commId,
          fromSessionId: asSessionId("sess_caller"),
          toSessionId: asSessionId("sess_target"),
          kind: "spawn",
          prompt: "do work",
          createdAt: asTimestamp(1_700_000_120_000 + index),
        });
        await store.finishCrossSessionComm(commId, "completed", undefined, "done", undefined, "full result");
        await store.registerSpawnAsyncItem({
          ref,
          commId,
          callerSession: "caller",
          targetSession: "target",
          failedPhase: "execution",
          failureKind: "run_timeout",
          status,
          createdAt: asTimestamp(1_700_000_121_000 + index),
          updatedAt: asTimestamp(1_700_000_121_000 + index),
        });
        expect(await store.closeSpawnAsyncItemSyncDelivered(commId, reason, now)).toBe(0);
        expect(await store.getSpawnAsyncItem(ref)).toMatchObject({
          status,
          verdict: null,
          verdictReason: null,
        });
      }

      expect(await store.closeSpawnAsyncItemSyncDelivered("comm_nonexistent", reason, now)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("getSpawnAsyncItemByComm returns the most recently registered item for the comm", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedCompletedComm(store);
      for (const [index, ref] of ["async_bycomm_old", "async_bycomm_new"].entries()) {
        await store.registerSpawnAsyncItem({
          ref,
          commId: "comm_ledger_1",
          callerSession: "caller",
          targetSession: "target",
          failedPhase: "execution",
          failureKind: "run_timeout",
          status: "waiting_child",
          createdAt: asTimestamp(1_700_000_101_000 + index * 1000),
          updatedAt: asTimestamp(1_700_000_101_000 + index * 1000),
        });
      }

      const item = await store.getSpawnAsyncItemByComm("comm_ledger_1");
      expect(item?.ref).toBe("async_bycomm_new");
      expect(item?.finalMessage).toBe("REPORT: done");
      expect(await store.getSpawnAsyncItemByComm("comm_nonexistent")).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
