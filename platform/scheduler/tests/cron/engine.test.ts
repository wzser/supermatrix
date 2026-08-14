import { describe, it, expect, vi } from "vitest";
import { createCronEngine, validateCron } from "../../src/cron/engine.js";

describe("cron engine", () => {
  it("validateCron accepts a good pattern and rejects garbage", () => {
    expect(validateCron("0 9 * * *")).toBe(true);
    expect(validateCron("not a cron")).toBe(false);
  });

  it("register exposes a nextRun via list()", () => {
    const eng = createCronEngine();
    eng.register("t1", "0 9 * * *", () => {});
    const listed = eng.list().find((e) => e.name === "t1");
    expect(listed?.nextRun).toBeInstanceOf(Date);
    eng.stopAll();
  });

  it("trigger() invokes the handler synchronously", () => {
    const eng = createCronEngine();
    const fn = vi.fn();
    eng.register("t1", "0 9 * * *", fn);
    eng.trigger("t1");
    expect(fn).toHaveBeenCalledOnce();
    eng.stopAll();
  });

  it("unregister stops and removes a job", () => {
    const eng = createCronEngine();
    eng.register("t1", "0 9 * * *", () => {});
    eng.unregister("t1");
    expect(eng.list()).toHaveLength(0);
    eng.stopAll();
  });
});
