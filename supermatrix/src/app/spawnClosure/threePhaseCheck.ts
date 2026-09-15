import type Database from "better-sqlite3";
import type { SpawnChildCompletedResult } from "../childSession.ts";
import type { CallerInvocation, ResultSink } from "../../domain/childCapabilities.ts";

export type FailureKind =
  | "spawn_not_started"
  | "run_error"
  | "run_timeout"
  | "empty_output"
  | "delivery_missing"
  | "late_result";

export type PhaseCheckResult = {
  phase: "communication" | "execution" | "delivery";
  passed: boolean;
  reason: string;
  failureKind?: FailureKind;
};

export type ThreePhaseResult = {
  allPassed: boolean;
  results: PhaseCheckResult[];
  firstFailure?: PhaseCheckResult;
};

type SpawnErrorResult = {
  error: "timeout" | "spawn_failed" | "run_error";
  reason?: string;
};

export function runThreePhaseCheck(input: {
  childSpawnResult: SpawnChildCompletedResult | SpawnErrorResult;
  callerInvocation?: CallerInvocation | null;
  declaredResultSinks: ResultSink[];
  db?: Database.Database;
}): ThreePhaseResult {
  const communication = checkCommunication(input.childSpawnResult);
  const execution = communication.passed
    ? checkExecution(input.childSpawnResult, resultSinksForExecution(input.childSpawnResult, input.declaredResultSinks), input.callerInvocation)
    : skipped("execution", "skipped because communication failed");
  const delivery = communication.passed && execution.passed
    ? checkDelivery(input.childSpawnResult, input.declaredResultSinks, input.db)
    : skipped("delivery", "skipped because an earlier phase failed");

  const results = [communication, execution, delivery];
  const firstFailure = results.find((result) => !result.passed);
  return {
    allPassed: firstFailure === undefined,
    results,
    ...(firstFailure ? { firstFailure } : {}),
  };
}

function checkCommunication(result: SpawnChildCompletedResult | SpawnErrorResult): PhaseCheckResult {
  if (isErrorResult(result) && result.error === "spawn_failed") {
    return {
      phase: "communication",
      passed: false,
      reason: result.reason ?? "child session did not start",
      failureKind: "spawn_not_started",
    };
  }
  return { phase: "communication", passed: true, reason: "child session started" };
}

function checkExecution(
  result: SpawnChildCompletedResult | SpawnErrorResult,
  resultSinks: ResultSink[],
  callerInvocation?: CallerInvocation | null,
): PhaseCheckResult {
  if (isErrorResult(result)) {
    if (result.error === "timeout") {
      return {
        phase: "execution",
        passed: false,
        reason: result.reason ?? "child run timed out",
        failureKind: "run_timeout",
      };
    }
    if (result.error === "run_error") {
      return {
        phase: "execution",
        passed: false,
        reason: result.reason ?? "child run failed",
        failureKind: "run_error",
      };
    }
  }

  if (!isErrorResult(result) && result.finalMessage.trim() === "") {
    if (callerInvocation === "fire_and_forget") {
      return {
        phase: "execution",
        passed: true,
        reason: "child run completed; fire_and_forget intentionally produces no output",
      };
    }
    if (resultSinks.length > 0 && resultSinks.every((sink) => sink.kind === "audit_only")) {
      return {
        phase: "execution",
        passed: true,
        reason: "child run completed; audit-only output is optional",
      };
    }
    return {
      phase: "execution",
      passed: false,
      reason: "child final message is empty",
      failureKind: "empty_output",
    };
  }

  return { phase: "execution", passed: true, reason: "child run completed with output" };
}

function checkDelivery(
  result: SpawnChildCompletedResult | SpawnErrorResult,
  sinks: ResultSink[],
  db: Database.Database | undefined,
): PhaseCheckResult {
  if (sinks.length === 0) {
    return {
      phase: "delivery",
      passed: false,
      reason: "no delivery address declared",
      failureKind: "delivery_missing",
    };
  }
  if (sinks.every((sink) => sink.kind === "http_response")) {
    return { phase: "delivery", passed: true, reason: "http_response delivery is owned by the sync handler" };
  }
  if (!db) {
    return {
      phase: "delivery",
      passed: false,
      reason: "delivery address declared but no verification database is available",
      failureKind: "delivery_missing",
    };
  }
  if (isErrorResult(result) || !result.spawnCommId) {
    return {
      phase: "delivery",
      passed: false,
      reason: "child result has no spawn comm id for delivery verification",
      failureKind: "delivery_missing",
    };
  }

  const missing = sinks.find((sink) => !deliveredSinkAttemptExists(db, result.spawnCommId!, sink.kind));
  if (missing) {
    return {
      phase: "delivery",
      passed: false,
      reason: `no successful delivery record for declared address: ${missing.kind}`,
      failureKind: "delivery_missing",
    };
  }

  return { phase: "delivery", passed: true, reason: "declared delivery address has successful delivery record" };
}

function skipped(phase: "execution" | "delivery", reason: string): PhaseCheckResult {
  return { phase, passed: false, reason };
}

function isErrorResult(result: SpawnChildCompletedResult | SpawnErrorResult): result is SpawnErrorResult {
  return "error" in result;
}

function resultSinksForExecution(
  result: SpawnChildCompletedResult | SpawnErrorResult,
  declaredResultSinks: ResultSink[],
): ResultSink[] {
  if (isErrorResult(result)) return declaredResultSinks;
  return result.session.capabilityPayload?.resultSinks ?? declaredResultSinks;
}

function deliveredSinkAttemptExists(db: Database.Database, spawnCommId: string, sinkKind: ResultSink["kind"]): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS matched
         FROM result_sink_attempts
         WHERE spawn_comm_id = ?
           AND sink_kind = ?
           AND (status = 'delivered'
                OR (status = 'skipped' AND note LIKE '%sync_inline handler owns delivery%'))
         LIMIT 1`
      )
      .get(spawnCommId, sinkKind) as { matched: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}
