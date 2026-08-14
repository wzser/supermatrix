import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

describe("daily-commit ignore policy", () => {
  it("has a canonical SOP that defines ownership and enforcement boundaries", () => {
    const policyPath = join(ROOT, "sop/references/daily-commit-ignore-policy.md");
    expect(existsSync(policyPath)).toBe(true);
    if (!existsSync(policyPath)) return;

    const policy = readFileSync(policyPath, "utf-8");
    expect(policy).toContain("localgit owns");
    expect(policy).toContain("repo owner owns");
    expect(policy).toContain("allowlist");
    expect(policy).toContain("denylist");
    expect(policy).toContain("auto-remediate");
    expect(policy).toContain("never auto-ignore");
    expect(policy).toContain("owner handoff is a last resort");
    expect(policy).toContain("localgit should resolve about 90%");
    expect(policy).toContain("must-commit candidates");
    expect(policy).toContain("quiet-deferred");
  });

  it("registers the policy in the SOP index", () => {
    const index = readFileSync(join(ROOT, "sop/INDEX.md"), "utf-8");
    expect(index).toContain("daily-commit-ignore-policy.md");
  });

  it("wires the judgment matrix, rubric, and policy path into daily-commit", () => {
    const source = readFileSync(join(ROOT, "src/scripts/daily-commit.ts"), "utf-8");
    const pipeline = readFileSync(join(ROOT, "src/scripts/daily-commit-pipeline.ts"), "utf-8");
    const policySource = readFileSync(join(ROOT, "src/scripts/daily-commit-ignore-policy.ts"), "utf-8");

    // The L2 prompt is loaded from the SOP reference file, never inlined (SOP Step 4).
    expect(pipeline).toContain("L2_PROMPT_REFERENCE_PATH");
    expect(pipeline).toContain("extractPromptTemplate");
    // Owner hints must carry the rubric + a pre-judged default (rubric §D) and the
    // ignore-policy catalog path for repo-local .gitignore decisions.
    expect(source).toContain("OWNER_DECISION_RUBRIC_PATH");
    expect(source).toContain("OWNER_DECISION_RUBRIC_VERSION");
    expect(source).toContain("localgit 预判默认项");
    expect(source).toContain("DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH");
    // Selective staging only — the add -A red line applies to the mechanism itself.
    expect(source).not.toMatch(/add",\s*"-A"/);
    expect(pipeline).not.toMatch(/add",\s*"-A"/);
    expect(pipeline).toContain('"add", "--"');
    expect(policySource).toContain("resolve(LOCALGIT_ROOT, DAILY_COMMIT_IGNORE_POLICY_RELATIVE_PATH)");
    expect(policySource).toContain("must-commit behavior changes");
  });
});
