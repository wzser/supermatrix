import { describe, expect, test } from "vitest";
import {
  createSessionTableSyncRequester,
  type SessionTableSyncMode,
} from "../../src/app/sessionLifecycle.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("session table sync request queue", () => {
  test("coalesces normalized scoped targets but keeps one follow-up while active", async () => {
    const first = deferred();
    const secondStarted = deferred();
    const calls: Array<{ mode: SessionTableSyncMode; sessionNames: string[] }> = [];

    const request = createSessionTableSyncRequester(async (mode, sessionNames = []) => {
      calls.push({ mode, sessionNames: [...sessionNames] });
      if (calls.length === 1) await first.promise;
      if (calls.length === 2) secondStarted.resolve();
    });

    request("scoped-push-current", [" zeta ", "alpha"]);
    request("scoped-push-current", ["alpha", "zeta", "alpha"]);
    request("scoped-push-current", ["zeta", "alpha"]);

    expect(calls).toEqual([
      { mode: "scoped-push-current", sessionNames: ["alpha", "zeta"] },
    ]);

    first.resolve();
    await secondStarted.promise;
    expect(calls).toEqual([
      { mode: "scoped-push-current", sessionNames: ["alpha", "zeta"] },
      { mode: "scoped-push-current", sessionNames: ["alpha", "zeta"] },
    ]);
  });

  test("preserves FIFO for different scoped targets without dropping non-adjacent repeats", async () => {
    const first = deferred();
    const drained = deferred();
    const calls: string[][] = [];

    const request = createSessionTableSyncRequester(async (_mode, sessionNames) => {
      calls.push([...sessionNames]);
      if (calls.length === 1) await first.promise;
      if (calls.length === 3) drained.resolve();
    });

    request("scoped-push-current", ["alpha"]);
    request("scoped-push-current", ["beta"]);
    request("scoped-push-current", ["alpha"]);
    request("scoped-push-current", ["alpha"]);

    expect(calls).toEqual([["alpha"]]);
    first.resolve();
    await drained.promise;
    expect(calls).toEqual([["alpha"], ["beta"], ["alpha"]]);
  });

  test("serializes adjacent full requests and coalesces the queued duplicate", async () => {
    const first = deferred();
    const second = deferred();
    const secondStarted = deferred();
    const secondFinished = deferred();
    const calls: SessionTableSyncMode[] = [];
    let active = 0;
    let maxActive = 0;

    const request = createSessionTableSyncRequester(async (mode) => {
      const index = calls.push(mode) - 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (index === 1) secondStarted.resolve();
      try {
        await [first, second][index]!.promise;
      } finally {
        active -= 1;
        if (index === 1) secondFinished.resolve();
      }
    });

    expect(request("full")).toBeUndefined();
    request("full");
    request("full");

    expect(calls).toEqual(["full"]);
    expect(maxActive).toBe(1);

    first.resolve();
    await secondStarted.promise;
    expect(calls).toEqual(["full", "full"]);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);

    second.resolve();
    await secondFinished.promise;
    await Promise.resolve();
    expect(calls).toHaveLength(2);
  });

  test("continues with a later request after one runner failure", async () => {
    const first = deferred();
    const nextStarted = deferred();
    const calls: SessionTableSyncMode[] = [];
    const errors: unknown[] = [];
    const failure = new Error("first sync failed");

    const request = createSessionTableSyncRequester(
      async (mode) => {
        calls.push(mode);
        if (calls.length === 1) {
          await first.promise;
          return;
        }
        nextStarted.resolve();
      },
      (error) => errors.push(error),
    );

    request("full");
    request("runtime-settings-pull");
    first.reject(failure);

    await nextStarted.promise;
    expect(calls).toEqual(["full", "runtime-settings-pull"]);
    expect(errors).toEqual([failure]);
  });

  test("preserves different-mode order while coalescing only adjacent equal modes", async () => {
    const first = deferred();
    const drained = deferred();
    const calls: SessionTableSyncMode[] = [];

    const request = createSessionTableSyncRequester(async (mode) => {
      calls.push(mode);
      if (calls.length === 1) await first.promise;
      if (calls.length === 4) drained.resolve();
    });

    request("full");
    request("runtime-settings-push-current");
    request("full");
    request("runtime-settings-pull");
    request("runtime-settings-pull");

    expect(calls).toEqual(["full"]);
    first.resolve();
    await drained.promise;
    expect(calls).toEqual([
      "full",
      "runtime-settings-push-current",
      "full",
      "runtime-settings-pull",
    ]);
  });
});
