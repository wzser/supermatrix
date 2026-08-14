import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { ensureIncidentStore } from "./incident-store.mjs";
import { defaultIncidentDbPath } from "./self-heal-config.mjs";

export const LEGACY_INCIDENT_DB_PATH = "/Users/LOCAL_USER/amzdata/amz_sql.db";

const RUN_EVENT_COLUMNS = [
  "id",
  "run_id",
  "pack_name",
  "target",
  "profile",
  "event_type",
  "failure_kind",
  "attempt_no",
  "details_json",
  "screenshot_path",
  "created_at"
];

const REPAIR_COLUMNS = [
  "id",
  "incident_key",
  "pack_name",
  "profile",
  "target",
  "run_id",
  "trigger",
  "status",
  "branch_name",
  "worktree_path",
  "summary_json",
  "created_at",
  "updated_at"
];

function getDatabaseSyncImpl(DatabaseSyncImpl) {
  return DatabaseSyncImpl || DatabaseSync;
}

function assertReadableSource(sourceDbPath) {
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Legacy incident database does not exist: ${sourceDbPath}`);
  }
}

function tableExists(db, schemaName, tableName) {
  return Boolean(
    db
      .prepare(`SELECT name FROM ${schemaName}.sqlite_master WHERE type = ? AND name = ?`)
      .get("table", tableName)
  );
}

function summarizeTable(db, schemaName, tableName) {
  if (!tableExists(db, schemaName, tableName)) {
    return { table: tableName, count: 0, minCreatedAt: null, maxCreatedAt: null };
  }

  const row = db
    .prepare(`SELECT count(*) AS count, min(created_at) AS minCreatedAt, max(created_at) AS maxCreatedAt FROM ${schemaName}.${tableName}`)
    .get();

  return {
    table: tableName,
    count: Number(row.count),
    minCreatedAt: row.minCreatedAt || null,
    maxCreatedAt: row.maxCreatedAt || null
  };
}

function copyTable(db, tableName, columns) {
  if (!tableExists(db, "legacy", tableName)) {
    return { table: tableName, copied: 0, skipped: true };
  }

  const columnList = columns.join(", ");
  const result = db
    .prepare(
      `
        INSERT OR REPLACE INTO main.${tableName} (${columnList})
        SELECT ${columnList}
        FROM legacy.${tableName}
      `
    )
    .run();

  return { table: tableName, copied: Number(result.changes), skipped: false };
}

export function migrateIncidentStore({
  sourceDbPath = LEGACY_INCIDENT_DB_PATH,
  targetDbPath = defaultIncidentDbPath(),
  DatabaseSyncImpl
} = {}) {
  assertReadableSource(sourceDbPath);
  ensureIncidentStore({ dbPath: targetDbPath, DatabaseSyncImpl });

  const DatabaseCtor = getDatabaseSyncImpl(DatabaseSyncImpl);
  const db = new DatabaseCtor(targetDbPath);
  let attached = false;

  try {
    db.prepare("ATTACH DATABASE ? AS legacy").run(sourceDbPath);
    attached = true;

    const before = [
      summarizeTable(db, "legacy", "web_access_run_events"),
      summarizeTable(db, "legacy", "web_access_repairs")
    ];

    db.exec("BEGIN");
    try {
      const copied = [
        copyTable(db, "web_access_run_events", RUN_EVENT_COLUMNS),
        copyTable(db, "web_access_repairs", REPAIR_COLUMNS)
      ];
      db.exec("COMMIT");

      const after = [
        summarizeTable(db, "main", "web_access_run_events"),
        summarizeTable(db, "main", "web_access_repairs")
      ];

      return {
        sourceDbPath,
        targetDbPath,
        sourceSummary: before,
        targetSummary: after,
        copied
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (attached) {
      db.exec("DETACH DATABASE legacy");
    }
    db.close();
  }
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      options.sourceDbPath = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--target") {
      options.targetDbPath = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(arg, argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/core/migrate-incident-store.mjs [--source <legacy.db>] [--target <incidents.db>]",
      "",
      `Default source: ${LEGACY_INCIDENT_DB_PATH}`,
      `Default target: ${defaultIncidentDbPath()}`
    ].join("\n")
  );
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const result = migrateIncidentStore(options);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
