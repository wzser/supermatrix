import type { ExecutorResult } from "../executors/types.js";
import { classifyFailure, type FailureClass } from "./classifyFailure.js";

export type RetryPolicy = {
  maxTransientRetries: number;
  transientDelayMs: number;
};

export type ExecuteWithRetryDeps = {
  execute: () => Promise<ExecutorResult>;
  sleep: (ms: number) => Promise<void>;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
};

export type RetryOutcome = {
  finalResult: ExecutorResult;
  attempts: number;
  transientRetries: number;
  lastClass: FailureClass | null;
};

export async function executeWithRetry(
  deps: ExecuteWithRetryDeps,
  policy: RetryPolicy,
): Promise<RetryOutcome> {
  let attempts = 0;
  let transientRetries = 0;
  let lastResult: ExecutorResult = { success: false, output: "", error: "not executed" };
  let lastClass: FailureClass = "task_issue";

  while (true) {
    attempts++;
    lastResult = await deps.execute();

    if (lastResult.success) {
      return { finalResult: lastResult, attempts, transientRetries, lastClass: null };
    }

    lastClass = classifyFailure(lastResult.error);

    if (lastClass !== "transient_network") break;
    if (transientRetries >= policy.maxTransientRetries) break;

    deps.logger.warn(
      { attempt: attempts, error: lastResult.error, delayMs: policy.transientDelayMs },
      "transient network failure; retrying",
    );
    await deps.sleep(policy.transientDelayMs);
    transientRetries++;
  }

  return { finalResult: lastResult, attempts, transientRetries, lastClass };
}
