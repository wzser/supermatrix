import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { parseOpaqueHandoffPrompt, type OpaqueHandoff } from "../../src/app/opaqueHandoff.ts";

const RECOVERY_AUDIT_ERROR =
  "completed opaque handoff released after explicit no-write/no-readback proof; original client_request_id released for retry";

export type OpaqueHandoffNoSideEffectProof = {
  schema_version: "spawn2.opaque_handoff_no_side_effect.v1";
  comm_id: string;
  client_request_id: string;
  envelope_sha256: string;
  no_write_confirmed: true;
  no_readback_confirmed: true;
  queue_job_count: 0;
  feishu_write_count: 0;
  high_water_advanced: false;
};

export type CompletedOpaqueHandoffRecoveryInput = {
  commId: string;
  clientRequestId: string;
  sourcePrompt: string;
  proof: OpaqueHandoffNoSideEffectProof;
};

export type CompletedOpaqueHandoffRecoveryResult = {
  commId: string;
  clientRequestId: string;
  envelopeSha256: string;
  outcome: "eligible" | "recovered" | "already_recovered" | "blocked";
  applied: boolean;
  keyRetryable: boolean;
  wouldMakeKeyRetryable: boolean;
  blocker?: string;
};

type Snapshot = {
  comm_status: string;
  comm_kind: string;
  comm_client_request_id: string | null;
  comm_prompt: string | null;
  comm_final_message: string | null;
  comm_error_message: string | null;
  from_session_name: string | null;
  to_session_name: string | null;
  child_session_id: string | null;
  message_run_id: string | null;
  child_prompt: string | null;
  child_final_message: string | null;
};

type AsyncReceiptSnapshot = {
  ref: string;
  status: string;
  verdict: string | null;
};

/**
 * Release one false-completed opaque handoff for a same-key retry. The proof
 * is deliberately explicit and the database mutation is a narrow CAS: this
 * helper never starts a child, invokes a business CLI, or creates a new key.
 */
export function recoverCompletedOpaqueHandoff(
  db: Database.Database,
  input: CompletedOpaqueHandoffRecoveryInput,
  options: { apply: boolean },
): CompletedOpaqueHandoffRecoveryResult {
  let expected: OpaqueHandoff | null;
  try {
    expected = parseOpaqueHandoffPrompt(input.sourcePrompt);
  } catch {
    return blockedResult(input, "source_prompt_is_not_opaque_handoff", "");
  }
  if (!expected) return blockedResult(input, "source_prompt_is_not_opaque_handoff", "");
  const proofBlocker = validateProof(input, expected);
  if (proofBlocker) return blockedResult(input, proofBlocker, expected.bytesSha256);

  if (!options.apply) return assess(db, input, expected);

  db.pragma("busy_timeout = 5000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const assessment = assess(db, input, expected);
    if (assessment.outcome !== "eligible") {
      db.exec("COMMIT");
      return assessment;
    }
    const now = Date.now();
    const update = db.prepare(
      `UPDATE cross_session_log
          SET status = 'failed', error_message = ?, finished_at = ?
        WHERE id = ? AND status = 'completed' AND kind = 'spawn' AND client_request_id = ?`,
    ).run(RECOVERY_AUDIT_ERROR, now, input.commId, input.clientRequestId);
    if (update.changes !== 1) {
      db.exec("COMMIT");
      return blockedResult(input, "compare_and_swap_lost", expected.bytesSha256);
    }

    const keyRetryable = countNonFailedComms(db, input.clientRequestId) === 0;
    db.exec("COMMIT");
    return {
      commId: input.commId,
      clientRequestId: input.clientRequestId,
      envelopeSha256: expected.bytesSha256,
      outcome: "recovered",
      applied: true,
      keyRetryable,
      wouldMakeKeyRetryable: keyRetryable,
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
}

function assess(
  db: Database.Database,
  input: CompletedOpaqueHandoffRecoveryInput,
  expected: OpaqueHandoff,
): CompletedOpaqueHandoffRecoveryResult {
  const snapshot = readSnapshot(db, input.commId);
  if (!snapshot) return blockedResult(input, "comm_not_found", expected.bytesSha256);
  const blocker = snapshotBlocker(snapshot, input, expected);
  if (blocker) return blockedResult(input, blocker, expected.bytesSha256);
  const sameKey = readClientRequestSnapshots(db, input.clientRequestId);
  if (sameKey.some((candidate) => candidate.commId !== input.commId && candidate.status !== "failed")) {
    return blockedResult(input, "another_nonfailed_comm_uses_client_request_id", expected.bytesSha256);
  }
  if (sameKey.some((candidate) => candidate.commId !== input.commId && candidate.receipts.length > 0)) {
    return blockedResult(input, "receipt_comm_id_mismatch", expected.bytesSha256);
  }
  const receiptBlocker = asyncReceiptBlocker(
    sameKey.find((candidate) => candidate.commId === input.commId)?.receipts ?? [],
  );
  if (receiptBlocker) return blockedResult(input, receiptBlocker, expected.bytesSha256);
  if (snapshot.comm_status === "failed" && snapshot.comm_error_message === RECOVERY_AUDIT_ERROR) {
    return {
      commId: input.commId,
      clientRequestId: input.clientRequestId,
      envelopeSha256: expected.bytesSha256,
      outcome: "already_recovered",
      applied: false,
      keyRetryable: true,
      wouldMakeKeyRetryable: true,
    };
  }
  if (snapshot.comm_status !== "completed") {
    return blockedResult(input, "comm_status_not_completed", expected.bytesSha256);
  }
  return {
    commId: input.commId,
    clientRequestId: input.clientRequestId,
    envelopeSha256: expected.bytesSha256,
    outcome: "eligible",
    applied: false,
    keyRetryable: false,
    wouldMakeKeyRetryable: true,
  };
}

function readSnapshot(db: Database.Database, commId: string): Snapshot | undefined {
  const comm = db.prepare(
    `SELECT c.status AS comm_status, c.kind AS comm_kind,
            c.client_request_id AS comm_client_request_id, c.prompt AS comm_prompt,
            c.final_message AS comm_final_message, c.error_message AS comm_error_message,
            source.name AS from_session_name, target.name AS to_session_name,
            c.child_session_id AS child_session_id, c.message_run_id AS message_run_id,
            run.prompt AS child_prompt, run.final_message AS child_final_message
       FROM cross_session_log c
       LEFT JOIN sessions source ON source.id = c.from_session_id
       LEFT JOIN sessions target ON target.id = c.to_session_id
       LEFT JOIN message_runs run ON run.id = c.message_run_id
      WHERE c.id = ?
      LIMIT 1`,
  ).get(commId) as Omit<Snapshot, "async_receipts"> | undefined;
  if (!comm) return undefined;
  return comm;
}

type ClientRequestSnapshot = {
  commId: string;
  status: string;
  receipts: AsyncReceiptSnapshot[];
};

function readClientRequestSnapshots(db: Database.Database, clientRequestId: string): ClientRequestSnapshot[] {
  const rows = db.prepare(
    "SELECT id, status FROM cross_session_log WHERE client_request_id = ? ORDER BY id",
  ).all(clientRequestId) as Array<{ id: string; status: string }>;
  return rows.map((row) => ({
    commId: row.id,
    status: row.status,
    receipts: readAsyncReceipts(db, row.id),
  }));
}

function readAsyncReceipts(db: Database.Database, commId: string): AsyncReceiptSnapshot[] {
  if (!hasTable(db, "spawn_async_items")) return [];
  return db.prepare(
    "SELECT ref, status, verdict FROM spawn_async_items WHERE comm_id = ? ORDER BY ref",
  ).all(commId) as AsyncReceiptSnapshot[];
}

function snapshotBlocker(
  snapshot: Snapshot,
  input: CompletedOpaqueHandoffRecoveryInput,
  expected: OpaqueHandoff,
): string | null {
  if (snapshot.comm_kind !== "spawn") return "comm_kind_not_spawn";
  if (snapshot.comm_client_request_id !== input.clientRequestId) return "client_request_id_mismatch";
  if (snapshot.from_session_name !== "pinglunmaster") return "from_session_mismatch";
  if (snapshot.to_session_name !== "product-tracker") return "to_session_mismatch";
  if (!snapshot.child_session_id || !snapshot.message_run_id) return "child_or_message_run_missing";
  if (!sameOpaqueHandoff(snapshot.comm_prompt, expected) || !sameOpaqueHandoff(snapshot.child_prompt, expected)) {
    return "recorded_envelope_digest_mismatch";
  }
  if (!isTerminalTransportFailure(snapshot.comm_final_message, input.clientRequestId)
    || !isTerminalTransportFailure(snapshot.child_final_message, input.clientRequestId)) {
    return "terminal_failure_receipt_missing";
  }
  return null;
}

function asyncReceiptBlocker(receipts: AsyncReceiptSnapshot[]): string | null {
  if (receipts.length === 0) return "historical_receipt_missing";
  if (receipts.some((receipt) => receipt.verdict === "caller_consumed")) {
    return "prior_delivery_terminal";
  }
  if (receipts.some((receipt) => receipt.status !== "closed")) {
    return "async_receipt_not_closed";
  }
  if (receipts.some((receipt) => receipt.verdict !== "delivered")) {
    return "async_item_already_closed";
  }
  return null;
}

function isTerminalTransportFailure(message: string | null, clientRequestId: string): boolean {
  if (!message) return false;
  try {
    const value = JSON.parse(message) as {
      ok?: unknown;
      error?: unknown;
      handoff?: {
        client_request_id?: unknown;
        delivery_mode?: unknown;
        from_session?: unknown;
      };
      row_count?: unknown;
      read_back_verified?: unknown;
    };
    return value.ok === false
      && value.error === "handoff_transport_invalid"
      && value.handoff?.client_request_id === clientRequestId
      && value.handoff.delivery_mode === "spawnr_todo_pool"
      && value.handoff.from_session === "pinglunmaster"
      && value.row_count === 0
      && value.read_back_verified === false;
  } catch {
    return false;
  }
}

function sameOpaqueHandoff(prompt: string | null, expected: OpaqueHandoff): boolean {
  if (!prompt) return false;
  try {
    const actual = parseOpaqueHandoffPrompt(prompt);
    return actual?.encodedBytes === expected.encodedBytes
      && actual.bytesSha256 === expected.bytesSha256
      && actual.executable === expected.executable
      && JSON.stringify(actual.args) === JSON.stringify(expected.args);
  } catch {
    return false;
  }
}

function validateProof(
  input: CompletedOpaqueHandoffRecoveryInput,
  expected: OpaqueHandoff,
): string | null {
  const proof = input.proof as Partial<OpaqueHandoffNoSideEffectProof> | null | undefined;
  if (!proof || typeof proof !== "object") return "proof_malformed";
  if (proof.schema_version !== "spawn2.opaque_handoff_no_side_effect.v1") return "proof_schema_mismatch";
  if (proof.comm_id !== input.commId) return "proof_comm_id_mismatch";
  if (proof.client_request_id !== input.clientRequestId) return "proof_client_request_id_mismatch";
  if (proof.envelope_sha256 !== expected.bytesSha256) return "proof_envelope_digest_mismatch";
  if (proof.no_write_confirmed !== true || proof.no_readback_confirmed !== true) {
    return "proof_requires_no_write_and_no_readback";
  }
  if (proof.queue_job_count !== 0 || proof.feishu_write_count !== 0 || proof.high_water_advanced !== false) {
    return "proof_reports_side_effects";
  }
  return null;
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function countNonFailedComms(db: Database.Database, clientRequestId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM cross_session_log WHERE client_request_id = ? AND status <> 'failed'",
  ).get(clientRequestId) as { count: number };
  return row.count;
}

function blockedResult(
  input: CompletedOpaqueHandoffRecoveryInput,
  blocker: string,
  envelopeSha256: string,
): CompletedOpaqueHandoffRecoveryResult {
  return {
    commId: input.commId,
    clientRequestId: input.clientRequestId,
    envelopeSha256,
    outcome: "blocked",
    applied: false,
    keyRetryable: false,
    wouldMakeKeyRetryable: false,
    blocker,
  };
}

export function readOpaqueRecoveryProof(path: string): OpaqueHandoffNoSideEffectProof {
  const value = JSON.parse(readFileSync(path, "utf8")) as OpaqueHandoffNoSideEffectProof;
  return value;
}
