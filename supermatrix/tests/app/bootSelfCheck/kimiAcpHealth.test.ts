import { describe, expect, test } from "vitest";
import { createKimiAcpHealthCheck } from "../../../src/app/bootSelfCheck/checks/kimiAcpHealth.ts";

const fakeCtx = {
  cfg: {} as any,
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, child: () => fakeCtx.logger } as any,
  processLister: {} as any,
};

describe("createKimiAcpHealthCheck", () => {
  test("ok status when probe resolves", async () => {
    const check = createKimiAcpHealthCheck({ probe: async () => ({ kind: "ok", version: "1.37.0" }) });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("ok");
  });

  test("warn (not fail) when probe fails — kimi is optional", async () => {
    const check = createKimiAcpHealthCheck({ probe: async () => ({ kind: "fail", error: "ENOENT: kimi not found" }) });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("warn");
    if (res.status === "warn") {
      expect(res.message).toMatch(/kimi/);
    }
  });

  test("registered for pre-wiring phase", () => {
    const check = createKimiAcpHealthCheck({ probe: async () => ({ kind: "fail", error: "x" }) });
    expect(check.phases).toContain("pre-wiring");
  });
});
