import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { applyMigrations } from "./db/schema.js";
import { createIssueStore } from "./db/issueStore.js";
import { createBitableSync } from "./sync/bitable.js";

const config = loadConfig(process.env as Record<string, string>);
const db = new Database(config.dbPath);
applyMigrations(db);
const store = createIssueStore(db);
const bitable = createBitableSync({
  larkCliPath: config.larkCliPath,
  db,
  baseToken: config.bitableBaseToken,
  tableId: config.bitableTableId,
});

const issues = store.listAll();
console.log(`Syncing ${issues.length} issues...`);
for (const issue of issues) {
  await bitable.syncIssue(issue);
  console.log(`Synced: ${issue.title} (${issue.status})`);
}
db.close();
console.log("Done");
