import { describe, expect, test } from "vitest";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

describe("sqlite spawn throttle queue", () => {
  test("enqueues and claims pending items FIFO per parent", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const parent = await store.createSession({
        id: asSessionId("sess_parent"),
        name: "parent",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/parent"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      const caller = await store.createSession({
        id: asSessionId("sess_caller"),
        name: "caller",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/caller"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      await store.logCrossSessionComm({
        id: "comm_fifo_1",
        fromSessionId: caller.id,
        toSessionId: parent.id,
        kind: "spawn",
        prompt: "one",
        createdAt: asTimestamp(1000),
      });
      await store.logCrossSessionComm({
        id: "comm_fifo_2",
        fromSessionId: caller.id,
        toSessionId: parent.id,
        kind: "spawn",
        prompt: "two",
        createdAt: asTimestamp(1001),
      });

      await store.enqueueSpawnQueueItem({
        id: "spawnq_1",
        parentId: parent.id,
        spawnInputJson: JSON.stringify({ prompt: "one" }),
        callerSession: caller.id,
        commId: "comm_fifo_1",
        createdAt: asTimestamp(1000),
        ttlSec: 86_400,
      });
      await store.enqueueSpawnQueueItem({
        id: "spawnq_2",
        parentId: parent.id,
        spawnInputJson: JSON.stringify({ prompt: "two" }),
        callerSession: caller.id,
        commId: "comm_fifo_2",
        createdAt: asTimestamp(1001),
        ttlSec: 86_400,
      });

      expect(await store.countPendingSpawnQueueItemsByParent(parent.id)).toBe(2);
      const first = await store.claimNextSpawnQueueItem(parent.id, asTimestamp(2000));
      const second = await store.claimNextSpawnQueueItem(parent.id, asTimestamp(2001));
      const empty = await store.claimNextSpawnQueueItem(parent.id, asTimestamp(2002));

      expect(first?.id).toBe("spawnq_1");
      expect(first?.status).toBe("dispatched");
      expect(second?.id).toBe("spawnq_2");
      expect(empty).toBeNull();
      expect(await store.countPendingSpawnQueueItemsByParent(parent.id)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("expires pending items whose TTL elapsed", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const parent = await store.createSession({
        id: asSessionId("sess_parent"),
        name: "parent",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/parent"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      const caller = await store.createSession({
        id: asSessionId("sess_caller"),
        name: "caller",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/caller"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      await store.logCrossSessionComm({
        id: "comm_expire_1",
        fromSessionId: caller.id,
        toSessionId: parent.id,
        kind: "spawn",
        prompt: "expired",
        createdAt: asTimestamp(1000),
      });
      await store.enqueueSpawnQueueItem({
        id: "spawnq_expire_1",
        parentId: parent.id,
        spawnInputJson: JSON.stringify({ prompt: "expired" }),
        callerSession: caller.id,
        commId: "comm_expire_1",
        createdAt: asTimestamp(1000),
        ttlSec: 1,
      });

      const expired = await store.expireSpawnQueueItemsByParent(parent.id, asTimestamp(2501));

      expect(expired.map((item) => item.id)).toEqual(["spawnq_expire_1"]);
      expect(await store.countPendingSpawnQueueItemsByParent(parent.id)).toBe(0);
      const row = store.db
        .prepare("SELECT status FROM spawn_queue WHERE id = ?")
        .get("spawnq_expire_1") as { status: string };
      expect(row.status).toBe("expired");
    } finally {
      await cleanup();
    }
  });
});
