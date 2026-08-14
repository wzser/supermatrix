import { describe, expect, test, vi } from "vitest";
import { createCodexRuntimeConfigCheck } from "../../../src/app/bootSelfCheck/checks/codexRuntimeConfig.ts";

describe("codex-runtime-config boot check", () => {
  test("returns ok for a clean reconciliation summary", async () => {
    const check = createCodexRuntimeConfigCheck({
      reconcile: vi.fn().mockResolvedValue({
        unchanged: 2, clamped: 0, fallbackModel: 0, conflict: 0, failed: 0,
        verifiedDefault: "gpt-ok", problems: {},
      }),
    });
    await expect(check.run({} as never, "execute")).resolves.toMatchObject({
      name: "codex-runtime-config", status: "ok",
    });
  });

  test("warns when verifiedDefault is null even with zero problem counts", async () => {
    const check = createCodexRuntimeConfigCheck({
      reconcile: vi.fn().mockResolvedValue({
        unchanged: 3, clamped: 0, fallbackModel: 0, conflict: 0, failed: 0,
        verifiedDefault: null, problems: {},
      }),
    });
    const result = await check.run({} as never, "execute");
    expect(result).toMatchObject({ name: "codex-runtime-config", status: "warn" });
    expect("message" in result && result.message).toContain("unchanged=3 clamped=0 fallbackModel=0 conflict=0 failed=0");
    expect("message" in result && result.message).toContain("verifiedDefault=none");
  });

  test("warns with the route reason when default verification was skipped, never ok", async () => {
    const check = createCodexRuntimeConfigCheck({
      reconcile: vi.fn().mockResolvedValue({
        unchanged: 3, clamped: 0, fallbackModel: 0, conflict: 0, failed: 0,
        verifiedDefault: null,
        defaultVerificationSkipped:
          'codex route "deepseek" is active and serves deepseek-v4-flash; gpt-5.6-sol is not served on this route, so it was not probed',
        problems: {},
      }),
    });
    const result = await check.run({} as never, "execute");
    expect(result).toMatchObject({ name: "codex-runtime-config", status: "warn" });
    expect("message" in result && result.message).toContain("verifiedDefault=skipped");
    expect("message" in result && result.message).toContain('codex route "deepseek"');
    expect("message" in result && result.message).not.toContain("verifiedDefault=none");
  });

  test("returns ok when verifiedDefault is set and all problem counts are zero", async () => {
    const check = createCodexRuntimeConfigCheck({
      reconcile: vi.fn().mockResolvedValue({
        unchanged: 0, clamped: 0, fallbackModel: 0, conflict: 0, failed: 0,
        verifiedDefault: "gpt-ok", problems: {},
      }),
    });
    await expect(check.run({} as never, "execute")).resolves.toMatchObject({
      name: "codex-runtime-config", status: "ok",
    });
  });

  test("returns warn with exact counts and only non-zero problem names", async () => {
    const check = createCodexRuntimeConfigCheck({
      reconcile: vi.fn().mockResolvedValue({
        unchanged: 1, clamped: 2, fallbackModel: 1, conflict: 1, failed: 0,
        verifiedDefault: "gpt-ok",
        problems: { clamped: ["a", "b"], fallbackModel: ["c"], conflict: ["d"] },
      }),
    });
    const result = await check.run({} as never, "execute");
    expect(result).toMatchObject({ status: "warn" });
    expect("message" in result && result.message).toContain("unchanged=1 clamped=2 fallbackModel=1 conflict=1 failed=0");
    expect("message" in result && result.message).toContain("clamped: a, b");
    expect("message" in result && result.message).not.toContain("failed:");
  });

  test("isolates check exceptions as warn", async () => {
    const check = createCodexRuntimeConfigCheck({ reconcile: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(check.run({} as never, "execute")).resolves.toMatchObject({
      name: "codex-runtime-config", status: "warn", message: expect.stringContaining("boom"),
    });
  });
});
