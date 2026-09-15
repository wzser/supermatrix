import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/schema.js";
import { createBitableSync } from "../../src/sync/bitable.js";
import type { Issue } from "../../src/db/issueStore.js";

const issue: Issue = {
  id: "issue-local-1",
  title: "Local sync test",
  source: "isolated-watchdog",
  description: "A local Bitable read-back fixture",
  verification: "printf verify",
  status: "done",
  createdAt: Date.parse("2026-09-14T00:00:00.000Z"),
  finishedAt: Date.parse("2026-09-14T00:01:00.000Z"),
  result: "verified",
  retryCount: 0,
  requiredOwner: null,
  requiredCompletionMarker: null,
  requiredEvidenceState: null,
};

describe("Bitable sync", () => {
  let db: Database.Database;

  afterEach(() => db.close());

  it("records the mapping only after an exact record-get read-back", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const calls: string[][] = [];
    const sync = createBitableSync({
      larkCliPath: "local-fixture",
      db,
      enabled: true,
      baseToken: "example-base",
      tableId: "example-table",
      runCli: async (_cmd, args) => {
        calls.push(args);
        if (args[1] === "+record-upsert") {
          return JSON.stringify({ data: { record: { record_id_list: ["rec-local-1"] } } });
        }
        return JSON.stringify({
          data: {
            records: [{
              record_id: "rec-local-1",
              fields: {
                title: issue.title,
                issue_id: issue.id,
                source: issue.source,
                description: issue.description,
                status: issue.status,
                result: issue.result,
                created_at: "2026-09-14 00:00:00",
                finished_at: "2026-09-14 00:01:00",
                retry_count: "0",
              },
            }],
          },
        });
      },
    });

    await sync.syncIssue(issue);

    expect(calls.map((args) => args[1])).toEqual(["+record-upsert", "+record-get"]);
    expect(db.prepare("SELECT record_id FROM bitable_sync WHERE issue_id = ?").get(issue.id))
      .toEqual({ record_id: "rec-local-1" });
  });

  it("fails closed on a read-back mismatch and does not claim a mapping", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const sync = createBitableSync({
      larkCliPath: "local-fixture",
      db,
      enabled: true,
      baseToken: "example-base",
      tableId: "example-table",
      runCli: async (_cmd, args) => args[1] === "+record-upsert"
        ? JSON.stringify({ data: { record: { record_id_list: ["rec-local-2"] } } })
        : JSON.stringify({ data: { records: [{ record_id: "rec-local-2", fields: { ...issue, issue_id: "wrong" } }] } }),
    });

    await expect(sync.syncIssue(issue)).rejects.toThrow("Bitable read-back mismatch for field issue_id");
    expect(db.prepare("SELECT record_id FROM bitable_sync WHERE issue_id = ?").get(issue.id)).toBeUndefined();
  });

  it("does not invoke the CLI when sync is explicitly disabled", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    let invoked = false;
    const sync = createBitableSync({
      larkCliPath: "local-fixture",
      db,
      enabled: false,
      runCli: async () => { invoked = true; return ""; },
    });

    await sync.syncIssue(issue);
    expect(invoked).toBe(false);
  });
});
