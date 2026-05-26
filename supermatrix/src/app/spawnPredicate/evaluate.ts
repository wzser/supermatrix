import type {
  PredicateEvaluationResult,
  SpawnPredicate,
} from "../../domain/spawnPredicate.ts";
import type { PredicateDbRegistry } from "../../ports/PredicateDbRegistry.ts";
import { evaluateDbRowPredicate } from "./evaluators/dbRow.ts";
import { evaluateFileMtimePredicate } from "./evaluators/fileMtime.ts";
import { evaluateGitLogPredicate } from "./evaluators/gitLog.ts";
import { evaluateHttpGetPredicate } from "./evaluators/httpGet.ts";
import { evaluateInboxMessagePredicate } from "./evaluators/inboxMessage.ts";

export type PredicateEvaluationContext = {
  allowedPathRoots?: string[];
  dbRegistry?: PredicateDbRegistry;
  env?: NodeJS.ProcessEnv;
  spawnCreatedAtMs?: number;
  now?: () => number;
};

export type PredicateEvaluatorOutcome = {
  matched: boolean;
  observed_count?: number;
  reason?: string;
  details?: Record<string, unknown>;
};

type ClassifiedError = Error & {
  predicateErrorKind?: "transient" | "permanent";
  code?: string;
};

function classifyError(error: unknown): "transient" | "permanent" {
  const err = error as ClassifiedError;
  if (err.predicateErrorKind === "transient" || err.predicateErrorKind === "permanent") {
    return err.predicateErrorKind;
  }
  const message = err instanceof Error ? err.message : String(error);
  const code = typeof err.code === "string" ? err.code : "";
  if (
    /timeout|timed out|SQLITE_BUSY|SQLITE_LOCKED|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(message) ||
    /SQLITE_BUSY|SQLITE_LOCKED|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/.test(code)
  ) {
    return "transient";
  }
  return "permanent";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutError(): ClassifiedError {
  const error = new Error("evaluation_timeout") as ClassifiedError;
  error.predicateErrorKind = "transient";
  return error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(timeoutError()), timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function durationSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export async function evaluateSpawnPredicate(
  predicate: SpawnPredicate,
  context: PredicateEvaluationContext = {}
): Promise<PredicateEvaluationResult> {
  const startedAt = Date.now();

  try {
    const outcome = await withTimeout(dispatchPredicate(predicate, context), predicate.evaluation_timeout_ms);
    const result: PredicateEvaluationResult = {
      result: outcome.matched ? "true" : "false",
      duration_ms: durationSince(startedAt),
    };
    if (outcome.observed_count !== undefined) result.observed_count = outcome.observed_count;
    if (outcome.reason !== undefined) result.reason = outcome.reason;
    if (outcome.details !== undefined) result.details = outcome.details;
    return result;
  } catch (error) {
    const kind = classifyError(error);
    return {
      result: kind === "transient" ? "transient_fail" : "permanent_fail",
      duration_ms: durationSince(startedAt),
      error_message: errorMessage(error),
      error_kind: kind,
    };
  }
}

async function dispatchPredicate(
  predicate: SpawnPredicate,
  context: PredicateEvaluationContext
): Promise<PredicateEvaluatorOutcome> {
  switch (predicate.type) {
    case "git-log":
      return evaluateGitLogPredicate(predicate, context);
    case "db-row":
      return evaluateDbRowPredicate(predicate, context);
    case "file-mtime":
      return evaluateFileMtimePredicate(predicate, context);
    case "http-get":
      return evaluateHttpGetPredicate(predicate, context);
    case "inbox-message":
      return evaluateInboxMessagePredicate(predicate, context);
  }
}
