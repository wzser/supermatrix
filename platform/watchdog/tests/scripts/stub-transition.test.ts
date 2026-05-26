import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectStubToFormalTransitionFromDiff,
  isNovelClaudeMdIdentityChange,
} from "../../src/scripts/stub-transition.js";

const FIXTURES = join(__dirname, "__fixtures__");

describe("detectStubToFormalTransitionFromDiff", () => {
  it("auto-passes tag-manager's real 38a05e3 stub→formal diff (replay of yesterday's flagged case)", () => {
    const diff = readFileSync(join(FIXTURES, "tag-manager-stub-to-formal.diff"), "utf-8");
    const result = detectStubToFormalTransitionFromDiff(diff, ["AGENTS.md", "CLAUDE.md"]);
    expect(result).toMatchObject({ match: true, category: "business" });
  });

  it("rejects when extra files are dirty (preserves risk-class interception)", () => {
    const diff = readFileSync(join(FIXTURES, "tag-manager-stub-to-formal.diff"), "utf-8");
    const result = detectStubToFormalTransitionFromDiff(diff, ["AGENTS.md", "CLAUDE.md", "src/leaked.key"]);
    expect(result.match).toBe(false);
  });

  it("rejects when stub marker is absent (e.g. ordinary CLAUDE.md edit)", () => {
    const diff = `diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,1 +1,2 @@\n # name\n+new section\n`;
    const result = detectStubToFormalTransitionFromDiff(diff, ["CLAUDE.md"]);
    expect(result.match).toBe(false);
  });

  it("rejects when stub is removed but no formal cat-template added", () => {
    const diff = `--- a/CLAUDE.md\n+++ b/CLAUDE.md\n-> **首次激活说明 — 这是临时的"上线初始化运行手册"**\n+just some random replacement\n`;
    const result = detectStubToFormalTransitionFromDiff(diff, ["CLAUDE.md"]);
    expect(result.match).toBe(false);
  });

  it("recognizes each cat-template variant", () => {
    for (const cat of ["business", "platform", "tool", "knowledge"]) {
      const diff = `--- a/CLAUDE.md\n+++ b/CLAUDE.md\n-> **首次激活说明 — 这是临时的"上线初始化运行手册"**\n+> **Reference template for ${cat}-category session CLAUDE.md.**\n`;
      const result = detectStubToFormalTransitionFromDiff(diff, ["CLAUDE.md"]);
      expect(result).toMatchObject({ match: true, category: cat, backend: "CLAUDE.md" });
    }
  });
});

describe("isNovelClaudeMdIdentityChange", () => {
  it("returns false when no CLAUDE.md/AGENTS.md is in the changed set (e.g. .pyc-only flag)", () => {
    expect(isNovelClaudeMdIdentityChange("", ["scripts/__pycache__/foo.pyc", "data/out.csv"], [])).toBe(false);
  });

  it("returns false for ainotes-style diff: stub→formal .md mixed with other dirty files", () => {
    // Replays 2026-05-06 ainotes: stub→formal markers present in the .md diff,
    // but the rejection was about data/ai-notes/ pipeline products, not the .md
    // change itself. FP already governs stub→formal via fp-generate-init —
    // re-escalating just adds noise.
    const diff = readFileSync(join(FIXTURES, "tag-manager-stub-to-formal.diff"), "utf-8");
    const changed = ["AGENTS.md", "CLAUDE.md", "data/ai-notes/raw/r1.json", "data/ai-notes/index.md", "scripts/run.ts"];
    const untracked = ["data/ai-notes/raw/r1.json", "data/ai-notes/index.md"];
    expect(isNovelClaudeMdIdentityChange(diff, changed, untracked)).toBe(false);
  });

  it("returns true for substantial non-stub→formal rewrite (novel identity change)", () => {
    // Synthesize a 40-line +/- diff with no stub marker: a session reorganizing
    // its CLAUDE.md without going through fp-generate-init. FP needs to know.
    const lines: string[] = [
      "diff --git a/CLAUDE.md b/CLAUDE.md",
      "--- a/CLAUDE.md",
      "+++ b/CLAUDE.md",
      "@@ -1,20 +1,20 @@",
    ];
    for (let i = 0; i < 20; i++) lines.push(`-old line ${i}`);
    for (let i = 0; i < 20; i++) lines.push(`+new line ${i}`);
    expect(isNovelClaudeMdIdentityChange(lines.join("\n"), ["CLAUDE.md"], [])).toBe(true);
  });

  it("returns false for a small wording tweak", () => {
    const diff = `diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,2 +1,2 @@\n # session\n-old tagline\n+new tagline\n`;
    expect(isNovelClaudeMdIdentityChange(diff, ["CLAUDE.md"], [])).toBe(false);
  });

  it("returns true when CLAUDE.md is brand new (untracked) — identity creation outside fp-generate-init", () => {
    expect(isNovelClaudeMdIdentityChange("", ["CLAUDE.md"], ["CLAUDE.md"])).toBe(true);
  });

  it("returns true when AGENTS.md is brand new even bundled with other untracked files", () => {
    expect(
      isNovelClaudeMdIdentityChange(
        "",
        ["AGENTS.md", "src/new.ts"],
        ["AGENTS.md", "src/new.ts"],
      ),
    ).toBe(true);
  });
});
