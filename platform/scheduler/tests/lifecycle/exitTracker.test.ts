import { describe, it, expect } from "vitest";
import { createExitTracker } from "../../src/lifecycle/exitTracker.js";

describe("exitTracker", () => {
  it("records exit code when process finishes", async () => {
    const tracker = createExitTracker();
    tracker.register("run-1", Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      exitedAt: Date.now(),
    }));
    await new Promise((r) => setImmediate(r));
    const ctx = tracker.lookup("run-1");
    expect(ctx.exitCode).toBe(0);
  });

  it("returns exitCode=null for still-running process", () => {
    const tracker = createExitTracker();
    tracker.register("run-2", new Promise(() => {}));
    const ctx = tracker.lookup("run-2");
    expect(ctx.exitCode).toBeNull();
  });

  it("returns empty ctx for unknown run", () => {
    const tracker = createExitTracker();
    const ctx = tracker.lookup("unknown");
    expect(ctx).toEqual({});
  });
});
