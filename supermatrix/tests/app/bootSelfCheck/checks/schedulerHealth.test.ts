import { describe, expect, it, vi, afterEach } from "vitest";
import { schedulerHealthCheck } from "../../../../src/app/bootSelfCheck/checks/schedulerHealth.ts";
import type { BootCheckContext } from "../../../../src/app/bootSelfCheck/types.ts";

function ctx(): BootCheckContext {
  return {
    cfg: {} as BootCheckContext["cfg"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
    processLister: { list: async () => [], killAll: async () => [], getCommand: async () => null, getProcessInfo: async () => null },
  };
}

describe("scheduler-health", () => {
  const oldEnv = process.env.SM_SCHEDULER_HEALTH_URL;
  afterEach(() => {
    if (oldEnv === undefined) delete process.env.SM_SCHEDULER_HEALTH_URL;
    else process.env.SM_SCHEDULER_HEALTH_URL = oldEnv;
    vi.unstubAllGlobals();
  });

  it("returns ok with skipped detail when env unset", async () => {
    delete process.env.SM_SCHEDULER_HEALTH_URL;
    const r = await schedulerHealthCheck.run(ctx(), "execute");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.detail).toMatchObject({ skipped: expect.any(String) });
  });

  it("returns ok when HTTP returns status=ok", async () => {
    process.env.SM_SCHEDULER_HEALTH_URL = "http://scheduler.test/health";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "ok", tasks: 5 }), { status: 200 }));
    const r = await schedulerHealthCheck.run(ctx(), "execute");
    expect(r.status).toBe("ok");
  });

  it("returns warn on non-ok status field", async () => {
    process.env.SM_SCHEDULER_HEALTH_URL = "http://scheduler.test/health";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "degraded" }), { status: 200 }));
    const r = await schedulerHealthCheck.run(ctx(), "execute");
    expect(r.status).toBe("warn");
  });

  it("returns warn on fetch reject", async () => {
    process.env.SM_SCHEDULER_HEALTH_URL = "http://scheduler.test/health";
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    const r = await schedulerHealthCheck.run(ctx(), "execute");
    expect(r.status).toBe("warn");
    if (r.status === "warn") expect(r.message).toMatch(/ECONNREFUSED/);
  });

  it("returns warn on timeout (TimeoutError)", async () => {
    process.env.SM_SCHEDULER_HEALTH_URL = "http://scheduler.test/health";
    vi.stubGlobal("fetch", async () => {
      const err = new Error("The operation was aborted.");
      err.name = "TimeoutError";
      throw err;
    });
    const r = await schedulerHealthCheck.run(ctx(), "execute");
    expect(r.status).toBe("warn");
    if (r.status === "warn") {
      expect(r.message).toMatch(/2 秒超时/);
      expect(r.message).toMatch(/scheduler\.test\/health/);
    }
  });
});
