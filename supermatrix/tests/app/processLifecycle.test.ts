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
});
