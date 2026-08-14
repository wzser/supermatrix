import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JUDGMENT_PARAMS,
  L2_PROMPT_REFERENCE_PATH,
  SECRET_CONTENT_PATTERNS,
  SECRET_NAME_GLOBS,
  SECRET_PATH_DIRS,
  SECRET_PATTERNS_REFERENCE_PATH,
  buildCommitMessage,
  buildCommitSet,
  buildL2Prompt,
  buildVerdictCache,
  classifyFileL0,
  decideInFlightGate,
  deriveLastReviewedAt,
  extractPromptTemplate,
  isBehaviorFastPathEligible,
  loadRepoPolicy,
  matchPolicyRule,
  matchesSecretContent,
  matchesSecretName,
  noiseIgnoreEntryFor,
  orderReposForProcessing,
  parseL2Verdicts,
  prioritizeForContentScan,
  summarizeLeftovers,
  type FileEvidence,
  type FileDisposition,
} from "../../src/scripts/daily-commit-judgment-matrix.js";
import type { GitLedgerEntry } from "../../src/scripts/git-ledger.js";

function evidence(overrides: Partial<FileEvidence> & { file: string }): FileEvidence {
  return {
    statusCode: "??",
    bytes: 100,
    isBinary: false,
    contentSample: "",
    sampled: true,
    ...overrides,
  };
}

describe("L0 classification (SOP Step 2, R1-R9 first match wins)", () => {
  it("R1: secret filenames and secret-bearing paths deny", () => {
    expect(classifyFileL0(evidence({ file: ".env" }))).toBe("deny_secret");
    expect(classifyFileL0(evidence({ file: "config/.env.production" }))).toBe("deny_secret");
    expect(classifyFileL0(evidence({ file: "certs/server.pem" }))).toBe("deny_secret");
    expect(classifyFileL0(evidence({ file: "ops/service-account-prod.json" }))).toBe("deny_secret");
    expect(classifyFileL0(evidence({ file: ".ssh/known_hosts" }))).toBe("deny_secret");
    expect(classifyFileL0(evidence({ file: "config/api_credentials.yaml" }))).toBe("deny_secret");
  });

  it("R1: tokenizer artifacts are excluded from the *token* glob", () => {
    expect(matchesSecretName("models/tokenizer.json")).toBe(false);
    expect(matchesSecretName("stats/token_count.log")).toBe(false);
    expect(matchesSecretName("secrets/api_token.txt")).toBe(true);
  });

  it("R1: secret content patterns deny even innocuous filenames", () => {
    expect(matchesSecretContent("aws_key = AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(matchesSecretContent("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(matchesSecretContent('api_key = "EXAMPLEA1234EFGH5678"')).toBe(true);
    expect(matchesSecretContent("plain readme text")).toBe(false);
    expect(
      classifyFileL0(evidence({ file: "src/config.ts", contentSample: "token: ghp_EXAMPLE01234567890123456789012345678" })),
    ).toBe("deny_secret");
  });

  it("R2: database files deny to manifest flow", () => {
    expect(classifyFileL0(evidence({ file: "state/app.sqlite" }))).toBe("deny_db");
    expect(classifyFileL0(evidence({ file: "runtime.db-wal" }))).toBe("deny_db");
    expect(classifyFileL0(evidence({ file: "cache.sqlite-shm" }))).toBe("deny_db");
  });

  it("R3: oversized files deny; small files pass through", () => {
    expect(classifyFileL0(evidence({ file: "src/big.ts", bytes: JUDGMENT_PARAMS.bigFileBytes + 1 }))).toBe("deny_big");
    expect(
      classifyFileL0(evidence({ file: "assets/blob.bin", isBinary: true, bytes: JUDGMENT_PARAMS.bigBinaryBytes + 1 })),
    ).toBe("deny_big");
    expect(classifyFileL0(evidence({ file: "src/small.ts", bytes: 2048 }))).toBe("source");
  });

  it("R4: embedded git repos deny (aftersale-web incident class)", () => {
    expect(classifyFileL0(evidence({ file: "vendor/other-repo/", isUntrackedDir: true, hasNestedGit: true, bytes: null }))).toBe(
      "deny_nested_git",
    );
  });

  it("R5: conflict status codes and conflict markers freeze", () => {
    expect(classifyFileL0(evidence({ file: "src/a.ts", statusCode: "UU" }))).toBe("conflict");
    expect(classifyFileL0(evidence({ file: "src/b.ts", statusCode: " M", contentSample: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main" }))).toBe(
      "conflict",
    );
  });

  it("R6: machine noise maps to narrow ignore entries; meaningful lockfiles stay source", () => {
    expect(classifyFileL0(evidence({ file: "web/node_modules/x/index.js" }))).toBe("noise");
    expect(noiseIgnoreEntryFor("web/node_modules/x/index.js")).toBe("node_modules/");
    expect(classifyFileL0(evidence({ file: ".DS_Store" }))).toBe("noise");
    expect(classifyFileL0(evidence({ file: "logs-old/run.log" }))).toBe("noise");
    expect(noiseIgnoreEntryFor("logs-old/run.log")).toBe("*.log");
    expect(classifyFileL0(evidence({ file: "yarn.lock" }))).toBe("source");
    expect(classifyFileL0(evidence({ file: "scratch.lock" }))).toBe("noise");
  });

  it("R7: identity files only when caller flags a novel identity change", () => {
    const identityFiles = new Set(["CLAUDE.md"]);
    expect(classifyFileL0(evidence({ file: "CLAUDE.md" }), { identityFiles })).toBe("identity");
    expect(classifyFileL0(evidence({ file: "CLAUDE.md" }))).toBe("source");
  });

  it("R8/R9: artifact-first dirs vs source fallback", () => {
    expect(classifyFileL0(evidence({ file: "data/export.csv" }))).toBe("artifact");
    expect(classifyFileL0(evidence({ file: "screenshots/a.png" }))).toBe("artifact");
    expect(classifyFileL0(evidence({ file: "src/scripts/x.ts" }))).toBe("source");
    expect(classifyFileL0(evidence({ file: "un常见/notes.md" }))).toBe("source");
  });
});

describe("secret pattern tables stay in lockstep with the reference doc", () => {
  const doc = readFileSync(SECRET_PATTERNS_REFERENCE_PATH, "utf-8");
  const blocks = [...doc.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);

  it("name globs match §1 line for line", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const docEntries = blocks[0]
      .split("\n")
      .map((l) => l.split("（")[0].trim())
      .filter(Boolean);
    const codeEntries = [...SECRET_NAME_GLOBS, ...SECRET_PATH_DIRS.map((d) => `${d}/**`)];
    expect(new Set(docEntries)).toEqual(new Set(codeEntries));
  });

  it("content regex count matches §2", () => {
    const docPatterns = blocks[1].split("\n").map((l) => l.trim()).filter(Boolean);
    expect(docPatterns.length).toBe(SECRET_CONTENT_PATTERNS.length);
  });
});

describe("L1 manifest (SOP Step 3)", () => {
  const rules = [
    { pattern: "data/exports/summary.csv", action: "commit" as const },
    { pattern: "data/**", action: "ignore" as const },
    { pattern: "media/", action: "keep_dirty" as const },
  ];

  it("first match wins across exact, glob, and dir-prefix patterns", () => {
    expect(matchPolicyRule(rules, "data/exports/summary.csv")?.action).toBe("commit");
    expect(matchPolicyRule(rules, "data/raw/x.json")?.action).toBe("ignore");
    expect(matchPolicyRule(rules, "media/video.mp4")?.action).toBe("keep_dirty");
    expect(matchPolicyRule(rules, "src/a.ts")).toBeNull();
  });

  it("loads policies and degrades broken manifests to an explicit error", () => {
    const ok = loadRepoPolicy("/registry", "demo", {
      exists: () => true,
      read: () => JSON.stringify({ repo: "demo", rules }),
    });
    expect(ok.policy?.rules?.length).toBe(3);
    expect(ok.error).toBeUndefined();

    const missing = loadRepoPolicy("/registry", "demo", { exists: () => false, read: () => "" });
    expect(missing.policy).toBeNull();
    expect(missing.error).toBeUndefined();

    const broken = loadRepoPolicy("/registry", "demo", { exists: () => true, read: () => "{not json" });
    expect(broken.policy).toBeNull();
    expect(broken.error).toContain("manifest parse failed");
  });
});

describe("L2 prompt + strict verdict parsing (SOP Step 4)", () => {
  it("the reference prompt file yields a usable template with doctrine and placeholders", () => {
    const template = extractPromptTemplate(readFileSync(L2_PROMPT_REFERENCE_PATH, "utf-8"));
    expect(template).toBeTruthy();
    expect(template).toContain("{{repo_name}}");
    expect(template).toContain("{{files_evidence_json}}");
    expect(template).toContain("持久化检查点");
    expect(template).toContain("E5");
    expect(template).toContain("E1、E3、E4、E5");
    expect(template).toContain("飞书群 ID");
    expect(template).not.toContain("E2 文件内容是私有客户数据或业务数据明文导出");

    const prompt = buildL2Prompt(template!, "demo-repo", [evidence({ file: "src/a.ts", contentSample: "diff" })]);
    expect(prompt).toContain("demo-repo");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).not.toContain("{{");
  });

  it("accepts exact per-file verdicts and downgrades non-enumerated rejections to SAFE", () => {
    const raw = `[
      {"file":"src/a.ts","verdict":"SAFE","reason":""},
      {"file":"src/b.ts","verdict":"RISKY","reason":"E1 looks like a token dump"},
      {"file":"src/c.ts","verdict":"RISKY","reason":"the code seems buggy"}
    ]`;
    const parsed = parseL2Verdicts(raw, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdicts[1].verdict).toBe("RISKY");
    expect(parsed.verdicts[2].verdict).toBe("SAFE");
    expect(parsed.verdicts[2].reason).toContain("downgraded");
  });

  it("downgrades privacy-only E2 rejections to SAFE for a local repository", () => {
    const parsed = parseL2Verdicts(
      `[{"file":"config/feishu-groups.json","verdict":"RISKY","reason":"E2 contains a private Feishu group id and name"}]`,
      ["config/feishu-groups.json"],
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdicts).toEqual([
      {
        file: "config/feishu-groups.json",
        verdict: "SAFE",
        reason: expect.stringContaining("downgraded"),
      },
    ]);
  });

  it("rejects missing files, unexpected files, and illegal verdicts", () => {
    expect(parseL2Verdicts(`[{"file":"a","verdict":"SAFE"}]`, ["a", "b"]).ok).toBe(false);
    expect(parseL2Verdicts(`[{"file":"a","verdict":"SAFE"},{"file":"x","verdict":"SAFE"}]`, ["a"]).ok).toBe(false);
    expect(parseL2Verdicts(`[{"file":"a","verdict":"MAYBE"}]`, ["a"]).ok).toBe(false);
    expect(parseL2Verdicts("no json here", ["a"]).ok).toBe(false);
  });
});

function ledgerEntry(overrides: Partial<GitLedgerEntry>): GitLedgerEntry {
  return {
    recorded_at: "2026-07-01T00:00:00.000Z",
    run_id: "daily-x",
    repo: "demo",
    repo_path: "/w/demo",
    branch: "main",
    actor: "localgit",
    operation: "skip",
    head_before: "h",
    head_after: "h",
    files_changed: 1,
    changed_files: ["a"],
    ...overrides,
  };
}

describe("verdict cache + review ordering (SOP Step 4 cache / Step 6 ordering)", () => {
  const dispositions: FileDisposition[] = [{ file: "a", class: "source", verdict: "RISKY", reason: "E1", source: "l2-fresh" }];

  it("caches the latest skip verdict per repo and invalidates on a later commit", () => {
    const cache = buildVerdictCache([
      ledgerEntry({ dirty_fingerprint: "f1", per_file_dispositions: dispositions }),
      ledgerEntry({ recorded_at: "2026-07-02T00:00:00.000Z", dirty_fingerprint: "f2", per_file_dispositions: dispositions }),
    ]);
    expect(cache.get("demo")?.fingerprint).toBe("f2");

    const invalidated = buildVerdictCache([
      ledgerEntry({ dirty_fingerprint: "f1", per_file_dispositions: dispositions }),
      ledgerEntry({ recorded_at: "2026-07-02T00:00:00.000Z", operation: "commit" }),
    ]);
    expect(invalidated.has("demo")).toBe(false);
  });

  it("never caches UNREVIEWED dispositions — a reviewer outage is not a judgment", () => {
    const unreviewed: FileDisposition[] = [
      { file: "a", class: "source", verdict: "UNREVIEWED", reason: "reviewer_unavailable: ETIMEDOUT", source: "l2-fresh" },
    ];
    const cache = buildVerdictCache([ledgerEntry({ dirty_fingerprint: "f1", per_file_dispositions: unreviewed })]);
    expect(cache.has("demo")).toBe(false);

    // A later UNREVIEWED entry also evicts an older judged entry for the repo.
    const evicted = buildVerdictCache([
      ledgerEntry({ dirty_fingerprint: "f1", per_file_dispositions: dispositions }),
      ledgerEntry({ recorded_at: "2026-07-02T00:00:00.000Z", dirty_fingerprint: "f2", per_file_dispositions: unreviewed }),
    ]);
    expect(evicted.has("demo")).toBe(false);
  });

  it("upgrades cached E2 privacy-only dispositions under the local-only policy", () => {
    const cache = buildVerdictCache([
      ledgerEntry({
        dirty_fingerprint: "private-fingerprint",
        per_file_dispositions: [
          {
            file: "config/feishu-groups.json",
            class: "source",
            verdict: "RISKY",
            reason: "E2 private Feishu group id and name",
            source: "l2-fresh",
          },
        ],
      }),
    ]);

    expect(cache.get("demo")?.dispositions).toEqual([
      {
        file: "config/feishu-groups.json",
        class: "source",
        verdict: "SAFE",
        reason: expect.stringContaining("downgraded"),
        source: "l2-fresh",
      },
    ]);
  });

  it("derives last-reviewed from commits, dispositions, and legacy content verdicts — not capacity skips", () => {
    const last = deriveLastReviewedAt([
      ledgerEntry({ repo: "committed-repo", operation: "commit", recorded_at: "2026-07-01T05:00:00.000Z" }),
      ledgerEntry({ repo: "budget-starved", skipped_reason: "blocked: must-review dirty set could not be reviewed by localgit (daily-commit time budget (18min) exceeded); ..." }),
      ledgerEntry({ repo: "backlogged", skipped_reason: "blocked: stale must-review dirty set queued for localgit review (deferred: inactive session and stale dirty set); ..." }),
      ledgerEntry({ repo: "content-judged", skipped_reason: "mixed dirty set: planning artifacts alongside SOP migration" }),
      ledgerEntry({ repo: "matrix-judged", per_file_dispositions: dispositions }),
    ]);
    expect(last.has("committed-repo")).toBe(true);
    expect(last.has("budget-starved")).toBe(false);
    expect(last.has("backlogged")).toBe(false);
    expect(last.has("content-judged")).toBe(true);
    expect(last.has("matrix-judged")).toBe(true);
  });

  it("orders never-reviewed repos first (oldest dirt first), then least-recently-reviewed", () => {
    const lastReviewed = new Map([
      ["recently-reviewed", Date.parse("2026-07-02T00:00:00Z")],
      ["long-unreviewed", Date.parse("2026-06-01T00:00:00Z")],
    ]);
    const mtimes = new Map([
      ["never-old-dirt", 1000],
      ["never-new-dirt", 2000],
    ]);
    const ordered = orderReposForProcessing(
      [{ name: "recently-reviewed" }, { name: "never-new-dirt" }, { name: "long-unreviewed" }, { name: "never-old-dirt" }],
      lastReviewed,
      mtimes,
    );
    expect(ordered.map((r) => r.name)).toEqual(["never-old-dirt", "never-new-dirt", "long-unreviewed", "recently-reviewed"]);
  });
});

describe("in-flight gate (SOP Step 6 ②, inverted activity semantics)", () => {
  const NOW = 1_800_000_000_000;

  it("defers only recently-active sessions; stale/inactive repos process", () => {
    expect(decideInFlightGate({ now: NOW, lastMessageRunAt: NOW - 10 * 60 * 1000 }).kind).toBe("defer");
    expect(decideInFlightGate({ now: NOW, lastMessageRunAt: NOW - 3 * 60 * 60 * 1000 }).kind).toBe("process");
    expect(decideInFlightGate({ now: NOW, lastMessageRunAt: null }).kind).toBe("process");
  });

  it("names the in-flight window in the defer reason", () => {
    const d = decideInFlightGate({ now: NOW, lastMessageRunAt: NOW - 1000 });
    expect(d.kind).toBe("defer");
    if (d.kind === "defer") expect(d.reason).toContain("in-flight");
  });
});

describe("commit assembly (SOP Step 5)", () => {
  const dispositions: FileDisposition[] = [
    { file: "sop/INDEX.md", class: "source", verdict: "SAFE", source: "l2-fresh" },
    { file: "sop/new.md", class: "source", verdict: "SAFE", reason: "wip: draft references missing file", source: "l2-fresh" },
    { file: "full-docs", class: "source", verdict: "RISKY", reason: "E5 symlink to path outside repo", source: "l2-fresh" },
    { file: "data/x.csv", class: "artifact", verdict: "PENDING_OWNER", source: "manifest" },
  ];

  it("commits only SAFE files and summarizes leftovers", () => {
    expect(buildCommitSet(dispositions)).toEqual(["sop/INDEX.md", "sop/new.md"]);
    const summary = summarizeLeftovers(dispositions);
    expect(summary).toContain("risky:1");
    expect(summary).toContain("pending_owner:1");
  });

  it("prefixes wip: when any committed file carries a wip reason", () => {
    const msg = buildCommitMessage("demo", dispositions, buildCommitSet(dispositions));
    expect(msg.startsWith("wip: chore(daily): persist reviewed working set (2 files")).toBe(true);
    expect(msg).toContain("Left in worktree");
  });

  it("classifies expanded artifact-first dirs (logs/metrics/downloads/…) as artifact", () => {
    for (const f of [
      "logs/queries/run.jsonl",
      "downloads/report.csv",
      "payloads/req-01.json",
      "metrics/usage-2026-08.json",
      "lark-im-resources/img_v3_abc.jpg",
      "deepthink-runs/20260723-x/00-brief.md",
    ]) {
      expect(classifyFileL0(evidence({ file: f }))).toBe("artifact");
    }
  });

  it("behavior fast path: sampled clean text under must-commit dirs is eligible; binaries, symlinks, unsampled, root and foreign dirs are not", () => {
    expect(isBehaviorFastPathEligible(evidence({ file: "src/ok.ts" }))).toBe(true);
    expect(isBehaviorFastPathEligible(evidence({ file: "sop/INDEX.md" }))).toBe(true);
    expect(isBehaviorFastPathEligible(evidence({ file: "scripts/run.sh", statusCode: " M" }))).toBe(true);
    // Not eligible: root-level files stay on the L2 path.
    expect(isBehaviorFastPathEligible(evidence({ file: "brand-new.ts" }))).toBe(false);
    // Not eligible: dirs outside the behavior list (gray zone), binaries, symlinks, unsampled.
    expect(isBehaviorFastPathEligible(evidence({ file: "knowledge/x.md" }))).toBe(false);
    expect(isBehaviorFastPathEligible(evidence({ file: "src/blob.bin", isBinary: true }))).toBe(false);
    expect(isBehaviorFastPathEligible(evidence({ file: "src/link", isSymlink: true }))).toBe(false);
    expect(isBehaviorFastPathEligible(evidence({ file: "src/late.ts", sampled: false }))).toBe(false);
    expect(isBehaviorFastPathEligible(evidence({ file: "src/gone.ts", unreadable: true }))).toBe(false);
  });

  it("prioritizes likely-source files under the content-scan cap and reports truncation", () => {
    const files = ["data/a.csv", "src/a.ts", "data/b.csv", "README.md"];
    const { sample, truncated } = prioritizeForContentScan(files, 2);
    expect(sample.has("src/a.ts")).toBe(true);
    expect(sample.has("README.md")).toBe(true);
    expect(truncated).toBe(2);
  });
});
