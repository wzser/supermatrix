import { describe, expect, test, vi } from "vitest";
import {
  createKimiAcpHealthCheck,
  parseKimiCliVersion,
} from "../../../src/app/bootSelfCheck/checks/kimiAcpHealth.ts";

const fakeCtx = {
  cfg: {} as any,
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, child: () => fakeCtx.logger } as any,
  processLister: {} as any,
};

describe("createKimiAcpHealthCheck", () => {
  // ── existing tests updated to use new `probeVersion` shape ─────────────────

  test("ok status when version probe + ACP probe both resolve", async () => {
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "ok", version: "1.37.0" }),
      probeAcpInitialize: async () => ({ kind: "ok", rttMs: 42 }),
      acpInitTimeoutMs: 500,
      rttSlowThresholdMs: 100,
    });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("ok");
  });

  test("warn (not fail) when version probe fails — kimi is optional", async () => {
    const acpProbe = vi.fn();
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "fail", error: "ENOENT: kimi not found" }),
      probeAcpInitialize: acpProbe,
      acpInitTimeoutMs: 500,
      rttSlowThresholdMs: 100,
    });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("warn");
    if (res.status === "warn") {
      expect(res.message).toMatch(/kimi/);
    }
  });

  test("registered for pre-wiring phase", () => {
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "fail", error: "x" }),
      probeAcpInitialize: async () => ({ kind: "fail", error: "x" }),
    });
    expect(check.phases).toContain("pre-wiring");
  });

  // ── new branch 1: version ok + ACP ok + fast RTT → status "ok" ─────────────

  test("status ok with detail.rttMs and detail.version when version and ACP both succeed fast", async () => {
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "ok", version: "1.37.0" }),
      probeAcpInitialize: async () => ({ kind: "ok", rttMs: 50 }),
      acpInitTimeoutMs: 500,
      rttSlowThresholdMs: 100,
    });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("ok");
    expect(res.detail).toMatchObject({ version: "1.37.0", rttMs: 50 });
  });

  // ── new branch 2: version ok + ACP ok + slow RTT → status "info" ────────────

  test("status info with slowness message when RTT exceeds threshold", async () => {
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "ok", version: "1.37.0" }),
      probeAcpInitialize: async () => ({ kind: "ok", rttMs: 200 }),
      acpInitTimeoutMs: 500,
      rttSlowThresholdMs: 100,
    });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("info");
    if (res.status === "info") {
      expect(res.message).toMatch(/缓慢/);
      expect(res.message).toMatch(/200ms/);
      expect(res.message).toMatch(/100ms/);
    }
    expect(res.detail).toMatchObject({ version: "1.37.0", rttMs: 200 });
  });

  // ── new branch 3: version ok + ACP fail → status "warn" ──────────────────────

  test("status warn with ACP message when version ok but ACP initialize fails", async () => {
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "ok", version: "1.37.0" }),
      probeAcpInitialize: async () => ({ kind: "fail", error: "ACP initialize timeout after 500ms" }),
      acpInitTimeoutMs: 500,
      rttSlowThresholdMs: 100,
    });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("warn");
    if (res.status === "warn") {
      expect(res.message).toMatch(/ACP 协议层无响应/);
      expect(res.message).toMatch(/ACP initialize timeout after 500ms/);
    }
    expect(res.detail).toMatchObject({ version: "1.37.0" });
  });

  // ── new branch 4: version fail → short-circuit, ACP NOT called ──────────────

  test("probeAcpInitialize is NOT called when version probe fails", async () => {
    const acpProbe = vi.fn(async () => ({ kind: "ok" as const, rttMs: 50 }));
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "fail", error: "ENOENT: kimi not found" }),
      probeAcpInitialize: acpProbe,
      acpInitTimeoutMs: 500,
      rttSlowThresholdMs: 100,
    });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("warn");
    expect(acpProbe).not.toHaveBeenCalled();
  });

  test("version fail message includes error text", async () => {
    const check = createKimiAcpHealthCheck({
      probeVersion: async () => ({ kind: "fail", error: "ENOENT: kimi not found" }),
      probeAcpInitialize: async () => ({ kind: "ok", rttMs: 0 }),
      acpInitTimeoutMs: 500,
      rttSlowThresholdMs: 100,
    });
    const res = await check.run(fakeCtx, "execute");
    expect(res.status).toBe("warn");
    if (res.status === "warn") {
      expect(res.message).toMatch(/ENOENT: kimi not found/);
      expect(res.message).toMatch(/claude\/codex/);
    }
  });

  // ── Kimi Code version parsing ────────────────────────────────────────────────

  test("does not treat retired kimi-cli info output as a Kimi Code version", () => {
    expect(parseKimiCliVersion("kimi-cli version: 1.37.0\nwire protocol: 1.9")).toBe("unknown");
  });

  test("parses Kimi Code --version output", () => {
    expect(parseKimiCliVersion("0.20.1")).toBe("0.20.1");
  });
});
