import { describe, expect, it } from "vitest";
import {
  assessCliUpgradeCompatibility,
  assessCliUpgradeCompatibilityRuns,
  extractCodexReferencedModels,
  formatCliUpgradeCompatibilityAssessment,
  parseCliUpgradeCompatibilityReport,
  runCliUpgradeCompatibilityCheck,
  runCliUpgradeCompatibilityPostCheck,
  type CliUpgradeCompatibilityReport,
} from "../../src/scripts/_weekly-upgrade-compatibility.js";

function report(
  checks: CliUpgradeCompatibilityReport["checks"],
): CliUpgradeCompatibilityReport {
  return {
    schemaVersion: 1,
    profile: "cli-upgrade",
    mode: "observe",
    ok: !checks.some(({ status }) => status === "fail"),
    checks,
  };
}

describe("weekly CLI upgrade compatibility gate", () => {
  it("requires source adjustment for structured Codex alias drift without rolling back the CLI", () => {
    const before = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const after = report([
      {
        name: "codex-default-model",
        status: "warn",
        detail: {
          slug: "gpt-5.5",
          reasonCode: "CODEX_ALIAS_CATALOG_DRIFT",
          aliases: [{ alias: "5.4", target: "gpt-5.4" }],
        },
      },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "adjustment-required",
      requiresAdjustment: true,
      adjustmentReasons: ["CODEX_ALIAS_CATALOG_DRIFT"],
      rollbackClis: [],
    });
  });

  it("does not roll Codex back when a stale explicit pin has a runnable fallback", () => {
    const before = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const after = report([
      {
        name: "codex-default-model",
        status: "warn",
        detail: {
          fallbackSlug: "gpt-5.6-sol",
          reasonCode: "CODEX_ALIAS_CATALOG_DRIFT",
          aliases: [{ alias: "5.4", target: "gpt-5.4" }],
        },
      },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "adjustment-required",
      requiresAdjustment: true,
      adjustmentReasons: ["CODEX_ALIAS_CATALOG_DRIFT"],
      rollbackClis: [],
    });
  });

  it("does not roll Codex back for a runnable explicit-pin fallback without alias drift", () => {
    const before = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const after = report([
      {
        name: "codex-default-model",
        status: "warn",
        message: "configured default is unavailable; using detected fallback",
        detail: {
          fallbackSlug: "gpt-5.6-sol",
        },
      },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "pass",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: [],
    });
  });

  it("does not treat an empty fallback slug as runnable", () => {
    const before = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const after = report([
      {
        name: "codex-default-model",
        status: "warn",
        message: "configured default is unavailable",
        detail: {
          fallbackSlug: "",
        },
      },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "fail",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: ["codex"],
      error: "codex-default-model: configured default is unavailable",
    });
  });

  it("rolls Codex back when the post-upgrade boot check newly fails", () => {
    const before = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const after = report([
      {
        name: "codex-default-model",
        status: "fail",
        message: "configured default is outside the effective catalog",
      },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "fail",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: ["codex"],
      error: "codex-default-model: configured default is outside the effective catalog",
    });
  });

  it("rolls Codex back on a new non-alias warning such as catalog detection failure", () => {
    const before = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const after = report([
      {
        name: "codex-default-model",
        status: "warn",
        message: "codex 默认模型自动检测失败：debug models exited 2",
      },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "fail",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: ["codex"],
      error: "codex-default-model: codex 默认模型自动检测失败：debug models exited 2",
    });
  });

  it("rolls Kimi back when ACP health newly degrades after the installer", () => {
    const before = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const after = report([
      { name: "codex-default-model", status: "ok" },
      {
        name: "kimi-acp-health",
        status: "warn",
        message: "ACP initialize rejected the negotiated protocol",
      },
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "fail",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: ["kimi-code"],
      error: "kimi-acp-health: ACP initialize rejected the negotiated protocol",
    });
  });

  it("does not blame an upgrade for a pre-existing Kimi warning", () => {
    const warning = {
      name: "kimi-acp-health",
      status: "warn" as const,
      message: "ACP initialize is already unavailable",
    };
    const before = report([
      { name: "codex-default-model", status: "ok" },
      warning,
    ]);
    const after = report([
      { name: "codex-default-model", status: "ok" },
      warning,
    ]);

    expect(assessCliUpgradeCompatibility(before, after)).toEqual({
      status: "pass",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: [],
    });
  });

  it("parses the structured SuperMatrix cli-upgrade self-check report", () => {
    const parsed = parseCliUpgradeCompatibilityReport(JSON.stringify({
      schemaVersion: 1,
      profile: "cli-upgrade",
      mode: "observe",
      ok: true,
      checks: [
        {
          name: "codex-default-model",
          status: "warn",
          detail: {
            reasonCode: "CODEX_ALIAS_CATALOG_DRIFT",
            aliases: [{ alias: "5.4", target: "gpt-5.4" }],
          },
        },
        { name: "kimi-acp-health", status: "ok" },
      ],
    }));

    expect(parsed.checks).toHaveLength(2);
    expect(parsed.checks[0]).toMatchObject({
      name: "codex-default-model",
      status: "warn",
    });
  });

  it("runs the existing SuperMatrix self-check entry with the cli-upgrade JSON profile", () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const expected = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    const result = runCliUpgradeCompatibilityCheck((command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return {
        status: 0,
        stdout: JSON.stringify(expected),
        stderr: "",
      };
    });

    expect(calls).toEqual([{
      command: "/usr/local/bin/npm",
      args: ["run", "--silent", "self-check", "--", "--profile", "cli-upgrade"],
      cwd: "/Users/LOCAL_USER/SuperMatrix",
    }]);
    expect(result).toEqual({ kind: "ok", report: expected });
  });

  it("accepts the known Kimi ACP launch preamble before the structured report", () => {
    const expected = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    const result = runCliUpgradeCompatibilityCheck(() => ({
      status: 0,
      stdout: [
        "[kimi-acp launch] {",
        "  command: '/Users/LOCAL_USER/.kimi-code/bin/kimi',",
        "  args: [ '--skills-dir', '/Users/LOCAL_USER/.kimi/skills', 'acp' ],",
        "  pid: 83731",
        "}",
        JSON.stringify(expected),
      ].join("\n"),
      stderr: "",
    }));

    expect(result).toEqual({ kind: "ok", report: expected });
  });

  it("keeps unknown self-check stdout preambles fail-closed", () => {
    const expected = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    const result = runCliUpgradeCompatibilityCheck(() => ({
      status: 0,
      stdout: `unexpected diagnostic\n${JSON.stringify(expected)}`,
      stderr: "",
    }));

    expect(result).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("returned invalid JSON"),
    });
  });

  it("fails closed when the self-check command times out after printing an otherwise healthy report", () => {
    const expected = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    const result = runCliUpgradeCompatibilityCheck(() => ({
      status: null,
      stdout: JSON.stringify(expected),
      stderr: "",
      error: new Error("spawnSync npm ETIMEDOUT"),
    }));

    expect(result).toEqual({
      kind: "fail",
      error: "cli-upgrade self-check failed: spawnSync npm ETIMEDOUT",
      report: expected,
    });
  });

  it("does not turn a timed-out post-check into pass because it printed healthy JSON first", () => {
    const healthy = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);

    expect(assessCliUpgradeCompatibilityRuns(
      { kind: "ok", report: healthy },
      {
        kind: "fail",
        error: "cli-upgrade self-check failed: spawnSync npm ETIMEDOUT",
        report: healthy,
      },
    )).toEqual({
      status: "fail",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: [],
      error: "post-upgrade compatibility check failed: cli-upgrade self-check failed: spawnSync npm ETIMEDOUT",
    });
  });

  it("retries a post-check once when no structured report was produced", () => {
    const healthy = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const runs = [
      {
        kind: "fail" as const,
        error: "cli-upgrade self-check returned invalid JSON: Unexpected end of JSON input",
      },
      { kind: "ok" as const, report: healthy },
    ];

    expect(runCliUpgradeCompatibilityPostCheck(() => runs.shift()!)).toEqual({
      run: { kind: "ok", report: healthy },
      attempts: 2,
      firstFailure: "cli-upgrade self-check returned invalid JSON: Unexpected end of JSON input",
    });
  });

  it("does not retry a structured post-check failure", () => {
    const failed = report([
      {
        name: "codex-default-model",
        status: "fail",
        message: "configured default is unavailable",
      },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    let attempts = 0;

    expect(runCliUpgradeCompatibilityPostCheck(() => {
      attempts += 1;
      return {
        kind: "fail",
        error: "cli-upgrade self-check failed: exit 1",
        report: failed,
      };
    })).toEqual({
      run: {
        kind: "fail",
        error: "cli-upgrade self-check failed: exit 1",
        report: failed,
      },
      attempts: 1,
    });
    expect(attempts).toBe(1);
  });

  it("returns the second no-report failure after the bounded post-check retry", () => {
    let attempts = 0;

    expect(runCliUpgradeCompatibilityPostCheck(() => {
      attempts += 1;
      return {
        kind: "fail",
        error: `cli-upgrade self-check transport failure ${attempts}`,
      };
    })).toEqual({
      run: {
        kind: "fail",
        error: "cli-upgrade self-check transport failure 2",
      },
      attempts: 2,
      firstFailure: "cli-upgrade self-check transport failure 1",
    });
    expect(attempts).toBe(2);
  });

  it("fails closed on an internally inconsistent exit-zero failure report", () => {
    const failed = {
      ...report([
        {
          name: "codex-default-model",
          status: "fail" as const,
          message: "configured default is unavailable",
        },
        { name: "kimi-acp-health", status: "ok" as const },
      ]),
      ok: false,
    };

    const result = runCliUpgradeCompatibilityCheck(() => ({
      status: 0,
      stdout: JSON.stringify(failed),
      stderr: "",
    }));

    expect(result).toEqual({
      kind: "fail",
      error: "cli-upgrade self-check reported ok=false with exit 0",
      report: failed,
    });
  });

  it("fails closed when a required compatibility check is missing", () => {
    const incomplete = report([
      { name: "codex-default-model", status: "ok" },
    ]);

    const result = runCliUpgradeCompatibilityCheck(() => ({
      status: 0,
      stdout: JSON.stringify(incomplete),
      stderr: "",
    }));

    expect(result).toEqual({
      kind: "fail",
      error: "cli-upgrade self-check is missing required check: kimi-acp-health",
      report: incomplete,
    });
  });

  it("fails closed when report.ok contradicts its check statuses", () => {
    const inconsistent = {
      ...report([
        {
          name: "codex-default-model",
          status: "fail" as const,
          message: "broken",
        },
        { name: "kimi-acp-health", status: "ok" as const },
      ]),
      ok: true,
    };

    const result = runCliUpgradeCompatibilityCheck(() => ({
      status: 0,
      stdout: JSON.stringify(inconsistent),
      stderr: "",
    }));

    expect(result).toEqual({
      kind: "fail",
      error: "cli-upgrade self-check report ok/check status mismatch",
      report: inconsistent,
    });
  });

  it("keeps a structured runner fatal as a failed assessment", () => {
    const healthy = report([
      { name: "codex-default-model", status: "ok" },
      { name: "kimi-acp-health", status: "ok" },
    ]);
    const fatal = {
      schemaVersion: 1 as const,
      profile: "cli-upgrade" as const,
      mode: "observe" as const,
      ok: false,
      checks: [],
      error: {
        code: "SELF_CHECK_FATAL" as const,
        message: "config exploded",
      },
    };

    expect(assessCliUpgradeCompatibilityRuns(
      { kind: "ok", report: healthy },
      {
        kind: "fail",
        error: "cli-upgrade self-check failed: exit 2",
        report: fatal,
      },
    )).toEqual({
      status: "fail",
      requiresAdjustment: false,
      adjustmentReasons: [],
      rollbackClis: [],
      error: "post-upgrade compatibility check failed: cli-upgrade self-check failed: exit 2",
    });
  });

  it("preserves the structured runner fatal instead of reporting a missing check", () => {
    const fatal = {
      schemaVersion: 1 as const,
      profile: "cli-upgrade" as const,
      mode: "observe" as const,
      ok: false,
      checks: [],
      error: {
        code: "SELF_CHECK_FATAL" as const,
        message: "config exploded",
      },
    };

    expect(runCliUpgradeCompatibilityCheck(() => ({
      status: 2,
      stdout: JSON.stringify(fatal),
      stderr: "",
    }))).toEqual({
      kind: "fail",
      error: "cli-upgrade self-check fatal: config exploded",
      report: fatal,
    });
  });

  it("formats the compatibility decision and recovery outcome for the Console receipt", () => {
    expect(formatCliUpgradeCompatibilityAssessment({
      status: "fail",
      requiresAdjustment: true,
      adjustmentReasons: ["CODEX_ALIAS_CATALOG_DRIFT"],
      rollbackClis: ["codex"],
      error: "codex-default-model: configured default is unavailable",
    }, {
      kind: "ok",
      report: report([
        { name: "codex-default-model", status: "ok" },
        { name: "kimi-acp-health", status: "ok" },
      ]),
    })).toEqual([
      "status: fail",
      "source adjustment: CODEX_ALIAS_CATALOG_DRIFT",
      "rollback: codex",
      "error: codex-default-model: configured default is unavailable",
      "recovery check: pass",
    ]);
  });

  it("extracts referenced Codex models from the owner profile without a watchdog alias registry", () => {
    const ownerReport = report([
      {
        name: "codex-default-model",
        status: "warn",
        message: "alias drift",
        detail: {
          slug: "gpt-5.5",
          referencedModels: ["gpt-5.6-sol", "gpt-5.4", "gpt-5.4"],
          aliases: [
            { alias: "5.4-mini", target: "gpt-5.4-mini" },
          ],
        },
      },
    ]);

    expect(extractCodexReferencedModels(ownerReport)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-sol",
    ]);
  });
});
