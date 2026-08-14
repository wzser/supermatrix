import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const RUNTIME_ROOT = "/Users/LOCAL_USER/SuperMatrixRuntime";
const OWNER_WORKSPACE = `${RUNTIME_ROOT}/workspaces/huojianwang2hao`;
const TARGET_SCRIPT = `${OWNER_WORKSPACE}/rules/shipment-type-v2/runtime/shipment-judge.mjs`;
const IDEMPOTENCY_KEY_RE = /^shipment_type_v2\.initial_apply\.v1:[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/u;
const APPROVED_REPORT_REF_RE = /^shipment-type-v2-approved:[a-f0-9]{64}$/u;
const REQUEST_KEYS = new Set(["command_id", "idempotency_key", "approved_report_ref"]);
const FIXED_CHILD_ENV = Object.freeze({
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/Users/LOCAL_USER",
});

export const SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST = Object.freeze({
  commandId: "shipment_type_v2.initial_apply.v1",
  ownerSession: "huojianwang2hao",
  secretAlias: "replenishment_execution",
  secretEnv: "SHIPMENT_JUDGE_BASE_TOKEN",
  argv: Object.freeze([
    "node",
    TARGET_SCRIPT,
    "--mode",
    "apply",
    "--all",
  ]),
});

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest() {
  return new Error("invalid narrow command request");
}

/**
 * The request deliberately has no caller, owner, argv, env, alias, or secret
 * fields. Owner and execution parameters are frozen in the manifest above.
 */
export function parseShipmentTypeV2InitialApplyRequest(raw) {
  if (!isPlainRecord(raw)) throw invalidRequest();
  const keys = Object.keys(raw);
  if (keys.length !== REQUEST_KEYS.size || keys.some((key) => !REQUEST_KEYS.has(key))) {
    throw invalidRequest();
  }
  if (raw.command_id !== SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.commandId) {
    throw invalidRequest();
  }
  if (
    typeof raw.idempotency_key !== "string"
    || !IDEMPOTENCY_KEY_RE.test(raw.idempotency_key)
    || typeof raw.approved_report_ref !== "string"
    || !APPROVED_REPORT_REF_RE.test(raw.approved_report_ref)
  ) {
    throw invalidRequest();
  }
  return {
    command_id: SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.commandId,
    idempotency_key: raw.idempotency_key,
    approved_report_ref: raw.approved_report_ref,
  };
}

/**
 * Build the target process environment from fixed non-secret values. The alias
 * provider supplies only SHIPMENT_JUDGE_BASE_TOKEN; its alias map and every
 * caller-supplied environment variable are never inherited by the target.
 * The value is copied without logging or serialization because the child
 * process is the only intended consumer.
 */
export function buildShipmentTypeV2InitialApplyEnv(sourceEnv) {
  const baseToken = sourceEnv[SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.secretEnv];
  if (typeof baseToken !== "string" || baseToken.trim().length === 0) return null;

  return {
    ...FIXED_CHILD_ENV,
    SM_RUNTIME_ROOT: RUNTIME_ROOT,
    SM_SESSION_NAME: SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.ownerSession,
    [SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.secretEnv]: baseToken,
  };
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(runId)) {
    throw new Error("invalid generated run id");
  }
  return runId;
}

function makeRunId() {
  return `shipment_type_v2_initial_apply_${randomUUID().replace(/-/gu, "")}`;
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

async function writeSafeReport({ reportDir, runId, request, status, errorPhase, now }) {
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const report = {
    schema_version: 1,
    command_id: SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.commandId,
    run_id: runId,
    owner_session: SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.ownerSession,
    status,
    approved_report_ref: request.approved_report_ref,
    error_phase: errorPhase,
    completed_at: nowIso(now),
  };
  const contents = `${JSON.stringify(report)}\n`;
  const reportPath = join(reportDir, `${runId}.json`);
  const temporaryPath = join(reportDir, `.${runId}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, reportPath);
  return { reportPath, reportHash: hashText(contents) };
}

function openRunLedger(ledgerPath) {
  const db = new Database(ledgerPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS shipment_type_v2_initial_apply_runs (
      command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      approved_report_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      report_path TEXT,
      report_hash TEXT,
      error_phase TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (command_id, idempotency_key)
    )
  `);
  return db;
}

function rowToReceipt(row) {
  return {
    run_id: row.run_id,
    status: row.status,
    report_path: row.report_path,
    report_hash: row.report_hash,
    error_phase: row.error_phase,
  };
}

function existingRun(db, idempotencyKey) {
  return db.prepare(`
    SELECT run_id, status, report_path, report_hash, error_phase
    FROM shipment_type_v2_initial_apply_runs
    WHERE command_id = ? AND idempotency_key = ?
  `).get(SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.commandId, idempotencyKey);
}

function claimRun(db, request, runId, now) {
  const inserted = db.prepare(`
    INSERT INTO shipment_type_v2_initial_apply_runs (
      command_id, idempotency_key, run_id, approved_report_ref, status,
      report_path, report_hash, error_phase, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?)
    ON CONFLICT(command_id, idempotency_key) DO NOTHING
  `).run(
    SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.commandId,
    request.idempotency_key,
    runId,
    request.approved_report_ref,
    now,
    now,
  );
  if (inserted.changes === 1) return null;
  return existingRun(db, request.idempotency_key);
}

function finishRun(db, request, receipt, now) {
  db.prepare(`
    UPDATE shipment_type_v2_initial_apply_runs
    SET status = ?, report_path = ?, report_hash = ?, error_phase = ?, updated_at = ?
    WHERE command_id = ? AND idempotency_key = ? AND status = 'running'
  `).run(
    receipt.status,
    receipt.report_path,
    receipt.report_hash,
    receipt.error_phase,
    now,
    SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.commandId,
    request.idempotency_key,
  );
}

function waitForFixedChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish({ kind: "spawn_error" }));
    child.once("close", (exitCode) => finish({ kind: "closed", exitCode }));
  });
}

async function persistTerminalReceipt({ db, request, runId, reportDir, status, errorPhase, now }) {
  try {
    const report = await writeSafeReport({
      reportDir,
      runId,
      request,
      status,
      errorPhase,
      now,
    });
    const receipt = {
      run_id: runId,
      status,
      report_path: report.reportPath,
      report_hash: report.reportHash,
      error_phase: errorPhase,
    };
    finishRun(db, request, receipt, nowIso(now));
    return receipt;
  } catch {
    const receipt = {
      run_id: runId,
      status: "failed",
      report_path: null,
      report_hash: null,
      error_phase: "receipt_persist",
    };
    try {
      finishRun(db, request, receipt, nowIso(now));
    } catch {
      // The caller only receives the fixed phase; no child output or DB error leaks.
    }
    return receipt;
  }
}

/**
 * Executes exactly one static command. It intentionally has no generic argv,
 * env, working-directory, or secret-provider parameters. The surrounding
 * authenticated broker is responsible for launching this process only after
 * consuming its one-time authorization and injecting the fixed alias.
 */
export async function executeShipmentTypeV2InitialApply(request, deps) {
  const parsedRequest = parseShipmentTypeV2InitialApplyRequest(request);
  const runId = assertSafeRunId((deps.createRunId ?? makeRunId)());
  const now = deps.now ?? Date.now;
  let db;
  try {
    await mkdir(dirname(deps.ledgerPath), { recursive: true, mode: 0o700 });
    db = openRunLedger(deps.ledgerPath);
  } catch {
    return {
      run_id: runId,
      status: "failed",
      report_path: null,
      report_hash: null,
      error_phase: "receipt_persist",
    };
  }

  try {
    const duplicate = claimRun(db, parsedRequest, runId, nowIso(now));
    if (duplicate) return rowToReceipt(duplicate);

    const childEnv = buildShipmentTypeV2InitialApplyEnv(deps.sourceEnv);
    if (!childEnv) {
      return await persistTerminalReceipt({
        db,
        request: parsedRequest,
        runId,
        reportDir: deps.reportDir,
        status: "failed",
        errorPhase: "secret_alias_unavailable",
        now,
      });
    }

    let child;
    try {
      child = deps.spawnChild(
        SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.argv[0],
        [...SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST.argv.slice(1)],
        {
          cwd: OWNER_WORKSPACE,
          env: childEnv,
          // Never capture or forward the target's stdout/stderr: it is not a
          // receipt channel and could contain a secret from a downstream tool.
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
    } catch {
      return await persistTerminalReceipt({
        db,
        request: parsedRequest,
        runId,
        reportDir: deps.reportDir,
        status: "failed",
        errorPhase: "spawn",
        now,
      });
    }

    const result = await waitForFixedChild(child);
    if (result.kind !== "closed" || result.exitCode !== 0) {
      return await persistTerminalReceipt({
        db,
        request: parsedRequest,
        runId,
        reportDir: deps.reportDir,
        status: "failed",
        errorPhase: result.kind === "spawn_error" ? "spawn" : "child_exit",
        now,
      });
    }
    return await persistTerminalReceipt({
      db,
      request: parsedRequest,
      runId,
      reportDir: deps.reportDir,
      status: "succeeded",
      errorPhase: null,
      now,
    });
  } finally {
    db.close();
  }
}

export function spawnShipmentTypeV2InitialApplyChild(file, argv, options) {
  return spawn(file, argv, options);
}

export const SHIPMENT_TYPE_V2_INITIAL_APPLY_RUNTIME_PATHS = Object.freeze({
  ledgerPath: `${RUNTIME_ROOT}/data/narrow-command-runs/shipment_type_v2_initial_apply.sqlite`,
  reportDir: `${RUNTIME_ROOT}/data/narrow-command-receipts/shipment_type_v2_initial_apply.v1`,
});
