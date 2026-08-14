import Database from "better-sqlite3";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { redactSecretsInText, type SecretRuleId } from "./secret-redaction.js";

const DEFAULT_DB_PATH = "/Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db";
const DEFAULT_REPORT_DIR = "/Users/LOCAL_USER/SuperMatrixRuntime/data/secret-redactions";

type TargetTable = {
  table: "message_runs" | "cross_session_log";
  idColumn: "id";
  orderColumn: "started_at" | "created_at";
  fields: string[];
};

const TARGETS: TargetTable[] = [
  {
    table: "message_runs",
    idColumn: "id",
    orderColumn: "started_at",
    fields: ["prompt", "final_message", "error_message", "stream_log"],
  },
  {
    table: "cross_session_log",
    idColumn: "id",
    orderColumn: "created_at",
    fields: ["prompt", "result_preview", "error_message", "final_message"],
  },
];

export type RedactChatSecretsOptions = {
  dbPath?: string;
  reportDir?: string;
  apply?: boolean;
  batchSize?: number;
  maxRows?: number;
  now?: Date;
};

export type RedactChatSecretsSummary = {
  mode: "apply" | "dry-run";
  dbPath: string;
  reportPath: string;
  rowsScanned: number;
  rowsChanged: number;
  fieldsChanged: number;
  secretsFound: number;
  byRule: Partial<Record<SecretRuleId, number>>;
};

type RedactionEvent = {
  event: "redaction";
  mode: "apply" | "dry-run";
  table: string;
  rowId: string;
  field: string;
  ruleId: SecretRuleId;
  hash: string;
  marker: string;
  preview: string;
};

type SummaryEvent = RedactChatSecretsSummary & {
  event: "summary";
};

type DbRow = Record<string, unknown>;

export async function redactChatSecretsDatabase(
  options: RedactChatSecretsOptions = {},
): Promise<RedactChatSecretsSummary> {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const reportDir = options.reportDir ?? DEFAULT_REPORT_DIR;
  const mode: "apply" | "dry-run" = options.apply === true ? "apply" : "dry-run";
  const now = options.now ?? new Date();
  const reportPath = join(reportDir, `${timestampForPath(now)}-${mode}.jsonl`);

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, "", { flag: "wx" });

  const db = new Database(dbPath, { readonly: mode === "dry-run" });
  db.pragma("busy_timeout = 5000");

  const summary: RedactChatSecretsSummary = {
    mode,
    dbPath,
    reportPath,
    rowsScanned: 0,
    rowsChanged: 0,
    fieldsChanged: 0,
    secretsFound: 0,
    byRule: {},
  };

  try {
    for (const target of TARGETS) {
      scanTarget(db, target, options, summary, reportPath);
    }
    appendReport(reportPath, { event: "summary", ...summary });
    return summary;
  } finally {
    db.close();
  }
}

function scanTarget(
  db: Database.Database,
  target: TargetTable,
  options: RedactChatSecretsOptions,
  summary: RedactChatSecretsSummary,
  reportPath: string,
): void {
  const fields = existingFields(db, target);
  if (fields.length === 0) return;

  const columns = [target.idColumn, target.orderColumn, ...fields].map(quoteIdent).join(", ");
  const batchSize = options.batchSize ?? 100;
  let lastOrder: number | null = null;
  let lastId = "";
  let targetRowsScanned = 0;

  while (options.maxRows === undefined || targetRowsScanned < options.maxRows) {
    const remaining = options.maxRows === undefined ? batchSize : Math.min(batchSize, options.maxRows - targetRowsScanned);
    const where =
      lastOrder === null
        ? ""
        : `WHERE (${quoteIdent(target.orderColumn)} > ? OR (${quoteIdent(target.orderColumn)} = ? AND ${quoteIdent(
            target.idColumn,
          )} > ?))`;
    const stmt = db.prepare(
      `SELECT ${columns} FROM ${quoteIdent(target.table)} ${where} ORDER BY ${quoteIdent(target.orderColumn)} ASC, ${quoteIdent(
        target.idColumn,
      )} ASC LIMIT ?`,
    );
    const params = lastOrder === null ? [remaining] : [lastOrder, lastOrder, lastId, remaining];
    const rows = stmt.all(...params) as DbRow[];
    if (rows.length === 0) break;

    const updates: Array<{ rowId: string; changedValues: Record<string, string | null> }> = [];
    for (const row of rows) {
      summary.rowsScanned += 1;
      targetRowsScanned += 1;
      const rowId = String(row[target.idColumn]);
      const changedValues: Record<string, string | null> = {};
      let rowChanged = false;

      for (const field of fields) {
        const value = row[field];
        if (typeof value !== "string" || value.length === 0) continue;

        const result = redactSecretsInText(value);
        if (!result.changed) continue;

        rowChanged = true;
        changedValues[field] = result.redactedText;
        summary.fieldsChanged += 1;
        summary.secretsFound += result.matches.length;
        for (const match of result.matches) {
          summary.byRule[match.ruleId] = (summary.byRule[match.ruleId] ?? 0) + 1;
          appendReport(reportPath, {
            event: "redaction",
            mode: summary.mode,
            table: target.table,
            rowId,
            field,
            ruleId: match.ruleId,
            hash: match.hash,
            marker: match.marker,
            preview: previewAroundMarker(result.redactedText, match.marker),
          });
        }
      }

      if (!rowChanged) continue;
      summary.rowsChanged += 1;
      updates.push({ rowId, changedValues });
    }

    if (summary.mode === "apply") {
      const applyBatch = db.transaction((batch: Array<{ rowId: string; changedValues: Record<string, string | null> }>) => {
        for (const update of batch) {
          updateRow(db, target.table, target.idColumn, update.rowId, update.changedValues);
        }
      });
      applyBatch(updates);
    }

    const lastRow = rows[rows.length - 1];
    lastOrder = Number(lastRow?.[target.orderColumn]);
    lastId = String(lastRow?.[target.idColumn]);
  }
}

function existingFields(db: Database.Database, target: TargetTable): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(target.table)})`).all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  if (!columns.has(target.idColumn) || !columns.has(target.orderColumn)) return [];
  return target.fields.filter((field) => columns.has(field));
}

function updateRow(
  db: Database.Database,
  table: string,
  idColumn: string,
  rowId: string,
  changedValues: Record<string, string | null>,
): void {
  const fields = Object.keys(changedValues);
  if (fields.length === 0) return;
  const setClause = fields.map((field) => `${quoteIdent(field)} = ?`).join(", ");
  const values = fields.map((field) => changedValues[field]);
  db.prepare(`UPDATE ${quoteIdent(table)} SET ${setClause} WHERE ${quoteIdent(idColumn)} = ?`).run(...values, rowId);
}

function appendReport(path: string, event: RedactionEvent | SummaryEvent): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
}

function previewAroundMarker(text: string, marker: string): string {
  const idx = text.indexOf(marker);
  if (idx < 0) return "";
  const start = Math.max(0, idx - 48);
  const end = Math.min(text.length, idx + marker.length + 48);
  return text.slice(start, end).replace(/\s+/gu, " ");
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/gu, "\"\"")}"`;
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

type CliOptions = RedactChatSecretsOptions & {
  json?: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--db":
        options.dbPath = requiredValue(argv, ++i, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(argv, ++i, arg);
        break;
      case "--max-rows":
        options.maxRows = Number.parseInt(requiredValue(argv, ++i, arg), 10);
        if (!Number.isFinite(options.maxRows) || options.maxRows <= 0) {
          throw new Error("--max-rows must be a positive integer");
        }
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: npx tsx src/scripts/redact-chat-secrets.ts [--dry-run|--apply] [options]

Options:
  --db <path>          SQLite database path. Defaults to SuperMatrix runtime DB.
  --report-dir <path>  JSONL audit report directory.
  --max-rows <n>       Limit rows per target table, useful for smoke tests.
  --json               Print machine-readable summary.

Default mode is --dry-run. Reports never include raw secret values.`);
}

function printSummary(summary: RedactChatSecretsSummary, json = false): void {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    [
      `chat secret redaction ${summary.mode} complete`,
      `db: ${summary.dbPath}`,
      `report: ${summary.reportPath}`,
      `rows scanned: ${summary.rowsScanned}`,
      `rows changed: ${summary.rowsChanged}`,
      `fields changed: ${summary.fieldsChanged}`,
      `secrets found: ${summary.secretsFound}`,
      `by rule: ${JSON.stringify(summary.byRule)}`,
    ].join("\n"),
  );
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const summary = await redactChatSecretsDatabase(options);
  printSummary(summary, options.json);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
