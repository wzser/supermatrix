import type { LarkGroupId } from "../../domain/ids.ts";
import type { BindingStore, BootOrphanedSpawnComm } from "../../ports/BindingStore.ts";

export type BootOrphanedSpawnWatcherException = {
  kind: "spawn_exception_transaction_fallback";
  tx_id: string;
  dedupe_key: string;
  spawn_comm_id: string;
  trigger_signal: "boot_orphaned_child";
  summary: string;
  payload: {
    caller_session: string;
    target_session: string;
    child_session: string;
    child_session_id: string;
  };
  target_chat_id: LarkGroupId | undefined;
};

export type BootOrphanedSpawnReporterDeps = {
  store: Pick<BindingStore, "findBySession">;
  deliver: (input: BootOrphanedSpawnWatcherException) => Promise<void>;
};

export type BootOrphanedSpawnReporter = (
  comms: BootOrphanedSpawnComm[],
) => Promise<void>;

export function createBootOrphanedSpawnReporter(
  deps: BootOrphanedSpawnReporterDeps,
): BootOrphanedSpawnReporter {
  return async (comms) => {
    for (const comm of comms) {
      const binding = await deps.store.findBySession(comm.callerSessionId);
      await deps.deliver(toWatcherExceptionPayload(comm, binding?.groupId));
    }
  };
}

function toWatcherExceptionPayload(
  comm: BootOrphanedSpawnComm,
  targetChatId: LarkGroupId | undefined,
): BootOrphanedSpawnWatcherException {
  return {
    kind: "spawn_exception_transaction_fallback",
    tx_id: `tx-boot-orphan-${comm.commId}`,
    dedupe_key: `${comm.commId}:boot_orphaned_child`,
    spawn_comm_id: comm.commId,
    trigger_signal: "boot_orphaned_child",
    summary: `boot reconcile orphaned child spawn ${comm.callerSessionName} -> ${comm.targetSessionName} (${comm.commId})`,
    payload: {
      caller_session: comm.callerSessionName,
      target_session: comm.targetSessionName,
      child_session: comm.childSessionName,
      child_session_id: comm.childSessionId,
    },
    target_chat_id: targetChatId,
  };
}
