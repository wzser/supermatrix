import { describe, expect, test } from "vitest";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  scope: "user" as const,
  backend: "codex" as const,
  workdir: asAbsolutePath("/tmp/ws/spawn-async-items"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

async function seedDeliverableItem(store: Awaited<ReturnType<typeof createTempStore>>["store"], ref: string, commId: string) {
  await store.logCrossSessionComm({
    id: commId,
    fromSessionId: asSessionId("sess_caller"),
    toSessionId: asSessionId("sess_target"),
    kind: "spawn",
    prompt: "do work",
    createdAt: asTimestamp(1_700_000_100_000),
  });
  await store.finishCrossSessionComm(commId, "completed", undefined, "done", undefined, "full result");
  await store.registerSpawnAsyncItem({
    ref,
    commId,
    callerSession: "caller",
    targetSession: "target",
    failedPhase: "execution",
    failureKind: "run_timeout",
    status: "waiting_child",
    createdAt: asTimestamp(1_700_000_101_000),
    updatedAt: asTimestamp(1_700_000_101_000),
  });
}

describe("SqliteBindingStore spawn async item delivery proof", () => {
  test("delivered close stamps the verdict readable via getSpawnAsyncItemByComm", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });
      await seedDeliverableItem(store, "async_proof_1", "comm_proof_1");

      const claimed = await store.claimSpawnAsyncItemForDelivery("async_proof_1", asTimestamp(1_700_000_200_000));
      expect(claimed?.ref).toBe("async_proof_1");

      const delivered = await store.markSpawnAsyncItemDelivered(
        "async_proof_1",
        { verdict: "delivered", reason: "fast-path heartbeat todo enqueued for caller" },
        asTimestamp(1_700_000_201_000),
      );
      expect(delivered).toBe(true);

      const item = await store.getSpawnAsyncItemByComm("comm_proof_1");
      expect(item).toMatchObject({
        ref: "async_proof_1",
        commId: "comm_proof_1",
        status: "closed",
        verdict: "delivered",
        verdictReason: "fast-path heartbeat todo enqueued for caller",
        commStatus: "completed",
        finalMessage: "full result",
        attemptCount: 1,
      });
    } finally {
      await cleanup();
    }
  });

  test("delivered close is a CAS on delivering status only", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });
      await seedDeliverableItem(store, "async_proof_cas", "comm_proof_cas");

      // Not claimed: still waiting_child, so the delivered close must not apply.
      expect(
        await store.markSpawnAsyncItemDelivered(
          "async_proof_cas",
          { verdict: "delivered", reason: "should not apply" },
          asTimestamp(1_700_000_201_000),
        ),
      ).toBe(false);

      const item = await store.getSpawnAsyncItem("async_proof_cas");
      expect(item).toMatchObject({ status: "waiting_child", verdict: null, verdictReason: null });
    } finally {
      await cleanup();
    }
  });

  test("adjudication escalation cannot overwrite a delivered verdict", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });
      await seedDeliverableItem(store, "async_proof_guard", "comm_proof_guard");

      await store.claimSpawnAsyncItemForDelivery("async_proof_guard", asTimestamp(1_700_000_200_000));
      expect(
        await store.markSpawnAsyncItemDelivered(
          "async_proof_guard",
          { verdict: "delivered", reason: "fast-path heartbeat todo enqueued for caller" },
          asTimestamp(1_700_000_201_000),
        ),
      ).toBe(true);

      await store.markSpawnAsyncItemAdjudicationEscalated(
        "async_proof_guard",
        "racing adjudication tried to escalate",
        asTimestamp(1_700_000_202_000),
      );

      const item = await store.getSpawnAsyncItem("async_proof_guard");
      expect(item).toMatchObject({
        status: "closed",
        verdict: "delivered",
        verdictReason: "fast-path heartbeat todo enqueued for caller",
      });
    } finally {
      await cleanup();
    }
  });

  test("adjudication escalation cannot overwrite caller_consumed but still escalates open items", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });
      await seedDeliverableItem(store, "async_proof_consumed", "comm_proof_consumed");
      await seedDeliverableItem(store, "async_proof_open", "comm_proof_open");

      const consumed = await store.closeSpawnAsyncItemConsumed(
        "async_proof_consumed",
        "result taken via POST /api/spawn_async_items/:ref/take",
        asTimestamp(1_700_000_200_000),
      );
      expect(consumed).toBe(true);

      await store.markSpawnAsyncItemAdjudicationEscalated(
        "async_proof_consumed",
        "racing adjudication tried to escalate",
        asTimestamp(1_700_000_201_000),
      );
      await store.markSpawnAsyncItemAdjudicationEscalated(
        "async_proof_open",
        "adjudication ended without a valid transition",
        asTimestamp(1_700_000_201_000),
      );

      const consumedItem = await store.getSpawnAsyncItem("async_proof_consumed");
      expect(consumedItem).toMatchObject({ status: "closed", verdict: "caller_consumed" });

      const openItem = await store.getSpawnAsyncItem("async_proof_open");
      expect(openItem).toMatchObject({
        status: "closed",
        verdict: "escalated",
        verdictReason: "adjudication ended without a valid transition",
      });
    } finally {
      await cleanup();
    }
  });

  test("listSpawnAsyncItemsByCallerSession returns caller items with comm result fields", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });
      await store.logCrossSessionComm({
        id: "comm_list_a",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "do work",
        clientRequestId: "dedupe_a",
        createdAt: asTimestamp(1_700_000_100_000),
      });
      await store.finishCrossSessionComm("comm_list_a", "completed", undefined, "done", undefined, "full result a");
      await store.registerSpawnAsyncItem({
        ref: "async_list_a",
        commId: "comm_list_a",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "communication",
        failureKind: "spawn_not_started",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_101_000),
        updatedAt: asTimestamp(1_700_000_101_000),
      });
      await store.logCrossSessionComm({
        id: "comm_list_b",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "do work",
        clientRequestId: "dedupe_b",
        createdAt: asTimestamp(1_700_000_102_000),
      });
      await store.finishCrossSessionComm("comm_list_b", "failed", undefined, undefined, "expired");
      await store.registerSpawnAsyncItem({
        ref: "async_list_b",
        commId: "comm_list_b",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "communication",
        failureKind: "spawn_not_started",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_103_000),
        updatedAt: asTimestamp(1_700_000_103_000),
      });
      await store.logCrossSessionComm({
        id: "comm_list_other",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "do work",
        createdAt: asTimestamp(1_700_000_103_500),
      });
      await store.registerSpawnAsyncItem({
        ref: "async_other_caller",
        commId: "comm_list_other",
        callerSession: "other",
        targetSession: "target",
        failedPhase: "communication",
        failureKind: "spawn_not_started",
        status: "waiting_child",
        createdAt: asTimestamp(1_700_000_104_000),
        updatedAt: asTimestamp(1_700_000_104_000),
      });

      const items = await store.listSpawnAsyncItemsByCallerSession("caller", 10);
      expect(items.map((i) => i.ref)).toEqual(["async_list_a", "async_list_b"]);
      expect(items[0]).toMatchObject({
        ref: "async_list_a",
        commId: "comm_list_a",
        callerSession: "caller",
        commStatus: "completed",
        finalMessage: "full result a",
        clientRequestId: "dedupe_a",
      });
      expect(items[1]).toMatchObject({
        ref: "async_list_b",
        commStatus: "failed",
        errorMessage: "expired",
        clientRequestId: "dedupe_b",
      });
      expect(await store.listSpawnAsyncItemsByCallerSession("other", 10)).toHaveLength(1);
      expect(await store.listSpawnAsyncItemsByCallerSession("no_such_caller", 10)).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
