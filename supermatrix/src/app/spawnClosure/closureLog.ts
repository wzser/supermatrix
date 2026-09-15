import type { Logger } from "../../ports/Logger.ts";
import type { FailureKind, PhaseCheckResult } from "./threePhaseCheck.ts";

type ClosureLogCommon = {
  commId: string | null;
  targetSession: string | null;
  callerSession: string | null;
  mode?: string | undefined;
  clientRequestId?: string | undefined;
  deliveryAddressKinds?: string[] | undefined;
};

export type ClosureLogEvent =
  | (ClosureLogCommon & {
      event: "admission_validation";
      result: "accepted" | "rejected";
      reason?: string | undefined;
    })
  | (ClosureLogCommon & {
      event: "phase_check";
      attempt: "first" | "repeat" | "retry";
      phase: PhaseCheckResult["phase"];
      passed: boolean;
      reason: string;
      failureKind?: FailureKind | undefined;
    })
  | (ClosureLogCommon & {
      event: "sync_retry";
      action: "triggered" | "result";
      result?: "passed" | "failed" | undefined;
      reason?: string | undefined;
      previousCommId?: string | null | undefined;
    })
  | (ClosureLogCommon & {
      event: "async_switch";
      decision: "registered" | "sync_error";
      ref?: string | undefined;
      failedPhase?: PhaseCheckResult["phase"] | undefined;
      failureKind?: FailureKind | undefined;
      reason?: string | undefined;
      nextStatus?: string | undefined;
    })
  | (ClosureLogCommon & {
      event: "state_transition";
      ref?: string | undefined;
      fromStatus?: string | undefined;
      toStatus: string;
      reason: string;
    })
  | (ClosureLogCommon & {
      event: "spawn_comm_orphan_recovered";
      createdAt: number;
      ageSeconds: number;
      source: "startup" | "watcher_tick";
    });

export function logClosureEvent(logger: Logger, event: ClosureLogEvent): void {
  const fields: Record<string, unknown> = {
    closure_event: event.event,
    comm_id: event.commId,
    target_session: event.targetSession,
    caller_session: event.callerSession,
  };
  if (event.mode !== undefined) fields.mode = event.mode;
  if (event.clientRequestId !== undefined) fields.client_request_id = event.clientRequestId;
  if (event.deliveryAddressKinds !== undefined) fields.delivery_address_kinds = event.deliveryAddressKinds;

  switch (event.event) {
    case "admission_validation":
      fields.result = event.result;
      if (event.reason !== undefined) fields.reason = event.reason;
      break;
    case "phase_check":
      fields.attempt = event.attempt;
      fields.phase = event.phase;
      fields.passed = event.passed;
      fields.reason = event.reason;
      if (event.failureKind !== undefined) fields.failure_kind = event.failureKind;
      break;
    case "sync_retry":
      fields.action = event.action;
      if (event.result !== undefined) fields.result = event.result;
      if (event.reason !== undefined) fields.reason = event.reason;
      if (event.previousCommId !== undefined) fields.previous_comm_id = event.previousCommId;
      break;
    case "async_switch":
      fields.decision = event.decision;
      if (event.ref !== undefined) fields.ref = event.ref;
      if (event.failedPhase !== undefined) fields.failed_phase = event.failedPhase;
      if (event.failureKind !== undefined) fields.failure_kind = event.failureKind;
      if (event.reason !== undefined) fields.reason = event.reason;
      if (event.nextStatus !== undefined) fields.next_status = event.nextStatus;
      break;
    case "state_transition":
      if (event.ref !== undefined) fields.ref = event.ref;
      if (event.fromStatus !== undefined) fields.from_status = event.fromStatus;
      fields.to_status = event.toStatus;
      fields.reason = event.reason;
      break;
    case "spawn_comm_orphan_recovered":
      fields.created_at = event.createdAt;
      fields.age_seconds = event.ageSeconds;
      fields.source = event.source;
      break;
  }

  if (isWarningEvent(event)) {
    logger.warn("spawn closure", fields);
  } else {
    logger.info("spawn closure", fields);
  }
}

function isWarningEvent(event: ClosureLogEvent): boolean {
  if (event.event === "admission_validation") return event.result === "rejected";
  if (event.event === "phase_check") return !event.passed;
  if (event.event === "sync_retry") return event.action === "triggered" || event.result === "failed";
  if (event.event === "async_switch") return true;
  if (event.event === "state_transition") return false;
  if (event.event === "spawn_comm_orphan_recovered") return true;
  return false;
}
