import { describe, expect, test } from "vitest";
import {
  KIMI_DEFAULT_MODEL,
  KIMI_HIGHSPEED_MODEL,
  KIMI_K3_MODEL,
  KIMI_K3_256K_MODEL,
  getKimiThinkingCapability,
  isKnownKimiModel,
  mapKimiRequestedEffort,
  resolveKimiThinkingLevel,
} from "../../src/ports/KimiModelCatalog.ts";

describe("KimiModelCatalog — kimi-code 0.41.0 models", () => {
  test("knows the four models the managed provider actually serves", () => {
    expect(isKnownKimiModel(KIMI_DEFAULT_MODEL)).toBe(true);
    expect(isKnownKimiModel(KIMI_HIGHSPEED_MODEL)).toBe(true);
    expect(isKnownKimiModel(KIMI_K3_MODEL)).toBe(true);
    expect(isKnownKimiModel(KIMI_K3_256K_MODEL)).toBe(true);
    expect(isKnownKimiModel("kimi-k2-thinking")).toBe(false);
  });

  test("k3-256k uses the same K3 thinking capability", () => {
    expect(getKimiThinkingCapability(KIMI_K3_256K_MODEL)).toEqual({
      kind: "levels",
      levels: ["low", "high", "max"],
      defaultLevel: "high",
    });
  });
});

describe("KimiModelCatalog — model-aware thinking capability", () => {
  test("K2.7 models are fixed-on (no level dimension)", () => {
    for (const model of [KIMI_DEFAULT_MODEL, KIMI_HIGHSPEED_MODEL]) {
      expect(getKimiThinkingCapability(model)).toEqual({ kind: "fixed-on" });
    }
  });

  test("K3 advertises low/high/max with default high", () => {
    expect(getKimiThinkingCapability(KIMI_K3_MODEL)).toEqual({
      kind: "levels",
      levels: ["low", "high", "max"],
      defaultLevel: "high",
    });
  });

  test("unknown model has no capability", () => {
    expect(getKimiThinkingCapability("nonsense-model")).toBeNull();
  });
});

describe("KimiModelCatalog — official K3 compatibility mapping", () => {
  test.each([
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
    ["ultra", "max"],
  ] as const)("maps %s -> %s", (requested, expected) => {
    expect(mapKimiRequestedEffort(requested)).toBe(expected);
  });

  test("rejects ultracode (claude-only token)", () => {
    expect(() => mapKimiRequestedEffort("ultracode")).toThrow(/ultracode/);
  });
});

describe("KimiModelCatalog — resolveKimiThinkingLevel", () => {
  test("K3 default (null) resolves to native high so a reused ACP session cannot retain an earlier override", () => {
    expect(resolveKimiThinkingLevel(KIMI_K3_MODEL, null)).toBe("high");
  });

  test("K3 maps requested levels through the official compatibility table", () => {
    expect(resolveKimiThinkingLevel(KIMI_K3_MODEL, "low")).toBe("low");
    expect(resolveKimiThinkingLevel(KIMI_K3_MODEL, "medium")).toBe("high");
    expect(resolveKimiThinkingLevel(KIMI_K3_MODEL, "ultra")).toBe("max");
  });

  test("K2.7 fixed-on models have no settable level", () => {
    expect(resolveKimiThinkingLevel(KIMI_DEFAULT_MODEL, null)).toBeNull();
    expect(resolveKimiThinkingLevel(KIMI_DEFAULT_MODEL, "low")).toBeNull();
    expect(resolveKimiThinkingLevel(KIMI_HIGHSPEED_MODEL, "high")).toBeNull();
  });

  test("unknown model yields no level", () => {
    expect(resolveKimiThinkingLevel("nonsense-model", "low")).toBeNull();
    expect(resolveKimiThinkingLevel("nonsense-model", null)).toBeNull();
  });
});
