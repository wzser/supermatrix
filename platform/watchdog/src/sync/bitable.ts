import { execFile } from "node:child_process";
import type Database from "better-sqlite3";
import type { Issue } from "../db/issueStore.js";

type SyncConfig = {
  larkCliPath: string;
  db: Database.Database;
  enabled?: boolean;
  baseToken?: string;
  tableId?: string;
  runCli?: (cmd: string, args: string[]) => Promise<string>;
};

function runLarkCli(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`lark-cli command failed: ${err.message}`));
      else resolve(stdout);
    });
  });
}

function parseCliJson(output: string, operation: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Bitable ${operation} returned invalid JSON`);
  }
}

function recordIdFromUpsert(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recordIdFromUpsert(item);
      if (found) return found;
    }
    return null;
  }

  const object = value as Record<string, unknown>;
  if (typeof object.record_id === "string" && object.record_id) return object.record_id;
  for (const key of ["record_id_list", "records", "record", "data"]) {
    const found = recordIdFromUpsert(object[key]);
    if (found) return found;
  }
  return null;
}

type ReadBackRecord = { recordId: string; fields: Record<string, unknown> };

function recordsFromReadBack(value: unknown): ReadBackRecord[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => recordsFromReadBack(item));
  }

  const object = value as Record<string, unknown>;
  const records: ReadBackRecord[] = [];
  if (typeof object.record_id === "string" && object.fields && typeof object.fields === "object") {
    records.push({ recordId: object.record_id, fields: object.fields as Record<string, unknown> });
  }

  const fieldNames = object.fields;
  const rows = object.data;
  const recordIds = object.record_id_list;
  if (
    Array.isArray(fieldNames) &&
    fieldNames.every((field) => typeof field === "string") &&
    Array.isArray(rows) &&
    Array.isArray(recordIds)
  ) {
    rows.forEach((row, index) => {
      if (!Array.isArray(row) || typeof recordIds[index] !== "string") return;
      records.push({
        recordId: recordIds[index] as string,
        fields: Object.fromEntries(fieldNames.map((field, fieldIndex) => [field, row[fieldIndex]])),
      });
    });
  }

  for (const child of Object.values(object)) {
    records.push(...recordsFromReadBack(child));
  }
  return records;
}

function assertReadBack(
  output: string,
  expectedRecordId: string,
  expectedFields: Record<string, string>,
): void {
  const records = recordsFromReadBack(parseCliJson(output, "record-get"));
  const record = records.find((candidate) => candidate.recordId === expectedRecordId);
  if (!record) throw new Error("Bitable record-get did not return the upserted record");

  for (const [field, expected] of Object.entries(expectedFields)) {
    if (!(field in record.fields) || String(record.fields[field]) !== expected) {
      throw new Error(`Bitable read-back mismatch for field ${field}`);
    }
  }
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
  const disabled = config.enabled === false || process.env.WATCHDOG_DISABLE_SYNC === "1";
  const baseToken = config.baseToken;
  const tableId = config.tableId;
  const db = config.db;
  const execute = config.runCli ?? runLarkCli;

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

      const out = await execute(config.larkCliPath, args);
      const upsertedRecordId = existing?.record_id ?? recordIdFromUpsert(
        parseCliJson(out, "record-upsert"),
      );
      if (!upsertedRecordId) {
        throw new Error("Bitable record-upsert did not return a record id");
      }

      const readBackArgs = [
        "base", "+record-get",
        "--base-token", baseToken,
        "--table-id", tableId,
        "--record-id", upsertedRecordId,
        "--format", "json",
      ];
      const readBack = await execute(config.larkCliPath, readBackArgs);
      assertReadBack(readBack, upsertedRecordId, buildRecord(issue));

      if (!existing) {
        upsertMapping.run(issue.id, upsertedRecordId);
      }
    },
  };
}
