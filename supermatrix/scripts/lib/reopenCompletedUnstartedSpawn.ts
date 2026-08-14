import type Database from "better-sqlite3";

const RECOVERY_AUDIT_ERROR =
  "completed child stopped at verified pre-business refusal; original client_request_id released for retry";

export type CompletedUnstartedSpawnRecoveryInput = {
  commId: string;
  fromSessionName: string;
  toSessionName: string;
  childSessionName: string;
  messageRunId: string;
  clientRequestId: string;
  /** A known pre-business refusal phrase. It is checked but never returned. */
  refusalMarker: string;
  /** A business-command marker that must be absent from the recorded stream. */
  forbiddenStreamMarker: string;
};

export type CompletedUnstartedSpawnRecoveryResult = {
  commId: string;
  clientRequestId: string;
  outcome: "eligible" | "recovered" | "already_recovered" | "blocked";
  applied: boolean;
  keyRetryable: boolean;
  wouldMakeKeyRetryable: boolean;
  blocker?: string;
};

type RecoverySnapshot = {
  comm_status: string;
  comm_kind: string;
  comm_client_request_id: string | null;
  child_session_id: string | null;
  comm_final_has_refusal_marker: number;
  comm_has_error: number;
  comm_has_recovery_audit_error: number;
  from_session_name: string | null;
  to_session_name: string | null;
  child_session_name: string | null;
  child_scope: string | null;
  child_parent_id: string | null;
  target_session_id: string | null;
  child_trigger_kind: string | null;
  child_type: string | null;
  comm_message_run_id: string | null;
  message_run_id: string | null;
  message_run_session_id: string | null;
  message_run_status: string | null;
  run_final_has_refusal_marker: number;
  run_has_error: number;
  forbidden_stream_marker_present: number;
};

/**
 * Reclassifies one auditable false-completion as failed so its original
 * Spawn2.0 idempotency key can be retried. This is intentionally an owner-run
 * repair primitive, not an automatic redrive: it never invokes a child or
 * business CLI and it refuses any route or stream that does not exactly match
 * the operator's verified pre-business refusal evidence.
 */
export function recoverCompletedUnstartedSpawn(
  db: Database.Database,
  input: CompletedUnstartedSpawnRecoveryInput,
  options: { apply: boolean },
): CompletedUnstartedSpawnRecoveryResult {
  if (!options.apply) return assessCompletedUnstartedSpawn(db, input);

  db.pragma("busy_timeout = 5000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const assessment = assessCompletedUnstartedSpawn(db, input);
    if (assessment.outcome !== "eligible") {
      db.exec("COMMIT");
      return assessment;
    }

    const update = db.prepare(
      `UPDATE cross_session_log
       SET status = 'failed',
           error_message = ?
       WHERE id = ?
         AND status = 'completed'
         AND kind = 'spawn'
         AND client_request_id = ?`,
    ).run(RECOVERY_AUDIT_ERROR, input.commId, input.clientRequestId);
    if (update.changes !== 1) {
      db.exec("COMMIT");
      return blockedResult(input, "compare_and_swap_lost", false);
    }

    const keyRetryable = countNonFailedCommsForKey(db, input.clientRequestId) === 0;
    db.exec("COMMIT");
    return {
      commId: input.commId,
      clientRequestId: input.clientRequestId,
      outcome: "recovered",
      applied: true,
      keyRetryable,
      wouldMakeKeyRetryable: keyRetryable,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have committed while producing a result.
    }
    throw error;
  }
}

function assessCompletedUnstartedSpawn(
  db: Database.Database,
  input: CompletedUnstartedSpawnRecoveryInput,
): CompletedUnstartedSpawnRecoveryResult {
  const snapshot = readSnapshot(db, input);
  if (!snapshot) return blockedResult(input, "comm_not_found", false);

  const routeBlocker = routeBlockerFor(snapshot, input);
  if (routeBlocker) return blockedResult(input, routeBlocker, false);

  const otherNonFailed = countOtherNonFailedCommsForKey(db, input.clientRequestId, input.commId);
  if (otherNonFailed > 0) {
    return blockedResult(input, "another_nonfailed_comm_uses_client_request_id", false);
  }

  if (snapshot.comm_status === "failed") {
    if (snapshot.comm_has_recovery_audit_error !== 1) {
      return blockedResult(input, "comm_already_failed_without_recovery_audit", true);
    }
    return {
      commId: input.commId,
      clientRequestId: input.clientRequestId,
      outcome: "already_recovered",
      applied: false,
      keyRetryable: true,
      wouldMakeKeyRetryable: true,
    };
  }
  if (snapshot.comm_status !== "completed") {
    return blockedResult(input, "comm_status_not_completed", false);
  }

  return {
    commId: input.commId,
    clientRequestId: input.clientRequestId,
    outcome: "eligible",
    applied: false,
    keyRetryable: false,
    wouldMakeKeyRetryable: true,
  };
}

function readSnapshot(
  db: Database.Database,
  input: CompletedUnstartedSpawnRecoveryInput,
): RecoverySnapshot | undefined {
  return db.prepare(
    `SELECT c.status AS comm_status,
            c.kind AS comm_kind,
            c.client_request_id AS comm_client_request_id,
            c.child_session_id AS child_session_id,
            CASE WHEN instr(COALESCE(c.final_message, ''), ?) > 0 THEN 1 ELSE 0 END AS comm_final_has_refusal_marker,
            CASE WHEN c.error_message IS NULL THEN 0 ELSE 1 END AS comm_has_error,
            CASE WHEN c.error_message = ? THEN 1 ELSE 0 END AS comm_has_recovery_audit_error,
            source.name AS from_session_name,
            target.name AS to_session_name,
            child.name AS child_session_name,
            child.scope AS child_scope,
            child.parent_id AS child_parent_id,
            target.id AS target_session_id,
            child.trigger_kind AS child_trigger_kind,
            child.child_type AS child_type,
            c.message_run_id AS comm_message_run_id,
            run.id AS message_run_id,
            run.session_id AS message_run_session_id,
            run.status AS message_run_status,
            CASE WHEN instr(COALESCE(run.final_message, ''), ?) > 0 THEN 1 ELSE 0 END AS run_final_has_refusal_marker,
            CASE WHEN run.error_message IS NULL THEN 0 ELSE 1 END AS run_has_error,
            CASE WHEN instr(COALESCE(run.stream_log, ''), ?) > 0 THEN 1 ELSE 0 END AS forbidden_stream_marker_present
       FROM cross_session_log AS c
       LEFT JOIN sessions AS source ON source.id = c.from_session_id
       LEFT JOIN sessions AS target ON target.id = c.to_session_id
       LEFT JOIN sessions AS child ON child.id = c.child_session_id
       LEFT JOIN message_runs AS run ON run.id = c.message_run_id
       WHERE c.id = ?`,
  ).get(
    input.refusalMarker,
    RECOVERY_AUDIT_ERROR,
    input.refusalMarker,
    input.forbiddenStreamMarker,
    input.commId,
  ) as RecoverySnapshot | undefined;
}

function routeBlockerFor(
  snapshot: RecoverySnapshot,
  input: CompletedUnstartedSpawnRecoveryInput,
): string | null {
  if (snapshot.comm_kind !== "spawn") return "comm_kind_not_spawn";
  if (snapshot.comm_client_request_id !== input.clientRequestId) return "client_request_id_mismatch";
  if (snapshot.from_session_name !== input.fromSessionName) return "from_session_mismatch";
  if (snapshot.to_session_name !== input.toSessionName) return "to_session_mismatch";
  if (snapshot.child_session_name !== input.childSessionName) return "child_session_mismatch";
  if (snapshot.child_scope !== "child") return "child_scope_not_child";
  if (snapshot.child_parent_id !== snapshot.target_session_id) return "child_parent_does_not_match_target";
  if (snapshot.child_trigger_kind !== "session") return "child_trigger_kind_not_session";
  if (snapshot.child_type !== "one_shot_delegation") return "child_type_not_one_shot_delegation";
  if (snapshot.comm_message_run_id !== input.messageRunId || snapshot.message_run_id !== input.messageRunId) {
    return "message_run_mismatch";
  }
  if (snapshot.message_run_session_id === null || snapshot.message_run_session_id === "") {
    return "message_run_session_missing";
  }
  if (snapshot.message_run_session_id !== snapshot.child_session_id) {
    return "message_run_not_owned_by_child";
  }
  if (snapshot.message_run_status !== "completed") return "message_run_status_not_completed";
  if (snapshot.comm_final_has_refusal_marker !== 1 || snapshot.run_final_has_refusal_marker !== 1) {
    return "verified_pre_business_refusal_marker_missing";
  }
  const expectedRecoveryAudit = snapshot.comm_status === "failed"
    && snapshot.comm_has_recovery_audit_error === 1;
  if ((!expectedRecoveryAudit && snapshot.comm_has_error !== 0) || snapshot.run_has_error !== 0) {
    return "terminal_error_present";
  }
  if (snapshot.forbidden_stream_marker_present !== 0) return "forbidden_stream_marker_present";
  return null;
}

function countOtherNonFailedCommsForKey(
  db: Database.Database,
  clientRequestId: string,
  commId: string,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count
       FROM cross_session_log
      WHERE client_request_id = ?
        AND id <> ?
        AND status <> 'failed'`,
  ).get(clientRequestId, commId) as { count: number };
  return row.count;
}

function countNonFailedCommsForKey(db: Database.Database, clientRequestId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count
       FROM cross_session_log
      WHERE client_request_id = ?
        AND status <> 'failed'`,
  ).get(clientRequestId) as { count: number };
  return row.count;
}

function blockedResult(
  input: CompletedUnstartedSpawnRecoveryInput,
  blocker: string,
  keyRetryable: boolean,
): CompletedUnstartedSpawnRecoveryResult {
  return {
    commId: input.commId,
    clientRequestId: input.clientRequestId,
    outcome: "blocked",
    applied: false,
    keyRetryable,
    wouldMakeKeyRetryable: false,
    blocker,
  };
}
