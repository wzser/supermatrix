import { randomUUID } from "node:crypto";
import type { Timestamp } from "../../domain/ids.ts";
import type {
  BindingStore,
  RegisterSpawnAsyncItemInput,
  SpawnAsyncItemFailureKind,
  SpawnAsyncItemFailedPhase,
  SpawnAsyncItemStatus,
} from "../../ports/BindingStore.ts";
import type { PhaseCheckResult } from "./threePhaseCheck.ts";

type AsyncItemStore = Pick<BindingStore, "registerSpawnAsyncItem">;

export async function registerAsyncItem(input: {
  store: AsyncItemStore;
  commId: string;
  callerSession: string;
  targetSession: string;
  firstFailure: PhaseCheckResult;
  now: Timestamp;
  idFactory?: () => string;
}): Promise<{ ref: string; status: SpawnAsyncItemStatus }> {
  if (!input.firstFailure.failureKind) {
    throw new Error("cannot register async item without failureKind");
  }

  const ref = input.idFactory ? input.idFactory() : `async_${randomUUID()}`;
  const item: RegisterSpawnAsyncItemInput = {
    ref,
    commId: input.commId,
    callerSession: input.callerSession,
    targetSession: input.targetSession,
    failedPhase: input.firstFailure.phase as SpawnAsyncItemFailedPhase,
    failureKind: input.firstFailure.failureKind as SpawnAsyncItemFailureKind,
    status: statusForFailureKind(input.firstFailure.failureKind),
    createdAt: input.now,
    updatedAt: input.now,
  };
  await input.store.registerSpawnAsyncItem(item);
  return { ref, status: item.status ?? "pending" };
}

function statusForFailureKind(failureKind: NonNullable<PhaseCheckResult["failureKind"]>): SpawnAsyncItemStatus {
  if (failureKind === "run_timeout" || failureKind === "late_result") {
    return "waiting_child";
  }
  return "pending";
}
