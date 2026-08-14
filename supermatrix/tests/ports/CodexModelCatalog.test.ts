import { afterEach, describe, expect, test } from "vitest";
import {
  formatCodexEffortMatrix,
  getCodexDefaultModel,
  getCodexModelCatalogFingerprint,
  getCodexModelCatalogSnapshot,
  getCodexSupportedEfforts,
  normalizeCodexReasoningEffortForCli,
  resetCodexModelCatalogForTests,
  setCodexEffectiveDefaultModel,
  setCodexModelCatalogEntries,
} from "../../src/ports/CodexModelCatalog.ts";

describe("CodexModelCatalog effort support", () => {
  afterEach(() => {
    resetCodexModelCatalogForTests();
  });

  test("fallback catalog lists current model-specific Codex reasoning effort matrix", () => {
    resetCodexModelCatalogForTests([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);

    expect(getCodexSupportedEfforts("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getCodexSupportedEfforts("gpt-5.6-terra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getCodexSupportedEfforts("gpt-5.6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getCodexSupportedEfforts("gpt-5.5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getCodexSupportedEfforts("gpt-5.4")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getCodexSupportedEfforts("gpt-5.4-mini")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(formatCodexEffortMatrix()).toContain(
      "gpt-5.6-sol / gpt-5.6-terra: low / medium / high / xhigh / max / ultra",
    );
    expect(formatCodexEffortMatrix()).toContain(
      "gpt-5.6-luna: low / medium / high / xhigh / max",
    );
    expect(formatCodexEffortMatrix()).toContain(
      "gpt-5.5 / gpt-5.4 / gpt-5.4-mini: low / medium / high / xhigh",
    );
    expect(formatCodexEffortMatrix()).not.toContain("none");
    expect(formatCodexEffortMatrix()).not.toContain("minimal");
  });

  test("bundled catalog entries preserve supported max and ultra before user-facing display", () => {
    setCodexModelCatalogEntries(
      [
        {
          slug: "gpt-5.6-sol",
          supportedEfforts: ["low", "medium", "xhigh", "max", "ultra"],
        },
      ],
      "test",
    );

    expect(getCodexSupportedEfforts("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(formatCodexEffortMatrix()).toBe("gpt-5.6-sol: low / medium / xhigh / max / ultra");
  });

  test("bundled catalog entries drop none and minimal because current models do not expose them", () => {
    setCodexModelCatalogEntries(
      [
        {
          slug: "gpt-5.6-sol",
          supportedEfforts: ["none", "minimal", "low", "medium", "xhigh", "ultra"],
        },
      ],
      "test",
    );

    expect(getCodexSupportedEfforts("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "xhigh",
      "ultra",
    ]);
  });

  test.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
    ["gpt-5.5", "max", "xhigh"],
    ["gpt-5.5", "ultra", "xhigh"],
    ["gpt-5.4", "max", "xhigh"],
    ["gpt-5.4", "ultra", "xhigh"],
    ["gpt-5.4-mini", "max", "xhigh"],
    ["gpt-5.4-mini", "ultra", "xhigh"],
  ] as const)("normalizes %s %s to %s for the Codex CLI", (model, effort, expected) => {
    expect(normalizeCodexReasoningEffortForCli(effort, model)).toBe(expected);
  });

  test("preserves a null CLI reasoning effort", () => {
    expect(normalizeCodexReasoningEffortForCli(null, "gpt-5.6-sol")).toBeNull();
  });

  test("snapshot is detached from catalog state and fingerprint is stable", () => {
    resetCodexModelCatalogForTests(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"]);

    const first = getCodexModelCatalogSnapshot();
    const fingerprint = getCodexModelCatalogFingerprint();
    first.models[0]!.supportedEfforts.pop();
    first.models.pop();

    expect(getCodexModelCatalogSnapshot()).toEqual({
      defaultModel: "gpt-5.6-sol",
      models: [
        { slug: "gpt-5.6-sol", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        { slug: "gpt-5.6-luna", supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
        { slug: "gpt-5.5", supportedEfforts: ["low", "medium", "high", "xhigh"] },
      ],
    });
    expect(getCodexModelCatalogFingerprint()).toBe(fingerprint);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("promotes an effective default without reordering models or losing effort metadata", () => {
    setCodexModelCatalogEntries([
      { slug: "first", supportedEfforts: ["low", "medium", "high"] },
      { slug: "verified", supportedEfforts: ["low", "medium"] },
    ], "test");

    setCodexEffectiveDefaultModel("verified");

    expect(getCodexModelCatalogSnapshot()).toEqual({
      defaultModel: "verified",
      models: [
        { slug: "first", supportedEfforts: ["low", "medium", "high"] },
        { slug: "verified", supportedEfforts: ["low", "medium"] },
      ],
    });
    expect(getCodexDefaultModel()).toBe("verified");
  });

  test("rejects promotion outside the active catalog", () => {
    resetCodexModelCatalogForTests(["known"]);
    expect(() => setCodexEffectiveDefaultModel("missing")).toThrow(/not in the catalog/i);
  });
});
