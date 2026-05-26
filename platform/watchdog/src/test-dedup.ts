import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { applyMigrations } from "./db/schema.js";
import { createBitableSync } from "./sync/bitable.js";
import type { Issue } from "./db/issueStore.js";

const config = loadConfig(process.env as Record<string, string>);
const db = new Database(config.dbPath);
applyMigrations(db);
const bitable = createBitableSync({ larkCliPath: config.larkCliPath, db, baseToken: config.bitableBaseToken, tableId: config.bitableTableId });

const fakeIssue: Issue = {
  id: "test-dedup-002", title: "Dedup Test 2", source: "test",
  description: "d", verification: null, status: "open" as const,
  createdAt: Date.now(), finishedAt: null, result: null, retryCount: 0,
};

await bitable.syncIssue(fakeIssue);
console.log("First sync done");
await bitable.syncIssue(fakeIssue);
console.log("Second sync done (should update, not create)");
fakeIssue.status = "done" as const;
await bitable.syncIssue(fakeIssue);
console.log("Third sync (status update) done");
db.close();
