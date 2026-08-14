import { describe, expect, it } from "vitest";
import * as weeklyModelAudit from "../../src/scripts/_weekly-upgrade-model-audit.js";
import {
  assessModelAuditResolution,
  buildWeeklyModelAudit,
  classifyModelProbe,
  collectCodexUpgradeProbeTargets,
  diffModelSurfaces,
  extractClaudeEffortHelp,
  extractClaudeModelHelp,
  isAcceptedClaudeEffortProbe,
  parseCodexBundledCatalog,
  parseKimiProviderCatalog,
  formatModelAuditReviewInstructions,
  type ModelSurfaceSnapshot,
} from "../../src/scripts/_weekly-upgrade-model-audit.js";

function snapshot(input: Partial<ModelSurfaceSnapshot> = {}): ModelSurfaceSnapshot {
  return {
    capturedAt: 1,
    claude: {
      modelHelp: "alias: fable, opus, sonnet",
      effortHelp: "Effort level for the current session (low, medium, high, xhigh, max)",
      acceptedEfforts: ["low", "medium", "high", "xhigh", "max", "ultracode"],
    },
    codex: {
      models: [
        {
          slug: "gpt-5.5",
          visibility: "list",
          supportedInApi: true,
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          upgradeModel: null,
        },
      ],
    },
    kimi: { models: [] },
    ...input,
  };
}

describe("weekly upgrade model audit", () => {
  it("reduces the Codex bundled catalog to the model fields that affect SuperMatrix", () => {
    const models = parseCodexBundledCatalog(JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          supported_reasoning_levels: [
            { effort: "low", description: "fast" },
            { effort: "ultra", description: "delegated" },
          ],
          base_instructions: "large field that must not enter the audit receipt",
        },
      ],
    }));

    expect(models).toEqual([{
      slug: "gpt-5.6-sol",
      visibility: "list",
      supportedInApi: true,
      reasoningEfforts: ["low", "ultra"],
      upgradeModel: null,
    }]);
  });

  it("reduces Kimi provider output to model fields without retaining credentials", () => {
    const models = parseKimiProviderCatalog(JSON.stringify({
      providers: {
        "managed:kimi-code": { api_key: "must-not-enter-the-audit" },
      },
      models: {
        "kimi-code/kimi-for-coding": {
          provider: "managed:kimi-code",
          model: "kimi-for-coding",
          displayName: "K2.7 Code",
          capabilities: ["thinking", "tool_use"],
          supportEfforts: ["low", "high", "max"],
          defaultEffort: "high",
          api_key: "must-not-enter-the-audit",
        },
      },
    }));

    expect(models).toEqual([{
      id: "kimi-code/kimi-for-coding",
      provider: "managed:kimi-code",
      model: "kimi-for-coding",
      displayName: "K2.7 Code",
      capabilities: ["thinking", "tool_use"],
      supportedEfforts: ["high", "low", "max"],
      defaultEffort: "high",
    }]);
    expect(JSON.stringify(models)).not.toContain("api_key");
  });

  it("detects Codex additions, removals, effort changes, and Claude CLI model/effort help changes", () => {
    const before = snapshot({
      codex: {
        models: [
          {
            slug: "gpt-5.5",
            visibility: "list",
            supportedInApi: true,
            reasoningEfforts: ["low", "high"],
            upgradeModel: null,
          },
          {
            slug: "gpt-5.4",
            visibility: "list",
            supportedInApi: true,
            reasoningEfforts: ["low", "high"],
            upgradeModel: null,
          },
        ],
      },
    });
    const after = snapshot({
      claude: {
        modelHelp: "alias: mythos, opus, sonnet",
        effortHelp: "Effort level for the current session (low, medium, high, xhigh, max, ultra)",
        acceptedEfforts: ["low", "medium", "high", "xhigh", "max", "ultracode", "new-level"],
      },
      codex: {
        models: [
          {
            slug: "gpt-5.6-sol",
            visibility: "list",
            supportedInApi: true,
            reasoningEfforts: ["low", "max", "ultra"],
            upgradeModel: null,
          },
          {
            slug: "gpt-5.5",
            visibility: "list",
            supportedInApi: true,
            reasoningEfforts: ["low", "high", "xhigh"],
            upgradeModel: null,
          },
        ],
      },
    });

    expect(diffModelSurfaces(before, after)).toEqual({
      changed: true,
      claudeModelHelpChanged: true,
      claudeEffortHelpChanged: true,
      claudeAcceptedEffortsChanged: true,
      codexAdded: ["gpt-5.6-sol"],
      codexRemoved: ["gpt-5.4"],
      codexChanged: ["gpt-5.5"],
      kimiAdded: [],
      kimiRemoved: [],
      kimiChanged: [],
    });
  });

  it("requires root review when Kimi's configured model surface changes", () => {
    const before = snapshot({
      kimi: {
        models: [{
          id: "kimi-code/kimi-for-coding",
          provider: "managed:kimi-code",
          model: "kimi-for-coding",
          displayName: "K2.7 Code",
          capabilities: ["thinking"],
        }],
      },
    });
    const after = snapshot({
      kimi: {
        models: [{
          id: "kimi-code/kimi-for-coding",
          provider: "managed:kimi-code",
          model: "kimi-for-coding",
          displayName: "K2.8 Code",
          capabilities: ["thinking", "tool_use"],
        }],
      },
    });

    expect(diffModelSurfaces(before, after)).toMatchObject({
      changed: true,
      kimiAdded: [],
      kimiRemoved: [],
      kimiChanged: ["kimi-code/kimi-for-coding"],
    });
    expect(buildWeeklyModelAudit(before, after, [
      { backend: "claude", target: "sonnet", status: "available" },
      { backend: "codex", target: "gpt-5.5", status: "available" },
    ])).toMatchObject({
      requiresReview: true,
      requiresAdjustment: false,
    });
  });

  it("requires review when Codex catalog capture remains unavailable across both snapshots", () => {
    const unavailable = snapshot({
      codex: {
        models: [],
        error: "codex debug models exited 2",
      },
    });

    expect(buildWeeklyModelAudit(unavailable, unavailable, [
      { backend: "claude", target: "sonnet", status: "available" },
      { backend: "codex", target: "gpt-5.5", status: "transient" },
    ])).toMatchObject({
      requiresReview: true,
    });
  });

  it("probes only changed Codex models referenced by SuperMatrix plus their upstream successors", () => {
    const before = snapshot({
      codex: {
        models: [
          {
            slug: "gpt-5.4",
            visibility: "list",
            supportedInApi: true,
            reasoningEfforts: ["low", "high"],
            upgradeModel: null,
          },
          {
            slug: "gpt-5.2",
            visibility: "list",
            supportedInApi: true,
            reasoningEfforts: ["low", "high"],
            upgradeModel: null,
          },
        ],
      },
    });
    const after = snapshot({
      codex: {
        models: [
          {
            slug: "gpt-5.4",
            visibility: "hide",
            supportedInApi: true,
            reasoningEfforts: ["low", "high"],
            upgradeModel: "gpt-5.6-terra",
          },
          {
            slug: "gpt-5.2",
            visibility: "hide",
            supportedInApi: true,
            reasoningEfforts: ["low", "high"],
            upgradeModel: null,
          },
          {
            slug: "gpt-5.6-terra",
            visibility: "list",
            supportedInApi: true,
            reasoningEfforts: ["low", "high", "xhigh"],
            upgradeModel: null,
          },
        ],
      },
    });

    expect(collectCodexUpgradeProbeTargets(
      before,
      after,
      ["gpt-5.4", "gpt-5.5"],
    )).toEqual(["gpt-5.4", "gpt-5.6-terra"]);
  });

  it("extracts the complete wrapped Claude --model help text", () => {
    const help = `Options:\n  --model <model>  Model for the current session. Provide an alias for the latest model\n                   (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.\n  --output-format <format>  Output format`;

    expect(extractClaudeModelHelp(help)).toBe(
      "Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.",
    );
  });

  it("extracts the complete wrapped Claude --effort help text", () => {
    const help = `Options:\n  --effort <level>  Effort level for the current session\n                    (low, medium, high, xhigh, max)\n  --model <model>  Model for the current session`;

    expect(extractClaudeEffortHelp(help)).toBe(
      "Effort level for the current session (low, medium, high, xhigh, max)",
    );
  });

  it("uses a no-model parser probe instead of help text to identify accepted Claude effort candidates", () => {
    expect(isAcceptedClaudeEffortProbe({
      exitCode: 0,
      output: "2.1.210 (Claude Code)",
    })).toBe(true);
    expect(isAcceptedClaudeEffortProbe({
      exitCode: 0,
      output: "Warning: Unknown --effort value 'ultra' - ignoring it and using the default effort.",
    })).toBe(false);
    expect(isAcceptedClaudeEffortProbe({
      exitCode: 1,
      output: "permission denied",
    })).toBe(false);
  });

  it("preserves available, unavailable, transient, and error outcomes from Claude effort parser probes", () => {
    const classify = (weeklyModelAudit as Record<string, unknown>)["classifyClaudeEffortParserProbe"];

    expect(classify).toBeTypeOf("function");
    expect((classify as Function)({
      effort: "low",
      exitCode: 0,
      output: "2.1.210 (Claude Code)",
    })).toEqual({ effort: "low", status: "available" });
    expect((classify as Function)({
      effort: "ultracode",
      exitCode: 0,
      output: "Unknown --effort value 'ultracode'",
    })).toEqual({
      effort: "ultracode",
      status: "unavailable",
      detail: "Unknown --effort value 'ultracode'",
    });
    expect((classify as Function)({
      effort: "high",
      exitCode: 1,
      output: "permission denied",
    })).toEqual({
      effort: "high",
      status: "error",
      detail: "permission denied",
    });
    expect((classify as Function)({
      effort: "max",
      exitCode: null,
      output: "",
      error: "operation timed out",
    })).toEqual({
      effort: "max",
      status: "transient",
      detail: "operation timed out",
    });
  });

  it("does not treat quota and rate-limit failures as model retirement", () => {
    expect(classifyModelProbe({
      backend: "claude",
      target: "sonnet",
      exitCode: 1,
      output: "You've hit your weekly limit",
    }).status).toBe("transient");

    expect(classifyModelProbe({
      backend: "codex",
      target: "gpt-5.5",
      exitCode: 1,
      output: "429 rate limit exceeded",
    }).status).toBe("transient");

    expect(classifyModelProbe({
      backend: "claude",
      target: "claude-fable-5",
      exitCode: 1,
      output: "You've hit your session limit · resets 5pm (Asia/Shanghai)",
    }).status).toBe("transient");

    for (const output of [
      "You've reached your Fable 5 limit",
      "Fable 5 quota exceeded; try again later",
      "claude-fable-5 limit reached",
    ]) {
      expect(classifyModelProbe({
        backend: "claude",
        target: "claude-fable-5",
        exitCode: 1,
        output,
      })).toMatchObject({
        status: "transient",
        detail: output,
      });
    }

    // sm-proxy 路由级拒绝（如 sm-switch 切到 DeepSeek 通道）是账号态不是模型退役
    expect(classifyModelProbe({
      backend: "codex",
      target: "gpt-5.6-terra",
      exitCode: 1,
      output: '{"type":"turn.failed","error":{"message":"sm-proxy strict mode: requested model \'gpt-5.6-terra\' is not served by this route (served model: \'deepseek-v4-flash\'); silent model remapping is disabled, code: model_not_served"}}',
    }).status).toBe("transient");
  });

  it("live-probes every Codex model-effort parent chain", () => {
    const runEffortProbes = (weeklyModelAudit as Record<string, unknown>)["runCodexEffortProbes"];
    const calls: Array<{ command: string; args: string[] }> = [];

    expect(runEffortProbes).toBeTypeOf("function");
    const probes = (runEffortProbes as Function)({
      targets: [
        { target: "gpt-5.6-sol", efforts: ["ultra", "low"] },
        { target: "gpt-5.6-sol", efforts: ["ultra"] },
        { target: "gpt-5.5", efforts: ["xhigh"] },
      ],
      codexBin: "/bin/codex",
      supermatrixDir: "/repo/SuperMatrix",
      run: (command: string, args: string[]) => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "WEEKLY_MODEL_PROBE_OK", stderr: "" };
      },
    });

    expect(probes).toEqual([
      { backend: "codex", target: "gpt-5.5", effort: "xhigh", status: "available" },
      { backend: "codex", target: "gpt-5.6-sol", effort: "low", status: "available" },
      { backend: "codex", target: "gpt-5.6-sol", effort: "ultra", status: "available" },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      command: "/bin/codex",
      args: expect.arrayContaining(["--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=ultra"]),
    });
  });

  it("distinguishes a verified model response from definitive unavailability", () => {
    expect(classifyModelProbe({
      backend: "codex",
      target: "gpt-5.5",
      exitCode: 0,
      output: "{\"type\":\"assistant\",\"text\":\"WEEKLY_MODEL_PROBE_OK\"}",
    }).status).toBe("available");

    expect(classifyModelProbe({
      backend: "codex",
      target: "gpt-5.5",
      exitCode: 1,
      output: "The model `gpt-5.5` does not exist or you do not have access to it.",
    }).status).toBe("unavailable");
  });

  it("live-probes every current catalog model once across Claude, Codex, and Kimi", () => {
    const runCatalogProbes = (weeklyModelAudit as Record<string, unknown>)["runCatalogModelProbes"];
    const calls: Array<{ command: string; args: string[] }> = [];

    expect(runCatalogProbes).toBeTypeOf("function");
    const probes = (runCatalogProbes as Function)({
      catalogModels: {
        claude: ["claude-opus-4-6"],
        codex: ["gpt-5.4", "gpt-5.5"],
        kimi: ["kimi-code/k3"],
      },
      alreadyProbed: [
        { backend: "codex", target: "gpt-5.5", status: "available" },
      ],
      claudeBin: "/bin/claude",
      codexBin: "/bin/codex",
      kimiBin: "/bin/kimi",
      supermatrixDir: "/repo/SuperMatrix",
      run: (command: string, args: string[]) => {
        calls.push({ command, args });
        return command === "/bin/kimi"
          ? { exitCode: 1, stdout: "", stderr: "request timed out" }
          : { exitCode: 0, stdout: "WEEKLY_MODEL_PROBE_OK", stderr: "" };
      },
    });

    expect(probes).toEqual([
      { backend: "claude", target: "claude-opus-4-6", status: "available" },
      { backend: "codex", target: "gpt-5.4", status: "available" },
      {
        backend: "kimi",
        target: "kimi-code/k3",
        status: "transient",
        detail: "request timed out",
      },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      command: "/bin/claude",
      args: expect.arrayContaining(["--model", "claude-opus-4-6"]),
    });
    expect(calls[1]).toMatchObject({
      command: "/bin/codex",
      args: expect.arrayContaining(["--model", "gpt-5.4"]),
    });
    expect(calls[2]).toMatchObject({
      command: "/bin/kimi",
      args: expect.arrayContaining(["--model", "kimi-code/k3", "--prompt"]),
    });
    expect(calls.flatMap(({ args }) => args)).not.toContain("gpt-5.5");
  });

  it("requires root review for catalog drift and adjustment for a missing BTW target", () => {
    const before = snapshot();
    const after = snapshot({ codex: { models: [] } });
    const audit = buildWeeklyModelAudit(before, after, [
      { backend: "claude", target: "sonnet", status: "available" },
      {
        backend: "codex",
        target: "gpt-5.5",
        status: "unavailable",
        detail: "model retired",
      },
    ]);

    expect(audit.requiresReview).toBe(true);
    expect(audit.requiresAdjustment).toBe(true);
    expect(assessModelAuditResolution(audit, "MODEL_AUDIT_RESOLUTION: unchanged")).toEqual({
      status: "invalid",
      resolution: "unchanged",
      reason: "model audit requires a source adjustment",
    });
    expect(assessModelAuditResolution(audit, `## Auto-fixed
- synchronized model surfaces (commit: abc1234 in SuperMatrix)

MODEL_AUDIT_RESOLUTION: adjusted`)).toEqual({
      status: "accepted",
      resolution: "adjusted",
    });
    expect(assessModelAuditResolution(audit, "MODEL_AUDIT_RESOLUTION: adjusted")).toEqual({
      status: "invalid",
      resolution: "adjusted",
      reason: "adjusted resolution has no Auto-fixed commit receipt",
    });
  });

  it("uses the SuperMatrix compatibility reason instead of duplicating its alias registry", () => {
    const audit = buildWeeklyModelAudit(
      snapshot(),
      snapshot(),
      [
        { backend: "claude", target: "sonnet", status: "available" },
        { backend: "codex", target: "gpt-5.5", status: "available" },
      ],
      {
        requiresAdjustment: true,
        adjustmentReasons: ["CODEX_ALIAS_CATALOG_DRIFT"],
      },
    );

    expect(audit.requiresReview).toBe(true);
    expect(audit.requiresAdjustment).toBe(true);
    expect(audit.compatibilityAdjustmentReasons).toEqual([
      "CODEX_ALIAS_CATALOG_DRIFT",
    ]);
    expect(formatModelAuditReviewInstructions(audit)).toContain(
      "CODEX_ALIAS_CATALOG_DRIFT",
    );
  });

  it("accepts an unchanged receipt only when the detected surface does not require adjustment", () => {
    const audit = buildWeeklyModelAudit(snapshot(), snapshot(), [
      { backend: "claude", target: "sonnet", status: "transient", detail: "weekly quota" },
      { backend: "codex", target: "gpt-5.5", status: "available" },
    ]);

    expect(audit.requiresAdjustment).toBe(false);
    expect(assessModelAuditResolution(audit, "MODEL_AUDIT_RESOLUTION: unchanged")).toEqual({
      status: "accepted",
      resolution: "unchanged",
    });
    expect(assessModelAuditResolution(audit, "review without receipt").status).toBe("invalid");
  });

  it("gives root review an explicit adjust-or-block contract", () => {
    const audit = buildWeeklyModelAudit(snapshot(), snapshot({ codex: { models: [] } }), [
      { backend: "claude", target: "sonnet", status: "available" },
      { backend: "codex", target: "gpt-5.5", status: "unavailable" },
    ]);
    const instructions = formatModelAuditReviewInstructions(audit);

    expect(instructions).toContain("MODEL_AUDIT_RESOLUTION: adjusted|unchanged|blocked");
    expect(instructions).toContain("不得只登记普通待办");
    expect(instructions).toContain("/model");
    expect(instructions).toContain("/help model");
    expect(instructions).toContain("/btw");
    expect(instructions).toContain("Kimi");
    expect(instructions).toContain("requires source adjustment: yes");
    expect(instructions).toContain("claude --effort parser values");
    expect(instructions).toContain("backend_model_effort_probe v1");
    expect(instructions).toContain("不得直接修改飞书枚举或另写 catalog");
    expect(instructions).not.toContain("MODEL_ENUM_ADDITIONS");
  });
});
