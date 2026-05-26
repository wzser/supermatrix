import { describe, it, expect, vi } from "vitest";
import { executeWithRetry } from "../../src/notify/executeWithRetry.js";
import type { ExecutorResult } from "../../src/executors/types.js";

function success(output = "ok"): ExecutorResult {
  return { success: true, output, error: null };
}
function fail(error: string): ExecutorResult {
  return { success: false, output: "", error };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("executeWithRetry", () => {
  it("returns immediately on first-try success without sleeping", async () => {
    const execute = vi.fn().mockResolvedValue(success());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await executeWithRetry(
      { execute, sleep, logger: makeLogger() },
      { maxTransientRetries: 2, transientDelayMs: 1000 },
    );

    expect(outcome.finalResult.success).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(outcome.transientRetries).toBe(0);
    expect(outcome.lastClass).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on transient network failure and returns success when retry succeeds", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(fail("TypeError: fetch failed"))
      .mockResolvedValueOnce(success("recovered"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await executeWithRetry(
      { execute, sleep, logger: makeLogger() },
      { maxTransientRetries: 2, transientDelayMs: 15_000 },
    );

    expect(outcome.finalResult.success).toBe(true);
    expect(outcome.finalResult.output).toBe("recovered");
    expect(outcome.attempts).toBe(2);
    expect(outcome.transientRetries).toBe(1);
    expect(outcome.lastClass).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("exhausts transient retries and reports lastClass=transient_network", async () => {
    const execute = vi.fn().mockResolvedValue(fail("connect ECONNREFUSED 127.0.0.1:3501"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await executeWithRetry(
      { execute, sleep, logger: makeLogger() },
      { maxTransientRetries: 2, transientDelayMs: 100 },
    );

    expect(outcome.finalResult.success).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(outcome.transientRetries).toBe(2);
    expect(outcome.lastClass).toBe("transient_network");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry task_issue failures", async () => {
    const execute = vi.fn().mockResolvedValue(fail("TypeError: Cannot read properties of undefined"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await executeWithRetry(
      { execute, sleep, logger: makeLogger() },
      { maxTransientRetries: 3, transientDelayMs: 1000 },
    );

    expect(outcome.finalResult.success).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(outcome.transientRetries).toBe(0);
    expect(outcome.lastClass).toBe("task_issue");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying once failure reclassifies from transient to task_issue", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(fail("TypeError: fetch failed"))
      .mockResolvedValueOnce(fail("HTTP 400: bad request"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await executeWithRetry(
      { execute, sleep, logger: makeLogger() },
      { maxTransientRetries: 3, transientDelayMs: 100 },
    );

    expect(outcome.finalResult.success).toBe(false);
    expect(outcome.finalResult.error).toBe("HTTP 400: bad request");
    expect(outcome.attempts).toBe(2);
    expect(outcome.transientRetries).toBe(1);
    expect(outcome.lastClass).toBe("task_issue");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("treats maxTransientRetries=0 as classification-only (no retry even for transient)", async () => {
    const execute = vi.fn().mockResolvedValue(fail("socket hang up"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await executeWithRetry(
      { execute, sleep, logger: makeLogger() },
      { maxTransientRetries: 0, transientDelayMs: 1000 },
    );

    expect(outcome.finalResult.success).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(outcome.transientRetries).toBe(0);
    expect(outcome.lastClass).toBe("transient_network");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
