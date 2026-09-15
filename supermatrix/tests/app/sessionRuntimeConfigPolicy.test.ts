import { describe, expect, test } from "vitest";
import type { EffortLevel } from "../../src/domain/session.ts";
import type { CodexModelCatalogSnapshot } from "../../src/ports/CodexModelCatalog.ts";
import {
  clampCodexEffort,
  resolveSessionRuntimeConfig,
} from "../../src/app/sessionRuntimeConfigPolicy.ts";

const testCatalog: CodexModelCatalogSnapshot = {
  defaultModel: "gpt-5.6-sol",
  models: [
    { slug: "gpt-5.6-sol", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { slug: "gpt-5.6-terra", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { slug: "gpt-5.6-luna", supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    { slug: "gpt-5.5", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { slug: "gpt-5.4", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { slug: "gpt-5.4-mini", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  ],
};

function codexConfig(model: string | null, effort: EffortLevel | null) {
  return { backend: "codex" as const, model, effort, backendSessionId: "resume-1" };
}

describe("session runtime config policy", () => {
  test.each([
    ["gpt-5.6-sol", "max", "gpt-5.5", "xhigh"],
    ["gpt-5.6-sol", "ultra", "gpt-5.6-luna", "max"],
    ["gpt-5.5", "xhigh", "gpt-5.6-sol", "xhigh"],
  ] as const)("set-model clamps without promotion", (fromModel, effort, toModel, expected) => {
    const decision = resolveSessionRuntimeConfig({
      current: codexConfig(fromModel, effort),
      intent: { kind: "set-model", model: toModel },
      catalog: testCatalog,
    });
    expect(decision.after.model).toBe(toModel);
    expect(decision.after.effort).toBe(expected);
  });

  test("reconcile preserves null defaults", () => {
    const decision = resolveSessionRuntimeConfig({
      current: codexConfig(null, null), intent: { kind: "reconcile" }, catalog: testCatalog,
    });
    expect(decision.after.model).toBeNull();
    expect(decision.after.effort).toBeNull();
    expect(decision.action).toBe("accept");
  });

  test.each([
    { name: "set-effort", intent: { kind: "set-effort", effort: "ultra" } as const },
    { name: "set-model default", intent: { kind: "set-model", model: null } as const },
    {
      name: "inherit",
      intent: { kind: "inherit", backend: "codex", model: null, effort: "ultra" } as const,
    },
    { name: "reconcile", intent: { kind: "reconcile" } as const },
  ])("$name clamps a dynamic default effort while keeping model null", ({ intent }) => {
    const current = codexConfig(null, intent.kind === "set-effort" ? "high" : "ultra");

    const lunaDecision = resolveSessionRuntimeConfig({
      current,
      intent,
      catalog: { ...testCatalog, defaultModel: "gpt-5.6-luna" },
    });
    expect(lunaDecision.after.model).toBeNull();
    expect(lunaDecision.after.effort).toBe("max");

    const legacyDecision = resolveSessionRuntimeConfig({
      current,
      intent,
      catalog: { ...testCatalog, defaultModel: "gpt-5.5" },
    });
    expect(legacyDecision.after.model).toBeNull();
    expect(legacyDecision.after.effort).toBe("xhigh");
  });

  test("keeps a null effort null for a dynamic default model", () => {
    const decision = resolveSessionRuntimeConfig({
      current: codexConfig(null, "ultra"),
      intent: { kind: "set-effort", effort: null },
      catalog: { ...testCatalog, defaultModel: "gpt-5.5" },
    });
    expect(decision.after).toEqual(codexConfig(null, null));
  });

  test("throws when the catalog default model is missing from the catalog", () => {
    expect(() => resolveSessionRuntimeConfig({
      current: codexConfig(null, "ultra"),
      intent: { kind: "reconcile" },
      catalog: { ...testCatalog, defaultModel: "missing-default" },
    })).toThrow(/default model.*not in the catalog/i);
  });

  test("only reconcile falls back from an unknown stored model", () => {
    const decision = resolveSessionRuntimeConfig({
      current: codexConfig("retired-model", "ultra"), intent: { kind: "reconcile" }, catalog: testCatalog,
    });
    expect(decision.action).toBe("fallback_model");
    expect(decision.after.model).toBe("gpt-5.6-sol");
    expect(decision.after.effort).toBe("ultra");
  });

  test("rejects an explicitly unavailable model", () => {
    const current = codexConfig("gpt-5.5", "high");
    const decision = resolveSessionRuntimeConfig({
      current, intent: { kind: "set-model", model: "gpt-private", modelAvailable: false }, catalog: testCatalog,
    });
    expect(decision.action).toBe("reject");
    expect(decision.after).toEqual(current);
  });

  test("clamp uses the highest supported effort at or below the request", () => {
    expect(clampCodexEffort("ultra", ["low", "high", "max"])).toBe("max");
    expect(clampCodexEffort("medium", ["low", "high"])).toBe("low");
    expect(() => clampCodexEffort("high", [])).toThrow(/no supported effort/i);
  });

  test("Codex policy fails closed for ultracode before clamping", () => {
    expect(() => resolveSessionRuntimeConfig({
      current: codexConfig("gpt-5.6-sol", "ultracode"),
      intent: { kind: "reconcile" },
      catalog: testCatalog,
    })).toThrow(/Codex.*does not support.*ultracode/);
  });

  test("runtime admission failure uses the supplied fallback", () => {
    const decision = resolveSessionRuntimeConfig({
      current: codexConfig("gpt-5.6-sol", "ultra"),
      intent: { kind: "runtime-model-unavailable", fallbackModel: "gpt-5.6-luna" },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("fallback_model");
    expect(decision.after).toEqual({
      ...codexConfig("gpt-5.6-luna", "max"),
      backendSessionId: "resume-1",
    });
  });

  test.each([
    { name: "set-model", intent: { kind: "set-model", model: "gpt-5.6-luna" } as const },
    { name: "set-effort", intent: { kind: "set-effort", effort: "max" } as const },
    { name: "reconcile", intent: { kind: "reconcile" } as const },
    {
      name: "runtime-model-unavailable",
      intent: { kind: "runtime-model-unavailable", fallbackModel: "gpt-5.6-luna" } as const,
    },
  ])("$name preserves the current backend session id", ({ intent }) => {
    const decision = resolveSessionRuntimeConfig({
      current: codexConfig("gpt-5.6-sol", "ultra"),
      intent,
      catalog: testCatalog,
    });
    expect(decision.after.backendSessionId).toBe("resume-1");
  });

  test.each([
    { name: "set-backend", intent: { kind: "set-backend", backend: "codex" } as const },
    {
      name: "inherit",
      intent: { kind: "inherit", backend: "codex", model: "gpt-5.6-sol", effort: "ultra" } as const,
    },
  ])("$name clears the current backend session id", ({ intent }) => {
    const decision = resolveSessionRuntimeConfig({
      current: codexConfig("gpt-5.6-sol", "ultra"),
      intent,
      catalog: testCatalog,
    });
    expect(decision.after.backendSessionId).toBeNull();
  });
});

describe("session runtime config policy — kimi thinking capability", () => {
  function kimiConfig(model: string | null, effort: EffortLevel | null) {
    return { backend: "kimi" as const, model, effort, backendSessionId: "acp-1" };
  }

  test("set-effort on a K3 model maps the request to the native level", () => {
    const decision = resolveSessionRuntimeConfig({
      current: kimiConfig("kimi-code/k3", null),
      intent: { kind: "set-effort", effort: "medium" },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("clamp");
    expect(decision.after).toEqual(kimiConfig("kimi-code/k3", "high"));
  });

  test("set-effort on a K3 model accepts an already-native level", () => {
    const decision = resolveSessionRuntimeConfig({
      current: kimiConfig("kimi-code/k3", null),
      intent: { kind: "set-effort", effort: "low" },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("accept");
    expect(decision.after).toEqual(kimiConfig("kimi-code/k3", "low"));
  });

  test("set-model K3 -> K2.7 clears the now-invalid K3 effort instead of retaining it", () => {
    const decision = resolveSessionRuntimeConfig({
      current: kimiConfig("kimi-code/k3", "low"),
      intent: { kind: "set-model", model: "kimi-code/kimi-for-coding" },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("clamp");
    expect(decision.after).toEqual(kimiConfig("kimi-code/kimi-for-coding", null));
  });

  test("set-model re-normalizes a retained K3 effort through the native mapping", () => {
    const decision = resolveSessionRuntimeConfig({
      current: kimiConfig("kimi-code/k3", "xhigh"),
      intent: { kind: "set-model", model: "kimi-code/k3" },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("clamp");
    expect(decision.after).toEqual(kimiConfig("kimi-code/k3", "max"));
  });

  test("set-model to default (null) follows the kimi default model, which is fixed-on: effort clears", () => {
    const decision = resolveSessionRuntimeConfig({
      current: kimiConfig("kimi-code/k3", "low"),
      intent: { kind: "set-model", model: null },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("clamp");
    expect(decision.after).toEqual(kimiConfig(null, null));
  });

  test("set-model on K2.7 with no effort stays accept with null effort", () => {
    const decision = resolveSessionRuntimeConfig({
      current: kimiConfig(null, null),
      intent: { kind: "set-model", model: "kimi-code/k3" },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("accept");
    expect(decision.after).toEqual(kimiConfig("kimi-code/k3", null));
  });

  // Policy is not the admission gate: /model rejects unknown kimi ids (see
  // setModel.kimi.test.ts). This only asserts a kimi-namespaced id is never
  // resolved against the codex catalog.
  test("kimi set-model does not consult the codex catalog for kimi model ids", () => {
    const decision = resolveSessionRuntimeConfig({
      current: kimiConfig(null, null),
      intent: { kind: "set-model", model: "kimi-code/k3-256k" },
      catalog: testCatalog,
    });
    expect(decision.action).toBe("accept");
    expect(decision.after.model).toBe("kimi-code/k3-256k");
  });
});
