import { afterEach, describe, expect, test, vi } from "vitest";
import { closeServerWithTimeout, runWithTimeout } from "../../src/cli/bootstrap.ts";

describe("shutdown timeout guards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("runWithTimeout returns timed_out instead of waiting forever", async () => {
    vi.useFakeTimers();
    const pending = new Promise<void>(() => {});

    const resultPromise = runWithTimeout(() => pending, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toBe("timed_out");
  });

  test("closeServerWithTimeout force-closes active connections on timeout", async () => {
    vi.useFakeTimers();
    const server = {
      close: vi.fn((_callback?: (err?: Error) => void) => undefined),
      closeAllConnections: vi.fn(),
      closeIdleConnections: vi.fn(),
    };

    const resultPromise = closeServerWithTimeout(server, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toBe("timed_out");
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).not.toHaveBeenCalled();
  });
});
