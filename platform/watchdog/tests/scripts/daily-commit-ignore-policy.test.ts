import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const POLICY_PATH = "sop/daily-commit-ignore-policy.md";

describe("daily-commit ignore policy", () => {
  it("has a canonical SOP that defines ownership and enforcement boundaries", () => {
    const policyPath = join(ROOT, "sop/daily-commit-ignore-policy.md");
    expect(existsSync(policyPath)).toBe(true);
    if (!existsSync(policyPath)) return;

    const policy = readFileSync(policyPath, "utf-8");
    expect(policy).toContain("watchdog owns");
    expect(policy).toContain("repo owner owns");
    expect(policy).toContain("allowlist");
    expect(policy).toContain("denylist");
    expect(policy).toContain("auto-remediate");
    expect(policy).toContain("never auto-ignore");
    expect(policy).toContain("owner handoff is a last resort");
    expect(policy).toContain("watchdog should resolve about 90%");
  });

  it("registers the policy in the SOP index", () => {
    const index = readFileSync(join(ROOT, "sop/INDEX.md"), "utf-8");
    expect(index).toContain("daily-commit-ignore-policy.md");
  });

  it("wires the canonical policy into daily-commit reviewer prompts", () => {
    const source = readFileSync(join(ROOT, "src/scripts/daily-commit.ts"), "utf-8");
    const policySource = readFileSync(join(ROOT, "src/scripts/daily-commit-ignore-policy.ts"), "utf-8");

    expect(source).toContain("DAILY_COMMIT_IGNORE_POLICY_PROMPT");
    expect(source).toContain("DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH");
    expect(policySource).toContain(POLICY_PATH);
    expect(policySource).toContain("owner handoff is a last resort");
    expect(policySource).toContain("watchdog should resolve about 90%");
    expect(source).not.toContain("典型可处理场景：产物目录");
    expect(source).not.toContain("请按 ${DAILY_COMMIT_IGNORE_POLICY_SOP}");

    const refs = source.match(/DAILY_COMMIT_IGNORE_POLICY_PROMPT/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(3);
  });
});
