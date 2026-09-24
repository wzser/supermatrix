import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createCodexModelAvailabilityProbe,
  type ProbeProcessInput,
  type ProbeProcessResult,
} from "../../../src/adapters/backend-codex/modelAvailabilityProbe.ts";
import { createRouteAwareCodexModelAvailability } from "../../../src/adapters/backend-codex/routeAwareModelAvailability.ts";
import { ROUTE_STATE_CONTRACT_VERSION } from "../../../src/adapters/backend-codex/routeState.ts";

const ORIGINAL_OVERRIDE = process.env["SM_CODEX_ROUTE_STATE_PATH"];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-route-aware-probe-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env["SM_CODEX_ROUTE_STATE_PATH"];
  else process.env["SM_CODEX_ROUTE_STATE_PATH"] = ORIGINAL_OVERRIDE;
});

function useRouteState(state: unknown): void {
  const path = join(dir, `route-state-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state));
  process.env["SM_CODEX_ROUTE_STATE_PATH"] = path;
}

function deepseekState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: ROUTE_STATE_CONTRACT_VERSION,
    backend: "codex",
    route: "deepseek",
    defaultModel: "deepseek-v4-flash",
    servedModels: ["deepseek-v4-flash"],
    activatedAt: "2026-08-07T12:00:00+08:00",
    proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
    ...overrides,
  };
}

/**
 * The real probe, with only the child process replaced. Anything reaching
 * `runProcess` is a `codex exec --model <model>` that would hit the route proxy
 * and come back 400 model_not_served, so asserting on this spy is the direct
 * evidence that no such request is made.
 */
function probeWithSpawnSpy() {
  const runProcess = vi.fn(async (_input: ProbeProcessInput): Promise<ProbeProcessResult> => ({
    exitCode: 0,
    stdout: JSON.stringify({ type: "turn.completed" }),
    stderr: "",
  }));
  const inner = createCodexModelAvailabilityProbe({
    runProcess,
    getCliVersion: async () => "codex 0.144.1",
    getCatalogFingerprint: () => "test-fingerprint",
    getAuthStat: async () => null,
    fs: {
      makeTempDir: async () => join(dir, "probe-cwd"),
      readDir: async () => [],
      removeDir: async () => {},
    },
  });
  return { inner, runProcess };
}

describe("createRouteAwareCodexModelAvailability", () => {
  test("skips the probe for a model the active route does not serve", async () => {
    useRouteState(deepseekState());
    const { inner, runProcess } = probeWithSpawnSpy();
    const availability = createRouteAwareCodexModelAvailability(inner, { now: () => 42 });

    const result = await availability.probe("gpt-5.6-sol");

    expect(runProcess).not.toHaveBeenCalled();
    expect(result.kind).toBe("skipped");
    expect(result).toMatchObject({ checkedAt: 42 });
    expect("reason" in result && result.reason).toContain("deepseek");
    expect("reason" in result && result.reason).toContain("deepseek-v4-flash");
    expect("reason" in result && result.reason).toContain("gpt-5.6-sol");
  });

  test("probes for real a model the active route does serve", async () => {
    useRouteState(deepseekState());
    const { inner, runProcess } = probeWithSpawnSpy();
    const availability = createRouteAwareCodexModelAvailability(inner);

    const result = await availability.probe("deepseek-v4-flash");

    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(runProcess.mock.calls[0]?.[0]).toMatchObject({ command: "codex" });
    expect(result.kind).not.toBe("skipped");
  });

  test("passthrough route probes every model", async () => {
    useRouteState(deepseekState({ route: "openai", defaultModel: null, servedModels: [], proxy: null }));
    const { inner, runProcess } = probeWithSpawnSpy();
    const availability = createRouteAwareCodexModelAvailability(inner);

    const result = await availability.probe("gpt-5.6-sol");

    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(result.kind).not.toBe("skipped");
  });

  test.each([
    ["missing file", null],
    ["corrupt JSON", "{not json"],
    ["unknown contract version", deepseekState({ contractVersion: "sm-switch.route-state/v2" })],
    ["non-codex backend", deepseekState({ backend: "claude" })],
    ["no usable defaultModel", deepseekState({ defaultModel: "  " })],
  ])("fails open and probes when the contract is unusable: %s", async (_label, state) => {
    if (state === null) process.env["SM_CODEX_ROUTE_STATE_PATH"] = join(dir, "does-not-exist.json");
    else useRouteState(state);
    const { inner, runProcess } = probeWithSpawnSpy();
    const availability = createRouteAwareCodexModelAvailability(inner);

    const result = await availability.probe("gpt-5.6-sol");

    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(result.kind).not.toBe("skipped");
  });

  test("re-reads route state per probe so a switch takes effect without a restart", async () => {
    useRouteState(deepseekState({ route: "openai", defaultModel: null, servedModels: [] }));
    const { inner, runProcess } = probeWithSpawnSpy();
    const availability = createRouteAwareCodexModelAvailability(inner);

    expect((await availability.probe("gpt-5.6-sol")).kind).not.toBe("skipped");
    useRouteState(deepseekState());
    expect((await availability.probe("gpt-5.6-sol")).kind).toBe("skipped");
    expect(runProcess).toHaveBeenCalledTimes(1);
  });
});
