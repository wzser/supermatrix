import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveIncidentDbPath } from "./self-heal-config.mjs";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS web_access_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    pack_name TEXT NOT NULL,
    target TEXT NOT NULL,
    profile TEXT NOT NULL,
    event_type TEXT NOT NULL,
    failure_kind TEXT NOT NULL DEFAULT '',
    attempt_no INTEGER NOT NULL DEFAULT 0,
    details_json TEXT NOT NULL DEFAULT '{}',
    screenshot_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )
`;

const CREATE_REPAIRS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS web_access_repairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_key TEXT NOT NULL UNIQUE,
    pack_name TEXT NOT NULL,
    profile TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    branch_name TEXT NOT NULL DEFAULT '',
    worktree_path TEXT NOT NULL DEFAULT '',
    summary_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

function ensureParentDir(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function getDatabaseSyncImpl(DatabaseSyncImpl) {
  return DatabaseSyncImpl || DatabaseSync;
}

function resolveDbPath(dbPath) {
  return dbPath || resolveIncidentDbPath();
}

function normalizeEvent(event = {}) {
  const runId = event.runId || event.run_id;
  const packName = event.packName || event.pack_name;
  const target = event.target;
  const profile = event.profile;
  const eventType = event.eventType || event.event_type;
  const failureKind = event.failureKind ?? event.failure_kind ?? "";
  const attemptNo = event.attemptNo ?? event.attempt_no ?? 0;
  const screenshotPath = event.screenshotPath || event.screenshot_path || "";
  const createdAt = event.createdAt || event.created_at || new Date().toISOString();
  const details = event.details ?? event.details_json ?? {};

  if (!runId || !packName || !target || !profile || !eventType) {
    throw new Error("Invalid run event");
  }

  return {
    runId,
    packName,
    target,
    profile,
    eventType,
    failureKind,
    attemptNo,
    detailsJson: normalizeDetailsJson(details),
    screenshotPath,
    createdAt,
  };
}

function normalizeDetailsJson(details) {
  if (details === undefined) {
    return "{}";
  }

  if (typeof details === "string") {
    try {
      return JSON.stringify(JSON.parse(details));
    } catch {
      throw new Error("Invalid JSON details");
    }
  }

  try {
    return JSON.stringify(details ?? {});
  } catch {
    throw new Error("Invalid JSON details");
  }
}

function normalizeRepairRecord(record = {}) {
  const incidentKey = String(record.incidentKey || record.incident_key || "").trim();
  const packName = String(record.packName || record.pack_name || "").trim();
  const profile = String(record.profile || "").trim();
  const status = String(record.status || "").trim();
  const target = String(record.target || "").trim();
  const runId = String(record.runId || record.run_id || "").trim();
  const trigger = String(record.trigger || "").trim();
  const branchName = String(record.branchName || record.branch_name || "").trim();
  const worktreePath = String(record.worktreePath || record.worktree_path || "").trim();
  const createdAt = String(record.createdAt || record.created_at || new Date().toISOString()).trim();
  const updatedAt = String(record.updatedAt || record.updated_at || createdAt).trim();
  const summary = record.summary ?? record.summary_json ?? {};

  if (!incidentKey || !packName || !profile || !status || !createdAt || !updatedAt) {
    throw new Error("Invalid repair record");
  }

  return {
    incidentKey,
    packName,
    profile,
    target,
    runId,
    trigger,
    status,
    branchName,
    worktreePath,
    summaryJson: normalizeDetailsJson(summary),
    createdAt,
    updatedAt
  };
}

function mapRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    runId: row.run_id,
    packName: row.pack_name,
    target: row.target,
    profile: row.profile,
    eventType: row.event_type,
    failureKind: row.failure_kind,
    attemptNo: row.attempt_no,
    details: row.details_json ? JSON.parse(row.details_json) : {},
    screenshotPath: row.screenshot_path,
    createdAt: row.created_at,
  };
}

function mapRepairRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    incidentKey: row.incident_key,
    packName: row.pack_name,
    profile: row.profile,
    target: row.target,
    runId: row.run_id,
    trigger: row.trigger,
    status: row.status,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    summary: row.summary_json ? JSON.parse(row.summary_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function ensureIncidentStore({ dbPath, DatabaseSyncImpl } = {}) {
  const resolvedDbPath = resolveDbPath(dbPath);
  ensureParentDir(resolvedDbPath);

  const DatabaseCtor = getDatabaseSyncImpl(DatabaseSyncImpl);
  const db = new DatabaseCtor(resolvedDbPath);
  db.exec(CREATE_TABLE_SQL);
  db.exec(CREATE_REPAIRS_TABLE_SQL);
  db.close();

  return { dbPath: resolvedDbPath };
}

export function appendRunEvent({ dbPath, event, DatabaseSyncImpl } = {}) {
  const resolvedDbPath = resolveDbPath(dbPath);
  ensureIncidentStore({ dbPath: resolvedDbPath, DatabaseSyncImpl });

  const DatabaseCtor = getDatabaseSyncImpl(DatabaseSyncImpl);
  const db = new DatabaseCtor(resolvedDbPath);

  try {
    const normalized = normalizeEvent(event);
    const stmt = db.prepare(`
      INSERT INTO web_access_run_events (
        run_id,
        pack_name,
        target,
        profile,
        event_type,
        failure_kind,
        attempt_no,
        details_json,
        screenshot_path,
        created_at
      ) VALUES (
        @runId,
        @packName,
        @target,
        @profile,
        @eventType,
        @failureKind,
        @attemptNo,
        @detailsJson,
        @screenshotPath,
        @createdAt
      )
    `);
    const result = stmt.run(normalized);
    return { id: Number(result.lastInsertRowid) };
  } finally {
    db.close();
  }
}

export function listRecentRunEvents({
  dbPath,
  packName,
  profile,
  limit = 20,
  DatabaseSyncImpl
} = {}) {
  if (!packName || !profile) {
    throw new Error("packName and profile are required");
  }

  const resolvedDbPath = resolveDbPath(dbPath);
  ensureIncidentStore({ dbPath: resolvedDbPath, DatabaseSyncImpl });

  const DatabaseCtor = getDatabaseSyncImpl(DatabaseSyncImpl);
  const db = new DatabaseCtor(resolvedDbPath);

  try {
    const rows = db
      .prepare(
        `
          SELECT
            id,
            run_id,
            pack_name,
            target,
            profile,
            event_type,
            failure_kind,
            attempt_no,
            details_json,
            screenshot_path,
            created_at
          FROM web_access_run_events
          WHERE pack_name = ?
            AND profile = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(packName, profile, limit);

    return rows.map(mapRow);
  } finally {
    db.close();
  }
}

export function listRecentTerminalFailures({
  dbPath,
  packName,
  profile,
  limit = 20,
  DatabaseSyncImpl
} = {}) {
  if (!packName || !profile) {
    throw new Error("packName and profile are required");
  }

  const resolvedDbPath = resolveDbPath(dbPath);
  ensureIncidentStore({ dbPath: resolvedDbPath, DatabaseSyncImpl });

  const DatabaseCtor = getDatabaseSyncImpl(DatabaseSyncImpl);
  const db = new DatabaseCtor(resolvedDbPath);

  try {
    const rows = db
      .prepare(
        `
          SELECT
            id,
            run_id,
            pack_name,
            target,
            profile,
            event_type,
            failure_kind,
            attempt_no,
            details_json,
            screenshot_path,
            created_at
          FROM web_access_run_events
          WHERE event_type = 'run_failed'
            AND pack_name = ?
            AND profile = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(packName, profile, limit);

    return rows.map(mapRow);
  } finally {
    db.close();
  }
}

export function upsertRepairRecord({ dbPath, record, DatabaseSyncImpl } = {}) {
  const resolvedDbPath = resolveDbPath(dbPath);
  ensureIncidentStore({ dbPath: resolvedDbPath, DatabaseSyncImpl });
  const DatabaseCtor = getDatabaseSyncImpl(DatabaseSyncImpl);
  const db = new DatabaseCtor(resolvedDbPath);

  try {
    const normalized = normalizeRepairRecord(record);
    db.prepare(
      `
        INSERT INTO web_access_repairs (
          incident_key,
          pack_name,
          profile,
          target,
          run_id,
          trigger,
          status,
          branch_name,
          worktree_path,
          summary_json,
          created_at,
          updated_at
        ) VALUES (
          @incidentKey,
          @packName,
          @profile,
          @target,
          @runId,
          @trigger,
          @status,
          @branchName,
          @worktreePath,
          @summaryJson,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(incident_key) DO UPDATE SET
          pack_name = excluded.pack_name,
          profile = excluded.profile,
          target = excluded.target,
          run_id = excluded.run_id,
          trigger = excluded.trigger,
          status = excluded.status,
          branch_name = excluded.branch_name,
          worktree_path = excluded.worktree_path,
          summary_json = excluded.summary_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `
    ).run(normalized);

    return getRepairRecord({
      dbPath: resolvedDbPath,
      DatabaseSyncImpl,
      incidentKey: normalized.incidentKey
    });
  } finally {
    db.close();
  }
}

export function getRepairRecord({ dbPath, incidentKey, DatabaseSyncImpl } = {}) {
  const resolvedIncidentKey = String(incidentKey || "").trim();
  if (!resolvedIncidentKey) {
    throw new Error("incidentKey is required");
  }

  const resolvedDbPath = resolveDbPath(dbPath);
  ensureIncidentStore({ dbPath: resolvedDbPath, DatabaseSyncImpl });
  const DatabaseCtor = getDatabaseSyncImpl(DatabaseSyncImpl);
  const db = new DatabaseCtor(resolvedDbPath);

  try {
    const row = db.prepare(
      `
        SELECT
          id,
          incident_key,
          pack_name,
          profile,
          target,
          run_id,
          trigger,
          status,
          branch_name,
          worktree_path,
          summary_json,
          created_at,
          updated_at
        FROM web_access_repairs
        WHERE incident_key = ?
      `
    ).get(resolvedIncidentKey);

    return mapRepairRow(row);
  } finally {
    db.close();
  }
}
