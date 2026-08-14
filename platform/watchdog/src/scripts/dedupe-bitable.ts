import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { loadConfig } from "../config.js";
import { applyMigrations } from "../db/schema.js";

const config = loadConfig(process.env as Record<string, string>);
const db = new Database(config.dbPath);
applyMigrations(db);

const DRY_RUN = process.argv.includes("--dry-run");

function runLarkCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(config.larkCliPath, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

type RecordListResponse = {
  data?: {
    data?: unknown[][];
    fields?: string[];
    record_id_list?: string[];
    has_more?: boolean;
  };
};

async function listAllRecords(): Promise<Array<{ recordId: string; issueId: string }>> {
  const all: Array<{ recordId: string; issueId: string }> = [];
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const args = [
      "base", "+record-list",
      "--base-token", config.bitableBaseToken,
      "--table-id", config.bitableTableId,
      "--limit", String(pageSize),
      "--offset", String(offset),
    ];
    const out = await runLarkCli(args);
    const resp = JSON.parse(out) as RecordListResponse;
    const inner = resp.data;
    if (!inner || !inner.fields || !inner.data || !inner.record_id_list) break;
    const issueIdIdx = inner.fields.indexOf("issue_id");
    if (issueIdIdx < 0) throw new Error("issue_id field not found in table");
    for (let i = 0; i < inner.data.length; i++) {
      const row = inner.data[i];
      const recordId = inner.record_id_list[i];
      const issueId = String(row[issueIdIdx] ?? "");
      if (recordId && issueId) {
        all.push({ recordId, issueId });
      }
    }
    if (!inner.has_more) break;
    offset += pageSize;
  }
  return all;
}

async function deleteRecord(recordId: string): Promise<void> {
  const args = [
    "base", "+record-delete",
    "--base-token", config.bitableBaseToken,
    "--table-id", config.bitableTableId,
    "--record-id", recordId,
    "--yes",
  ];
  await runLarkCli(args);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  const records = await listAllRecords();
  console.log(`Fetched ${records.length} Feishu records.`);

  const groups = new Map<string, string[]>();
  for (const r of records) {
    const list = groups.get(r.issueId) ?? [];
    list.push(r.recordId);
    groups.set(r.issueId, list);
  }

  const duplicates: Array<{ issueId: string; keep: string; remove: string[] }> = [];
  for (const [issueId, recordIds] of groups) {
    if (recordIds.length > 1) {
      duplicates.push({ issueId, keep: recordIds[0], remove: recordIds.slice(1) });
    }
  }
  console.log(`Duplicate groups: ${duplicates.length}`);
  console.log(`Records to delete: ${duplicates.reduce((n, g) => n + g.remove.length, 0)}`);

  const upsertMapping = db.prepare(
    "INSERT INTO bitable_sync (issue_id, record_id) VALUES (?, ?) ON CONFLICT(issue_id) DO UPDATE SET record_id = excluded.record_id"
  );

  let deleted = 0;
  let mapped = 0;

  for (const [issueId, recordIds] of groups) {
    const keep = recordIds[0];
    if (!DRY_RUN) {
      upsertMapping.run(issueId, keep);
    }
    mapped++;
    for (const recordId of recordIds.slice(1)) {
      console.log(`  delete issue=${issueId} record=${recordId}`);
      if (!DRY_RUN) {
        try {
          await deleteRecord(recordId);
          deleted++;
        } catch (err) {
          console.error(`  failed to delete ${recordId}:`, err);
        }
      } else {
        deleted++;
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Groups processed: ${groups.size}`);
  console.log(`  Mappings upserted: ${mapped}`);
  console.log(`  Records deleted: ${deleted}${DRY_RUN ? " (dry-run)" : ""}`);

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
