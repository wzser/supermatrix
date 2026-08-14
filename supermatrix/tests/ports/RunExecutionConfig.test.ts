import { beforeEach, describe, expect, test } from "vitest";
import {
  resolveKimiExecutionModel,
  resolveRunExecutionConfig,
} from "../../src/ports/RunExecutionConfig.ts";
import {
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../src/ports/BackendRuntimeDefaults.ts";
import {
  KIMI_DEFAULT_MODEL,
  KIMI_HIGHSPEED_MODEL,
  KIMI_K3_MODEL,
} from "../../src/ports/KimiModelCatalog.ts";

describe("resolveRunExecutionConfig — kimi", () => {
  beforeEach(() => resetConfiguredBackendRuntimeDefaultsForTests());

  test("K3 session with an explicit effort resolves the native level at execution", () => {
    const execution = resolveRunExecutionConfig({
      backend: "kimi",
      model: KIMI_K3_MODEL,
      effort: "low",
    });
    expect(execution).toEqual({ backend: "kimi", model: KIMI_K3_MODEL, effort: "low" });
  });

  test("K3 session maps requested levels through official compatibility", () => {
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: KIMI_K3_MODEL, effort: "medium" }).effort,
    ).toBe("high");
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: KIMI_K3_MODEL, effort: "xhigh" }).effort,
    ).toBe("max");
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: KIMI_K3_MODEL, effort: "ultra" }).effort,
    ).toBe("max");
  });

  test("K3 session with default effort resolves to native high at execution so a reused ACP session cannot retain an earlier override", () => {
    const execution = resolveRunExecutionConfig({
      backend: "kimi",
      model: KIMI_K3_MODEL,
      effort: null,
    });
    expect(execution.effort).toBe("high");
  });

  test("K2.7 session is fixed-on: effort stays null even if a stale value was persisted", () => {
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: KIMI_DEFAULT_MODEL, effort: null }).effort,
    ).toBeNull();
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: KIMI_DEFAULT_MODEL, effort: "low" }).effort,
    ).toBeNull();
  });

  test("model null follows the live ACP model: the requested effort passes through for the backend to resolve against the configOptions snapshot", () => {
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: "low" }),
    ).toEqual({ backend: "kimi", model: null, effort: "low" });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: null }),
    ).toEqual({ backend: "kimi", model: null, effort: null });
  });

  test("model null resolves the configured global kimi default before execution", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: null }),
    ).toEqual({ backend: "kimi", model: KIMI_K3_MODEL, effort: "high" });
  });

  test("global default K3 maps a session's requested effort through official compatibility", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: "xhigh" }),
    ).toEqual({ backend: "kimi", model: KIMI_K3_MODEL, effort: "max" });
  });

  test("a configured global K3 effort is inherited by a session without an explicit effort", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL, effort: "medium" });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: null }),
    ).toEqual({ backend: "kimi", model: KIMI_K3_MODEL, effort: "high" });
  });

  test("an explicit session effort wins over the configured global K3 effort", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL, effort: "max" });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: "low" }),
    ).toEqual({ backend: "kimi", model: KIMI_K3_MODEL, effort: "low" });
  });

  test("a stale global effort is not used without a usable global Kimi model", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: null, effort: "high" });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: null }),
    ).toEqual({ backend: "kimi", model: null, effort: null });
  });

  test("an explicit session model still wins over the configured global default", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: KIMI_HIGHSPEED_MODEL, effort: null }),
    ).toEqual({ backend: "kimi", model: KIMI_HIGHSPEED_MODEL, effort: null });
  });

  test("clearing the global default restores the null passthrough so the backend applies KIMI_DEFAULT_MODEL", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL });
    setConfiguredBackendRuntimeDefaults("kimi", { model: null });
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: null }),
    ).toEqual({ backend: "kimi", model: null, effort: null });
  });

  test("resolveKimiExecutionModel reports the same chain the run path uses", () => {
    expect(resolveKimiExecutionModel(null)).toBe(KIMI_DEFAULT_MODEL);
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL });
    expect(resolveKimiExecutionModel(null)).toBe(KIMI_K3_MODEL);
    expect(resolveKimiExecutionModel(KIMI_HIGHSPEED_MODEL)).toBe(KIMI_HIGHSPEED_MODEL);
  });

  test("a configured global kimi default never leaks into claude or codex", () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL });
    expect(
      resolveRunExecutionConfig({ backend: "claude", model: null, effort: null }).model,
    ).not.toBe(KIMI_K3_MODEL);
    expect(
      resolveRunExecutionConfig({ backend: "codex", model: null, effort: null }).model,
    ).not.toBe(KIMI_K3_MODEL);
  });

  test("claude and codex execution configs are untouched", () => {
    const claude = resolveRunExecutionConfig({
      backend: "claude",
      model: "claude-opus-4-8",
      effort: "max",
    });
    expect(claude).toEqual({ backend: "claude", model: "claude-opus-4-8", effort: "max" });
    const codex = resolveRunExecutionConfig({
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(codex).toEqual({ backend: "codex", model: "gpt-5.6-sol", effort: "ultra" });
  });
});
