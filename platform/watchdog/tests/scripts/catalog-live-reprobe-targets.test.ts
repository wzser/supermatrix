import { describe, expect, it } from "vitest";
import { extractYoloCatalogProbeTargets } from "../../src/scripts/_catalog-live-reprobe-targets.js";

describe("catalog live reprobe target extraction", () => {
  it("selects only models and exact effort parent chains referenced by YOLO routes", () => {
    const targets = extractYoloCatalogProbeTargets({
      asset: "yolo.task-model-routing",
      source: "feishu (authoritative)",
      task_types: {
        design: [
          { priority: 10, backend: "claude", model: "claude-opus-5", effort: "high" },
          { priority: 20, backend: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
        ],
        implementation: [
          { priority: 10, backend: "codex", model: "gpt-5.6-sol", effort: "high" },
          { priority: 20, backend: "kimi", model: "kimi-code/k3", effort: "default" },
          { priority: 30, backend: "claude", model: "claude-opus-5", effort: "high" },
        ],
      },
    });

    expect(targets).toEqual({
      assetId: "yolo.task-model-routing",
      routeCount: 5,
      models: {
        claude: ["claude-opus-5"],
        codex: ["gpt-5.6-sol"],
        kimi: ["kimi-code/k3"],
      },
      effortParentChains: {
        claude: [{ model: "claude-opus-5", efforts: ["high"] }],
        codex: [{ model: "gpt-5.6-sol", efforts: ["high", "xhigh"] }],
        kimi: [],
      },
      controlEfforts: [
        { backend: "kimi", model: "kimi-code/k3", effort: "default" },
      ],
    });
  });

  it("fails closed on a routing backend outside the catalog contract", () => {
    expect(() => extractYoloCatalogProbeTargets({
      asset: "yolo.task-model-routing",
      task_types: {
        coding: [
          { priority: 10, backend: "other", model: "mystery", effort: "high" },
        ],
      },
    })).toThrow("unsupported backend in YOLO routing: other");
  });
});
