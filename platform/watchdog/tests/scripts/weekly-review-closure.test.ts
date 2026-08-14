import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createIssueStore } from "../../src/db/issueStore.js";
import {
  assessWeeklyReviewClosure,
  extractRequiredEvidenceFromVerification,
  renderWeeklyReviewClosureStatus,
  runWeeklyReviewStandingSweep,
  runWeeklyReviewStandingSweepWithEscalation,
  syncWeeklyReviewClosureStatuses,
} from "../../src/scripts/weekly-review-closure.js";

const ISSUE = {
  id: "6dd2b712-8a1c-4e2a-9836-d10a633a5f08",
  source: "weekly-review-watchdog",
} as const;

describe("weekly review closure assessment", () => {
  it("rejects pending owner handoffs even when reports and async refs exist", () => {
    const result = assessWeeklyReviewClosure({
      issue: { ...ISSUE, status: "in_progress" },
      receiptsText: `
# Weekly Review Follow-Up Receipts
- verifier: PASS
- Status: dispatched to owner, pending completion.
- Async ref: async_925d3ea0-4898-427a-8d52-e5e3ea47d582
- codexroot / larkc: pending separate handoff.
`,
      requiredEvidence: [
        "after-sales completion: verified",
        "ziniao completion: verified",
        "first-principle completion: verified",
        "codexroot completion: verified",
      ],
    });

    expect(result.purpose_met).toBe("not_met");
    expect(result.purposeMet).toBe("not_met");
    expect(result.missing).toContain("issue status is in_progress, expected done");
    expect(result.missing).toContain("after-sales completion: verified");
    expect(result.missing).toContain("codexroot completion: verified");
  });

  it("requires the watchdog weekly-review issue to be done", () => {
    const result = assessWeeklyReviewClosure({
      issue: { ...ISSUE, status: "pending" },
      receiptsText: `
- after-sales completion: verified
- ziniao completion: verified
- first-principle completion: verified
- codexroot completion: verified
`,
      requiredEvidence: [
        "after-sales completion: verified",
        "ziniao completion: verified",
        "first-principle completion: verified",
        "codexroot completion: verified",
      ],
    });

    expect(result.purposeMet).toBe("not_met");
    expect(result.missing).toEqual(["issue status is pending, expected done"]);
  });

  it("passes only when issue is done and every required owner completion is verified", () => {
    const result = assessWeeklyReviewClosure({
      issue: { ...ISSUE, status: "done" },
      receiptsText: `
- after-sales completion: verified
- ziniao completion: verified
- first-principle completion: verified
- codexroot completion: verified
`,
      requiredEvidence: [
        "after-sales completion: verified",
        "ziniao completion: verified",
        "first-principle completion: verified",
        "codexroot completion: verified",
      ],
    });

    expect(result).toMatchObject({
      purpose_met: "met",
      purposeMet: "met",
      missing: [],
    });
    expect(result.evidence).toContain("issue status: done");
    expect(result.evidence).toContain("codexroot completion: verified");
  });

  it("does not count missing-marker documentation as verified completion", () => {
    const result = assessWeeklyReviewClosure({
      issue: { ...ISSUE, status: "done" },
      receiptsText: `
## Required Completion Markers
- \`wendangwang completion: verified\` - missing.

## Current Receipts
- Status: pending owner completion receipt.
`,
      requiredEvidence: ["wendangwang completion: verified"],
    });

    expect(result.purposeMet).toBe("not_met");
    expect(result.missing).toEqual(["wendangwang completion: verified"]);
  });

  it("accepts verified markers only as standalone receipt lines", () => {
    const result = assessWeeklyReviewClosure({
      issue: { ...ISSUE, status: "done" },
      receiptsText: `
## Current Receipts
- wendangwang completion: verified
`,
      requiredEvidence: ["wendangwang completion: verified"],
    });

    expect(result.purposeMet).toBe("met");
  });

  it("accepts explicit waive-with-expiry receipts until they expire", () => {
    const active = assessWeeklyReviewClosure({
      issue: { ...ISSUE, status: "done" },
      receiptsText: "- after-sales waive-with-expiry: 2026-08-01\n",
      requiredEvidence: ["after-sales completion: verified"],
      now: new Date("2026-07-10T00:00:00.000Z"),
    });
    expect(active).toMatchObject({
      purposeMet: "met",
      evidence: expect.arrayContaining(["after-sales waive-with-expiry: 2026-08-01"]),
    });

    const expired = assessWeeklyReviewClosure({
      issue: { ...ISSUE, status: "done" },
      receiptsText: "- after-sales waive-with-expiry: 2026-07-01\n",
      requiredEvidence: ["after-sales completion: verified"],
      now: new Date("2026-07-10T00:00:00.000Z"),
    });
    expect(expired).toMatchObject({
      purposeMet: "not_met",
      missing: ["after-sales completion: verified"],
    });
  });

  it("renders closure status without treating dispatch evidence as completion", () => {
    expect(
      renderWeeklyReviewClosureStatus(
        {
          purpose_met: "not_met",
          purposeMet: "not_met",
          issueId: ISSUE.id,
          missing: ["issue status is open, expected done", "wendangwang completion: verified"],
          evidence: ["issue:3b7679b3"],
        },
        new Date("2026-07-08T00:00:00.000Z"),
      ),
    ).toContain("Verifier PASS, report freshness, dispatch receipts, and async refs are not closure evidence.");
  });

  it("extracts required evidence markers from issue verification", () => {
    expect(
      extractRequiredEvidenceFromVerification(
        "test -f receipts.md && rg -q 'wendangwang completion: verified' receipts.md && rg -q 'workspace dirty-state receipts: verified' receipts.md",
      ),
    ).toEqual(["wendangwang completion: verified", "workspace dirty-state receipts: verified"]);
  });

  it("CLI reports purpose_met=not_met until the DB issue is done and verification markers are present", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-closure-"));
    const dbPath = join(tmpDir, "watchdog.db");
    const receiptsPath = join(tmpDir, "follow-up-receipts.md");
    try {
      const db = new Database(dbPath);
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        ISSUE.id,
        "weekly-review 2026-07-07 P1/P2 follow-up owner handoffs",
        "weekly-review-watchdog",
        "follow up owner handoffs",
        "test -f receipts.md && rg -q 'wendangwang completion: verified' receipts.md && rg -q 'workspace dirty-state receipts: verified' receipts.md",
        "open",
        Date.now(),
      );
      db.close();
      writeFileSync(
        receiptsPath,
        "- verifier: PASS\n- wendangwang completion: verified\n- workspace dirty-state receipts: verified\n",
      );

      let output = "";
      try {
        execFileSync("npx", ["tsx", "src/scripts/weekly-review-closure.ts", "--issue-id", ISSUE.id, "--receipts", receiptsPath], {
          cwd: process.cwd(),
          env: { ...process.env, WATCHDOG_DB_PATH: dbPath },
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        output = (error as { stdout: string }).stdout;
      }

      expect(JSON.parse(output)).toMatchObject({
        purpose_met: "not_met",
        missing: ["issue status is open, expected done"],
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("CLI writes a status audit file for patrol rechecks", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-closure-status-"));
    const dbPath = join(tmpDir, "watchdog.db");
    const receiptsPath = join(tmpDir, "follow-up-receipts.md");
    const statusPath = join(tmpDir, "closure-status.md");
    try {
      const db = new Database(dbPath);
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        ISSUE.id,
        "weekly-review 2026-07-07 P1/P2 follow-up owner handoffs",
        "weekly-review-watchdog",
        "follow up owner handoffs",
        "test -f receipts.md && rg -q 'wendangwang completion: verified' receipts.md",
        "open",
        Date.now(),
      );
      db.close();
      writeFileSync(receiptsPath, "- verifier: PASS\n- Async ref: async_123\n");

      let output = "";
      try {
        execFileSync(
          "npx",
          [
            "tsx",
            "src/scripts/weekly-review-closure.ts",
            "--issue-id",
            ISSUE.id,
            "--receipts",
            receiptsPath,
            "--write-status",
            statusPath,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, WATCHDOG_DB_PATH: dbPath },
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        output = (error as { stdout: string }).stdout;
      }

      expect(JSON.parse(output)).toMatchObject({
        purpose_met: "not_met",
      });
      expect(readFileSync(statusPath, "utf-8")).toContain("wendangwang completion: verified");
      expect(readFileSync(statusPath, "utf-8")).toContain("async refs are not closure evidence");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("CLI infers owner markers for older issues whose verification predates receipts", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-closure-infer-"));
    const dbPath = join(tmpDir, "watchdog.db");
    const receiptsPath = join(tmpDir, "follow-up-receipts.md");
    try {
      const db = new Database(dbPath);
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "14d9cdac-8bb8-435c-957b-578b34238abe",
        "weekly-review 2026-06-23 after-sales owner follow-up",
        "weekly-review-watchdog",
        "after-sales verification reliability",
        "npx tsx src/scripts/weekly-review-closure.ts --issue-id 14d9cdac-8bb8-435c-957b-578b34238abe --receipts reports/weekly-review/2026-06-23/follow-up-receipts.md",
        "open",
        Date.now(),
      );
      db.close();
      writeFileSync(receiptsPath, "- Status: pending\n");

      let output = "";
      try {
        execFileSync(
          "npx",
          [
            "tsx",
            "src/scripts/weekly-review-closure.ts",
            "--issue-id",
            "14d9cdac-8bb8-435c-957b-578b34238abe",
            "--receipts",
            receiptsPath,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, WATCHDOG_DB_PATH: dbPath },
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        output = (error as { stdout: string }).stdout;
      }

      expect(JSON.parse(output).missing).toContain("after-sales completion: verified");
      expect(JSON.parse(output).missing).not.toContain("no required completion evidence markers were provided");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("syncs all open weekly-review issues into dated receipts and closure status", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-sync-"));
    const dbPath = join(tmpDir, "watchdog.db");
    const reportsRoot = join(tmpDir, "reports");
    try {
      const db = new Database(dbPath);
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "de87c419-2652-481b-91fc-5b43dc0e070c",
        "[weekly review] after-sales hardcoded Feishu base token cleanup",
        "weekly-review-watchdog",
        "after-sales owner action required",
        "cd after-sales && rg -q 'after-sales completion: verified' receipts.md",
        "open",
        Date.parse("2026-06-15T22:46:01.000Z"),
      );

      const firstSync = syncWeeklyReviewClosureStatuses(db, {
        reportsRoot,
        statuses: ["open"],
        createReceipts: true,
      });
      expect(firstSync).toMatchObject([
        {
          date: "2026-06-16",
          issueIds: ["de87c419-2652-481b-91fc-5b43dc0e070c"],
          purposeMet: "not_met",
        },
      ]);
      expect(readFileSync(join(reportsRoot, "2026-06-16", "follow-up-receipts.md"), "utf-8")).toContain(
        "after-sales completion: verified",
      );
      expect(readFileSync(join(reportsRoot, "2026-06-16", "closure-status.md"), "utf-8")).toContain("DB status: open");

      writeFileSync(
        join(reportsRoot, "2026-06-16", "follow-up-receipts.md"),
        "- after-sales completion: verified\n",
      );
      db.prepare("UPDATE issues SET status = 'done', finished_at = ? WHERE id = ?").run(
        Date.parse("2026-07-10T00:00:00.000Z"),
        "de87c419-2652-481b-91fc-5b43dc0e070c",
      );
      const secondSync = syncWeeklyReviewClosureStatuses(db, {
        reportsRoot,
        onlyDate: "2026-06-16",
      });
      expect(secondSync[0].purposeMet).toBe("met");
      const statusText = readFileSync(join(reportsRoot, "2026-06-16", "closure-status.md"), "utf-8");
      expect(statusText).toContain("DB status: done");
      expect(statusText).toContain("Purpose met: met");
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("syncs a later-created follow-up into the explicit review date", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-explicit-date-"));
    try {
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "review-date-follow-up",
        "2026-07-14 weekly-review P1 owner follow-up",
        "weekly-review-watchdog",
        "codexroot owner action required",
        "rg -q 'codexroot completion: verified' receipts.md",
        "in_progress",
        Date.parse("2026-07-15T13:00:00.000Z"),
      );

      const synced = syncWeeklyReviewClosureStatuses(db, {
        reportsRoot: join(tmpDir, "reports"),
        onlyDate: "2026-07-14",
        createReceipts: true,
      });

      expect(synced).toMatchObject([
        { date: "2026-07-14", issueIds: ["review-date-follow-up"], purposeMet: "not_met" },
      ]);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep exposes every non-terminal weekly-review issue and flags SLA breaches", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-open-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      const insert = db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "issue-open-old",
        "2026-07-07 weekly-review owner follow-up",
        "weekly-review-watchdog",
        "scheduler owner follow-up",
        "rg -q 'scheduler completion: verified' receipts.md",
        "open",
        Date.parse("2026-07-07T00:00:00.000Z"),
      );
      insert.run(
        "issue-progress-fresh",
        "2026-07-14 weekly-review owner follow-up",
        "weekly-review-watchdog",
        "codexroot owner follow-up",
        "rg -q 'codexroot completion: verified' receipts.md",
        "in_progress",
        Date.parse("2026-07-14T12:00:00.000Z"),
      );

      const result = runWeeklyReviewStandingSweep(db, {
        reportsRoot,
        now: new Date("2026-07-14T14:00:00.000Z"),
        orphanSlaHours: 24,
      });

      expect(result.openIssues.map((issue) => issue.id)).toEqual(["issue-open-old", "issue-progress-fresh"]);
      expect(result.strandedIssues).toMatchObject([{ id: "issue-open-old", slaBreached: true }]);
      expect(result.attentionRequired).toBe(true);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep uses canonical persisted evidence instead of title substring inference", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-canonical-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      createIssueStore(db).createIssue({
        title: "2026-07-21 weekly-review scheduler-looking title",
        source: "weekly-review-watchdog",
        description: "The persisted reviewer owner is authoritative",
        verification: "echo ok",
        requiredOwner: "codexroot",
        requiredCompletionMarker: "codexroot completion: verified",
        requiredEvidenceState: "canonical",
      });

      const result = runWeeklyReviewStandingSweep(db, {
        reportsRoot,
        now: new Date("2026-07-23T12:00:00.000Z"),
        orphanSlaHours: 1,
      });

      expect(result.openIssues).toMatchObject([
        {
          evidenceClassification: "canonical",
          requiredOwners: ["codexroot"],
          requiredCompletionMarkers: ["codexroot completion: verified"],
          missingOwners: ["codexroot"],
        },
      ]);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep exposes unclassifiable issues explicitly and never redispatches them", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-unclassified-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      const issue = createIssueStore(db).createIssue({
        title: "2026-07-21 weekly-review opaque follow-up",
        source: "weekly-review-watchdog",
        description: "No reviewer owner is available",
        verification: null,
        requiredOwner: null,
        requiredCompletionMarker: null,
        requiredEvidenceState: "unclassified",
      });
      // createIssue uses the production clock; pin the persisted timestamp so
      // this SLA/notification assertion remains deterministic without changing production semantics.
      db.prepare("UPDATE issues SET created_at = ? WHERE id = ?").run(
        Date.parse("2026-07-21T00:00:00.000Z"),
        issue.id,
      );
      const notify = vi.fn().mockResolvedValue({ messageId: "om_unclassified" });
      const redispatch = vi.fn();

      const outcome = await runWeeklyReviewStandingSweepWithEscalation(db, {
        reportsRoot,
        now: new Date("2026-07-24T12:00:00.000Z"),
        orphanSlaHours: 1,
        notifier: { notify },
        redispatch,
      });

      expect(outcome.result.openIssues).toMatchObject([
        {
          evidenceClassification: "unclassified",
          requiredOwners: [],
          requiredCompletionMarkers: [],
          missingOwners: [],
        },
      ]);
      expect(redispatch).not.toHaveBeenCalled();
      expect((notify.mock.calls[0]?.[0] as { body: string }).body).toContain("unclassified");
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep flags an old FAIL package with no package-failure tracking issue as orphaned", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-orphan-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const verifierDir = join(reportsRoot, "2026-07-07", "verifier");
      mkdirSync(verifierDir, { recursive: true });
      const verifierPath = join(verifierDir, "weekly-review-verification.md");
      writeFileSync(verifierPath, "VERDICT: FAIL\n\n# verifier\n");
      const old = Date.parse("2026-07-07T01:00:00.000Z") / 1000;
      execFileSync("touch", ["-t", "202607070900", verifierPath]);

      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      const result = runWeeklyReviewStandingSweep(db, {
        reportsRoot,
        now: new Date("2026-07-14T14:00:00.000Z"),
        orphanSlaHours: 24,
      });

      expect(old).toBeLessThan(Date.parse("2026-07-14T14:00:00.000Z") / 1000);
      expect(result.packageFailures).toHaveLength(1);
      expect(result.orphanedPackageFailures).toMatchObject([
        { date: "2026-07-07", verifierPath, trackedIssueIds: [], slaBreached: true },
      ]);
      expect(result.attentionRequired).toBe(true);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep keeps a FAIL package visible when a package-failure issue exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-tracked-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const verifierDir = join(reportsRoot, "2026-07-14", "verifier");
      mkdirSync(verifierDir, { recursive: true });
      writeFileSync(join(verifierDir, "weekly-review-verification.md"), "VERDICT: FAIL\n");
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "package-fail-issue",
        "2026-07-14 weekly-review package verifier FAIL",
        "weekly-review-watchdog",
        "correction required",
        "test -s verifier-retry/weekly-review-verification.md",
        "in_progress",
        Date.parse("2026-07-14T12:00:00.000Z"),
      );

      const result = runWeeklyReviewStandingSweep(db, {
        reportsRoot,
        now: new Date("2026-07-14T14:00:00.000Z"),
        orphanSlaHours: 24,
      });

      expect(result.packageFailures).toMatchObject([
        { date: "2026-07-14", trackedIssueIds: ["package-fail-issue"], slaBreached: false },
      ]);
      expect(result.orphanedPackageFailures).toEqual([]);
      expect(result.attentionRequired).toBe(true);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep uses the newest verifier retry so PASS clears the original package FAIL", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-retry-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const originalDir = join(reportsRoot, "2026-07-14", "verifier");
      const retryDir = join(reportsRoot, "2026-07-14", "verifier-retry");
      mkdirSync(originalDir, { recursive: true });
      mkdirSync(retryDir, { recursive: true });
      const originalPath = join(originalDir, "weekly-review-verification.md");
      const retryPath = join(retryDir, "weekly-review-verification.md");
      writeFileSync(originalPath, "VERDICT: FAIL\n");
      writeFileSync(retryPath, "VERDICT: PASS\n");
      execFileSync("touch", ["-t", "202607141300", originalPath]);
      execFileSync("touch", ["-t", "202607141301", retryPath]);

      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      const result = runWeeklyReviewStandingSweep(db, {
        reportsRoot,
        now: new Date("2026-07-14T14:00:00.000Z"),
        orphanSlaHours: 24,
      });

      expect(result.packageFailures).toEqual([]);
      expect(result.latestVerifiers).toMatchObject([{ date: "2026-07-14", verdict: "PASS", verifierPath: retryPath }]);
      expect(result.attentionRequired).toBe(false);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep recognizes legacy verifier sections whose PASS is not on the first line", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-legacy-verdict-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const verifierDir = join(reportsRoot, "2026-06-30", "verifier");
      mkdirSync(verifierDir, { recursive: true });
      writeFileSync(
        join(verifierDir, "weekly-review-verification.md"),
        "# weekly-review-watchdog verifier report\n\n## Verdict\n\nPASS\n",
      );
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);

      const result = runWeeklyReviewStandingSweep(db, { reportsRoot });

      expect(result.latestVerifiers).toMatchObject([{ date: "2026-06-30", verdict: "PASS" }]);
      expect(result.attentionRequired).toBe(false);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep does not label an old PASS verifier as an SLA breach", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-pass-age-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const verifierDir = join(reportsRoot, "2026-07-07", "verifier");
      mkdirSync(verifierDir, { recursive: true });
      const verifierPath = join(verifierDir, "weekly-review-verification.md");
      writeFileSync(verifierPath, "VERDICT: PASS\n");
      execFileSync("touch", ["-t", "202607070900", verifierPath]);

      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      const result = runWeeklyReviewStandingSweep(db, {
        reportsRoot,
        now: new Date("2026-07-14T14:00:00.000Z"),
        orphanSlaHours: 24,
      });

      expect(result.latestVerifiers).toMatchObject([
        { date: "2026-07-07", verdict: "PASS", slaBreached: false },
      ]);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("escalates stranded owners through notify and one idempotent re-dispatch", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-escalation-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const reportDir = join(reportsRoot, "2026-07-14");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        join(reportDir, "follow-up-receipts.md"),
        "- wendangwang completion: verified\n",
      );

      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      const insert = db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "late-p1",
        "2026-07-14 weekly-review P1 owner follow-up",
        "weekly-review-watchdog",
        "codexroot and wendangwang must close their owner follow-up",
        "test -f receipts.md && rg -q 'codexroot completion: verified' receipts.md && rg -q 'wendangwang completion: verified' receipts.md",
        "in_progress",
        Date.parse("2026-07-14T12:00:00.000Z"),
      );
      insert.run(
        "late-high",
        "2026-07-14 weekly-review High owner follow-up",
        "weekly-review-watchdog",
        "ad-adjust must close the execution-state finding",
        "test -f receipts.md && rg -q 'ad-adjust completion: verified' receipts.md",
        "in_progress",
        Date.parse("2026-07-14T12:01:00.000Z"),
      );

      const notify = vi.fn().mockResolvedValue({ messageId: "om_standing_sweep" });
      const redispatch = vi.fn().mockImplementation(async (request: { target: string }) => ({
        status: "accepted" as const,
        childSessionId: `sess_${request.target}`,
      }));

      const outcome = await runWeeklyReviewStandingSweepWithEscalation(db, {
        reportsRoot,
        now: new Date("2026-07-17T12:00:00.000Z"),
        orphanSlaHours: 24,
        notifier: { notify },
        redispatch,
      });

      expect(redispatch.mock.calls.map(([request]) => (request as { target: string }).target)).toEqual([
        "codexroot",
        "ad-adjust",
      ]);
      expect(redispatch.mock.calls.map(([request]) => (request as { client_request_id: string }).client_request_id)).toEqual([
        "2026-07-14:watchdog:codexroot:weekly-review-standing-retry:late-p1",
        "2026-07-14:watchdog:ad-adjust:weekly-review-standing-retry:late-high",
      ]);
      const codexrootPrompt = (redispatch.mock.calls[0]?.[0] as { prompt: string }).prompt;
      expect(codexrootPrompt).toContain(
        "the final response must begin with this exact standalone line: codexroot completion: verified",
      );
      expect(outcome.ownerRetries).toEqual([
        expect.objectContaining({ issueId: "late-p1", owner: "codexroot", status: "accepted", retryRecorded: true }),
        expect.objectContaining({ issueId: "late-high", owner: "ad-adjust", status: "accepted", retryRecorded: true }),
      ]);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        source: "watchdog",
        level: "warn",
        metadata: expect.objectContaining({ runKind: "weekly-review-standing-sweep" }),
      }));
      const notification = notify.mock.calls[0]?.[0] as { body: string };
      expect(notification.body).toContain("late-p1");
      expect(notification.body).toContain("late-high");
      expect(notification.body).toContain("codexroot");
      expect(notification.body).toContain("ad-adjust");
      expect(outcome.notification).toMatchObject({ status: "sent", messageId: "om_standing_sweep", attempts: 1 });
      expect(
        db.prepare("SELECT id, retry_count FROM issues WHERE id IN ('late-p1', 'late-high') ORDER BY id").all(),
      ).toEqual([
        { id: "late-high", retry_count: 1 },
        { id: "late-p1", retry_count: 1 },
      ]);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps retry_count unchanged when an owner re-dispatch was not admitted", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-retry-failure-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "late-failed-retry",
        "2026-07-14 weekly-review High owner follow-up",
        "weekly-review-watchdog",
        "ad-adjust must close the execution-state finding",
        "rg -q 'ad-adjust completion: verified' receipts.md",
        "in_progress",
        Date.parse("2026-07-14T12:00:00.000Z"),
      );

      const outcome = await runWeeklyReviewStandingSweepWithEscalation(db, {
        reportsRoot,
        now: new Date("2026-07-17T12:00:00.000Z"),
        notifier: { notify: vi.fn().mockResolvedValue({ messageId: "om_retry_failure" }) },
        redispatch: vi.fn().mockResolvedValue({ status: "failed", error: "HTTP 503" }),
      });

      expect(outcome.ownerRetries).toEqual([
        expect.objectContaining({ issueId: "late-failed-retry", owner: "ad-adjust", status: "failed", retryRecorded: false }),
      ]);
      expect(
        db.prepare("SELECT retry_count FROM issues WHERE id = 'late-failed-retry'").get(),
      ).toEqual({ retry_count: 0 });
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not let a verification retry suppress the first durable E7 owner re-dispatch", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-existing-retry-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "late-with-verification-retry",
        "2026-07-14 weekly-review High owner follow-up",
        "weekly-review-watchdog",
        "ad-adjust must close the execution-state finding",
        "rg -q 'ad-adjust completion: verified' receipts.md",
        "in_progress",
        Date.parse("2026-07-14T12:00:00.000Z"),
        1,
      );

      const redispatch = vi.fn().mockResolvedValue({ status: "accepted", childSessionId: "sess_e7_retry" });
      const options = {
        reportsRoot,
        now: new Date("2026-07-17T12:00:00.000Z"),
        notifier: { notify: vi.fn().mockResolvedValue({ messageId: "om_existing_retry" }) },
        redispatch,
      };
      const first = await runWeeklyReviewStandingSweepWithEscalation(db, options);
      const second = await runWeeklyReviewStandingSweepWithEscalation(db, options);

      expect(first.ownerRetries).toEqual([
        expect.objectContaining({
          issueId: "late-with-verification-retry",
          owner: "ad-adjust",
          status: "accepted",
          retryRecorded: true,
        }),
      ]);
      expect(second.ownerRetries).toEqual([]);
      expect(redispatch).toHaveBeenCalledTimes(1);
      expect(
        db.prepare("SELECT retry_count FROM issues WHERE id = 'late-with-verification-retry'").get(),
      ).toEqual({ retry_count: 2 });
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standing sweep does not rewrite historical status files when every issue for that date is terminal", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-weekly-review-standing-terminal-"));
    const reportsRoot = join(tmpDir, "reports");
    try {
      const reportDir = join(reportsRoot, "2026-06-30");
      mkdirSync(reportDir, { recursive: true });
      const statusPath = join(reportDir, "closure-status.md");
      writeFileSync(statusPath, "historical status must stay byte-for-byte stable\n");
      writeFileSync(join(reportDir, "follow-up-receipts.md"), "- scheduler completion: verified\n");
      const db = new Database(join(tmpDir, "watchdog.db"));
      applyMigrations(db);
      db.prepare(
        "INSERT INTO issues (id, title, source, description, verification, status, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "terminal-issue",
        "2026-06-30 weekly-review owner follow-up",
        "weekly-review-watchdog",
        "scheduler owner follow-up",
        "rg -q 'scheduler completion: verified' receipts.md",
        "done",
        Date.parse("2026-06-30T00:00:00.000Z"),
        Date.parse("2026-07-01T00:00:00.000Z"),
      );

      runWeeklyReviewStandingSweep(db, { reportsRoot });

      expect(readFileSync(statusPath, "utf-8")).toBe("historical status must stay byte-for-byte stable\n");
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
