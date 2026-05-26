import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createIssueStore, type IssueStore } from "../../src/db/issueStore.js";

describe("IssueStore", () => {
  let db: Database.Database;
  let store: IssueStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createIssueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates an issue and retrieves it", () => {
    const issue = store.createIssue({
      title: "Fix scheduler timeout",
      source: "user",
      description: "Scheduler shell executor ignores timeout config",
      verification: "npm test --prefix ../scheduler",
    });

    expect(issue.id).toBeDefined();
    expect(issue.title).toBe("Fix scheduler timeout");
    expect(issue.status).toBe("open");
    expect(issue.verification).toBe("npm test --prefix ../scheduler");

    const fetched = store.getIssue(issue.id);
    expect(fetched).toEqual(issue);
  });

  it("lists open issues in creation order", () => {
    store.createIssue({ title: "First", source: "user", description: "d1", verification: "echo 1" });
    store.createIssue({ title: "Second", source: "user", description: "d2", verification: "echo 2" });
    store.createIssue({ title: "Third", source: "user", description: "d3", verification: "echo 3" });

    const open = store.listByStatus("open");
    expect(open.length).toBe(3);
    expect(open[0].title).toBe("First");
    expect(open[2].title).toBe("Third");
  });

  it("returns next open issue (oldest first)", () => {
    store.createIssue({ title: "First", source: "user", description: "d1", verification: "echo 1" });
    store.createIssue({ title: "Second", source: "user", description: "d2", verification: "echo 2" });

    const next = store.nextOpen();
    expect(next).not.toBeNull();
    expect(next!.title).toBe("First");
  });

  it("returns null when no open issues", () => {
    const next = store.nextOpen();
    expect(next).toBeNull();
  });

  it("transitions status: open -> in_progress -> done", () => {
    const issue = store.createIssue({
      title: "Test issue",
      source: "eventbus:scheduler",
      description: "desc",
      verification: "echo ok",
    });

    const started = store.updateStatus(issue.id, "in_progress");
    expect(started.status).toBe("in_progress");
    expect(started.finishedAt).toBeNull();

    const done = store.markDone(issue.id, "Fixed by updating config");
    expect(done.status).toBe("done");
    expect(done.finishedAt).toBeGreaterThan(0);
    expect(done.result).toBe("Fixed by updating config");
  });

  it("marks an issue as failed", () => {
    const issue = store.createIssue({
      title: "Failing issue",
      source: "user",
      description: "desc",
      verification: "echo fail",
    });

    store.updateStatus(issue.id, "in_progress");
    const failed = store.markFailed(issue.id, "Verification command returned non-zero");
    expect(failed.status).toBe("failed");
    expect(failed.finishedAt).toBeGreaterThan(0);
    expect(failed.result).toBe("Verification command returned non-zero");
  });

  it("updates verification field", () => {
    const issue = store.createIssue({
      title: "No verification",
      source: "user",
      description: "desc",
      verification: null,
    });
    expect(issue.verification).toBeNull();

    const updated = store.setVerification(issue.id, "curl http://localhost:3500/health");
    expect(updated.verification).toBe("curl http://localhost:3500/health");
  });

  it("lists all issues", () => {
    store.createIssue({ title: "A", source: "user", description: "d", verification: "v" });
    store.createIssue({ title: "B", source: "user", description: "d", verification: "v" });

    const all = store.listAll();
    expect(all.length).toBe(2);
  });

  it("throws on getIssue with unknown id", () => {
    expect(() => store.getIssue("nonexistent")).toThrow("Issue not found");
  });

  it("creates issue with retryCount 0", () => {
    const issue = store.createIssue({
      title: "Retry test",
      source: "user",
      description: "d",
      verification: "echo ok",
    });
    expect(issue.retryCount).toBe(0);
  });

  it("increments retry count", () => {
    const issue = store.createIssue({
      title: "Retry inc",
      source: "user",
      description: "d",
      verification: "echo ok",
    });
    expect(issue.retryCount).toBe(0);

    const after1 = store.incrementRetry(issue.id);
    expect(after1.retryCount).toBe(1);

    const after2 = store.incrementRetry(issue.id);
    expect(after2.retryCount).toBe(2);

    const after3 = store.incrementRetry(issue.id);
    expect(after3.retryCount).toBe(3);
  });
});
