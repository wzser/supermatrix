import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROOT_SESSION,
  SPAWN_API,
  SOURCE_SESSION,
  buildRootReviewSpawnBody,
  childSessionIdFromDelegation,
  childSessionIdFromPending,
  classifyClaudeAuthStatus,
  classifyPolledSessionResult,
  formatWeeklyRunDate,
  formatUpgradeLines,
  formatSpawnAdmissionError,
  normalizeSpawn2Delegation,
  resultFromVersionProbe,
  shouldKickoffRootReview,
} from "../../src/scripts/_weekly-upgrade-shared.js";
import * as weeklyUpgradeShared from "../../src/scripts/_weekly-upgrade-shared.js";

const CHECKLIST_FILE = "docs/weekly-cli-upgrade-checklist.md";

describe("weekly upgrade spawn contract", () => {
  it("builds root review spawns on spawn2.0 with a tracked delegation closure", () => {
    const body = buildRootReviewSpawnBody("review prompt", "2026-05-27");

    expect(SPAWN_API).toBe("http://localhost:3501/api/spawn2.0");
    expect(body).toMatchObject({
      target: ROOT_SESSION,
      from: SOURCE_SESSION,
      prompt: "review prompt",
      client_request_id: "2026-05-27:watchdog:weekly-upgrade:supermatrix-root",
      closure: { kind: "message", target: { type: "todo_pool" } },
    });
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("supermatrix_internal");
    expect(body.verification_predicate).toEqual({
      type: "git-log",
      repo_path: "/Users/LOCAL_USER/SuperMatrix",
      since: { kind: "spawn_created_at" },
      message_regex: "(?:update lark cli dependency|adapt to (?:claude-code|codex|lark-cli|kimi-code)@|weekly CLI upgrade)",
      min_count: 1,
      expected_window_sec: 28800,
    });
  });

  it("keeps the full spawn2.0 delegation record instead of only a child session id", () => {
    const record = normalizeSpawn2Delegation(
      {
        ok: true,
        mode: "async_kickoff",
        closure: "todo_pool",
        childSessionId: "sess_weekly_review",
        childSessionName: "supermatrix-root-child",
        messageRunId: "mr_weekly_review",
        comm_id: "comm_weekly_review_public",
        spawnCommId: "comm_weekly_review",
      },
      "2026-05-27:watchdog:weekly-upgrade:supermatrix-root",
    );

    expect(record).toMatchObject({
      api: "spawn2.0",
      clientRequestId: "2026-05-27:watchdog:weekly-upgrade:supermatrix-root",
      closure: "todo_pool",
      childSessionId: "sess_weekly_review",
      childSessionName: "supermatrix-root-child",
      messageRunId: "mr_weekly_review",
      commId: "comm_weekly_review_public",
      spawnCommId: "comm_weekly_review",
    });
    expect(record.response).toMatchObject({
      ok: true,
      childSessionId: "sess_weekly_review",
      spawnCommId: "comm_weekly_review",
    });
    expect(childSessionIdFromDelegation(record)).toBe("sess_weekly_review");
  });

  it("can still poll legacy pending files that only stored childSessionId", () => {
    expect(childSessionIdFromPending({
      runDate: "2026-05-27",
      spawnedAt: Date.parse("2026-05-27T01:02:03.000Z"),
      childSessionId: "sess_legacy_weekly_review",
      results: [],
    })).toBe("sess_legacy_weekly_review");
  });

  it("rejects spawn2.0 responses that do not include a pollable child session", () => {
    expect(() => normalizeSpawn2Delegation(
      { ok: false, status: "switched_async", ref: "async_ref", spawnCommId: "comm_weekly_review" },
      "2026-05-27:watchdog:weekly-upgrade:supermatrix-root",
    )).toThrow(/pollable childSessionId/);
  });

  it("preserves machine-readable spawn admission errors", () => {
    const message = formatSpawnAdmissionError(400, {
      ok: false,
      code: "MISSING_VERIFICATION_PREDICATE",
      error: "missing verification_predicate",
      details: ["verification_predicate is required for /api/spawn2.0"],
    });

    expect(message).toBe(
      "HTTP 400 MISSING_VERIFICATION_PREDICATE: missing verification_predicate - verification_predicate is required for /api/spawn2.0",
    );
  });

  it("accepts only completed session results with a non-empty finalMessage", () => {
    expect(classifyPolledSessionResult({
      status: "completed",
      finalMessage: "review body",
    })).toEqual({ status: "done", finalMessage: "review body" });

    expect(classifyPolledSessionResult({
      status: "completed",
      finalMessage: "",
    })).toEqual({ status: "failed", reason: "completed with empty finalMessage" });
  });

  it("treats timeout session results as failed instead of delivered reviews", () => {
    expect(classifyPolledSessionResult({
      status: "timeout",
      finalMessage: null,
      errorMessage: "boot reconcile: backend orphaned by console restart",
    })).toEqual({
      status: "failed",
      reason: "timeout: boot reconcile: backend orphaned by console restart",
    });
  });

  it("formats upgrade result lines in Chinese for Console cards", () => {
    const { lines, changed, failed } = formatUpgradeLines([
      { cli: "codex", before: "0.1.0", after: "0.2.0", changed: true },
      { cli: "kimi-code", before: "0.20.1", after: "0.26.0", changed: true },
      { cli: "lark-cli", before: "1.0.0", after: "1.0.0", changed: false },
      { cli: "claude-code", before: "2.0.0", after: "2.0.0", changed: false, error: "network" },
    ]);

    expect(lines).toEqual([
      "- ✅ **codex**: 0.1.0 → 0.2.0",
      "- ✅ **kimi-code**: 0.20.1 → 0.26.0",
      "- ⏸ **lark-cli**: 1.0.0（已是最新）",
      "- ❌ **claude-code**: 2.0.0 → 升级失败（network）",
    ]);
    expect(changed).toBe(2);
    expect(failed).toBe(1);
  });

  it("uses the Asia/Shanghai scheduler date instead of UTC for weekly run identity", () => {
    expect(formatWeeklyRunDate(new Date("2026-07-01T20:30:15.000Z"))).toBe("2026-07-02");
  });

  it("treats a post-upgrade version probe failure as a failed upgrade", () => {
    expect(resultFromVersionProbe({
      cli: "codex",
      before: "0.142.5",
      after: "unknown",
      versionCommand: "codex --version",
    })).toEqual({
      cli: "codex",
      before: "0.142.5",
      after: "unknown",
      changed: false,
      error: "post-upgrade version probe failed: codex --version returned unknown",
    });
  });

  it("does not kick off root review when any CLI upgrade failed", () => {
    expect(shouldKickoffRootReview([
      { cli: "claude-code", before: "1.0.0", after: "1.1.0", changed: true },
      { cli: "codex", before: "0.142.5", after: "unknown", changed: false, error: "probe failed" },
    ])).toBe(false);

    expect(shouldKickoffRootReview([
      { cli: "claude-code", before: "1.0.0", after: "1.1.0", changed: true },
      { cli: "codex", before: "0.142.5", after: "0.142.5", changed: false },
    ])).toBe(true);

    expect(shouldKickoffRootReview([
      { cli: "claude-code", before: "1.0.0", after: "1.0.0", changed: false },
      { cli: "codex", before: "0.142.5", after: "0.142.5", changed: false },
    ], true)).toBe(true);
  });

  it("lets a recovered (rolled-back and verified) failure pass the review gate, but not an unrecovered one", () => {
    const changedClaude = { cli: "claude-code", before: "1.0.0", after: "1.1.0", changed: true };
    expect(shouldKickoffRootReview([
      changedClaude,
      { cli: "kimi-code", before: "0.30.0", after: "0.30.0", changed: false, error: "SM-PATCH failed; rolled back to 0.30.0", recovered: true },
    ])).toBe(true);

    expect(shouldKickoffRootReview([
      changedClaude,
      { cli: "kimi-code", before: "0.30.0", after: "0.30.0", changed: false, error: "SM-PATCH failed; rollback failed", recovered: false },
    ])).toBe(false);
  });

  it("computes review changes against the last-reviewed baseline, catching interrupted-run drift", () => {
    const { computeReviewChanges } = weeklyUpgradeShared;
    // 补跑场景：本进程 changed:false，但版本相对基线已漂移 → 仍需 review
    const results = [
      { cli: "claude-code", before: "2.1.222", after: "2.1.222", changed: false },
      { cli: "codex", before: "0.146.1", after: "0.146.1", changed: false },
      { cli: "kimi-code", before: "0.30.0", after: "0.30.0", changed: false },
    ];
    const baseline = {
      runDate: "2026-07-30",
      reviewedAt: 1,
      versions: { "claude-code": "2.1.220", codex: "0.146.1", "kimi-code": "0.30.0" },
    };
    expect(computeReviewChanges(results, baseline)).toEqual([
      { cli: "claude-code", before: "2.1.220", after: "2.1.222", changed: true },
    ]);
    // 基线缺失（首次运行）退回本进程 changed 标志
    expect(computeReviewChanges(results, null)).toEqual([]);
    expect(computeReviewChanges(
      [{ cli: "codex", before: "0.146.0", after: "0.146.1", changed: true }],
      null,
    )).toEqual([{ cli: "codex", before: "0.146.0", after: "0.146.1", changed: true }]);
    // after unknown（探测失败）不进 review changes
    expect(computeReviewChanges(
      [{ cli: "codex", before: "0.146.1", after: "unknown", changed: false, error: "probe failed" }],
      baseline,
    )).toEqual([]);
  });

  it("assesses root review changelog coverage fail-closed", () => {
    const { assessChangelogCoverage } = weeklyUpgradeShared;
    const expected = [
      { cli: "claude-code", versions: ["2.1.221", "2.1.222"] },
      { cli: "codex", versions: ["0.146.1"] },
    ];
    expect(assessChangelogCoverage("anything", undefined)).toEqual({ status: "not-required" });
    expect(assessChangelogCoverage("anything", [{ cli: "kimi-code", versions: [] }])).toEqual({ status: "not-required" });
    expect(assessChangelogCoverage("## Checklist\n- [✓] x", expected)).toEqual({ status: "missing-section" });
    expect(assessChangelogCoverage(
      "## Changelog coverage\n- [claude-code] 2.1.221: 不影响\n- [claude-code] 2.1.222: 不影响\n\n## Checklist meta\n无",
      expected,
    )).toEqual({ status: "incomplete", missing: [{ cli: "codex", version: "0.146.1" }] });
    expect(assessChangelogCoverage(
      "## Changelog coverage\n- [claude-code] 2.1.221: 不影响\n- [claude-code] 2.1.222: 不影响\n- [codex] 0.146.1: 不影响\n\n## Checklist meta\n无",
      expected,
    )).toEqual({ status: "ok" });
    // 版本号出现在 coverage 段之外不算覆盖
    expect(assessChangelogCoverage(
      "本周升级 codex 0.146.1\n## Changelog coverage\n- [claude-code] 2.1.221: 不影响\n- [claude-code] 2.1.222: 不影响\n## 后续",
      expected,
    )).toEqual({ status: "incomplete", missing: [{ cli: "codex", version: "0.146.1" }] });
  });

  it("keeps model availability probes in the weekly upgrade checklist", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("claude -p --model <id> \"ping\"");
    expect(checklist).toContain("AVAILABLE_CLAUDE_MODEL_IDS");
    expect(checklist).toContain("CodexModelCatalog");
    expect(checklist).toContain("KimiModelCatalog");
    expect(checklist).toContain("provider list --json");
  });

  it("checks Codex's config-based effort contract instead of retired direct flags", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("model_reasoning_effort");
    expect(checklist).toContain("max -> xhigh");
    expect(checklist).toContain("不把 `--thinking` / `--effort` 当作当前 Codex CLI flag");
  });

  it("requires account-level Codex model probes rather than trusting the bundled catalog", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("not supported when using Codex with a ChatGPT account");
    expect(checklist).toContain("bundled catalog 不等于当前登录可用性");
  });

  it("keeps lark-cli update notice noise in the weekly upgrade checklist", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("_notice.update");
    expect(checklist).toContain("普通任务最终回复");
    expect(checklist).toContain("weekly CLI upgrade/report");
  });

  it("keeps SuperMatrix /effort command and backend propagation checks in the weekly upgrade checklist", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("/effort");
    expect(checklist).toContain("setModelEffortBatch.test.ts");
    expect(checklist).toContain("backend-claude/commandBuilder.test.ts");
    expect(checklist).toContain("backend-codex/commandBuilder.test.ts");
    expect(checklist).toContain("model_reasoning_effort");
    expect(checklist).toContain("max -> xhigh");
  });

  it("requires Claude effort-surface review instead of assuming Codex ultra applies to Claude", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("Claude `--effort`");
    expect(checklist).toContain("low / medium / high / xhigh / max");
    expect(checklist).toContain("`ultra`");
    expect(checklist).toContain("`ultracode`");
    expect(checklist).toContain("claude --effort <candidate> --version");
    expect(checklist).toContain("/help effort");
  });

  it("requires /help model documentation review after Codex, Claude, or Kimi upgrades", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("/help model");
    expect(checklist).toContain("src/app/commandRegistry.ts");
    expect(checklist).toContain("tests/app/commands/help.test.ts");
    expect(checklist).toContain("Kimi Code");
  });

  it("keeps BTW on its independently pinned lower-tier models after CLI upgrades", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("/btw");
    expect(checklist).toContain("Claude = `sonnet`");
    expect(checklist).toContain("Codex = `gpt-5.5`");
    expect(checklist).toContain("tests/app/commands/btw.test.ts");
    expect(checklist).toContain("quota/rate-limit");
    expect(checklist).toContain("retired/renamed");
    expect(checklist).toContain("MODEL_AUDIT_RESOLUTION");
    expect(checklist).toContain("升级前后");
  });

  it("keeps the claude-code hidden marker regression check suspended in the weekly upgrade checklist", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(checklist).toContain("隐形标记回归（暂停，2026-07-09）");
    expect(checklist).toContain("claudeMarkerCheck=skipped");
    expect(checklist).toContain("不运行历史修复脚本");
    expect(checklist).not.toContain("check-claude-marker.ts --repair --json");
    expect(checklist).not.toContain("codesign --force --sign -");
  });

  it("keeps Claude Code authentication checks token-safe, quota-aware, and fail-closed", () => {
    type AuthStatus = "authenticated" | "quota" | "unauthenticated" | "unknown";
    type Probe = { context: "interactive-terminal" | "launchctl-asuser"; status: AuthStatus; exitCode: number };
    type Snapshot = {
      version: string;
      keychainScopes: Record<"user:inference" | "user:profile", boolean>;
      probes: Probe[];
    };
    type Summary = { status: "pass" | "fail"; authStatus: AuthStatus; remediation?: string };
    type Classify = (input: { exitCode: number; output: string }) => AuthStatus;
    type Summarize = (input: Snapshot) => Summary;
    type Assess = (before: Summary, after: Summary) => { status: "pass" | "fail"; remediation?: string; rebootWakeFollowUp: string };

    const api = weeklyUpgradeShared as unknown as {
      classifyClaudeAuthStatus?: Classify;
      summarizeClaudeAuthSnapshot?: Summarize;
      assessClaudeAuthCheck?: Assess;
    };
    expect(api.classifyClaudeAuthStatus).toBeTypeOf("function");
    expect(api.summarizeClaudeAuthSnapshot).toBeTypeOf("function");
    expect(api.assessClaudeAuthCheck).toBeTypeOf("function");
    if (!api.classifyClaudeAuthStatus || !api.summarizeClaudeAuthSnapshot || !api.assessClaudeAuthCheck) return;

    expect(api.classifyClaudeAuthStatus({ exitCode: 1, output: "HTTP 429 quota exceeded" })).toBe("quota");
    expect(api.classifyClaudeAuthStatus({ exitCode: 1, output: "Not logged in. Run claude auth login." })).toBe("unauthenticated");

    const probes = (status: AuthStatus): Probe[] => Array.from({ length: 3 }, () => [
      { context: "interactive-terminal" as const, status, exitCode: status === "authenticated" ? 0 : 1 },
      { context: "launchctl-asuser" as const, status, exitCode: status === "authenticated" ? 0 : 1 },
    ]).flat();
    const quota = api.summarizeClaudeAuthSnapshot({
      version: "2.1.215",
      keychainScopes: { "user:inference": true, "user:profile": true },
      probes: probes("quota"),
    });
    expect(quota).toMatchObject({ status: "pass", authStatus: "quota" });
    expect(quota.remediation).toBeUndefined();

    const missingProfile = api.summarizeClaudeAuthSnapshot({
      version: "2.1.215",
      keychainScopes: { "user:inference": true, "user:profile": false },
      probes: probes("authenticated"),
    });
    expect(missingProfile).toMatchObject({ status: "fail", remediation: "claude auth login --claudeai" });
    expect(api.assessClaudeAuthCheck(quota, missingProfile)).toMatchObject({
      status: "fail",
      remediation: "claude auth login --claudeai",
      rebootWakeFollowUp: "next-scheduled-run-only",
    });
  });

  it("classifies Claude auth JSON loggedIn independently of exit code", () => {
    const loggedOutJson = JSON.stringify({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    });

    expect(classifyClaudeAuthStatus({ exitCode: 0, output: loggedOutJson })).toBe("unauthenticated");
    expect(classifyClaudeAuthStatus({ exitCode: 1, output: loggedOutJson })).toBe("unauthenticated");
    expect(classifyClaudeAuthStatus({ exitCode: 1, output: JSON.stringify({ loggedIn: true }) })).toBe("authenticated");
    expect(classifyClaudeAuthStatus({ exitCode: 0, output: JSON.stringify({ loggedIn: "false" }) })).toBe("unknown");
    expect(classifyClaudeAuthStatus({ exitCode: 0, output: "{malformed" })).toBe("unknown");
  });

  it("keeps the scheduled Claude auth verifier in the tracked checklist and receipts", () => {
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");
    const source = readFileSync("src/scripts/weekly-upgrade.ts", "utf-8");

    expect(checklist).toContain("claude auth status");
    expect(checklist).toContain("Claude Code-credentials");
    expect(checklist).toContain("user:inference");
    expect(checklist).toContain("user:profile");
    expect(checklist).toContain("launchctl asuser");
    expect(checklist).toContain("429 quota");
    expect(checklist).toContain("claude auth login --claudeai");
    expect(checklist).toContain("不主动重启");
    expect(source).toContain("captureClaudeAuthSnapshot");
    expect(source).toContain("claude-auth-before");
    expect(source).toContain("claude-auth-after");
    expect(source).toContain("claudeAuthCheck");
    expect(source).toContain("writeReceipt({ date, results, claudeMarkerCheck: markerCheck, claudeAuthCheck");
  });

  it("loads the tracked checklist rather than ignored runtime data", () => {
    const source = readFileSync("src/scripts/weekly-upgrade.ts", "utf-8");

    expect(source).toContain('join(process.cwd(), "docs", "weekly-cli-upgrade-checklist.md")');
    expect(source).not.toContain('join(process.cwd(), "data", "upgrade-review-checklist.md")');
    expect(source).toContain("required weekly upgrade checklist is unavailable");
  });

  it("runs model drift detection inside the scheduled do/report workflow", () => {
    const doSource = readFileSync("src/scripts/weekly-upgrade.ts", "utf-8");
    const reportSource = readFileSync("src/scripts/weekly-upgrade-report.ts", "utf-8");
    const checklist = readFileSync(CHECKLIST_FILE, "utf-8");

    expect(doSource).toContain("runCliUpgradeCompatibilityCheck");
    expect(doSource).toContain("assessCliUpgradeCompatibilityRuns");
    expect(doSource).toContain("compatibilityAssessment");
    expect(doSource).toContain("compatibilityEvidence");
    expect(doSource).toContain(
      "buildWeeklyModelAudit(modelSurfaceBefore, modelSurfaceAfter, modelProbes, compatibilityAssessment)",
    );
    expect(doSource).toContain("compatibilityAssessment.status !== \"fail\"");
    expect(doSource).toContain("captureModelSurface");
    expect(doSource).toContain("runBtwModelProbes");
    expect(doSource).toContain("extractCodexReferencedModels");
    expect(doSource).toContain("collectCodexUpgradeProbeTargets");
    expect(doSource).toContain("runCodexModelProbes");
    expect(doSource).toContain("buildWeeklyModelAudit");
    expect(doSource).toContain("upgradeKimi");
    expect(doSource).toContain("snapshotLarkManifests");
    expect(doSource).toContain("restoreLarkManifests");
    expect(doSource).toContain(
      "codex --version failed before upgrade; exact rollback baseline unavailable",
    );
    expect(doSource).toContain("KIMI_CODE_INSTALLER_URL");
    expect(doSource).toContain("SM_KIMI_CLI_PATH");
    expect(doSource).toContain("modelAudit.requiresReview");
    expect(doSource).toContain("modelAudit,");
    expect(checklist).toContain("npm run --silent self-check -- --profile cli-upgrade");
    expect(checklist).toContain("reasonCode=CODEX_ALIAS_CATALOG_DRIFT");
    expect(checklist).toContain("Binary transaction");
    expect(checklist).toContain("Dependency transaction");
    expect(reportSource).toContain("assessModelAuditResolution");
    expect(reportSource).toContain("modelAuditResolution");
  });
});
