import { describe, expect, it, vi } from "vitest";
import { createBootOrphanedSpawnReporter } from "../../../src/app/bootSelfCheck/bootOrphanedSpawnReporter.ts";
import { asLarkGroupId, asSessionId } from "../../../src/domain/ids.ts";
import type { BootOrphanedSpawnComm } from "../../../src/ports/BindingStore.ts";

const orphanedComm: BootOrphanedSpawnComm = {
  commId: "comm_restart_orphan",
  callerSessionId: asSessionId("sess_caller"),
  callerSessionName: "caller",
  targetSessionName: "target",
  childSessionId: asSessionId("sess_child"),
  childSessionName: "child_target_restart",
};

describe("createBootOrphanedSpawnReporter", () => {
  it("reports a boot-orphaned comm to the caller binding through the canonical watcher-exception payload", async () => {
    const deliver = vi.fn(async () => {});
    const reporter = createBootOrphanedSpawnReporter({
      store: {
        async findBySession(sessionId) {
          expect(sessionId).toBe(orphanedComm.callerSessionId);
          return {
            groupId: asLarkGroupId("oc_caller"),
            sessionId,
            createdAt: 0 as never,
          };
        },
      },
      deliver,
    });

    await reporter([orphanedComm]);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith({
      kind: "spawn_exception_transaction_fallback",
      tx_id: "tx-boot-orphan-comm_restart_orphan",
      dedupe_key: "comm_restart_orphan:boot_orphaned_child",
      spawn_comm_id: "comm_restart_orphan",
      trigger_signal: "boot_orphaned_child",
      summary: "boot reconcile orphaned child spawn caller -> target (comm_restart_orphan)",
      payload: {
        caller_session: "caller",
        target_session: "target",
        child_session: "child_target_restart",
        child_session_id: "sess_child",
      },
      target_chat_id: "oc_caller",
    });
  });

  it("preserves the canonical alert fallback when the caller binding is absent", async () => {
    const deliver = vi.fn(async () => {});
    const reporter = createBootOrphanedSpawnReporter({
      store: { async findBySession() { return null; } },
      deliver,
    });

    await reporter([orphanedComm]);

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      spawn_comm_id: "comm_restart_orphan",
      target_chat_id: undefined,
    }));
  });
});
