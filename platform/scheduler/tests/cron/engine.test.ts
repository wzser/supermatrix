import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCronEngine, validateCron, type CronEngine } from "../../src/cron/engine.js";

describe("CronEngine", () => {
  let engine: CronEngine;

  beforeEach(() => {
    engine = createCronEngine();
  });

  afterEach(() => {
    engine.stopAll();
  });

  it("registers a job and calls handler on trigger", async () => {
    const handler = vi.fn();
    engine.register("test-job", "* * * * *", handler);

    engine.trigger("test-job");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("unregisters a job", () => {
    const handler = vi.fn();
    engine.register("test-job", "* * * * *", handler);
    engine.unregister("test-job");

    expect(() => engine.trigger("test-job")).toThrow("not found");
  });

  it("lists registered jobs", () => {
    engine.register("a", "0 9 * * *", vi.fn());
    engine.register("b", "0 10 * * *", vi.fn());
    const jobs = engine.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.name)).toContain("a");
    expect(jobs.map((j) => j.name)).toContain("b");
  });

  it("re-registers a job with new cron", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    engine.register("job", "0 9 * * *", handler1);
    engine.register("job", "0 10 * * *", handler2);

    engine.trigger("job");
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it("validateCron returns true for valid patterns", () => {
    expect(validateCron("* * * * *")).toBe(true);
    expect(validateCron("0 9 * * 1-5")).toBe(true);
    expect(validateCron("*/5 * * * *")).toBe(true);
  });

  it("validateCron returns false for invalid patterns", () => {
    expect(validateCron("not a cron")).toBe(false);
    expect(validateCron("")).toBe(false);
    expect(validateCron("* * * *")).toBe(false);
  });

  it("register with invalid cron preserves existing job", () => {
    const handler = vi.fn();
    engine.register("job", "* * * * *", handler);

    expect(() => engine.register("job", "not a cron", vi.fn())).toThrow();

    engine.trigger("job");
    expect(handler).toHaveBeenCalledOnce();
    expect(engine.list()).toHaveLength(1);
    expect(engine.list()[0].cron).toBe("* * * * *");
  });
});
