import { describe, it, expect, vi } from "vitest";
import { createProcessLifecycle } from "../../src/app/processLifecycle.ts";

describe("processLifecycle", () => {
  const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };

  it("does not exit when no restart is pending", async () => {
    const onExit = vi.fn();
    const lc = createProcessLifecycle({ onExit, logger: noopLogger });
    lc.runStarted();
    lc.runFinished();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("exits when restart is pending and in-flight drops to zero", async () => {
    const onExit = vi.fn().mockResolvedValue(undefined);
    const lc = createProcessLifecycle({ onExit, logger: noopLogger });
    lc.runStarted();
    lc.requestRestart("test reason");
    lc.runFinished();
    await new Promise((r) => setImmediate(r));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("does not exit while in-flight > 0 even if restart is pending", () => {
    const onExit = vi.fn();
    const lc = createProcessLifecycle({ onExit, logger: noopLogger });
    lc.runStarted();
    lc.runStarted();
    lc.requestRestart("test");
    lc.runFinished();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("force restart exits immediately regardless of in-flight", async () => {
    const onExit = vi.fn().mockResolvedValue(undefined);
    const lc = createProcessLifecycle({ onExit, logger: noopLogger });
    lc.runStarted();
    lc.requestRestart("force test", { force: true, source: "user" });
    await new Promise((r) => setImmediate(r));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("requestRestart with no in-flight exits immediately", async () => {
    const onExit = vi.fn().mockResolvedValue(undefined);
    const lc = createProcessLifecycle({ onExit, logger: noopLogger });
    lc.requestRestart("idle restart");
    await new Promise((r) => setImmediate(r));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("exposes reason and source", () => {
    const lc = createProcessLifecycle({ onExit: vi.fn().mockResolvedValue(undefined), logger: noopLogger });
    lc.requestRestart("src change: foo.ts", { source: "src-watcher" });
    expect(lc.reason()).toBe("src change: foo.ts");
    expect(lc.source()).toBe("src-watcher");
    expect(lc.isPending()).toBe(true);
  });

  it("does not call onExit twice", async () => {
    const onExit = vi.fn().mockResolvedValue(undefined);
    const lc = createProcessLifecycle({ onExit, logger: noopLogger });
    lc.requestRestart("a");
    lc.requestRestart("b");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("escalates to a forced exit after the drain window when runs stay in flight", async () => {
    vi.useFakeTimers();
    try {
      const onExit = vi.fn().mockResolvedValue(undefined);
      const lc = createProcessLifecycle({ onExit, logger: noopLogger });
      lc.runStarted(); // in flight, never finishes
      lc.requestRestart("/reload", { source: "user (console)", drainTimeoutMs: 20_000 });
      await vi.advanceTimersByTimeAsync(19_000);
      expect(onExit).not.toHaveBeenCalled(); // still draining, not forced yet
      await vi.advanceTimersByTimeAsync(2_000); // cross the 20s window
      expect(onExit).toHaveBeenCalledTimes(1); // escalated to a forced exit
      expect(lc.isForce()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits gracefully (not forced) and cancels the drain timer when runs finish before the window", async () => {
    vi.useFakeTimers();
    try {
      const onExit = vi.fn().mockResolvedValue(undefined);
      const lc = createProcessLifecycle({ onExit, logger: noopLogger });
      lc.runStarted();
      lc.requestRestart("/reload", { drainTimeoutMs: 20_000 });
      lc.runFinished(); // drops to zero before the window elapses
      await vi.advanceTimersByTimeAsync(0);
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(lc.isForce()).toBe(false); // graceful drain, not a forced kill
      await vi.advanceTimersByTimeAsync(30_000); // drain timer must have been cleared
      expect(onExit).toHaveBeenCalledTimes(1); // no double exit
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a drain window on an already-pending restart so it can't defer forever", async () => {
    vi.useFakeTimers();
    try {
      const onExit = vi.fn().mockResolvedValue(undefined);
      const lc = createProcessLifecycle({ onExit, logger: noopLogger });
      lc.runStarted();
      lc.requestRestart("src change: foo.ts", { source: "src-watcher" }); // pending, no drain
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onExit).not.toHaveBeenCalled(); // no drain armed → waits on in-flight
      lc.requestRestart("/reload", { source: "user (console)", drainTimeoutMs: 20_000 });
      await vi.advanceTimersByTimeAsync(20_001);
      expect(onExit).toHaveBeenCalledTimes(1); // the later drain window forces it
      expect(lc.reason()).toBe("src change: foo.ts"); // original reason preserved
    } finally {
      vi.useRealTimers();
    }
  });
});
