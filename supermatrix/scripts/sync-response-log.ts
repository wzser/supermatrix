#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { asTimestamp } from "../src/domain/ids.ts";
import { SqliteBindingStore } from "../src/adapters/store-sqlite/index.ts";
import type { ResponseLogRecord } from "../src/ports/BindingStore.ts";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));

const dbPath = requiredEnv("SM_DB_PATH");
const baseToken = requiredEnv("SM_RESPONSE_LOG_BASE_TOKEN");
const tableId = requiredEnv("SM_RESPONSE_LOG_TABLE_ID");
const identity = process.env["SM_RESPONSE_LOG_AS"] ?? "user";
const limit = parsePositiveInt(process.env["SM_RESPONSE_LOG_LIMIT"] ?? "100", "SM_RESPONSE_LOG_LIMIT");
const larkCli = process.env["LARK_CLI"] ?? resolve(scriptDir, "../node_modules/.bin/lark-cli");

const store = new SqliteBindingStore(dbPath);
await store.init();

try {
  const rows = await store.listPendingResponseLogs(limit);
  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    const args = [
      "base",
      "+record-upsert",
      "--as",
      identity,
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--json",
      JSON.stringify(toBitableFields(row)),
    ];
    if (row.mirrorRecordId) {
      args.push("--record-id", row.mirrorRecordId);
    }

    try {
      const { stdout } = await execFileAsync(larkCli, args, { maxBuffer: 10 * 1024 * 1024 });
      const recordId = extractRecordId(stdout) ?? row.mirrorRecordId;
      if (!recordId) {
        throw new Error("lark-cli succeeded but no record_id was returned");
      }
      await store.markResponseLogMirrorOk(row.responseId, recordId, asTimestamp(Date.now()));
      ok += 1;
      console.log(`SYNCED ${row.responseId} -> ${recordId}`);
    } catch (err) {
      failed += 1;
      const message = errorMessage(err);
      await store.markResponseLogMirrorFailed(row.responseId, message.slice(0, 2000), asTimestamp(Date.now()));
      console.error(`FAILED ${row.responseId}: ${message}`);
    }
  }

  console.log(`DONE: ok=${ok} failed=${failed} pending=${rows.length}`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await store.close();
}

function toBitableFields(row: ResponseLogRecord): Record<string, unknown> {
  return {
    "响应 ID": row.responseId,
    "触发时间": row.mentionedAt,
    "来源": row.source,
    "发起人": row.mentioner ?? "",
    "触发内容": truncate(row.triggerText),
    "回复内容": truncate(row.responseText),
    "回复时间": row.responseAt ?? null,
    "回复状态": row.responseStatus,
    "错误原因": truncate(row.responseError),
    "原始链接": row.sourceUrl ?? "",
  };
}

function truncate(value: string | null | undefined): string {
  return (value ?? "").slice(0, 2000);
}

function extractRecordId(stdout: string): string | null {
  const parsed = parseJson(stdout);
  if (!parsed || typeof parsed !== "object") return null;
  const record = getPath(parsed, ["data", "record"]);
  const candidates = [
    getPath(parsed, ["data", "record_id"]),
    getPath(record, ["record_id"]),
    getPath(record, ["record_id_list", 0]),
    getPath(parsed, ["data", "records", 0, "record_id"]),
  ];
  const found = candidates.find((item): item is string => typeof item === "string" && item.length > 0);
  return found ?? null;
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    return null;
  }
}

function getPath(value: unknown, path: Array<string | number>): unknown {
  let cursor = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[key];
    } else {
      if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
  }
  return cursor;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
