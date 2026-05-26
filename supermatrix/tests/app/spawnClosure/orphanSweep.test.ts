import { describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { recoverSpawnCommOrphans } from "../../../src/app/spawnClosure/orphanSweep.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Logger } from "../../../src/ports/Logger.ts";

function captureLogger() {
  const rows: Array<{ level: "info" | "warn"; message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    info(message, fields) {
      rows.push(fields === undefined ? { level: "info", message } : { level: "info", message, fields });
    },
    warn(message, fields) {
      rows.push(fields === undefined ? { level: "warn", message } : { level: "warn", message, fields });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, rows };
}

describe("recoverSpawnCommOrphans", () => {
  test("registers one pending spawn_async_item for an old pending spawn without a child", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    try {
      await seedSessions(store);
      await store.logCrossSessionComm({
        id: "comm_orphan_old",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "please do work",
        createdAt: asTimestamp(40_000),
      });

      const { logger, rows } = captureLogger();
      const recovered = recoverSpawnCommOrphans({
        db: store.db,
        now: asTimestamp(101_000),
        thresholdSec: 60,
        source: "startup",
        logger,
      });

      expect(recovered).toEqual([
        {
          commId: "comm_orphan_old",
          callerSession: "caller",
          targetSession: "target",
          createdAt: 40_000,
          ageSeconds: 61,
          ref: "async_orphan_comm_orphan_old",
        },
      ]);
      const row = store.db
        .prepare("SELECT * FROM spawn_async_items WHERE comm_id = ?")
        .get("comm_orphan_old") as Record<string, unknown>;
      expect(row).toMatchObject({
        ref: "async_orphan_comm_orphan_old",
        comm_id: "comm_orphan_old",
        caller_session: "caller",
        target_session: "target",
        failed_phase: "communication",
        failure_kind: "spawn_not_started",
        attempt_count: 0,
        status: "pending",
        created_at: 101_000,
        updated_at: 101_000,
      });
      expect(rows).toEqual([
        {
          level: "warn",
          message: "spawn closure",
          fields: {
            closure_event: "spawn_comm_orphan_recovered",
            comm_id: "comm_orphan_old",
            target_session: "target",
            caller_session: "caller",
            created_at: 40_000,
            age_seconds: 61,
            source: "startup",
          },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  test("is idempotent and ignores non-orphans", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    try {
      await seedSessions(store);
      await store.logCrossSessionComm({
        id: "comm_real_orphan",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "old",
        createdAt: asTimestamp(1_000),
      });
      await store.logCrossSessionComm({
        id: "comm_too_new",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "new",
        createdAt: asTimestamp(50_000),
      });
      await store.logCrossSessionComm({
        id: "comm_with_child_old",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "already started",
        createdAt: asTimestamp(1_000),
      });
      await store.logCrossSessionComm({
        id: "comm_resume_main",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "resume_main",
        prompt: "target main run",
        createdAt: asTimestamp(1_000),
      });
      store.db
        .prepare("UPDATE cross_session_log SET child_session_id = ? WHERE id = ?")
        .run("sess_child_started", "comm_with_child_old");
      await store.registerSpawnAsyncItem({
        ref: "async_existing",
        commId: "comm_real_orphan",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "communication",
        failureKind: "spawn_not_started",
        status: "pending",
        createdAt: asTimestamp(10_000),
        updatedAt: asTimestamp(10_000),
      });

      const first = recoverSpawnCommOrphans({
        db: store.db,
        now: asTimestamp(100_000),
        thresholdSec: 60,
        source: "watcher_tick",
      });
      const second = recoverSpawnCommOrphans({
        db: store.db,
        now: asTimestamp(100_000),
        thresholdSec: 60,
        source: "watcher_tick",
      });

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      const count = store.db
        .prepare("SELECT COUNT(*) AS count FROM spawn_async_items")
        .get() as { count: number };
      expect(count.count).toBe(1);
    } finally {
      await store.close();
    }
  });
});

async function seedSessions(store: SqliteBindingStore): Promise<void> {
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
  await store.createSession({
    id: asSessionId("sess_child_started"),
    name: "child-started",
    scope: "child",
    backend: "claude",
    workdir: asAbsolutePath("/tmp/target"),
    purpose: "",
    parentId: asSessionId("sess_target"),
    createdAt: asTimestamp(1),
  });
}
