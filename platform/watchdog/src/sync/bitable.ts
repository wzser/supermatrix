import { execFile } from "node:child_process";
import type Database from "better-sqlite3";
import type { Issue } from "../db/issueStore.js";

type SyncConfig = {
  larkCliPath: string;
  db: Database.Database;
  baseToken?: string;
  tableId?: string;
};

function runLarkCli(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function buildRecord(issue: Issue): Record<string, string> {
  return {
    title: issue.title,
    issue_id: issue.id,
    source: issue.source,
    description: issue.description,
    status: issue.status,
    result: issue.result ?? "",
    created_at: formatTimestamp(issue.createdAt),
    finished_at: formatTimestamp(issue.finishedAt),
    retry_count: String(issue.retryCount),
  };
}

export function createBitableSync(config: SyncConfig) {
  const disabled = process.env.WATCHDOG_DISABLE_SYNC === "1";
  const baseToken = config.baseToken;
  const tableId = config.tableId;
  const db = config.db;

  const getRecordId = db.prepare("SELECT record_id FROM bitable_sync WHERE issue_id = ?");
  const upsertMapping = db.prepare(
    "INSERT INTO bitable_sync (issue_id, record_id) VALUES (?, ?) ON CONFLICT(issue_id) DO UPDATE SET record_id = excluded.record_id"
  );

  return {
    async syncIssue(issue: Issue): Promise<void> {
      if (disabled || !baseToken || !tableId) return;

      const existing = getRecordId.get(issue.id) as { record_id: string } | undefined;
      const args = [
        "base", "+record-upsert",
        "--base-token", baseToken,
        "--table-id", tableId,
      ];

      if (existing) {
        args.push("--record-id", existing.record_id);
      }
      args.push("--json", JSON.stringify(buildRecord(issue)));

      try {
        const out = await runLarkCli(config.larkCliPath, args);
        if (!existing) {
          const data = JSON.parse(out);
          const inner = data?.data ?? data;
          const newRecordId = inner?.record?.record_id_list?.[0];
          if (newRecordId) {
            upsertMapping.run(issue.id, newRecordId);
          }
        }
      } catch (err) {
        console.error("Failed to sync to bitable:", err);
      }
    },
  };
}
