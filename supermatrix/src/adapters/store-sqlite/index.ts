import type { Binding } from "../../domain/binding.ts";
import { asTimestamp, type AbsolutePath, type CardId, type LarkGroupId, type MessageRunId, type SessionId, type Timestamp } from "../../domain/ids.ts";
import type { BackendKind, EffortLevel, Session, SessionStatus } from "../../domain/session.ts";
import {
  MAIN_BRANCH_NAME,
  validateBranchName,
  type NewSessionBranchInput,
  type SessionBranchRecord,
} from "../../domain/sessionBranch.ts";
import {
  assertBackendAllowedForCategory,
  isConformingAvatar,
  validateSessionAlias,
  validateSessionAvatar,
  validateSessionCategory,
} from "../../domain/sessionMeta.ts";
import type {
  AcquireBackendMaintenanceLeaseInput,
  AcquireBackendMaintenanceLeaseResult,
  AttachmentRef,
  BackendMaintenanceLease,
  BackendMaintenanceLeaseEvent,
  BindingStore,
  BootChildCleanupResult,
  BootOrphanedSpawnComm,
  BackendAccountSwitchRecord,
  RecordBackendAccountSwitchInput,
  ReleaseBackendMaintenanceLeaseInput,
  ReleaseBackendMaintenanceLeaseResult,
  ClaimDriveCommentMentionInput,
  CrossSessionComm,
  DisplayNameEntry,
  DriveCommentMentionRecord,
  GetRankStatsInput,
  FinishDriveCommentMentionInput,
  MessageRun,
  MessageRunAdmissionInput,
  MessageRunAdmissionResult,
  NewAttachmentInput,
  NewCrossSessionComm,
  NewMessageRunInput,
  NewSessionInput,
  NewSpawnPredicateInput,
  EnqueueSpawnQueueItemInput,
  OpenSpawnPredicateRecord,
  PatchSpawnPredicateInput,
  RankRow,
  RankStats,
  RegisterSpawnAsyncItemInput,
  DeliverableSpawnAsyncItemStatus,
  RecordResponseLogInput,
  RecordWatcherExceptionInput,
  FinishResponseLogInput,
  ResultSinkAttempt,
  ResultSinkAttemptInput,
  ResponseLogRecord,
  SessionRuntimeConfigAudit,
  SessionRuntimeConfigAuditSnapshot,
  SessionRuntimeConfigMutation,
  SessionRuntimeConfigPending,
  SessionRuntimeConfigSnapshot,
  SessionRuntimeConfigRequested,
  RunStatus,
  SchedulerTokenUsage,
  SpawnAsyncItemDeliveredClosure,
  SpawnAsyncItemRecord,
  SpawnQueueItem,
  SpawnPredicateRecord,
  TokenUsageInput,
  TokenUsageRawTotals,
  TokenUsageSummary,
  TokenUsageWindow,
  TokenUsageWindowCutoffs,
  UpsertWatcherStateInput,
  WatcherStateRecord,
} from "../../ports/BindingStore.ts";
import {
  RuntimeConfigConflictError,
  type DrainPendingSessionRuntimeConfigResult,
} from "../../ports/BindingStore.ts";
import type {
  ChildSessionDefaults,
  ChildSessionDefaultsPatch,
} from "../../ports/ChildSessionDefaults.ts";
import type {
  FollowMainOrLocked,
  SessionRuntimeSettings,
  SessionRuntimeSettingsPatch,
} from "../../ports/SessionRuntimeSettings.ts";
import { CANONICAL_MAIN_SESSION_DEFAULTS } from "../../ports/SessionRuntimeSettings.ts";
import { openDb, type Db } from "./db.ts";
import { applyMigrations, type MigrationResult } from "./migrations.ts";
export type { MigrationResult } from "./migrations.ts";
import { rowToSession, type SessionRow } from "./rowMappers.ts";

const RANK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RANK_LINK_RE = /data:[^\s"'<>]+|https?:\/\/[^\s"'<>]+|www\.[^\s"'<>]+/giu;

function hasSessionRuntimeSettingsPatch(patch: SessionRuntimeSettingsPatch): boolean {
  return Object.hasOwn(patch, "mainModelDefault")
    || Object.hasOwn(patch, "mainEffortDefault")
    || Object.hasOwn(patch, "childBackend")
    || Object.hasOwn(patch, "childModel")
    || Object.hasOwn(patch, "childEffort");
}

function followMainOrLocked<T>(configured: number, value: T | null): FollowMainOrLocked<T> {
  return configured === 1
    ? { configured: true, value: value as T }
    : { configured: false, value: null };
}

function countRankInputChars(prompt: string): number {
  return prompt.replace(RANK_LINK_RE, "").trim().length;
}

type RuntimeConfigAuditRow = {
  id: string;
  session_id: string;
  trigger: string;
  before_json: string;
  requested_json: string;
  after_json: string;
  decision: string;
  reason: string;
  catalog_source: string;
  catalog_fingerprint: string;
  created_at: number;
};

type RuntimeConfigPendingRow = {
  session_id: string;
  backend: BackendKind;
  model: string | null;
  effort: EffortLevel | null;
  requested_json: string;
  catalog_source: string;
  catalog_fingerprint: string;
  created_at: number;
  updated_at: number;
};

const RUNTIME_CONFIG_AUDIT_COLUMNS = [
  "id", "session_id", "trigger", "before_json", "requested_json", "after_json",
  "decision", "reason", "catalog_source", "catalog_fingerprint", "created_at",
] as const;
const RUNTIME_CONFIG_AUDIT_INDEX = "idx_session_runtime_config_audit_session_created";

function projectRuntimeConfigRequested(
  requested: SessionRuntimeConfigRequested,
): SessionRuntimeConfigRequested {
  const source = requested as Record<string, unknown>;
  return {
    ...(Object.hasOwn(source, "backend") ? { backend: source.backend } : {}),
    ...(Object.hasOwn(source, "model") ? { model: source.model } : {}),
    ...(Object.hasOwn(source, "effort") ? { effort: source.effort } : {}),
  } as SessionRuntimeConfigRequested;
}

function projectRuntimeConfigAuditSnapshot(
  snapshot: SessionRuntimeConfigSnapshot | SessionRuntimeConfigAuditSnapshot,
): SessionRuntimeConfigAuditSnapshot {
  const source = snapshot as unknown as Record<string, unknown>;
  return {
    backend: source.backend as SessionRuntimeConfigAuditSnapshot["backend"],
    model: source.model as SessionRuntimeConfigAuditSnapshot["model"],
    effort: source.effort as SessionRuntimeConfigAuditSnapshot["effort"],
    resumeCleared: typeof source.resumeCleared === "boolean"
      ? source.resumeCleared
      : source.backendSessionId == null,
  };
}

function insertPendingRuntimeConfigAudit(
  db: Db,
  input: {
    id: string;
    sessionId: SessionId;
    before: SessionRuntimeConfigSnapshot;
    after: SessionRuntimeConfigSnapshot;
    requested: SessionRuntimeConfigRequested;
    decision: string;
    reason: string;
    catalogSource: string;
    catalogFingerprint: string;
    createdAt: Timestamp;
  },
): void {
  db.prepare(
    `INSERT INTO session_runtime_config_audit
     (id, session_id, trigger, before_json, requested_json, after_json, decision, reason,
      catalog_source, catalog_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    "pending-runtime-config",
    JSON.stringify(projectRuntimeConfigAuditSnapshot(input.before)),
    JSON.stringify(projectRuntimeConfigRequested(input.requested)),
    JSON.stringify(projectRuntimeConfigAuditSnapshot(input.after)),
    input.decision,
    input.reason,
    input.catalogSource,
    input.catalogFingerprint,
    input.createdAt,
  );
}

function verifyRuntimeConfigAuditSchema(db: Db): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(session_runtime_config_audit)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const missingColumns = RUNTIME_CONFIG_AUDIT_COLUMNS.filter((column) => !columns.has(column));
  const indexes = new Set(
    (db.prepare("PRAGMA index_list(session_runtime_config_audit)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(session_runtime_config_audit)").all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  const hasSessionForeignKey = foreignKeys.some((foreignKey) =>
    foreignKey.table === "sessions"
      && foreignKey.from === "session_id"
      && foreignKey.to === "id"
  );

  if (missingColumns.length > 0 || !indexes.has(RUNTIME_CONFIG_AUDIT_INDEX) || !hasSessionForeignKey) {
    const defects = [
      missingColumns.length > 0 ? `missing columns: ${missingColumns.join(", ")}` : null,
      !indexes.has(RUNTIME_CONFIG_AUDIT_INDEX) ? `missing index: ${RUNTIME_CONFIG_AUDIT_INDEX}` : null,
      !hasSessionForeignKey ? "missing foreign key: session_id -> sessions(id)" : null,
    ].filter((defect): defect is string => defect !== null);
    throw new Error(`session_runtime_config_audit schema incompatible: ${defects.join("; ")}`);
  }
}

type SpawnAsyncItemSqlRow = {
  ref: string;
  comm_id: string;
  caller_session: string;
  target_session: string;
  failed_phase: SpawnAsyncItemRecord["failedPhase"];
  failure_kind: SpawnAsyncItemRecord["failureKind"];
  attempt_count: number;
  status: SpawnAsyncItemRecord["status"];
  verdict: string | null;
  verdict_reason: string | null;
  created_at: number;
  updated_at: number;
  last_attempt_at: number | null;
  child_session_id: string | null;
  message_run_id: string | null;
  comm_status: SpawnAsyncItemRecord["commStatus"];
  final_message: string | null;
  error_message: string | null;
  client_request_id: string | null;
  origin_run_id: string | null;
};

const SPAWN_ASYNC_ITEM_SELECT = `SELECT
           sai.ref,
           sai.comm_id,
           sai.caller_session,
           sai.target_session,
           sai.failed_phase,
           sai.failure_kind,
           sai.attempt_count,
           sai.status,
           sai.verdict,
           sai.verdict_reason,
           sai.created_at,
           sai.updated_at,
           sai.last_attempt_at,
           c.child_session_id,
           c.message_run_id,
           c.status AS comm_status,
           c.final_message,
           c.error_message,
           c.client_request_id,
           c.origin_run_id
         FROM spawn_async_items sai
         LEFT JOIN cross_session_log c ON c.id = sai.comm_id`;

function mapSpawnAsyncItemRow(row: SpawnAsyncItemSqlRow): SpawnAsyncItemRecord {
  return {
    ref: row.ref,
    commId: row.comm_id,
    callerSession: row.caller_session,
    targetSession: row.target_session,
    failedPhase: row.failed_phase,
    failureKind: row.failure_kind,
    attemptCount: row.attempt_count,
    status: row.status,
    verdict: row.verdict,
    verdictReason: row.verdict_reason,
    createdAt: row.created_at as Timestamp,
    updatedAt: row.updated_at as Timestamp,
    lastAttemptAt: (row.last_attempt_at ?? null) as Timestamp | null,
    childSessionId: row.child_session_id,
    messageRunId: row.message_run_id as MessageRunId | null,
    commStatus: row.comm_status,
    finalMessage: row.final_message,
    errorMessage: row.error_message,
    clientRequestId: row.client_request_id,
    originRunId: row.origin_run_id as MessageRunId | null,
  };
}

function bootOrphanFailureMessage(reason: string): string {
  return `Spawn failed during console restart before a result was produced: ${reason}`;
}

export class SqliteBindingStore implements BindingStore {
  readonly db: Db;

  constructor(path: string) {    this.db = openDb(path);
  }

  async init(): Promise<MigrationResult> {
    const result = await applyMigrations(this.db);
    verifyRuntimeConfigAuditSchema(this.db);

    // Create user_display_names cache table (owned by hrhrhrhrhr, read by /rank)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_display_names (
        sender_id    TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        fetched_at   INTEGER NOT NULL
      )
    `);

    return result;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async createSession(input: NewSessionInput): Promise<Session> {
    validateSessionMetaForWrite(input);
    const createdAt = sessionTimestamp(input.createdAt, "sessions.createdAt");
    // FP v1.0 contract §4 chat_name option (a): no new chat_name writers.
    // The column stays NULL for new rows; existing rows are not touched
    // (red line: no UPDATE).
    const insertSession = this.db.prepare(
      `INSERT INTO sessions
         (id, name, alias, avatar, category, scope, backend, model, effort, thinking, workdir, backend_session_id, purpose, status, affiliated_to, parent_id, depth, inactivity_timeout_s, max_runtime_s, child_type, trigger_kind, post_identity, caller_invocation, continuation_hook, capability_payload, heartbeat_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'initializing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
    const create = this.db.transaction(() => {
      insertSession.run(
        input.id,
        input.name,
        input.alias ?? "",
        input.avatar ?? "",
        input.category ?? "",
        input.scope,
        input.backend,
        input.model ?? null,
        input.effort ?? null,
        input.thinking ? 1 : 0,
        input.workdir,
        input.purpose,
        input.affiliatedTo ?? null,
        input.parentId ?? null,
        input.depth ?? 0,
        input.inactivityTimeoutS ?? null,
        input.maxRuntimeS ?? null,
        input.childType ?? null,
        input.triggerKind ?? null,
        input.postIdentity ?? null,
        input.callerInvocation ?? null,
        input.continuationHook ?? null,
        input.capabilityPayload ? JSON.stringify(input.capabilityPayload) : null,
        heartbeatEnabledByDefault(input),
        createdAt,
        createdAt,
      );
      if (input.scope !== "child") {
        this.insertDefaultSessionRuntimeSettings(input.id, input.backend, createdAt);
      }
    });
    create();
    const s = await this.findSessionById(input.id);
    if (!s) throw new Error("createSession failed: row not found after insert");
    return s;
  }

  async findSessionById(id: SessionId): Promise<Session | null> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  async findSessionByName(name: string): Promise<Session | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE name = ? OR alias = ?
         ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`,
      )
      .get(name, name, name) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async listAllSessions(): Promise<Session[]> {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all() as SessionRow[]).map(
      rowToSession
    );
  }

  async listActiveSessions(): Promise<Session[]> {
    // Child sessions are internal execution units — /list, /status summary,
    // /reload, and API /health all want the real work sessions, not the
    // short-lived children. Operators who want to see children explicitly
    // should use `listAllSessions()` or a future `/children <parent>`
    // diagnostic command (decisions.md D5).
    return (
      this.db
        .prepare(
          "SELECT * FROM sessions WHERE status != 'deleted' AND scope != 'child' ORDER BY created_at ASC",
        )
        .all() as SessionRow[]
    ).map(rowToSession);
  }

  async listActiveSessionsByBackend(backend?: string): Promise<Session[]> {
    const rows = backend
      ? (this.db
          .prepare(
            "SELECT * FROM sessions WHERE scope = 'user' AND status != 'deleted' AND backend = ? ORDER BY created_at ASC",
          )
          .all(backend) as SessionRow[])
      : (this.db
          .prepare(
            "SELECT * FROM sessions WHERE scope = 'user' AND status != 'deleted' ORDER BY created_at ASC",
          )
          .all() as SessionRow[]);
    return rows.map(rowToSession);
  }

  async updateSessionStatus(id: SessionId, status: SessionStatus, now: Timestamp): Promise<void> {
    const updatedAt = sessionTimestamp(now, "sessions.updatedAt");
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
  }

  async updateSessionModel(id: SessionId, model: string | null): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?")
      .run(model, updatedAt, id);
  }

  async updateSessionEffort(id: SessionId, effort: string | null): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET effort = ?, updated_at = ? WHERE id = ?")
      .run(effort, updatedAt, id);
  }

  async updateSessionThinking(id: SessionId, thinking: boolean): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET thinking = ?, updated_at = ? WHERE id = ?")
      .run(thinking ? 1 : 0, updatedAt, id);
  }

  async updateSessionModelLocked(id: SessionId, locked: boolean): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET model_locked = ?, updated_at = ? WHERE id = ?")
      .run(locked ? 1 : 0, updatedAt, id);
  }

  async updateSessionEffortLocked(id: SessionId, locked: boolean): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET effort_locked = ?, updated_at = ? WHERE id = ?")
      .run(locked ? 1 : 0, updatedAt, id);
  }

  async getBackendRuntimeDefaults(backend: BackendKind) {
    const row = this.db
      .prepare("SELECT backend, model, effort, updated_at FROM backend_runtime_defaults WHERE backend = ?")
      .get(backend) as { backend: BackendKind; model: string | null; effort: EffortLevel | null; updated_at: number } | undefined;
    return row ? { backend: row.backend, model: row.model, effort: row.effort, updatedAt: asTimestamp(row.updated_at) } : null;
  }

  async listBackendRuntimeDefaults() {
    const rows = this.db
      .prepare("SELECT backend, model, effort, updated_at FROM backend_runtime_defaults ORDER BY backend")
      .all() as Array<{ backend: BackendKind; model: string | null; effort: EffortLevel | null; updated_at: number }>;
    return rows.map((row) => ({ backend: row.backend, model: row.model, effort: row.effort, updatedAt: asTimestamp(row.updated_at) }));
  }

  async updateBackendRuntimeDefaults(
    backend: BackendKind,
    patch: { model?: string | null; effort?: EffortLevel | null },
  ): Promise<void> {
    const hasModel = Object.hasOwn(patch, "model");
    const hasEffort = Object.hasOwn(patch, "effort");
    if (!hasModel && !hasEffort) return;
    this.db.prepare(
      `INSERT INTO backend_runtime_defaults (backend, model, effort, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(backend) DO UPDATE SET
         model = CASE WHEN ? = 1 THEN excluded.model ELSE backend_runtime_defaults.model END,
         effort = CASE WHEN ? = 1 THEN excluded.effort ELSE backend_runtime_defaults.effort END,
         updated_at = excluded.updated_at`,
    ).run(
      backend,
      patch.model ?? null,
      patch.effort ?? null,
      currentSessionTimestamp(),
      hasModel ? 1 : 0,
      hasEffort ? 1 : 0,
    );
  }

  async getChildSessionDefaults(): Promise<ChildSessionDefaults> {
    const row = this.db
      .prepare(
        `SELECT backend, backend_configured, model, model_configured, effort, effort_configured, updated_at
         FROM child_session_defaults
         WHERE singleton = 1`,
      )
      .get() as {
        backend: BackendKind | null;
        backend_configured: number;
        model: string | null;
        model_configured: number;
        effort: EffortLevel | null;
        effort_configured: number;
        updated_at: number;
      } | undefined;
    if (!row) {
      return {
        backend: { configured: false, value: null },
        model: { configured: false, value: null },
        effort: { configured: false, value: null },
        updatedAt: null,
      };
    }
    return {
      backend: { configured: row.backend_configured === 1, value: row.backend },
      model: { configured: row.model_configured === 1, value: row.model },
      effort: { configured: row.effort_configured === 1, value: row.effort },
      updatedAt: asTimestamp(row.updated_at),
    };
  }

  async updateChildSessionDefaults(patch: ChildSessionDefaultsPatch): Promise<void> {
    const hasBackend = Object.hasOwn(patch, "backend");
    const hasModel = Object.hasOwn(patch, "model");
    const hasEffort = Object.hasOwn(patch, "effort");
    if (!hasBackend && !hasModel && !hasEffort) return;
    this.db
      .prepare(
        `INSERT INTO child_session_defaults
           (singleton, backend, backend_configured, model, model_configured, effort, effort_configured, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           backend = CASE WHEN ? = 1 THEN excluded.backend ELSE child_session_defaults.backend END,
           backend_configured = CASE WHEN ? = 1 THEN excluded.backend_configured ELSE child_session_defaults.backend_configured END,
           model = CASE WHEN ? = 1 THEN excluded.model ELSE child_session_defaults.model END,
           model_configured = CASE WHEN ? = 1 THEN excluded.model_configured ELSE child_session_defaults.model_configured END,
           effort = CASE WHEN ? = 1 THEN excluded.effort ELSE child_session_defaults.effort END,
           effort_configured = CASE WHEN ? = 1 THEN excluded.effort_configured ELSE child_session_defaults.effort_configured END,
           updated_at = excluded.updated_at`,
      )
      .run(
        patch.backend?.value ?? null,
        patch.backend?.configured ? 1 : 0,
        patch.model?.value ?? null,
        patch.model?.configured ? 1 : 0,
        patch.effort?.value ?? null,
        patch.effort?.configured ? 1 : 0,
        currentSessionTimestamp(),
        hasBackend ? 1 : 0,
        hasBackend ? 1 : 0,
        hasModel ? 1 : 0,
        hasModel ? 1 : 0,
        hasEffort ? 1 : 0,
        hasEffort ? 1 : 0,
      );
  }

  async compareAndSetChildSessionDefaults(
    expected: ChildSessionDefaults,
    patch: ChildSessionDefaultsPatch,
  ): Promise<boolean> {
    const hasBackend = Object.hasOwn(patch, "backend");
    const hasModel = Object.hasOwn(patch, "model");
    const hasEffort = Object.hasOwn(patch, "effort");
    if (!hasBackend && !hasModel && !hasEffort) return false;

    const result = this.db
      .prepare(
        `INSERT INTO child_session_defaults
           (singleton, backend, backend_configured, model, model_configured, effort, effort_configured, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           backend = CASE WHEN ? = 1 THEN excluded.backend ELSE child_session_defaults.backend END,
           backend_configured = CASE WHEN ? = 1 THEN excluded.backend_configured ELSE child_session_defaults.backend_configured END,
           model = CASE WHEN ? = 1 THEN excluded.model ELSE child_session_defaults.model END,
           model_configured = CASE WHEN ? = 1 THEN excluded.model_configured ELSE child_session_defaults.model_configured END,
           effort = CASE WHEN ? = 1 THEN excluded.effort ELSE child_session_defaults.effort END,
           effort_configured = CASE WHEN ? = 1 THEN excluded.effort_configured ELSE child_session_defaults.effort_configured END,
           updated_at = excluded.updated_at
         WHERE child_session_defaults.backend IS ?
           AND child_session_defaults.backend_configured = ?
           AND child_session_defaults.model IS ?
           AND child_session_defaults.model_configured = ?
           AND child_session_defaults.effort IS ?
           AND child_session_defaults.effort_configured = ?
           AND child_session_defaults.updated_at IS ?`,
      )
      .run(
        patch.backend?.value ?? null,
        patch.backend?.configured ? 1 : 0,
        patch.model?.value ?? null,
        patch.model?.configured ? 1 : 0,
        patch.effort?.value ?? null,
        patch.effort?.configured ? 1 : 0,
        currentSessionTimestamp(),
        hasBackend ? 1 : 0,
        hasBackend ? 1 : 0,
        hasModel ? 1 : 0,
        hasModel ? 1 : 0,
        hasEffort ? 1 : 0,
        hasEffort ? 1 : 0,
        expected.backend.value,
        expected.backend.configured ? 1 : 0,
        expected.model.value,
        expected.model.configured ? 1 : 0,
        expected.effort.value,
        expected.effort.configured ? 1 : 0,
        expected.updatedAt,
      );
    return result.changes === 1;
  }

  async getSessionRuntimeSettings(sessionId: SessionId): Promise<SessionRuntimeSettings | null> {
    const row = this.db.prepare(
      `SELECT session_id, main_model_default, main_effort_default,
              child_backend, child_backend_configured,
              child_model, child_model_configured,
              child_effort, child_effort_configured, updated_at
       FROM session_runtime_settings
       WHERE session_id = ?`,
    ).get(sessionId) as {
      session_id: SessionId;
      main_model_default: string | null;
      main_effort_default: EffortLevel | null;
      child_backend: BackendKind | null;
      child_backend_configured: number;
      child_model: string | null;
      child_model_configured: number;
      child_effort: EffortLevel | null;
      child_effort_configured: number;
      updated_at: number;
    } | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      mainModelDefault: row.main_model_default,
      mainEffortDefault: row.main_effort_default,
      childBackend: followMainOrLocked(row.child_backend_configured, row.child_backend),
      childModel: followMainOrLocked(row.child_model_configured, row.child_model),
      childEffort: followMainOrLocked(row.child_effort_configured, row.child_effort),
      updatedAt: asTimestamp(row.updated_at),
    };
  }

  async updateSessionRuntimeSettings(
    sessionId: SessionId,
    patch: SessionRuntimeSettingsPatch,
  ): Promise<void> {
    if (!hasSessionRuntimeSettingsPatch(patch)) return;
    this.runSessionRuntimeSettingsPatch(sessionId, patch, currentSessionTimestamp());
  }

  async getSessionHeartbeatEnabled(id: SessionId): Promise<boolean> {
    const row = this.db
      .prepare("SELECT heartbeat_enabled FROM sessions WHERE id = ?")
      .get(id) as { heartbeat_enabled: number } | undefined;
    if (!row) return false;
    return row.heartbeat_enabled === 1;
  }

  async updateSessionHeartbeatEnabled(id: SessionId, enabled: boolean): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET heartbeat_enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, updatedAt, id);
  }

  async getSessionWorkspaceLocked(id: SessionId): Promise<boolean> {
    const row = this.db
      .prepare("SELECT workspace_locked FROM sessions WHERE id = ?")
      .get(id) as { workspace_locked: number } | undefined;
    return row?.workspace_locked === 1;
  }

  async updateSessionWorkspaceLocked(id: SessionId, locked: boolean): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET workspace_locked = ?, updated_at = ? WHERE id = ?")
      .run(locked ? 1 : 0, updatedAt, id);
  }

  async listHeartbeatEnabledSessions(): Promise<Session[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM sessions
         WHERE heartbeat_enabled = 1
           AND status != 'deleted'
           AND scope != 'child'
           AND name != 'heartbeat'
         ORDER BY updated_at ASC, name ASC`,
      )
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  async updateSessionBackendSessionId(id: SessionId, backendSessionId: string | null): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare(
        "UPDATE sessions SET backend_session_id = ?, backend_session_updated_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(backendSessionId, backendSessionId ? updatedAt : null, updatedAt, id);
  }

  async updateSessionInactivityTimeout(id: SessionId, seconds: number | null): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET inactivity_timeout_s = ?, updated_at = ? WHERE id = ?")
      .run(seconds, updatedAt, id);
  }

  async updateSessionMaxRuntime(id: SessionId, seconds: number | null): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET max_runtime_s = ?, updated_at = ? WHERE id = ?")
      .run(seconds, updatedAt, id);
  }

  async updateSessionBackend(id: SessionId, backend: string): Promise<void> {
    const updatedAt = currentSessionTimestamp();
    this.db
      .prepare("UPDATE sessions SET backend = ?, updated_at = ? WHERE id = ?")
      .run(backend, updatedAt, id);
  }

  async applySessionRuntimeConfigMutations(
    mutations: readonly SessionRuntimeConfigMutation[],
  ): Promise<{ updated: number }> {
    const updateIdle = this.db.prepare(
      `UPDATE sessions
       SET backend = ?, model = ?, effort = ?, backend_session_id = ?,
           backend_session_updated_at = CASE WHEN ? IS NULL THEN NULL ELSE backend_session_updated_at END,
           updated_at = ?
       WHERE id = ?
         AND backend IS ? AND model IS ? AND effort IS ? AND backend_session_id IS ?
         AND status NOT IN ('busy', 'deleted')`,
    );
    const updateActiveRun = this.db.prepare(
      `UPDATE sessions
       SET backend = ?, model = ?, effort = ?, backend_session_id = ?,
           backend_session_updated_at = CASE WHEN ? IS NULL THEN NULL ELSE backend_session_updated_at END,
           updated_at = ?
       WHERE id = ?
         AND backend IS ? AND model IS ? AND effort IS ? AND backend_session_id IS ?
         AND status = 'busy'
         AND EXISTS (
           SELECT 1 FROM message_runs
           WHERE message_runs.session_id = sessions.id
             AND message_runs.id = ?
             AND message_runs.status = 'running'
         )`,
    );
    const insertAudit = this.db.prepare(
      `INSERT INTO session_runtime_config_audit
       (id, session_id, trigger, before_json, requested_json, after_json, decision, reason,
        catalog_source, catalog_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const apply = this.db.transaction(() => {
      for (const mutation of mutations) {
        const params = [
          mutation.after.backend,
          mutation.after.model,
          mutation.after.effort,
          mutation.after.backendSessionId,
          mutation.after.backendSessionId,
          mutation.audit.createdAt,
          mutation.sessionId,
          mutation.expected.backend,
          mutation.expected.model,
          mutation.expected.effort,
          mutation.expected.backendSessionId,
        ];
        const result = mutation.guard.kind === "idle"
          ? updateIdle.run(...params)
          : updateActiveRun.run(...params, mutation.guard.messageRunId);
        if (result.changes !== 1) throw new RuntimeConfigConflictError(mutation.sessionId);

        if (mutation.settingsPatch && hasSessionRuntimeSettingsPatch(mutation.settingsPatch)) {
          this.runSessionRuntimeSettingsPatch(
            mutation.sessionId,
            mutation.settingsPatch,
            mutation.audit.createdAt,
          );
        }

        insertAudit.run(
          mutation.audit.id,
          mutation.sessionId,
          mutation.audit.trigger,
          JSON.stringify(projectRuntimeConfigAuditSnapshot(mutation.expected)),
          JSON.stringify(projectRuntimeConfigRequested(mutation.audit.requested)),
          JSON.stringify(projectRuntimeConfigAuditSnapshot(mutation.after)),
          mutation.audit.decision,
          mutation.audit.reason,
          mutation.audit.catalogSource,
          mutation.audit.catalogFingerprint,
          mutation.audit.createdAt,
        );
      }
    });
    apply();
    return { updated: mutations.length };
  }

  async getPendingSessionRuntimeConfig(
    sessionId: SessionId,
  ): Promise<SessionRuntimeConfigPending | null> {
    const row = this.db.prepare(
      `SELECT session_id, backend, model, effort, requested_json, catalog_source,
              catalog_fingerprint, created_at, updated_at
       FROM session_runtime_config_pending WHERE session_id = ?`,
    ).get(sessionId) as RuntimeConfigPendingRow | undefined;
    if (!row) return null;
    const session = this.db.prepare(
      "SELECT backend_session_id FROM sessions WHERE id = ?",
    ).get(sessionId) as { backend_session_id: string | null } | undefined;
    if (!session) return null;
    return {
      sessionId: row.session_id as SessionId,
      projected: {
        backend: row.backend,
        model: row.model,
        effort: row.effort,
        backendSessionId: session.backend_session_id,
      },
      createdAt: row.created_at as Timestamp,
      updatedAt: row.updated_at as Timestamp,
    };
  }

  async queueSessionRuntimeConfigMutation(
    mutation: SessionRuntimeConfigMutation,
  ): Promise<void> {
    const insertAudit = this.db.prepare(
      `INSERT INTO session_runtime_config_audit
       (id, session_id, trigger, before_json, requested_json, after_json, decision, reason,
        catalog_source, catalog_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const queue = this.db.transaction(() => {
      const session = this.db.prepare(
        `SELECT backend, model, effort, backend_session_id, status
         FROM sessions WHERE id = ?`,
      ).get(mutation.sessionId) as {
        backend: BackendKind;
        model: string | null;
        effort: EffortLevel | null;
        backend_session_id: string | null;
        status: string;
      } | undefined;
      if (!session || session.status !== "busy") throw new RuntimeConfigConflictError(mutation.sessionId);
      const existing = this.db.prepare(
        `SELECT session_id, backend, model, effort, requested_json, catalog_source,
                catalog_fingerprint, created_at, updated_at
         FROM session_runtime_config_pending WHERE session_id = ?`,
      ).get(mutation.sessionId) as RuntimeConfigPendingRow | undefined;
      const expected = existing
        ? {
            backend: existing.backend,
            model: existing.model,
            effort: existing.effort,
            backendSessionId: session.backend_session_id,
          }
        : {
            backend: session.backend,
            model: session.model,
            effort: session.effort,
            backendSessionId: session.backend_session_id,
          };
      if (
        expected.backend !== mutation.expected.backend
        || expected.model !== mutation.expected.model
        || expected.effort !== mutation.expected.effort
        || expected.backendSessionId !== mutation.expected.backendSessionId
      ) {
        throw new RuntimeConfigConflictError(mutation.sessionId);
      }
      if (existing) {
        this.db.prepare(
          `UPDATE session_runtime_config_pending
           SET backend = ?, model = ?, effort = ?, requested_json = ?, catalog_source = ?,
               catalog_fingerprint = ?, updated_at = ?
           WHERE session_id = ?`,
        ).run(
          mutation.after.backend,
          mutation.after.model,
          mutation.after.effort,
          JSON.stringify(projectRuntimeConfigRequested(mutation.audit.requested)),
          mutation.audit.catalogSource,
          mutation.audit.catalogFingerprint,
          mutation.audit.createdAt,
          mutation.sessionId,
        );
      } else {
        this.db.prepare(
          `INSERT INTO session_runtime_config_pending
           (session_id, backend, model, effort, requested_json, catalog_source,
            catalog_fingerprint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          mutation.sessionId,
          mutation.after.backend,
          mutation.after.model,
          mutation.after.effort,
          JSON.stringify(projectRuntimeConfigRequested(mutation.audit.requested)),
          mutation.audit.catalogSource,
          mutation.audit.catalogFingerprint,
          mutation.audit.createdAt,
          mutation.audit.createdAt,
        );
      }
      insertAudit.run(
        mutation.audit.id,
        mutation.sessionId,
        mutation.audit.trigger,
        JSON.stringify(projectRuntimeConfigAuditSnapshot(mutation.expected)),
        JSON.stringify(projectRuntimeConfigRequested(mutation.audit.requested)),
        JSON.stringify(projectRuntimeConfigAuditSnapshot(mutation.after)),
        mutation.audit.decision,
        mutation.audit.reason,
        mutation.audit.catalogSource,
        mutation.audit.catalogFingerprint,
        mutation.audit.createdAt,
      );
    });
    queue();
  }

  async drainPendingSessionRuntimeConfig(
    sessionId: SessionId,
  ): Promise<DrainPendingSessionRuntimeConfigResult> {
    const drain = this.db.transaction((): DrainPendingSessionRuntimeConfigResult => {
      const pending = this.db.prepare(
        `SELECT session_id, backend, model, effort, requested_json, catalog_source,
                catalog_fingerprint, created_at, updated_at
         FROM session_runtime_config_pending WHERE session_id = ?`,
      ).get(sessionId) as RuntimeConfigPendingRow | undefined;
      if (!pending) return { kind: "none" };
      const session = this.db.prepare(
        `SELECT backend, model, effort, backend_session_id, status FROM sessions WHERE id = ?`,
      ).get(sessionId) as {
        backend: BackendKind;
        model: string | null;
        effort: EffortLevel | null;
        backend_session_id: string | null;
        status: string;
      } | undefined;
      if (!session || session.status === "deleted" || session.backend !== pending.backend) {
        const reason = !session ? "session no longer exists" : session.status === "deleted"
          ? "session was deleted before pending runtime config could apply"
          : "backend changed before pending runtime config could apply";
        insertPendingRuntimeConfigAudit(this.db, {
          id: `cfg_pending_reject_${crypto.randomUUID()}`,
          sessionId,
          before: session
            ? { backend: session.backend, model: session.model, effort: session.effort, backendSessionId: session.backend_session_id }
            : { backend: pending.backend, model: pending.model, effort: pending.effort, backendSessionId: null },
          after: session
            ? { backend: session.backend, model: session.model, effort: session.effort, backendSessionId: session.backend_session_id }
            : { backend: pending.backend, model: pending.model, effort: pending.effort, backendSessionId: null },
          requested: JSON.parse(pending.requested_json) as SessionRuntimeConfigRequested,
          decision: "reject",
          reason,
          catalogSource: pending.catalog_source,
          catalogFingerprint: pending.catalog_fingerprint,
          createdAt: asTimestamp(Date.now()),
        });
        this.db.prepare("DELETE FROM session_runtime_config_pending WHERE session_id = ?").run(sessionId);
        return { kind: "rejected", reason };
      }
      if (session.status === "busy") return { kind: "deferred" };
      const createdAt = asTimestamp(Date.now());
      this.db.prepare(
        `UPDATE sessions SET model = ?, effort = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('busy', 'deleted') AND backend = ?`,
      ).run(pending.model, pending.effort, createdAt, sessionId, pending.backend);
      insertPendingRuntimeConfigAudit(this.db, {
        id: `cfg_pending_apply_${crypto.randomUUID()}`,
        sessionId,
        before: { backend: session.backend, model: session.model, effort: session.effort, backendSessionId: session.backend_session_id },
        after: { backend: pending.backend, model: pending.model, effort: pending.effort, backendSessionId: session.backend_session_id },
        requested: JSON.parse(pending.requested_json) as SessionRuntimeConfigRequested,
        decision: "apply",
        reason: "queued runtime config applied after active run",
        catalogSource: pending.catalog_source,
        catalogFingerprint: pending.catalog_fingerprint,
        createdAt,
      });
      this.db.prepare("DELETE FROM session_runtime_config_pending WHERE session_id = ?").run(sessionId);
      return { kind: "applied" };
    });
    return drain();
  }

  async drainPendingSessionRuntimeConfigs(): Promise<number> {
    const rows = this.db.prepare("SELECT session_id FROM session_runtime_config_pending").all() as Array<{ session_id: string }>;
    let applied = 0;
    for (const row of rows) {
      if ((await this.drainPendingSessionRuntimeConfig(row.session_id as SessionId)).kind === "applied") applied += 1;
    }
    return applied;
  }

  async guardIdleSessionRuntimeConfig(
    sessionId: SessionId,
    expected: SessionRuntimeConfigSnapshot,
  ): Promise<SessionRuntimeConfigSnapshot> {
    const guard = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT backend, model, effort, backend_session_id
         FROM sessions
         WHERE id = ? AND status NOT IN ('busy', 'deleted')
           AND backend IS ? AND model IS ? AND effort IS ? AND backend_session_id IS ?`,
      ).get(sessionId, expected.backend, expected.model, expected.effort, expected.backendSessionId) as {
        backend: BackendKind; model: string | null; effort: EffortLevel | null; backend_session_id: string | null;
      } | undefined;
      if (!row) throw new RuntimeConfigConflictError(sessionId);
      return { backend: row.backend, model: row.model, effort: row.effort, backendSessionId: row.backend_session_id };
    });
    return guard();
  }

  async listSessionRuntimeConfigAudit(sessionId: SessionId): Promise<SessionRuntimeConfigAudit[]> {
    const rows = this.db.prepare(
      `SELECT id, session_id, trigger, before_json, requested_json, after_json, decision, reason,
              catalog_source, catalog_fingerprint, created_at
       FROM session_runtime_config_audit
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC`,
    ).all(sessionId) as RuntimeConfigAuditRow[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id as SessionId,
      trigger: row.trigger,
      before: projectRuntimeConfigAuditSnapshot(
        JSON.parse(row.before_json) as SessionRuntimeConfigSnapshot,
      ),
      requested: projectRuntimeConfigRequested(
        JSON.parse(row.requested_json) as SessionRuntimeConfigRequested,
      ),
      after: projectRuntimeConfigAuditSnapshot(
        JSON.parse(row.after_json) as SessionRuntimeConfigSnapshot,
      ),
      decision: row.decision,
      reason: row.reason,
      catalogSource: row.catalog_source,
      catalogFingerprint: row.catalog_fingerprint,
      createdAt: row.created_at as Timestamp,
    }));
  }

  async getActiveBranch(sessionId: SessionId): Promise<SessionBranchRecord> {
    const state = this.db
      .prepare("SELECT active_branch_name FROM session_branch_state WHERE session_id = ?")
      .get(sessionId) as { active_branch_name: string } | undefined;
    const activeName = state?.active_branch_name ?? MAIN_BRANCH_NAME;
    const active = await this.findSessionBranch(sessionId, activeName);
    if (active) return active;

    const main = await this.findSessionBranch(sessionId, MAIN_BRANCH_NAME);
    if (!main) throw new Error(`session not found: ${sessionId}`);
    await this.setActiveBranch(sessionId, MAIN_BRANCH_NAME, currentSessionTimestamp());
    return main;
  }

  async listSessionBranches(sessionId: SessionId): Promise<SessionBranchRecord[]> {
    const main = await this.findSessionBranch(sessionId, MAIN_BRANCH_NAME);
    if (!main) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM session_branches
         WHERE session_id = ? AND name != ?
         ORDER BY created_at ASC, name ASC`,
      )
      .all(sessionId, MAIN_BRANCH_NAME) as SessionBranchRow[];
    return [main, ...rows.map(mapSessionBranchRow)];
  }

  async findSessionBranch(sessionId: SessionId, name: string): Promise<SessionBranchRecord | null> {
    const normalized = validateBranchName(name);
    if (normalized === MAIN_BRANCH_NAME) {
      const session = await this.findSessionById(sessionId);
      return session ? mainBranchFromSession(session) : null;
    }
    const row = this.db
      .prepare("SELECT * FROM session_branches WHERE session_id = ? AND name = ?")
      .get(sessionId, normalized) as SessionBranchRow | undefined;
    return row ? mapSessionBranchRow(row) : null;
  }

  async createSessionBranch(input: NewSessionBranchInput): Promise<SessionBranchRecord> {
    const name = validateBranchName(input.name);
    if (name === MAIN_BRANCH_NAME) {
      throw new Error("main branch already exists");
    }
    const createdAt = sessionTimestamp(input.createdAt, "session_branches.createdAt");
    this.db
      .prepare(
        `INSERT INTO session_branches
         (session_id, name, backend_session_id, source_branch_name, source_backend_session_id,
          fork_pending, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        name,
        input.backendSessionId ?? null,
        input.sourceBranchName ?? null,
        input.sourceBackendSessionId ?? null,
        input.forkPending ? 1 : 0,
        createdAt,
        createdAt,
      );
    const branch = await this.findSessionBranch(input.sessionId, name);
    if (!branch) throw new Error(`createSessionBranch failed: row not found after insert: ${name}`);
    return branch;
  }

  async setActiveBranch(sessionId: SessionId, branchName: string, now: Timestamp): Promise<void> {
    const name = validateBranchName(branchName);
    const branch = await this.findSessionBranch(sessionId, name);
    if (!branch) throw new Error(`branch not found: ${name}`);
    const updatedAt = sessionTimestamp(now, "session_branch_state.updatedAt");
    this.db
      .prepare(
        `INSERT INTO session_branch_state (session_id, active_branch_name, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           active_branch_name = excluded.active_branch_name,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, name, updatedAt);
  }

  async updateSessionBranchBackendSessionId(
    sessionId: SessionId,
    branchName: string,
    backendSessionId: string,
    now: Timestamp,
  ): Promise<void> {
    const name = validateBranchName(branchName);
    const updatedAt = sessionTimestamp(now, "session_branches.updatedAt");
    if (name === MAIN_BRANCH_NAME) {
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE sessions SET backend_session_id = ?, backend_session_updated_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(backendSessionId, updatedAt, updatedAt, sessionId);
        this.upsertMainBranchMirror(sessionId, backendSessionId, updatedAt);
      })();
      return;
    }
    const result = this.db
      .prepare(
        `UPDATE session_branches
         SET backend_session_id = ?, fork_pending = 0, updated_at = ?
         WHERE session_id = ? AND name = ?`,
      )
      .run(backendSessionId, updatedAt, sessionId, name);
    if (result.changes === 0) throw new Error(`branch not found: ${name}`);
  }

  async clearSessionBranchBackendSessionId(
    sessionId: SessionId,
    branchName: string,
    now: Timestamp,
  ): Promise<void> {
    const name = validateBranchName(branchName);
    const updatedAt = sessionTimestamp(now, "session_branches.updatedAt");
    if (name === MAIN_BRANCH_NAME) {
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE sessions SET backend_session_id = NULL, backend_session_updated_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(updatedAt, sessionId);
        this.upsertMainBranchMirror(sessionId, null, updatedAt);
      })();
      return;
    }
    const result = this.db
      .prepare(
        `UPDATE session_branches
         SET backend_session_id = NULL,
             source_backend_session_id = NULL,
             fork_pending = 0,
             updated_at = ?
         WHERE session_id = ? AND name = ?`,
      )
      .run(updatedAt, sessionId, name);
    if (result.changes === 0) throw new Error(`branch not found: ${name}`);
  }

  private upsertMainBranchMirror(
    sessionId: SessionId,
    backendSessionId: string | null,
    updatedAt: Timestamp,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_branches
         (session_id, name, backend_session_id, source_branch_name, source_backend_session_id,
          fork_pending, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)
         ON CONFLICT(session_id, name) DO UPDATE SET
           backend_session_id = excluded.backend_session_id,
           source_branch_name = NULL,
           source_backend_session_id = NULL,
           fork_pending = 0,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, MAIN_BRANCH_NAME, backendSessionId, updatedAt, updatedAt);
  }

  async findNonConformingAvatars(): Promise<Array<{ name: string; avatar: string }>> {
    // Read-only diagnostic for FP per session-meta v1.0 contract §1 Migration.
    // We deliberately do NOT push the format check into SQL — SQLite has no
    // standard regex and the rule (`len==27 AND ^[A-Za-z0-9]+$`) is clearer
    // expressed via the same JS validator that gates writes. Cheap because
    // user-scope active-session count is small.
    const rows = this.db
      .prepare(
        `SELECT name, avatar FROM sessions
         WHERE status != 'deleted' AND scope != 'child' AND avatar != ''`,
      )
      .all() as Array<{ name: string; avatar: string }>;
    return rows.filter((r) => !isConformingAvatar(r.avatar));
  }

  async countActiveSessions(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE status != 'deleted'")
      .get() as { c: number };
    return row.c;
  }

  async countBusySessions(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'busy'")
      .get() as { c: number };
    return row.c;
  }

  async countBusySessionsByBackend(backend: BackendKind): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE backend = ? AND status = 'busy'")
      .get(backend) as { c: number };
    return row.c;
  }

  async clearBackendSessionIdsForBackend(
    backend: BackendKind,
    now: Timestamp,
  ): Promise<{ sessions: number; branches: number }> {
    const updatedAt = sessionTimestamp(now, "sessions.updatedAt");
    let sessions = 0;
    let branches = 0;
    this.db.transaction(() => {
      sessions = this.db
        .prepare(
          `UPDATE sessions
           SET backend_session_id = NULL, backend_session_updated_at = NULL, updated_at = ?
           WHERE backend = ? AND status != 'deleted' AND backend_session_id IS NOT NULL`,
        )
        .run(updatedAt, backend).changes;
      branches = this.db
        .prepare(
          `UPDATE session_branches
           SET backend_session_id = NULL,
               source_backend_session_id = NULL,
               fork_pending = 0,
               updated_at = ?
           WHERE session_id IN (SELECT id FROM sessions WHERE backend = ? AND status != 'deleted')
             AND (backend_session_id IS NOT NULL
                  OR source_backend_session_id IS NOT NULL
                  OR fork_pending != 0)`,
        )
        .run(updatedAt, backend).changes;
    })();
    return { sessions, branches };
  }

  async findBackendAccountSwitch(clientRequestId: string): Promise<BackendAccountSwitchRecord | null> {
    const row = this.db
      .prepare(
        `SELECT client_request_id, backend, caller, from_profile, to_profile,
                switched_at, cleared_sessions, cleared_branches, created_at
         FROM backend_account_switches WHERE client_request_id = ?`,
      )
      .get(clientRequestId) as
      | {
          client_request_id: string;
          backend: BackendKind;
          caller: string;
          from_profile: string | null;
          to_profile: string | null;
          switched_at: string | null;
          cleared_sessions: number;
          cleared_branches: number;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      clientRequestId: row.client_request_id,
      backend: row.backend,
      caller: row.caller,
      fromProfile: row.from_profile,
      toProfile: row.to_profile,
      switchedAt: row.switched_at,
      clearedSessions: row.cleared_sessions,
      clearedBranches: row.cleared_branches,
      createdAt: asTimestamp(row.created_at),
    };
  }

  async recordBackendAccountSwitch(input: RecordBackendAccountSwitchInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO backend_account_switches
         (client_request_id, backend, caller, from_profile, to_profile,
          switched_at, cleared_sessions, cleared_branches, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.clientRequestId,
        input.backend,
        input.caller,
        input.fromProfile ?? null,
        input.toProfile ?? null,
        input.switchedAt ?? null,
        input.clearedSessions,
        input.clearedBranches,
        sessionTimestamp(input.createdAt, "backend_account_switches.createdAt"),
      );
  }

  async acquireBackendMaintenanceLease(
    input: AcquireBackendMaintenanceLeaseInput,
  ): Promise<AcquireBackendMaintenanceLeaseResult> {
    const acquiredAt = sessionTimestamp(input.acquiredAt, "backend_maintenance_leases.acquiredAt");
    const tx = this.db.transaction((): AcquireBackendMaintenanceLeaseResult => {
      const existing = this.readBackendMaintenanceLease(input.backend);
      if (existing) {
        const duplicate = this.db
          .prepare(
            `SELECT token_hash
             FROM backend_maintenance_leases
             WHERE backend = ?`,
          )
          .get(input.backend) as { token_hash: string };
        if (existing.owner === input.owner && duplicate.token_hash === input.tokenHash) {
          this.recordBackendMaintenanceLeaseEvent({
            backend: input.backend,
            action: "acquire",
            outcome: "duplicate",
            owner: input.owner,
            requestId: input.requestId,
            leaseOwner: existing.owner,
            runningMessageRunCount: 0,
            createdAt: acquiredAt,
          });
          return { kind: "acquired", duplicate: true, lease: existing };
        }
        this.recordBackendMaintenanceLeaseEvent({
          backend: input.backend,
          action: "acquire",
          outcome: "held",
          owner: input.owner,
          requestId: input.requestId,
          leaseOwner: existing.owner,
          runningMessageRunCount: 0,
          createdAt: acquiredAt,
        });
        return { kind: "held", lease: existing };
      }

      const runningMessageRunCount = this.countRunningMessageRunsByBackend(input.backend);
      if (runningMessageRunCount > 0) {
        this.recordBackendMaintenanceLeaseEvent({
          backend: input.backend,
          action: "acquire",
          outcome: "running_message_runs",
          owner: input.owner,
          requestId: input.requestId,
          leaseOwner: null,
          runningMessageRunCount,
          createdAt: acquiredAt,
        });
        return { kind: "running_message_runs", backend: input.backend, runningMessageRunCount };
      }

      this.db
        .prepare(
          `INSERT INTO backend_maintenance_leases
           (backend, owner, token_hash, request_id, acquired_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.backend, input.owner, input.tokenHash, input.requestId, acquiredAt);
      const lease: BackendMaintenanceLease = {
        backend: input.backend,
        owner: input.owner,
        requestId: input.requestId,
        acquiredAt,
      };
      this.recordBackendMaintenanceLeaseEvent({
        backend: input.backend,
        action: "acquire",
        outcome: "acquired",
        owner: input.owner,
        requestId: input.requestId,
        leaseOwner: input.owner,
        runningMessageRunCount: 0,
        createdAt: acquiredAt,
      });
      return { kind: "acquired", duplicate: false, lease };
    });
    return tx.immediate();
  }

  async releaseBackendMaintenanceLease(
    input: ReleaseBackendMaintenanceLeaseInput,
  ): Promise<ReleaseBackendMaintenanceLeaseResult> {
    const releasedAt = sessionTimestamp(input.releasedAt, "backend_maintenance_leases.releasedAt");
    const tx = this.db.transaction((): ReleaseBackendMaintenanceLeaseResult => {
      const existing = this.readBackendMaintenanceLease(input.backend);
      if (!existing) {
        this.recordBackendMaintenanceLeaseEvent({
          backend: input.backend,
          action: "release",
          outcome: "not_held",
          owner: input.owner,
          requestId: input.requestId,
          leaseOwner: null,
          runningMessageRunCount: 0,
          createdAt: releasedAt,
        });
        return { kind: "released", duplicate: true };
      }
      const row = this.db
        .prepare("SELECT token_hash FROM backend_maintenance_leases WHERE backend = ?")
        .get(input.backend) as { token_hash: string };
      if (existing.owner !== input.owner) {
        this.recordBackendMaintenanceLeaseEvent({
          backend: input.backend,
          action: "release",
          outcome: "owner_mismatch",
          owner: input.owner,
          requestId: input.requestId,
          leaseOwner: existing.owner,
          runningMessageRunCount: 0,
          createdAt: releasedAt,
        });
        return { kind: "owner_mismatch", lease: existing };
      }
      if (row.token_hash !== input.tokenHash) {
        this.recordBackendMaintenanceLeaseEvent({
          backend: input.backend,
          action: "release",
          outcome: "token_mismatch",
          owner: input.owner,
          requestId: input.requestId,
          leaseOwner: existing.owner,
          runningMessageRunCount: 0,
          createdAt: releasedAt,
        });
        return { kind: "token_mismatch", lease: existing };
      }
      this.db.prepare("DELETE FROM backend_maintenance_leases WHERE backend = ?").run(input.backend);
      this.recordBackendMaintenanceLeaseEvent({
        backend: input.backend,
        action: "release",
        outcome: "released",
        owner: input.owner,
        requestId: input.requestId,
        leaseOwner: existing.owner,
        runningMessageRunCount: 0,
        createdAt: releasedAt,
      });
      return { kind: "released", duplicate: false, lease: existing };
    });
    return tx.immediate();
  }

  async getBackendMaintenanceLease(backend: BackendKind): Promise<BackendMaintenanceLease | null> {
    const lease = this.readBackendMaintenanceLease(backend);
    return lease ? { ...lease } : null;
  }

  async listBackendMaintenanceLeaseEvents(
    backend: BackendKind,
    limit = 100,
  ): Promise<BackendMaintenanceLeaseEvent[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 100;
    const rows = this.db
      .prepare(
        `SELECT id, backend, action, outcome, owner, request_id, lease_owner,
                running_message_run_count, created_at
         FROM backend_maintenance_lease_events
         WHERE backend = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(backend, safeLimit) as Array<{
      id: number;
      backend: BackendKind;
      action: BackendMaintenanceLeaseEvent["action"];
      outcome: BackendMaintenanceLeaseEvent["outcome"];
      owner: string;
      request_id: string;
      lease_owner: string | null;
      running_message_run_count: number;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      backend: row.backend,
      action: row.action,
      outcome: row.outcome,
      owner: row.owner,
      requestId: row.request_id,
      leaseOwner: row.lease_owner,
      runningMessageRunCount: row.running_message_run_count,
      createdAt: asTimestamp(row.created_at),
    }));
  }

  private readBackendMaintenanceLease(backend: BackendKind): BackendMaintenanceLease | null {
    const row = this.db
      .prepare(
        `SELECT backend, owner, request_id, acquired_at
         FROM backend_maintenance_leases
         WHERE backend = ?`,
      )
      .get(backend) as
      | { backend: BackendKind; owner: string; request_id: string; acquired_at: number }
      | undefined;
    return row
      ? {
          backend: row.backend,
          owner: row.owner,
          requestId: row.request_id,
          acquiredAt: asTimestamp(row.acquired_at),
        }
      : null;
  }

  private countRunningMessageRunsByBackend(backend: BackendKind): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM message_runs AS r
         JOIN sessions AS s ON s.id = r.session_id
         WHERE r.status = 'running' AND s.backend = ?`,
      )
      .get(backend) as { c: number };
    return row.c;
  }

  private recordBackendMaintenanceLeaseEvent(input: Omit<BackendMaintenanceLeaseEvent, "id">): void {
    this.db
      .prepare(
        `INSERT INTO backend_maintenance_lease_events
         (backend, action, outcome, owner, request_id, lease_owner,
          running_message_run_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.backend,
        input.action,
        input.outcome,
        input.owner,
        input.requestId,
        input.leaseOwner,
        input.runningMessageRunCount,
        input.createdAt,
      );
  }

  async resetBusySessionsOnBoot(now: Timestamp): Promise<number> {
    const updatedAt = sessionTimestamp(now, "sessions.updatedAt");
    // Busy sessions with a backend_session_id can be picked up on the next
    // prompt via `claude --resume`, so flip them back to idle — the dead
    // backend child will be re-spawned on demand. Busy sessions without a
    // backend_session_id never got that far (backend crashed before emitting
    // a session id), so they still need manual recovery via /restart.
    const tx = this.db.transaction(() => {
      const resumable = this.db
        .prepare(
          "UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'busy' AND backend_session_id IS NOT NULL",
        )
        .run(updatedAt);
      const broken = this.db
        .prepare(
          "UPDATE sessions SET status = 'error', updated_at = ? WHERE status = 'busy' AND backend_session_id IS NULL",
        )
        .run(updatedAt);
      // `waiting` children held an in-memory TopicBus subscription that is
      // gone after restart. Per decisions.md D7 first version, all waiters
      // become terminal — any gating event that fires post-restart is lost.
      const stranded = this.db
        .prepare(
          "UPDATE sessions SET status = 'error', updated_at = ? WHERE status = 'waiting'",
        )
        .run(updatedAt);
      return resumable.changes + broken.changes + stranded.changes;
    });
    return tx();
  }

  async createBinding(groupId: LarkGroupId, sessionId: SessionId, now: Timestamp): Promise<Binding> {
    this.db
      .prepare("INSERT INTO bindings (group_id, session_id, created_at) VALUES (?, ?, ?)")
      .run(groupId, sessionId, now);
    return { groupId, sessionId, createdAt: now };
  }

  async findByGroup(groupId: LarkGroupId): Promise<Binding | null> {
    const row = this.db.prepare("SELECT * FROM bindings WHERE group_id = ?").get(groupId) as
      | { group_id: string; session_id: string; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      groupId: row.group_id as LarkGroupId,
      sessionId: row.session_id as SessionId,
      createdAt: row.created_at as Timestamp,
    };
  }

  async findBySession(sessionId: SessionId): Promise<Binding | null> {
    const row = this.db.prepare("SELECT * FROM bindings WHERE session_id = ?").get(sessionId) as
      | { group_id: string; session_id: string; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      groupId: row.group_id as LarkGroupId,
      sessionId: row.session_id as SessionId,
      createdAt: row.created_at as Timestamp,
    };
  }

  async deleteBinding(groupId: LarkGroupId): Promise<void> {
    this.db.prepare("DELETE FROM bindings WHERE group_id = ?").run(groupId);
  }

  async createSessionWithBinding(
    input: NewSessionInput,
    groupId: LarkGroupId
  ): Promise<{ session: Session; binding: Binding }> {
    validateSessionMetaForWrite(input);
    const createdAt = sessionTimestamp(input.createdAt, "sessions.createdAt");
    // FP v1.0 contract §4 chat_name option (a): no new chat_name writers.
    // chatNamePrefix lives only in-memory at the lifecycle layer (used to
    // build the Feishu group name). Existing rows untouched (no UPDATE).
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions
           (id, name, alias, avatar, category, scope, backend, model, effort, thinking, workdir, backend_session_id, purpose, status, affiliated_to, parent_id, depth, inactivity_timeout_s, max_runtime_s, heartbeat_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'initializing', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.name,
          input.alias ?? "",
          input.avatar ?? "",
          input.category ?? "",
          input.scope,
          input.backend,
          input.model ?? null,
          input.effort ?? null,
          input.thinking ? 1 : 0,
          input.workdir,
          input.purpose,
          input.affiliatedTo ?? null,
          input.parentId ?? null,
          input.depth ?? 0,
          input.inactivityTimeoutS ?? null,
          input.maxRuntimeS ?? null,
          heartbeatEnabledByDefault(input),
          createdAt,
          createdAt
        );
      if (input.scope !== "child") {
        this.insertDefaultSessionRuntimeSettings(input.id, input.backend, createdAt);
      }
      this.db
        .prepare("INSERT INTO bindings (group_id, session_id, created_at) VALUES (?, ?, ?)")
        .run(groupId, input.id, createdAt);
    });
    tx();
    const session = await this.findSessionById(input.id);
    if (!session) throw new Error("createSessionWithBinding lost session after commit");
    const binding = await this.findByGroup(groupId);
    if (!binding) throw new Error("createSessionWithBinding lost binding after commit");
    return { session, binding };
  }

  private insertDefaultSessionRuntimeSettings(
    sessionId: SessionId,
    backend: BackendKind,
    updatedAt: Timestamp,
  ): void {
    const defaults = CANONICAL_MAIN_SESSION_DEFAULTS[backend];
    this.db.prepare(
      `INSERT OR IGNORE INTO session_runtime_settings (
         session_id, main_model_default, main_effort_default,
         child_backend, child_backend_configured,
         child_model, child_model_configured,
         child_effort, child_effort_configured, updated_at
       ) VALUES (?, ?, ?, NULL, 0, NULL, 0, NULL, 0, ?)`,
    ).run(
      sessionId,
      defaults.mainModelDefault,
      defaults.mainEffortDefault,
      updatedAt,
    );
  }

  private runSessionRuntimeSettingsPatch(
    sessionId: SessionId,
    patch: SessionRuntimeSettingsPatch,
    updatedAt: Timestamp,
  ): void {
    const hasMainModel = Object.hasOwn(patch, "mainModelDefault");
    const hasMainEffort = Object.hasOwn(patch, "mainEffortDefault");
    const hasChildBackend = Object.hasOwn(patch, "childBackend");
    const hasChildModel = Object.hasOwn(patch, "childModel");
    const hasChildEffort = Object.hasOwn(patch, "childEffort");
    this.db.prepare(
      `INSERT INTO session_runtime_settings (
         session_id, main_model_default, main_effort_default,
         child_backend, child_backend_configured,
         child_model, child_model_configured,
         child_effort, child_effort_configured, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         main_model_default = CASE WHEN ? = 1 THEN excluded.main_model_default ELSE session_runtime_settings.main_model_default END,
         main_effort_default = CASE WHEN ? = 1 THEN excluded.main_effort_default ELSE session_runtime_settings.main_effort_default END,
         child_backend = CASE WHEN ? = 1 THEN excluded.child_backend ELSE session_runtime_settings.child_backend END,
         child_backend_configured = CASE WHEN ? = 1 THEN excluded.child_backend_configured ELSE session_runtime_settings.child_backend_configured END,
         child_model = CASE WHEN ? = 1 THEN excluded.child_model ELSE session_runtime_settings.child_model END,
         child_model_configured = CASE WHEN ? = 1 THEN excluded.child_model_configured ELSE session_runtime_settings.child_model_configured END,
         child_effort = CASE WHEN ? = 1 THEN excluded.child_effort ELSE session_runtime_settings.child_effort END,
         child_effort_configured = CASE WHEN ? = 1 THEN excluded.child_effort_configured ELSE session_runtime_settings.child_effort_configured END,
         updated_at = excluded.updated_at`,
    ).run(
      sessionId,
      patch.mainModelDefault ?? null,
      patch.mainEffortDefault ?? null,
      patch.childBackend?.value ?? null,
      patch.childBackend?.configured ? 1 : 0,
      patch.childModel?.value ?? null,
      patch.childModel?.configured ? 1 : 0,
      patch.childEffort?.value ?? null,
      patch.childEffort?.configured ? 1 : 0,
      updatedAt,
      hasMainModel ? 1 : 0,
      hasMainEffort ? 1 : 0,
      hasChildBackend ? 1 : 0,
      hasChildBackend ? 1 : 0,
      hasChildModel ? 1 : 0,
      hasChildModel ? 1 : 0,
      hasChildEffort ? 1 : 0,
      hasChildEffort ? 1 : 0,
    );
  }

  async deleteSessionAndBinding(sessionId: SessionId): Promise<void> {
    // Single transaction: unbind, delete parent, cascade to non-terminal
    // children. decisions.md D11 — we do the cascade in application code
    // (not ON DELETE CASCADE) so the action is logged and auditable.
    // Children in terminal states (deleted / error) are left alone so the
    // error row remains visible for the retention TTL.
    const now = currentSessionTimestamp();
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM bindings WHERE session_id = ?").run(sessionId);
      this.db
        .prepare("UPDATE sessions SET status = 'deleted', updated_at = ? WHERE id = ?")
        .run(now, sessionId);
      this.db
        .prepare(
          `UPDATE sessions SET status = 'deleted', updated_at = ?
           WHERE parent_id = ? AND scope = 'child' AND status NOT IN ('deleted', 'error')`,
        )
        .run(now, sessionId);
    });
    tx();
  }

  async recordAttachment(input: NewAttachmentInput): Promise<AttachmentRef> {
    const id = "att_" + Math.random().toString(36).slice(2, 10);
    this.db
      .prepare(
        `INSERT INTO attachments
         (id, session_id, kind, local_path, original_name, mime_type, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.kind,
        input.localPath,
        input.originalName,
        input.mimeType ?? null,
        input.uploadedAt
      );
    return { id, ...input };
  }

  async listSessionAttachments(sessionId: SessionId): Promise<AttachmentRef[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM attachments WHERE session_id = ? ORDER BY uploaded_at DESC"
      )
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      kind: string;
      local_path: string;
      original_name: string;
      mime_type: string | null;
      uploaded_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id as SessionId,
      kind: r.kind as "image" | "file",
      localPath: r.local_path as AbsolutePath,
      originalName: r.original_name,
      ...(r.mime_type !== null ? { mimeType: r.mime_type } : {}),
      uploadedAt: r.uploaded_at as Timestamp,
    }));
  }

  async admitMessageRun(input: MessageRunAdmissionInput): Promise<MessageRunAdmissionResult> {
    const updatedAt = sessionTimestamp(input.startedAt, "sessions.updatedAt");
    const tx = this.db.transaction((): MessageRunAdmissionResult => {
      const session = this.db
        .prepare(
          `SELECT backend, model, effort, backend_session_id, status
           FROM sessions
           WHERE id = ?`,
        )
        .get(input.sessionId) as {
        backend: BackendKind;
        model: string | null;
        effort: EffortLevel | null;
        backend_session_id: string | null;
        status: SessionStatus;
      } | undefined;
      if (!session) return { kind: "not_admittable", status: null };

      const allowedInitializing = input.allowInitializing === true;
      const isAdmittable = session.status === "idle"
        || (allowedInitializing && session.status === "initializing");
      if (!isAdmittable) {
        const running = this.db
          .prepare(
            `SELECT id FROM message_runs
             WHERE session_id = ? AND status = 'running'
             ORDER BY started_at DESC
             LIMIT 1`,
          )
          .get(input.sessionId) as { id: string } | undefined;
        return running
          ? { kind: "busy", currentRunId: running.id as MessageRunId }
          : { kind: "not_admittable", status: session.status };
      }

      const lease = this.readBackendMaintenanceLease(session.backend);
      if (lease) return { kind: "maintenance", backend: session.backend, lease };

      const running = this.db
        .prepare(
          `SELECT id FROM message_runs
           WHERE session_id = ? AND status = 'running'
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .get(input.sessionId) as { id: string } | undefined;
      if (running) return { kind: "busy", currentRunId: running.id as MessageRunId };

      const statusGuard = allowedInitializing
        ? "status IN ('idle', 'initializing')"
        : "status = 'idle'";
      const updated = this.db
        .prepare(
          `UPDATE sessions
           SET status = 'busy', updated_at = ?
           WHERE id = ? AND ${statusGuard}`,
        )
        .run(updatedAt, input.sessionId);
      if (updated.changes !== 1) {
        const current = this.db
          .prepare("SELECT status FROM sessions WHERE id = ?")
          .get(input.sessionId) as { status: SessionStatus } | undefined;
        const currentRun = this.db
          .prepare(
            `SELECT id FROM message_runs
             WHERE session_id = ? AND status = 'running'
             ORDER BY started_at DESC
             LIMIT 1`,
          )
          .get(input.sessionId) as { id: string } | undefined;
        return currentRun
          ? { kind: "busy", currentRunId: currentRun.id as MessageRunId }
          : { kind: "not_admittable", status: current?.status ?? null };
      }

      this.insertMessageRun(input);
      return {
        kind: "admitted",
        backend: session.backend,
        runtimeConfig: {
          backend: session.backend,
          model: session.model,
          effort: session.effort,
          backendSessionId: session.backend_session_id,
        },
        previousStatus: session.status as "idle" | "initializing",
        messageRunId: input.id,
      };
    });
    return tx.immediate();
  }

  async startMessageRun(input: NewMessageRunInput): Promise<MessageRunId> {
    this.insertMessageRun(input);
    return input.id;
  }

  private insertMessageRun(input: NewMessageRunInput): void {
    const columns = [
      "id",
      "session_id",
      "group_id",
      "prompt",
      "card_id",
      "started_at",
      "finished_at",
      "status",
      "final_message",
      "error_message",
    ];
    const values: unknown[] = [
      input.id,
      input.sessionId,
      input.groupId,
      input.prompt,
      null,
      input.startedAt,
      null,
      "running",
      null,
      null,
    ];
    if (this.hasSenderIdColumn()) {
      columns.push("sender_id");
      values.push(input.senderId ?? null);
    }
    if (this.hasBranchNameColumn()) {
      columns.push("branch_name");
      values.push(input.branchName ?? MAIN_BRANCH_NAME);
    }
    const placeholders = columns.map(() => "?").join(", ");
    this.db
      .prepare(`INSERT INTO message_runs (${columns.join(", ")}) VALUES (${placeholders})`)
      .run(...values);
  }

  async finishMessageRun(
    id: MessageRunId,
    status: RunStatus,
    finalMessage?: string,
    error?: string,
    streamLogJson?: string,
  ): Promise<void> {
    // stream_log column is added by optional migration 016. When that
    // migration is degraded we fall back to the legacy 4-column UPDATE so
    // pre-migration databases keep working.
    if (this.hasStreamLogColumn()) {
      this.db
        .prepare(
          `UPDATE message_runs
           SET status = ?, finished_at = ?, final_message = ?, error_message = ?, stream_log = ?
           WHERE id = ?`,
        )
        .run(
          status,
          Date.now(),
          finalMessage ?? null,
          error ?? null,
          streamLogJson ?? null,
          id,
        );
      return;
    }
    this.db
      .prepare(
        `UPDATE message_runs
         SET status = ?, finished_at = ?, final_message = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(status, Date.now(), finalMessage ?? null, error ?? null, id);
  }

  private streamLogColumnCache: boolean | undefined;
  private hasStreamLogColumn(): boolean {
    if (this.streamLogColumnCache !== undefined) return this.streamLogColumnCache;
    const rows = this.db
      .prepare("PRAGMA table_info(message_runs)")
      .all() as Array<{ name: string }>;
    this.streamLogColumnCache = rows.some((r) => r.name === "stream_log");
    return this.streamLogColumnCache;
  }

  private senderIdColumnCache: boolean | undefined;
  private hasSenderIdColumn(): boolean {
    if (this.senderIdColumnCache !== undefined) return this.senderIdColumnCache;
    const rows = this.db
      .prepare("PRAGMA table_info(message_runs)")
      .all() as Array<{ name: string }>;
    this.senderIdColumnCache = rows.some((r) => r.name === "sender_id");
    return this.senderIdColumnCache;
  }

  private branchNameColumnCache: boolean | undefined;
  private hasBranchNameColumn(): boolean {
    if (this.branchNameColumnCache !== undefined) return this.branchNameColumnCache;
    const rows = this.db
      .prepare("PRAGMA table_info(message_runs)")
      .all() as Array<{ name: string }>;
    this.branchNameColumnCache = rows.some((r) => r.name === "branch_name");
    return this.branchNameColumnCache;
  }

  async setMessageRunCardId(id: MessageRunId, cardId: CardId): Promise<void> {
    this.db.prepare("UPDATE message_runs SET card_id = ? WHERE id = ?").run(cardId, id);
  }

  async findRunningMessageRunBySession(sessionId: SessionId): Promise<MessageRun | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM message_runs WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1"
      )
      .get(sessionId) as
      | {
          id: string;
          session_id: string;
          group_id: string;
          prompt: string;
          branch_name?: string;
          card_id: string | null;
          started_at: number;
          finished_at: number | null;
          status: string;
          final_message: string | null;
          error_message: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id as MessageRunId,
      sessionId: row.session_id as SessionId,
      groupId: row.group_id as LarkGroupId,
      prompt: row.prompt,
      branchName: row.branch_name ?? MAIN_BRANCH_NAME,
      cardId: row.card_id as CardId | null,
      startedAt: row.started_at as Timestamp,
      finishedAt: row.finished_at as Timestamp | null,
      status: row.status as RunStatus,
      finalMessage: row.final_message,
      errorMessage: row.error_message,
    };
  }

  async findLatestMessageRunBySession(sessionId: SessionId): Promise<MessageRun | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM message_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1"
      )
      .get(sessionId) as
      | {
          id: string;
          session_id: string;
          group_id: string;
          prompt: string;
          branch_name?: string;
          card_id: string | null;
          started_at: number;
          finished_at: number | null;
          status: string;
          final_message: string | null;
          error_message: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id as MessageRunId,
      sessionId: row.session_id as SessionId,
      groupId: row.group_id as LarkGroupId,
      prompt: row.prompt,
      branchName: row.branch_name ?? MAIN_BRANCH_NAME,
      cardId: row.card_id as CardId | null,
      startedAt: row.started_at as Timestamp,
      finishedAt: row.finished_at as Timestamp | null,
      status: row.status as RunStatus,
      finalMessage: row.final_message,
      errorMessage: row.error_message,
    };
  }

  async listRecentMessageRuns(sessionId: SessionId, limit: number, branchName?: string): Promise<MessageRun[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    if (safeLimit === 0) return [];
    const branchFilter = branchName && this.hasBranchNameColumn() ? " AND branch_name = ?" : "";
    const params: unknown[] = [sessionId];
    if (branchFilter) params.push(branchName);
    params.push(safeLimit);
    const rows = this.db
      .prepare(
        `SELECT * FROM message_runs
         WHERE session_id = ?${branchFilter}
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
        id: string;
        session_id: string;
        group_id: string;
        prompt: string;
        branch_name?: string;
        card_id: string | null;
        started_at: number;
        finished_at: number | null;
        status: string;
        final_message: string | null;
        error_message: string | null;
      }>;
    return rows.map((row) => ({
      id: row.id as MessageRunId,
      sessionId: row.session_id as SessionId,
      groupId: row.group_id as LarkGroupId,
      prompt: row.prompt,
      branchName: row.branch_name ?? MAIN_BRANCH_NAME,
      cardId: row.card_id as CardId | null,
      startedAt: row.started_at as Timestamp,
      finishedAt: row.finished_at as Timestamp | null,
      status: row.status as RunStatus,
      finalMessage: row.final_message,
      errorMessage: row.error_message,
    }));
  }

  async listRecentCompletedMessageRuns(sessionId: SessionId, limit: number): Promise<MessageRun[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    if (safeLimit === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM message_runs
         WHERE session_id = ?
           AND status = 'completed'
           AND prompt != ''
           AND final_message IS NOT NULL
           AND final_message != ''
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(sessionId, safeLimit) as Array<{
        id: string;
        session_id: string;
        group_id: string;
        prompt: string;
        branch_name?: string;
        card_id: string | null;
        started_at: number;
        finished_at: number | null;
        status: string;
        final_message: string | null;
        error_message: string | null;
      }>;
    return rows.map((row) => ({
      id: row.id as MessageRunId,
      sessionId: row.session_id as SessionId,
      groupId: row.group_id as LarkGroupId,
      prompt: row.prompt,
      branchName: row.branch_name ?? MAIN_BRANCH_NAME,
      cardId: row.card_id as CardId | null,
      startedAt: row.started_at as Timestamp,
      finishedAt: row.finished_at as Timestamp | null,
      status: row.status as RunStatus,
      finalMessage: row.final_message,
      errorMessage: row.error_message,
    }));
  }

  async getRankStats(input: GetRankStatsInput): Promise<RankStats> {
    const groupIdFilter = input.scope === "group" ? input.groupId : null;
    // Exclude framework-emitted "as user" messages. The lark-cli `--as user`
    // send path prepends "Δ" (U+0394) to every impersonated message, so a real
    // human message never starts with it; GLOB is byte/codepoint-anchored at
    // the start, so 'Δ*' matches only prompts whose first character is Δ.
    const realUserFilter = "mr.sender_id GLOB 'ou_*' AND mr.prompt NOT GLOB 'Δ*'";
    const windowStart = Date.now() - RANK_WINDOW_MS;
    const whereClause = groupIdFilter != null
      ? `WHERE ${realUserFilter} AND mr.started_at >= ? AND mr.group_id = ?`
      : `WHERE ${realUserFilter} AND mr.started_at >= ?`;
    const whereArgs: unknown[] = groupIdFilter != null ? [windowStart, groupIdFilter] : [windowStart];

    const runRows = this.db
      .prepare(
        `SELECT mr.sender_id, mr.prompt, s.name as session_name
         FROM message_runs mr
         JOIN sessions s ON s.id = mr.session_id
         ${whereClause}
         ORDER BY mr.started_at ASC`
      )
      .all(...whereArgs) as Array<{ sender_id: string; prompt: string; session_name: string }>;

    if (runRows.length === 0) {
      return { rows: [], trackingSince: windowStart };
    }

    const totals = new Map<
      string,
      { senderId: string; total: number; inputChars: number; sessions: Map<string, number> }
    >();
    for (const row of runRows) {
      const current = totals.get(row.sender_id) ?? {
        senderId: row.sender_id,
        total: 0,
        inputChars: 0,
        sessions: new Map<string, number>(),
      };
      current.total += 1;
      current.inputChars += countRankInputChars(row.prompt);
      current.sessions.set(row.session_name, (current.sessions.get(row.session_name) ?? 0) + 1);
      totals.set(row.sender_id, current);
    }

    const rows: RankRow[] = Array.from(totals.values())
      .sort((a, b) => b.total - a.total || b.inputChars - a.inputChars)
      .map((row) => {
        const allSessions = groupIdFilter != null
          ? []
          : Array.from(row.sessions.entries())
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([sessionName, count]) => ({ sessionName, count }));
        return {
          senderId: row.senderId,
          total: row.total,
          inputChars: row.inputChars,
          top3Sessions: allSessions.slice(0, 3),
          allSessions,
        };
      });

    return { rows, trackingSince: windowStart };
  }

  async getDisplayNames(senderIds: string[]): Promise<Map<string, DisplayNameEntry>> {
    if (senderIds.length === 0) return new Map();
    const placeholders = senderIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT sender_id, display_name, fetched_at
         FROM user_display_names
         WHERE sender_id IN (${placeholders})`
      )
      .all(...senderIds) as Array<{
      sender_id: string;
      display_name: string;
      fetched_at: number;
    }>;
    const result = new Map<string, DisplayNameEntry>();
    for (const row of rows) {
      result.set(row.sender_id, { displayName: row.display_name, fetchedAt: row.fetched_at });
    }
    return result;
  }

  async resetRunningMessageRunsOnBoot(now: Timestamp): Promise<number> {
    const info = this.db
      .prepare(
        `UPDATE message_runs
         SET status = 'timeout',
             finished_at = ?,
             error_message = 'console restart while running'
         WHERE status = 'running'`
      )
      .run(now);
    return info.changes;
  }

  async findAllSessionsWithBackendSessionId(): Promise<Array<{
    id: SessionId;
    backendSessionId: string;
    status: SessionStatus;
    workdir: AbsolutePath;
  }>> {
    const rows = this.db
      .prepare(
        `SELECT id, backend_session_id, status, workdir
         FROM sessions
         WHERE backend_session_id IS NOT NULL
           AND status != 'deleted'`
      )
      .all() as Array<{ id: string; backend_session_id: string; status: string; workdir: string }>;
    return rows.map((r) => ({
      id: r.id as SessionId,
      backendSessionId: r.backend_session_id,
      status: r.status as SessionStatus,
      workdir: r.workdir as AbsolutePath,
    }));
  }

  async findRunningMessageRuns(): Promise<Array<{
    id: MessageRunId;
    sessionId: SessionId;
    startedAt: Timestamp;
  }>> {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, started_at
         FROM message_runs
         WHERE status = 'running'`
      )
      .all() as Array<{ id: string; session_id: string; started_at: number }>;
    return rows.map((r) => ({
      id: r.id as MessageRunId,
      sessionId: r.session_id as SessionId,
      startedAt: r.started_at as Timestamp,
    }));
  }

  async markMessageRunTimeout(id: MessageRunId, reason: string, now: Timestamp): Promise<void> {
    // Guarded on status='running' so a race against the normal lifecycle
    // (e.g. completion landing just before reconcile) cannot clobber a
    // terminal row. Mirrors resetRunningMessageRunsOnBoot's WHERE filter.
    this.db
      .prepare(
        `UPDATE message_runs
         SET status = 'timeout',
             finished_at = ?,
             error_message = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(now, reason, id);
  }

  async timeoutMessageRunAndFailPendingSpawnComms(
    id: MessageRunId,
    reason: string,
    now: Timestamp,
  ): Promise<BootOrphanedSpawnComm[]> {
    // Keep the run timeout and linked spawn terminalization in one transaction.
    // If a normal lifecycle won the race and ended the run first, there is no
    // boot failure to propagate to its comms.
    return this.db.transaction(() => {
      const run = this.db
        .prepare("SELECT session_id FROM message_runs WHERE id = ? AND status = 'running'")
        .get(id) as { session_id: string } | undefined;
      if (!run) return [];

      this.db
        .prepare(
          `UPDATE message_runs
           SET status = 'timeout',
               finished_at = ?,
               error_message = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(now, reason, id);
      const failedComms = this.failPendingSpawnCommsForChildSession(run.session_id as SessionId, reason, now);
      if (failedComms.length > 0) {
        // Boot has already established that this child can never produce its
        // backend output. Keep the terminal run useful to callers even when
        // the backend left final_message NULL: the synthetic failure is the
        // durable result that backs the caller's resultUrl.
        this.db
          .prepare(
            `UPDATE message_runs
             SET final_message = COALESCE(NULLIF(TRIM(final_message), ''), ?)
             WHERE id = ? AND status = 'timeout'`
          )
          .run(bootOrphanFailureMessage(reason), id);
      }
      return failedComms;
    })();
  }

  async recoverBootOrphanedSpawnReceipts(now: Timestamp): Promise<BootOrphanedSpawnComm[]> {
    const reason = "boot reconcile: backend orphaned by console restart";
    const timestamp = sessionTimestamp(now, "cross_session_log.finishedAt");
    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT c.id AS comm_id,
                  c.from_session_id AS caller_session_id,
                  COALESCE(caller.name, c.from_session_id) AS caller_session_name,
                  COALESCE(target.name, c.to_session_id) AS target_session_name,
                  c.child_session_id AS child_session_id,
                  COALESCE(child.name, c.child_session_id) AS child_session_name,
                  c.message_run_id AS message_run_id,
                  c.final_message AS final_message
           FROM cross_session_log c
           LEFT JOIN sessions caller ON caller.id = c.from_session_id
           LEFT JOIN sessions target ON target.id = c.to_session_id
           LEFT JOIN sessions child ON child.id = c.child_session_id
           WHERE c.kind = 'spawn'
             AND c.status = 'failed'
             AND c.error_message = ?
             AND c.child_session_id IS NOT NULL
           ORDER BY c.finished_at ASC, c.created_at ASC`
        )
        .all(reason) as Array<{
          comm_id: string;
          caller_session_id: string;
          caller_session_name: string;
          target_session_name: string;
          child_session_id: string;
          child_session_name: string;
          message_run_id: string | null;
          final_message: string | null;
        }>;
      const failed: BootOrphanedSpawnComm[] = [];
      const parkExistingReceipt = this.db.prepare(
        `UPDATE spawn_async_items
         SET status = CASE WHEN status IN ('closed', 'parked') THEN status ELSE 'parked' END,
             verdict = CASE WHEN verdict IS NULL THEN 'boot_orphaned_failure' ELSE verdict END,
             verdict_reason = CASE WHEN verdict_reason IS NULL THEN ? ELSE verdict_reason END,
             updated_at = ?
         WHERE comm_id = ?`,
      );
      const insertFailureReceipt = this.db.prepare(
        `INSERT INTO spawn_async_items
           (ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
            attempt_count, status, verdict, verdict_reason, created_at, updated_at, last_attempt_at)
         SELECT ?, ?, ?, ?, 'execution', 'run_timeout', 0, 'parked', 'boot_orphaned_failure', ?, ?, ?, NULL
         WHERE NOT EXISTS (SELECT 1 FROM spawn_async_items WHERE comm_id = ?)`,
      );
      for (const candidate of candidates) {
        const finalMessage = candidate.final_message?.trim()
          ? candidate.final_message
          : bootOrphanFailureMessage(reason);
        this.db
          .prepare(
            `UPDATE cross_session_log
             SET final_message = COALESCE(NULLIF(TRIM(final_message), ''), ?)
             WHERE id = ? AND status = 'failed'`,
          )
          .run(finalMessage, candidate.comm_id);
        if (candidate.message_run_id) {
          this.db
            .prepare(
              `UPDATE message_runs
               SET final_message = COALESCE(NULLIF(TRIM(final_message), ''), ?)
               WHERE id = ? AND status = 'timeout'`,
            )
            .run(finalMessage, candidate.message_run_id);
        }
        parkExistingReceipt.run(finalMessage, timestamp, candidate.comm_id);
        insertFailureReceipt.run(
          `async_boot_${candidate.comm_id}`,
          candidate.comm_id,
          candidate.caller_session_name,
          candidate.target_session_name,
          finalMessage,
          timestamp,
          timestamp,
          candidate.comm_id,
        );
        failed.push({
          commId: candidate.comm_id,
          callerSessionId: candidate.caller_session_id as SessionId,
          callerSessionName: candidate.caller_session_name,
          targetSessionName: candidate.target_session_name,
          childSessionId: candidate.child_session_id as SessionId,
          childSessionName: candidate.child_session_name,
        });
      }
      return failed;
    })();
  }

  async getTokenUsageSummary(
    sessionId: SessionId,
    cutoffs: TokenUsageWindowCutoffs
  ): Promise<TokenUsageSummary> {
    // Recursive CTE walks sessions.parent_id to pull usage from all descendants
    // plus the session itself. Three window aggregates computed in one pass.
    const row = this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.id FROM sessions s JOIN descendants d ON s.parent_id = d.id
         )
         SELECT
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.input_tokens       ELSE 0 END), 0) AS today_input,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.output_tokens      ELSE 0 END), 0) AS today_output,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.cache_read_tokens  ELSE 0 END), 0) AS today_cache_read,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.cache_write_tokens ELSE 0 END), 0) AS today_cache_write,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.reasoning_tokens   ELSE 0 END), 0) AS today_reasoning,
           SUM(CASE WHEN tu.created_at >= ? THEN 1 ELSE 0 END) AS today_count,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.input_tokens       ELSE 0 END), 0) AS week_input,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.output_tokens      ELSE 0 END), 0) AS week_output,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.cache_read_tokens  ELSE 0 END), 0) AS week_cache_read,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.cache_write_tokens ELSE 0 END), 0) AS week_cache_write,
           COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.reasoning_tokens   ELSE 0 END), 0) AS week_reasoning,
           SUM(CASE WHEN tu.created_at >= ? THEN 1 ELSE 0 END) AS week_count,
           COALESCE(SUM(tu.input_tokens),       0) AS all_input,
           COALESCE(SUM(tu.output_tokens),      0) AS all_output,
           COALESCE(SUM(tu.cache_read_tokens),  0) AS all_cache_read,
           COALESCE(SUM(tu.cache_write_tokens), 0) AS all_cache_write,
           COALESCE(SUM(tu.reasoning_tokens),   0) AS all_reasoning,
           COUNT(tu.id) AS all_count
         FROM token_usage tu
         WHERE tu.session_id IN (SELECT id FROM descendants)`
      )
      .get(
        sessionId,
        cutoffs.todayStart, cutoffs.todayStart, cutoffs.todayStart, cutoffs.todayStart, cutoffs.todayStart, cutoffs.todayStart,
        cutoffs.weekStart, cutoffs.weekStart, cutoffs.weekStart, cutoffs.weekStart, cutoffs.weekStart, cutoffs.weekStart,
      ) as Record<string, number>;
    const toWindow = (prefix: string): TokenUsageWindow => ({
      inputTokens: row[`${prefix}_input`] ?? 0,
      outputTokens: row[`${prefix}_output`] ?? 0,
      cacheReadTokens: row[`${prefix}_cache_read`] ?? 0,
      cacheWriteTokens: row[`${prefix}_cache_write`] ?? 0,
      reasoningTokens: row[`${prefix}_reasoning`] ?? 0,
      rowCount: row[`${prefix}_count`] ?? 0,
    });
    return {
      today: toWindow("today"),
      last7Days: toWindow("week"),
      cumulative: toWindow("all"),
    };
  }

  async getSchedulerTokenUsage(from: Timestamp, to: Timestamp): Promise<SchedulerTokenUsage[]> {
    // Follow scheduler-origin runs through later spawns. UNION deduplicates
    // (task_id, message_run_id) pairs, so duplicate links do not inflate usage
    // and malformed cycles terminate. Collapse once more before joining
    // token_usage so a run reached from multiple tasks is charged only once.
    const rows = this.db
      .prepare(
        `WITH RECURSIVE scheduler_roots AS (
           SELECT
             c.message_run_id,
             MIN(SUBSTR(
               c.origin_run_id,
               11,
               INSTR(SUBSTR(c.origin_run_id, 11), ':') - 1
             )) AS task_id
           FROM cross_session_log c
           WHERE c.message_run_id IS NOT NULL
             AND SUBSTR(c.origin_run_id, 1, 10) = 'scheduler:'
             AND INSTR(SUBSTR(c.origin_run_id, 11), ':') > 1
             AND LENGTH(SUBSTR(
               c.origin_run_id,
               11 + INSTR(SUBSTR(c.origin_run_id, 11), ':')
             )) > 0
           GROUP BY c.message_run_id
         ),
         scheduler_message_runs(task_id, message_run_id) AS (
           SELECT task_id, message_run_id
           FROM scheduler_roots
           UNION
           SELECT scheduler_message_runs.task_id, c.message_run_id
           FROM scheduler_message_runs
           JOIN cross_session_log c
             ON c.origin_run_id = scheduler_message_runs.message_run_id
           WHERE c.message_run_id IS NOT NULL
         ),
         attributed_message_runs AS (
           SELECT message_run_id, MIN(task_id) AS task_id
           FROM scheduler_message_runs
           GROUP BY message_run_id
         )
         SELECT
           attributed_message_runs.task_id,
           COALESCE(SUM(tu.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(tu.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(tu.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(tu.cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(tu.reasoning_tokens), 0) AS reasoning_tokens,
           COALESCE(SUM(
             tu.input_tokens + tu.output_tokens + tu.cache_read_tokens
             + tu.cache_write_tokens + tu.reasoning_tokens
           ), 0) AS total_tokens,
           COUNT(DISTINCT tu.message_run_id) AS run_count
         FROM attributed_message_runs
         JOIN token_usage tu ON tu.message_run_id = attributed_message_runs.message_run_id
         WHERE tu.created_at >= ? AND tu.created_at < ?
         GROUP BY attributed_message_runs.task_id
         ORDER BY total_tokens DESC, attributed_message_runs.task_id ASC`
      )
      .all(from, to) as Array<{
        task_id: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        reasoning_tokens: number;
        total_tokens: number;
        run_count: number;
      }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens,
      runCount: row.run_count,
    }));
  }

  async recordTokenUsage(input: TokenUsageInput): Promise<void> {
    // Codex's native input_tokens includes cached_input_tokens. The durable
    // input_tokens column is provider-neutral net input; cache is represented
    // only by cache_read_tokens. Preserve raw_usage_json for forensics and
    // cumulative watermarks.
    const storedInputTokens =
      input.backend === "codex"
        ? Math.max(0, input.inputTokens - input.cacheReadTokens)
        : input.inputTokens;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO token_usage
         (session_id, message_run_id, backend, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          raw_usage_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.messageRunId,
        input.backend,
        input.model ?? null,
        storedInputTokens,
        input.outputTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.reasoningTokens,
        input.rawUsageJson,
        input.createdAt
      );
  }

  async getLatestTokenUsageRawTotals(sessionId: SessionId): Promise<TokenUsageRawTotals | null> {
    const row = this.db
      .prepare(
        `SELECT raw_usage_json
         FROM token_usage
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get(sessionId) as { raw_usage_json: string | null } | undefined;
    return row ? parseTokenUsageRawTotals(row.raw_usage_json) : null;
  }

  async countActiveChildrenByParent(parentId: SessionId): Promise<number> {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM sessions WHERE parent_id = ? AND status = 'busy'"
      )
      .get(parentId) as { c: number };
    return row.c;
  }

  async cleanupStaleChildSessions(cutoff: Timestamp): Promise<BootChildCleanupResult> {
    return this.cleanupChildSessionsWithPendingSpawnComms("idle", cutoff, "orphaned by console restart");
  }

  async cleanupErroredChildSessions(cutoff: Timestamp): Promise<BootChildCleanupResult> {
    return this.cleanupChildSessionsWithPendingSpawnComms("error", cutoff, "orphaned by console restart");
  }

  private cleanupChildSessionsWithPendingSpawnComms(
    status: "idle" | "error",
    cutoff: Timestamp,
    reason: string,
  ): BootChildCleanupResult {
    const timestamp = sessionTimestamp(cutoff, "sessions.updatedAt");
    return this.db.transaction(() => {
      const children = this.db
        .prepare(
          `SELECT id
           FROM sessions
           WHERE scope = 'child'
             AND status = ?
             AND updated_at < ?`
        )
        .all(status, timestamp) as Array<{ id: string }>;
      const failedComms: BootOrphanedSpawnComm[] = [];
      let count = 0;
      const deleteChild = this.db
        .prepare(
          `UPDATE sessions
           SET status = 'deleted', updated_at = ?
           WHERE id = ?
             AND scope = 'child'
             AND status = ?
             AND updated_at < ?`
        );
      for (const child of children) {
        failedComms.push(...this.failPendingSpawnCommsForChildSession(child.id as SessionId, reason, timestamp));
        count += deleteChild.run(timestamp, child.id, status, timestamp).changes;
      }
      return { count, failedComms };
    })();
  }

  async cleanupStuckBusyChildren(cutoff: Timestamp): Promise<number> {
    const timestamp = sessionTimestamp(cutoff, "sessions.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = 'error', updated_at = ?
         WHERE scope = 'child' AND status = 'busy'
           AND backend_session_id IS NULL AND updated_at < ?`
      )
      .run(timestamp, timestamp);
    return result.changes;
  }

  async logCrossSessionComm(input: NewCrossSessionComm, spawnPredicate?: NewSpawnPredicateInput): Promise<void> {
    const write = () => {
      this.insertCrossSessionComm(input);
      if (spawnPredicate) this.insertSpawnPredicate(spawnPredicate);
    };
    if (spawnPredicate) {
      this.db.transaction(write)();
      return;
    }
    write();
  }

  private insertCrossSessionComm(input: NewCrossSessionComm): void {
    this.db
      .prepare(
        `INSERT INTO cross_session_log
         (id, from_session_id, to_session_id, kind, prompt, child_model, client_request_id, origin_run_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(input.id, input.fromSessionId, input.toSessionId, input.kind, input.prompt,
           input.childModel ?? null, input.clientRequestId ?? null, input.originRunId ?? null, input.createdAt);
  }

  async findCrossSessionCommForDedup(clientRequestId: string): Promise<{
    id: string;
    status: "pending" | "completed" | "failed";
    childSessionId: string | null;
    createdAt: number;
  } | null> {
    // Served by idx_cross_session_log_client_request_id (migration 032).
    // failed comms are excluded so a caller can retry a genuinely failed
    // spawn with the same key.
    const row = this.db
      .prepare(
        `SELECT id, status, child_session_id, created_at
           FROM cross_session_log
          WHERE client_request_id = ? AND status != 'failed'
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get(clientRequestId) as
        | { id: string; status: string; child_session_id: string | null; created_at: number }
        | undefined;
    if (!row) return null;
    return {
      id: row.id,
      status: row.status as "pending" | "completed" | "failed",
      childSessionId: row.child_session_id,
      createdAt: row.created_at,
    };
  }

  async attachCrossSessionChild(id: string, childSessionId: SessionId, messageRunId: MessageRunId): Promise<void> {
    this.db
      .prepare(
        `UPDATE cross_session_log
         SET child_session_id = ?, message_run_id = ?
         WHERE id = ?`
      )
      .run(childSessionId, messageRunId, id);
  }

  private failPendingSpawnCommsForChildSession(
    childSessionId: SessionId,
    reason: string,
    now: Timestamp,
  ): BootOrphanedSpawnComm[] {
    const candidates = this.db
      .prepare(
        `SELECT c.id AS comm_id,
                c.from_session_id AS caller_session_id,
                COALESCE(caller.name, c.from_session_id) AS caller_session_name,
                COALESCE(target.name, c.to_session_id) AS target_session_name,
                c.child_session_id AS child_session_id,
                COALESCE(child.name, c.child_session_id) AS child_session_name
         FROM cross_session_log c
         LEFT JOIN sessions caller ON caller.id = c.from_session_id
         LEFT JOIN sessions target ON target.id = c.to_session_id
         LEFT JOIN sessions child ON child.id = c.child_session_id
         WHERE c.kind = 'spawn'
           AND c.status = 'pending'
           AND c.child_session_id = ?`
      )
      .all(childSessionId) as Array<{
        comm_id: string;
        caller_session_id: string;
        caller_session_name: string;
        target_session_name: string;
        child_session_id: string;
        child_session_name: string;
      }>;

    const failComm = this.db.prepare(
      `UPDATE cross_session_log
       SET status = 'failed', error_message = ?, final_message = ?, finished_at = ?
       WHERE id = ? AND status = 'pending'`,
    );
    const parkExistingReceipt = this.db.prepare(
      `UPDATE spawn_async_items
       SET status = 'parked',
           verdict = COALESCE(verdict, 'boot_orphaned_failure'),
           verdict_reason = COALESCE(verdict_reason, ?),
           updated_at = ?
       WHERE comm_id = ?
         AND status IN ('pending', 'waiting_child', 'delivering', 're_driving', 'adjudicating')`,
    );
    const insertFailureReceipt = this.db.prepare(
      `INSERT INTO spawn_async_items
         (ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
          attempt_count, status, verdict, verdict_reason, created_at, updated_at, last_attempt_at)
       SELECT ?, ?, ?, ?, 'execution', 'run_timeout', 0, 'parked', 'boot_orphaned_failure', ?, ?, ?, NULL
       WHERE NOT EXISTS (SELECT 1 FROM spawn_async_items WHERE comm_id = ?)`,
    );
    const failed: BootOrphanedSpawnComm[] = [];
    for (const candidate of candidates) {
      const finalMessage = bootOrphanFailureMessage(reason);
      const result = failComm.run(reason, finalMessage, now, candidate.comm_id);
      if (result.changes === 0) continue;
      parkExistingReceipt.run(finalMessage, now, candidate.comm_id);
      // The ref is deterministic so a retry/reconcile can never create a
      // second caller receipt for the same comm. This insert is in the same
      // transaction as the comm failure above.
      insertFailureReceipt.run(
        `async_boot_${candidate.comm_id}`,
        candidate.comm_id,
        candidate.caller_session_name,
        candidate.target_session_name,
        finalMessage,
        now,
        now,
        candidate.comm_id,
      );
      failed.push({
        commId: candidate.comm_id,
        callerSessionId: candidate.caller_session_id as SessionId,
        callerSessionName: candidate.caller_session_name,
        targetSessionName: candidate.target_session_name,
        childSessionId: candidate.child_session_id as SessionId,
        childSessionName: candidate.child_session_name,
      });
    }
    return failed;
  }

  private insertSpawnPredicate(input: NewSpawnPredicateInput): void {
    this.db
      .prepare(
        `INSERT INTO spawn_predicates
         (spawn_comm_id, owner_session_id, created_by_session_id, last_patched_by_session_id,
          predicate_json, predicate_hash, version, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, 1, 'active', ?, ?)`
      )
      .run(
        input.spawnCommId,
        input.ownerSessionId,
        input.createdBySessionId,
        input.normalizedPredicate.canonicalJson,
        input.normalizedPredicate.predicateHash,
        input.createdAt,
        input.createdAt,
      );
  }

  async createSpawnPredicate(input: NewSpawnPredicateInput): Promise<SpawnPredicateRecord> {
    this.insertSpawnPredicate(input);
    const row = await this.getSpawnPredicate(input.spawnCommId);
    if (!row) throw new Error(`createSpawnPredicate failed: row not found after insert: ${input.spawnCommId}`);
    return row;
  }

  private mapSpawnPredicateRow(r: {
    spawn_comm_id: string;
    owner_session_id: string;
    created_by_session_id: string;
    last_patched_by_session_id: string | null;
    from_session_id: string | null;
    to_session_id: string | null;
    predicate_json: string;
    predicate_hash: string;
    version: number;
    status: string;
    created_at: number;
    updated_at: number;
  }): SpawnPredicateRecord {
    return {
      spawnCommId: r.spawn_comm_id,
      ownerSessionId: r.owner_session_id as SessionId,
      createdBySessionId: r.created_by_session_id as SessionId,
      lastPatchedBySessionId: r.last_patched_by_session_id as SessionId | null,
      fromSessionId: r.from_session_id as SessionId | null,
      toSessionId: r.to_session_id as SessionId | null,
      predicate: JSON.parse(r.predicate_json) as SpawnPredicateRecord["predicate"],
      predicateJson: r.predicate_json,
      predicateHash: r.predicate_hash,
      version: r.version,
      status: r.status as SpawnPredicateRecord["status"],
      createdAt: r.created_at as Timestamp,
      updatedAt: r.updated_at as Timestamp,
    };
  }

  async getSpawnPredicate(spawnCommId: string): Promise<SpawnPredicateRecord | null> {
    const row = this.db
      .prepare(
        `SELECT p.*, c.from_session_id, c.to_session_id
         FROM spawn_predicates p
         LEFT JOIN cross_session_log c ON c.id = p.spawn_comm_id
         WHERE p.spawn_comm_id = ?`
      )
      .get(spawnCommId) as Parameters<typeof this.mapSpawnPredicateRow>[0] | undefined;
    return row ? this.mapSpawnPredicateRow(row) : null;
  }

  async patchSpawnPredicate(input: PatchSpawnPredicateInput): Promise<SpawnPredicateRecord> {
    const now = input.patchedAt;
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare(
          `SELECT p.*, c.from_session_id, c.to_session_id
           FROM spawn_predicates p
           LEFT JOIN cross_session_log c ON c.id = p.spawn_comm_id
           WHERE p.spawn_comm_id = ?`
        )
        .get(input.spawnCommId) as Parameters<typeof this.mapSpawnPredicateRow>[0] | undefined;
      if (!current) throw new Error(`spawn predicate not found: ${input.spawnCommId}`);
      const nextVersion = current.version + 1;

      this.db
        .prepare(
          `UPDATE spawn_predicates
           SET predicate_json = ?, predicate_hash = ?, version = ?,
               last_patched_by_session_id = ?, updated_at = ?
           WHERE spawn_comm_id = ?`
        )
        .run(
          input.normalizedPredicate.canonicalJson,
          input.normalizedPredicate.predicateHash,
          nextVersion,
          input.actorSessionId,
          now,
          input.spawnCommId,
        );

      this.db
        .prepare(
          `INSERT INTO spawn_predicate_patches
           (id, spawn_comm_id, version, actor_session_id, actor_role, tx_id,
            old_predicate_json, new_predicate_json, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.spawnCommId,
          nextVersion,
          input.actorSessionId,
          input.actorRole,
          input.txId ?? null,
          current.predicate_json,
          input.normalizedPredicate.canonicalJson,
          input.reason,
          now,
        );

      const cutoff = now - 24 * 60 * 60 * 1000;
      const countRow = this.db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM spawn_predicate_patches
           WHERE spawn_comm_id = ? AND created_at >= ?`
        )
        .get(input.spawnCommId, cutoff) as { c: number };
      this.db
        .prepare(
          `INSERT INTO watcher_state
           (spawn_comm_id, patch_count_24h, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(spawn_comm_id) DO UPDATE SET
             patch_count_24h = excluded.patch_count_24h,
             updated_at = excluded.updated_at`
        )
        .run(input.spawnCommId, countRow.c, now, now);
    });
    tx();

    const patched = await this.getSpawnPredicate(input.spawnCommId);
    if (!patched) throw new Error(`patchSpawnPredicate failed: row not found after patch: ${input.spawnCommId}`);
    return patched;
  }

  private mapWatcherStateRow(r: {
    spawn_comm_id: string;
    last_run_at: number | null;
    last_run_result: string | null;
    last_run_error: string | null;
    last_run_duration_ms: number | null;
    consecutive_false_count: number;
    consecutive_transient_fail_count: number;
    patch_count_24h: number;
    transaction_started_at: number | null;
    last_trigger_signal: string | null;
    next_eligible_at: number | null;
    closed_at: number | null;
    lease_owner: string | null;
    lease_expires_at: number | null;
    created_at: number;
    updated_at: number;
  }): WatcherStateRecord {
    return {
      spawnCommId: r.spawn_comm_id,
      lastRunAt: r.last_run_at as Timestamp | null,
      lastRunResult: r.last_run_result as WatcherStateRecord["lastRunResult"],
      lastRunError: r.last_run_error,
      lastRunDurationMs: r.last_run_duration_ms,
      consecutiveFalseCount: r.consecutive_false_count,
      consecutiveTransientFailCount: r.consecutive_transient_fail_count,
      patchCount24h: r.patch_count_24h,
      transactionStartedAt: r.transaction_started_at as Timestamp | null,
      lastTriggerSignal: r.last_trigger_signal as WatcherStateRecord["lastTriggerSignal"],
      nextEligibleAt: r.next_eligible_at as Timestamp | null,
      closedAt: r.closed_at as Timestamp | null,
      leaseOwner: r.lease_owner,
      leaseExpiresAt: r.lease_expires_at as Timestamp | null,
      createdAt: r.created_at as Timestamp,
      updatedAt: r.updated_at as Timestamp,
    };
  }

  async listOpenSpawnPredicates(cutoffMs: Timestamp, limit = 100): Promise<OpenSpawnPredicateRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT
           p.spawn_comm_id AS p_spawn_comm_id,
           p.owner_session_id,
           p.created_by_session_id,
           p.last_patched_by_session_id,
           p.predicate_json,
           p.predicate_hash,
           p.version,
           p.status,
           p.created_at AS p_created_at,
           p.updated_at AS p_updated_at,
           c.from_session_id,
           c.to_session_id,
           w.spawn_comm_id AS w_spawn_comm_id,
           w.last_run_at,
           w.last_run_result,
           w.last_run_error,
           w.last_run_duration_ms,
           w.consecutive_false_count,
           w.consecutive_transient_fail_count,
           w.patch_count_24h,
           w.transaction_started_at,
           w.last_trigger_signal,
           w.next_eligible_at,
           w.closed_at,
           w.lease_owner,
           w.lease_expires_at,
           w.created_at AS w_created_at,
           w.updated_at AS w_updated_at
         FROM spawn_predicates p
         LEFT JOIN cross_session_log c ON c.id = p.spawn_comm_id
         LEFT JOIN watcher_state w ON w.spawn_comm_id = p.spawn_comm_id
         WHERE p.status = 'active'
           AND p.created_at >= ?
           AND w.closed_at IS NULL
         ORDER BY p.updated_at ASC
         LIMIT ?`
      )
      .all(cutoffMs, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const predicate = this.mapSpawnPredicateRow({
        spawn_comm_id: r.p_spawn_comm_id as string,
        owner_session_id: r.owner_session_id as string,
        created_by_session_id: r.created_by_session_id as string,
        last_patched_by_session_id: r.last_patched_by_session_id as string | null,
        from_session_id: r.from_session_id as string | null,
        to_session_id: r.to_session_id as string | null,
        predicate_json: r.predicate_json as string,
        predicate_hash: r.predicate_hash as string,
        version: r.version as number,
        status: r.status as string,
        created_at: r.p_created_at as number,
        updated_at: r.p_updated_at as number,
      });
      const watcherState = r.w_spawn_comm_id
        ? this.mapWatcherStateRow({
            spawn_comm_id: r.w_spawn_comm_id as string,
            last_run_at: r.last_run_at as number | null,
            last_run_result: r.last_run_result as string | null,
            last_run_error: r.last_run_error as string | null,
            last_run_duration_ms: r.last_run_duration_ms as number | null,
            consecutive_false_count: r.consecutive_false_count as number,
            consecutive_transient_fail_count: r.consecutive_transient_fail_count as number,
            patch_count_24h: r.patch_count_24h as number,
            transaction_started_at: r.transaction_started_at as number | null,
            last_trigger_signal: r.last_trigger_signal as string | null,
            next_eligible_at: r.next_eligible_at as number | null,
            closed_at: r.closed_at as number | null,
            lease_owner: r.lease_owner as string | null,
            lease_expires_at: r.lease_expires_at as number | null,
            created_at: r.w_created_at as number,
            updated_at: r.w_updated_at as number,
          })
        : null;
      return { predicate, watcherState };
    });
  }

  async upsertWatcherState(input: UpsertWatcherStateInput): Promise<void> {
    const current = await this.getWatcherState(input.spawnCommId);
    const createdAt = current?.createdAt ?? input.updatedAt;
    this.db
      .prepare(
        `INSERT INTO watcher_state
         (spawn_comm_id, last_run_at, last_run_result, last_run_error, last_run_duration_ms,
          consecutive_false_count, consecutive_transient_fail_count, patch_count_24h,
          transaction_started_at, last_trigger_signal, next_eligible_at, closed_at,
          lease_owner, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(spawn_comm_id) DO UPDATE SET
          last_run_at = excluded.last_run_at,
          last_run_result = excluded.last_run_result,
          last_run_error = excluded.last_run_error,
          last_run_duration_ms = excluded.last_run_duration_ms,
          consecutive_false_count = excluded.consecutive_false_count,
          consecutive_transient_fail_count = excluded.consecutive_transient_fail_count,
          patch_count_24h = excluded.patch_count_24h,
          transaction_started_at = excluded.transaction_started_at,
          last_trigger_signal = excluded.last_trigger_signal,
          next_eligible_at = excluded.next_eligible_at,
          closed_at = excluded.closed_at,
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at`
      )
      .run(
        input.spawnCommId,
        input.lastRunAt ?? current?.lastRunAt ?? null,
        input.lastRunResult ?? current?.lastRunResult ?? null,
        input.lastRunError ?? current?.lastRunError ?? null,
        input.lastRunDurationMs ?? current?.lastRunDurationMs ?? null,
        input.consecutiveFalseCount ?? current?.consecutiveFalseCount ?? 0,
        input.consecutiveTransientFailCount ?? current?.consecutiveTransientFailCount ?? 0,
        input.patchCount24h ?? current?.patchCount24h ?? 0,
        input.transactionStartedAt ?? current?.transactionStartedAt ?? null,
        input.lastTriggerSignal ?? current?.lastTriggerSignal ?? null,
        input.nextEligibleAt ?? current?.nextEligibleAt ?? null,
        input.closedAt ?? current?.closedAt ?? null,
        input.leaseOwner ?? current?.leaseOwner ?? null,
        input.leaseExpiresAt ?? current?.leaseExpiresAt ?? null,
        createdAt,
        input.updatedAt,
      );
  }

  async getWatcherState(spawnCommId: string): Promise<WatcherStateRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM watcher_state WHERE spawn_comm_id = ?")
      .get(spawnCommId) as Parameters<typeof this.mapWatcherStateRow>[0] | undefined;
    return row ? this.mapWatcherStateRow(row) : null;
  }

  async registerSpawnAsyncItem(input: RegisterSpawnAsyncItemInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO spawn_async_items
         (ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
          attempt_count, status, verdict, verdict_reason, created_at, updated_at, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, NULL)`
      )
      .run(
        input.ref,
        input.commId,
        input.callerSession,
        input.targetSession,
        input.failedPhase,
        input.failureKind,
        input.status ?? "pending",
        sessionTimestamp(input.createdAt, "spawn_async_items.createdAt"),
        sessionTimestamp(input.updatedAt, "spawn_async_items.updatedAt"),
      );
  }

  private querySpawnAsyncItem(where: string, param: string): SpawnAsyncItemRecord | null {
    const row = this.db
      .prepare(`${SPAWN_ASYNC_ITEM_SELECT} ${where}`)
      .get(param) as SpawnAsyncItemSqlRow | undefined;
    return row ? mapSpawnAsyncItemRow(row) : null;
  }

  async getSpawnAsyncItem(ref: string): Promise<SpawnAsyncItemRecord | null> {
    return this.querySpawnAsyncItem("WHERE sai.ref = ?", ref);
  }

  /** Latest async item for a comm (most recent registration wins). */
  async getSpawnAsyncItemByComm(commId: string): Promise<SpawnAsyncItemRecord | null> {
    return this.querySpawnAsyncItem("WHERE sai.comm_id = ? ORDER BY sai.created_at DESC LIMIT 1", commId);
  }

  async listSpawnAsyncItemsByCallerSession(callerSession: string, limit = 100): Promise<SpawnAsyncItemRecord[]> {
    const rows = this.db
      .prepare(
        `${SPAWN_ASYNC_ITEM_SELECT}
         WHERE sai.caller_session = ?
         ORDER BY sai.updated_at ASC
         LIMIT ?`,
      )
      .all(callerSession, limit) as SpawnAsyncItemSqlRow[];
    return rows.map(mapSpawnAsyncItemRow);
  }

  /**
   * Caller-consumption ledger: the caller fetched the result itself over an
   * HTTP channel, so no push delivery may happen afterwards. CAS covers
   * pending/waiting_child/delivering so take can steal an in-flight push
   * (after claim, before finalize).
   */
  async closeSpawnAsyncItemConsumed(ref: string, reason: string, now: Timestamp): Promise<boolean> {
    const timestamp = sessionTimestamp(now, "spawn_async_items.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE spawn_async_items
         SET status = 'closed',
             verdict = 'caller_consumed',
             verdict_reason = ?,
             updated_at = ?
         WHERE ref = ? AND status IN ('pending', 'waiting_child', 'delivering', 'parked')`
      )
      .run(reason, timestamp, ref);
    return result.changes > 0;
  }

  /**
   * Sync-inline HTTP delivery ledger: closes every non-terminal async item
   * for the comm so the push path cannot redeliver. No ref filter — pure
   * sync usually has zero rows (returns 0, a normal no-op).
   */
  async closeSpawnAsyncItemSyncDelivered(commId: string, reason: string, now: Timestamp): Promise<number> {
    const timestamp = sessionTimestamp(now, "spawn_async_items.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE spawn_async_items
         SET status = 'closed',
             verdict = 'delivered',
             verdict_reason = ?,
             updated_at = ?
         WHERE comm_id = ? AND status IN ('pending', 'waiting_child', 'delivering')`
      )
      .run(reason, timestamp, commId);
    return result.changes;
  }

  async claimSpawnAsyncItemForDelivery(ref: string, now: Timestamp): Promise<SpawnAsyncItemRecord | null> {
    const item = await this.getSpawnAsyncItem(ref);
    if (!item || (item.status !== "pending" && item.status !== "waiting_child")) return null;
    const timestamp = sessionTimestamp(now, "spawn_async_items.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE spawn_async_items
         SET status = 'delivering', last_attempt_at = ?, updated_at = ?
         WHERE ref = ? AND status = ?`
      )
      .run(timestamp, timestamp, ref, item.status);
    return result.changes > 0 ? item : null;
  }

  async markSpawnAsyncItemAdjudicationEscalated(ref: string, reason: string, now: Timestamp): Promise<void> {
    const timestamp = sessionTimestamp(now, "spawn_async_items.updatedAt");
    this.db
      .prepare(
        `UPDATE spawn_async_items
         SET status = 'closed',
             verdict = 'escalated',
             verdict_reason = ?,
             updated_at = ?
         WHERE ref = ?
           AND NOT (status = 'closed' AND verdict IN ('delivered', 'caller_consumed'))`
      )
      .run(reason, timestamp, ref);
  }

  async markSpawnAsyncItemDelivered(
    ref: string,
    closure: SpawnAsyncItemDeliveredClosure,
    now: Timestamp,
  ): Promise<boolean> {
    const timestamp = sessionTimestamp(now, "spawn_async_items.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE spawn_async_items
         SET attempt_count = attempt_count + 1,
             status = 'closed',
             verdict = ?,
             verdict_reason = ?,
             last_attempt_at = ?,
             updated_at = ?
         WHERE ref = ? AND status = 'delivering'`
      )
      .run(closure.verdict, closure.reason, timestamp, timestamp, ref);
    return result.changes > 0;
  }

  async parkSpawnAsyncItemDeliveryUnsupported(ref: string, reason: string, now: Timestamp): Promise<boolean> {
    const timestamp = sessionTimestamp(now, "spawn_async_items.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE spawn_async_items
         SET status = 'parked',
             verdict = 'delivery_unsupported_caller_heartbeat_disabled',
             verdict_reason = ?,
             last_attempt_at = ?,
             updated_at = ?
         WHERE ref = ? AND status = 'delivering'`
      )
      .run(reason, timestamp, timestamp, ref);
    return result.changes > 0;
  }

  async releaseSpawnAsyncItemDelivery(
    ref: string,
    previousStatus: DeliverableSpawnAsyncItemStatus,
    now: Timestamp,
  ): Promise<void> {
    const timestamp = sessionTimestamp(now, "spawn_async_items.updatedAt");
    this.db
      .prepare(
        `UPDATE spawn_async_items
         SET status = ?, updated_at = ?
         WHERE ref = ? AND status = 'delivering'`
      )
      .run(previousStatus, timestamp, ref);
  }

  async enqueueSpawnQueueItem(input: EnqueueSpawnQueueItemInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO spawn_queue
         (id, parent_id, spawn_input_json, caller_session, comm_id, status,
          created_at, dispatched_at, ttl_sec, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.parentId,
        input.spawnInputJson,
        input.callerSession ?? null,
        input.commId,
        sessionTimestamp(input.createdAt, "spawn_queue.createdAt"),
        input.ttlSec,
        sessionTimestamp(input.createdAt, "spawn_queue.updatedAt"),
      );
  }

  async countPendingSpawnQueueItemsByParent(parentId: SessionId): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM spawn_queue WHERE parent_id = ? AND status = 'pending'")
      .get(parentId) as { c: number };
    return row.c;
  }

  async claimNextSpawnQueueItem(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem | null> {
    const timestamp = sessionTimestamp(now, "spawn_queue.dispatchedAt");
    const tx = this.db.transaction(() => {
      const next = this.db
        .prepare(
          `SELECT *
           FROM spawn_queue
           WHERE parent_id = ? AND status = 'pending'
           ORDER BY created_at ASC, id ASC
           LIMIT 1`,
        )
        .get(parentId) as SpawnQueueRow | undefined;
      if (!next) return null;

      const updated = this.db
        .prepare(
          `UPDATE spawn_queue
           SET status = 'dispatched', dispatched_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(timestamp, timestamp, next.id);
      if (updated.changes === 0) return null;

      const row = this.db
        .prepare("SELECT * FROM spawn_queue WHERE id = ?")
        .get(next.id) as SpawnQueueRow | undefined;
      return row ? mapSpawnQueueRow(row) : null;
    });
    return tx();
  }

  async expireSpawnQueueItemsByParent(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem[]> {
    const timestamp = sessionTimestamp(now, "spawn_queue.updatedAt");
    const tx = this.db.transaction(() => {
      const expired = this.db
        .prepare(
          `SELECT *
           FROM spawn_queue
           WHERE parent_id = ?
             AND status = 'pending'
             AND created_at + ttl_sec * 1000 <= ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(parentId, timestamp) as SpawnQueueRow[];
      if (expired.length === 0) return [];

      const ids = expired.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(", ");
      this.db
        .prepare(
          `UPDATE spawn_queue
           SET status = 'expired', updated_at = ?
           WHERE id IN (${placeholders}) AND status = 'pending'`,
        )
        .run(timestamp, ...ids);

      return expired.map((row) => mapSpawnQueueRow({
        ...row,
        status: "expired",
        updated_at: timestamp,
      }));
    });
    return tx();
  }

  async markSpawnQueueItemFailed(id: string, now: Timestamp): Promise<void> {
    const timestamp = sessionTimestamp(now, "spawn_queue.updatedAt");
    this.db
      .prepare("UPDATE spawn_queue SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(timestamp, id);
  }

  async claimDriveCommentMention(input: ClaimDriveCommentMentionInput): Promise<boolean> {
    const now = sessionTimestamp(input.now, "drive_comment_mentions.createdAt");
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO drive_comment_mentions
         (dedupe_key, event_id, file_token, file_type, comment_id, reply_id,
          from_user_id, target_session, matched_rule, status, result_text,
          error_message, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        input.dedupeKey,
        input.eventId,
        input.fileToken,
        input.fileType,
        input.commentId,
        input.replyId ?? null,
        input.fromUserId ?? null,
        input.targetSession,
        input.matchedRule,
        now,
        now,
      );
    return result.changes > 0;
  }

  async finishDriveCommentMention(input: FinishDriveCommentMentionInput): Promise<void> {
    const now = sessionTimestamp(input.now, "drive_comment_mentions.finishedAt");
    this.db
      .prepare(
        `UPDATE drive_comment_mentions
         SET status = ?, result_text = ?, error_message = ?, updated_at = ?, finished_at = ?
         WHERE dedupe_key = ? AND status = 'processing'`,
      )
      .run(
        input.status,
        input.resultText ?? null,
        input.errorMessage ?? null,
        now,
        now,
        input.dedupeKey,
      );
  }

  async findDriveCommentMention(dedupeKey: string): Promise<DriveCommentMentionRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM drive_comment_mentions WHERE dedupe_key = ?")
      .get(dedupeKey) as
      | {
          dedupe_key: string;
          event_id: string;
          file_token: string;
          file_type: string;
          comment_id: string;
          reply_id: string | null;
          from_user_id: string | null;
          target_session: string;
          matched_rule: string;
          status: DriveCommentMentionRecord["status"];
          result_text: string | null;
          error_message: string | null;
          created_at: number;
          updated_at: number;
          finished_at: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      dedupeKey: row.dedupe_key,
      eventId: row.event_id,
      fileToken: row.file_token,
      fileType: row.file_type,
      commentId: row.comment_id,
      replyId: row.reply_id,
      fromUserId: row.from_user_id,
      targetSession: row.target_session,
      matchedRule: row.matched_rule,
      status: row.status,
      resultText: row.result_text,
      errorMessage: row.error_message,
      createdAt: row.created_at as Timestamp,
      updatedAt: row.updated_at as Timestamp,
      finishedAt: (row.finished_at ?? null) as Timestamp | null,
    };
  }

  async recordResponseLog(input: RecordResponseLogInput): Promise<void> {
    const mentionedAt = sessionTimestamp(input.mentionedAt, "response_log.mentionedAt");
    const createdAt = sessionTimestamp(input.createdAt, "response_log.createdAt");
    this.db
      .prepare(
        `INSERT INTO response_log
         (response_id, source, source_ref, source_url, mentioner, mentioned_at,
          trigger_text, response_text, response_at, response_status, response_error,
          mirror_status, mirror_record_id, mirror_synced_at, mirror_error,
          mirror_retry_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'deferred', NULL,
          'pending', NULL, NULL, NULL, 0, ?)
         ON CONFLICT(response_id) DO UPDATE SET
           source = excluded.source,
           source_ref = excluded.source_ref,
           source_url = excluded.source_url,
           mentioner = excluded.mentioner,
           mentioned_at = excluded.mentioned_at,
           trigger_text = excluded.trigger_text,
           mirror_status = CASE
             WHEN response_log.mirror_status = 'ok' THEN 'pending'
             ELSE response_log.mirror_status
           END,
           mirror_error = NULL`,
      )
      .run(
        input.responseId,
        input.source,
        input.sourceRef,
        input.sourceUrl ?? null,
        input.mentioner ?? null,
        mentionedAt,
        input.triggerText ?? null,
        createdAt,
      );
  }

  async finishResponseLog(input: FinishResponseLogInput): Promise<void> {
    const responseAt = sessionTimestamp(input.responseAt, "response_log.responseAt");
    sessionTimestamp(input.now, "response_log.updatedAt");
    this.db
      .prepare(
        `UPDATE response_log
         SET response_status = ?,
             response_text = ?,
             response_at = ?,
             response_error = ?,
             mirror_status = 'pending',
             mirror_error = NULL
         WHERE response_id = ?`,
      )
      .run(
        input.responseStatus,
        input.responseText ?? null,
        responseAt,
        input.responseError ?? null,
        input.responseId,
      );
  }

  async findResponseLog(responseId: string): Promise<ResponseLogRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM response_log WHERE response_id = ?")
      .get(responseId) as ResponseLogRow | undefined;
    return row ? mapResponseLogRow(row) : null;
  }

  async listPendingResponseLogs(limit = 100): Promise<ResponseLogRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM response_log
         WHERE mirror_status != 'ok'
         ORDER BY mentioned_at ASC, id ASC
         LIMIT ?`,
      )
      .all(limit) as ResponseLogRow[];
    return rows.map(mapResponseLogRow);
  }

  async markResponseLogMirrorOk(responseId: string, recordId: string, now: Timestamp): Promise<void> {
    const timestamp = sessionTimestamp(now, "response_log.mirrorSyncedAt");
    this.db
      .prepare(
        `UPDATE response_log
         SET mirror_status = 'ok',
             mirror_record_id = ?,
             mirror_synced_at = ?,
             mirror_error = NULL
         WHERE response_id = ?`,
      )
      .run(recordId, timestamp, responseId);
  }

  async markResponseLogMirrorFailed(responseId: string, error: string, now: Timestamp): Promise<void> {
    const timestamp = sessionTimestamp(now, "response_log.mirrorSyncedAt");
    this.db
      .prepare(
        `UPDATE response_log
         SET mirror_status = 'failed',
             mirror_synced_at = ?,
             mirror_error = ?,
             mirror_retry_count = mirror_retry_count + 1
         WHERE response_id = ?`,
      )
      .run(timestamp, error, responseId);
  }

  async recordWatcherException(input: RecordWatcherExceptionInput): Promise<void> {
    this.ensureWatcherExceptionsTable();
    this.db
      .prepare(
        `INSERT INTO watcher_exceptions
         (id, ts, spawn_comm_id, trigger_signal, tx_id, dedupe_key, summary,
          payload, lark_message_id, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          ts = excluded.ts,
          spawn_comm_id = excluded.spawn_comm_id,
          trigger_signal = excluded.trigger_signal,
          tx_id = excluded.tx_id,
          dedupe_key = excluded.dedupe_key,
          summary = excluded.summary,
          payload = excluded.payload,
          lark_message_id = excluded.lark_message_id,
          resolved_at = excluded.resolved_at`
      )
      .run(
        input.id,
        sessionTimestamp(input.ts, "watcher_exceptions.ts"),
        input.spawnCommId,
        input.triggerSignal,
        input.txId,
        input.dedupeKey,
        input.summary,
        input.payload,
        input.larkMessageId,
        input.resolvedAt === null
          ? null
          : sessionTimestamp(input.resolvedAt, "watcher_exceptions.resolvedAt"),
      );
  }

  private ensureWatcherExceptionsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watcher_exceptions (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        spawn_comm_id TEXT,
        trigger_signal TEXT NOT NULL,
        tx_id TEXT,
        dedupe_key TEXT,
        summary TEXT NOT NULL,
        payload TEXT,
        lark_message_id TEXT,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_watcher_exceptions_ts ON watcher_exceptions(ts);
      CREATE INDEX IF NOT EXISTS idx_watcher_exceptions_spawn ON watcher_exceptions(spawn_comm_id);
    `);
  }

  async recordResultSinkAttempt(input: ResultSinkAttemptInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO result_sink_attempts
         (id, spawn_comm_id, child_session_id, message_run_id, sink_index,
          sink_kind, status, note, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.spawnCommId ?? null,
        input.childSessionId,
        input.messageRunId ?? null,
        input.sinkIndex,
        input.sinkKind,
        input.status,
        input.note ?? null,
        input.errorMessage ?? null,
        input.createdAt,
      );
  }

  async listResultSinkAttemptsBySpawn(spawnCommId: string): Promise<ResultSinkAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM result_sink_attempts
         WHERE spawn_comm_id = ?
         ORDER BY created_at DESC`
      )
      .all(spawnCommId) as Array<{
        id: string;
        spawn_comm_id: string | null;
        child_session_id: string;
        message_run_id: string | null;
        sink_index: number;
        sink_kind: string;
        status: string;
        note: string | null;
        error_message: string | null;
        created_at: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      spawnCommId: r.spawn_comm_id,
      childSessionId: r.child_session_id as SessionId,
      messageRunId: r.message_run_id as MessageRunId | null,
      sinkIndex: r.sink_index,
      sinkKind: r.sink_kind,
      status: r.status as ResultSinkAttempt["status"],
      note: r.note,
      errorMessage: r.error_message,
      createdAt: r.created_at as Timestamp,
    }));
  }

  async finishCrossSessionComm(
    id: string,
    status: "completed" | "failed",
    childSessionId?: string,
    resultPreview?: string,
    error?: string,
    finalMessage?: string,
    messageRunId?: MessageRunId,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE cross_session_log
         SET status = ?, child_session_id = ?, result_preview = ?, error_message = ?,
             final_message = ?, message_run_id = ?, finished_at = ?
         WHERE id = ?`
      )
      .run(
        status,
        childSessionId ?? null,
        resultPreview ?? null,
        error ?? null,
        finalMessage ?? null,
        messageRunId ?? null,
        Date.now(),
        id,
      );
  }

  private mapCommRow(r: {
    id: string;
    from_session_id: string;
    to_session_id: string;
    kind: string;
    prompt: string | null;
    child_session_id: string | null;
    child_model: string | null;
    status: string;
    result_preview: string | null;
    final_message: string | null;
    message_run_id: string | null;
    error_message: string | null;
    created_at: number;
    finished_at: number | null;
    bitable_record_id: string | null;
    synced_at: number | null;
    client_request_id: string | null;
    origin_run_id: string | null;
  }): CrossSessionComm {
    return {
      id: r.id,
      fromSessionId: r.from_session_id as SessionId,
      toSessionId: r.to_session_id as SessionId,
      kind: r.kind as "spawn",
      prompt: r.prompt ?? "",
      childSessionId: r.child_session_id,
      childModel: r.child_model ?? null,
      status: r.status as "pending" | "completed" | "failed",
      resultPreview: r.result_preview,
      finalMessage: r.final_message,
      messageRunId: r.message_run_id as MessageRunId | null,
      errorMessage: r.error_message,
      finishedAt: (r.finished_at ?? null) as Timestamp | null,
      createdAt: r.created_at as Timestamp,
      bitableRecordId: r.bitable_record_id,
      syncedAt: (r.synced_at ?? null) as Timestamp | null,
      clientRequestId: r.client_request_id ?? null,
      originRunId: r.origin_run_id as MessageRunId | null,
    };
  }

  async listCrossSessionComms(
    sessionId: SessionId,
    direction: "from" | "to",
    limit = 50,
  ): Promise<CrossSessionComm[]> {
    const col = direction === "from" ? "from_session_id" : "to_session_id";
    const rows = this.db
      .prepare(
        `SELECT * FROM cross_session_log WHERE ${col} = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(sessionId, limit) as Parameters<typeof this.mapCommRow>[0][];
    return rows.map((r) => this.mapCommRow(r));
  }

  async listAllCrossSessionComms(limit = 10000): Promise<CrossSessionComm[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM cross_session_log ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Parameters<typeof this.mapCommRow>[0][];
    return rows.map((r) => this.mapCommRow(r));
  }

  async listUnsyncedCrossSessionComms(): Promise<CrossSessionComm[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM cross_session_log WHERE bitable_record_id IS NULL ORDER BY created_at ASC`
      )
      .all() as Parameters<typeof this.mapCommRow>[0][];
    return rows.map((r) => this.mapCommRow(r));
  }

  async listStaleSyncedCrossSessionComms(): Promise<CrossSessionComm[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM cross_session_log
         WHERE bitable_record_id IS NOT NULL
           AND finished_at IS NOT NULL
           AND (synced_at IS NULL OR synced_at < finished_at)
         ORDER BY created_at ASC`
      )
      .all() as Parameters<typeof this.mapCommRow>[0][];
    return rows.map((r) => this.mapCommRow(r));
  }

  async markCrossSessionCommSynced(id: string, bitableRecordId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE cross_session_log SET bitable_record_id = ?, synced_at = ? WHERE id = ?`
      )
      .run(bitableRecordId, Date.now(), id);
  }
}

type SpawnQueueRow = {
  id: string;
  parent_id: string;
  spawn_input_json: string;
  caller_session: string | null;
  comm_id: string;
  status: string;
  created_at: number;
  dispatched_at: number | null;
  ttl_sec: number;
  updated_at: number;
};

function mapSpawnQueueRow(row: SpawnQueueRow): SpawnQueueItem {
  return {
    id: row.id,
    parentId: row.parent_id as SessionId,
    spawnInputJson: row.spawn_input_json,
    callerSession: row.caller_session as SessionId | null,
    commId: row.comm_id,
    status: row.status as SpawnQueueItem["status"],
    createdAt: row.created_at as Timestamp,
    dispatchedAt: row.dispatched_at as Timestamp | null,
    ttlSec: row.ttl_sec,
    updatedAt: row.updated_at as Timestamp,
  };
}

type ResponseLogRow = {
  id: number;
  response_id: string;
  source: ResponseLogRecord["source"];
  source_ref: string;
  source_url: string | null;
  mentioner: string | null;
  mentioned_at: number;
  trigger_text: string | null;
  response_text: string | null;
  response_at: number | null;
  response_status: ResponseLogRecord["responseStatus"];
  response_error: string | null;
  mirror_status: ResponseLogRecord["mirrorStatus"];
  mirror_record_id: string | null;
  mirror_synced_at: number | null;
  mirror_error: string | null;
  mirror_retry_count: number;
  created_at: number;
};

function mapResponseLogRow(row: ResponseLogRow): ResponseLogRecord {
  return {
    id: row.id,
    responseId: row.response_id,
    source: row.source,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    mentioner: row.mentioner,
    mentionedAt: row.mentioned_at as Timestamp,
    triggerText: row.trigger_text,
    responseText: row.response_text,
    responseAt: (row.response_at ?? null) as Timestamp | null,
    responseStatus: row.response_status,
    responseError: row.response_error,
    mirrorStatus: row.mirror_status,
    mirrorRecordId: row.mirror_record_id,
    mirrorSyncedAt: (row.mirror_synced_at ?? null) as Timestamp | null,
    mirrorError: row.mirror_error,
    mirrorRetryCount: row.mirror_retry_count,
    createdAt: row.created_at as Timestamp,
  };
}

type SessionBranchRow = {
  session_id: string;
  name: string;
  backend_session_id: string | null;
  source_branch_name: string | null;
  source_backend_session_id: string | null;
  fork_pending: number;
  created_at: number;
  updated_at: number;
};

function mapSessionBranchRow(row: SessionBranchRow): SessionBranchRecord {
  return {
    sessionId: row.session_id as SessionId,
    name: row.name,
    backendSessionId: row.backend_session_id,
    sourceBranchName: row.source_branch_name,
    sourceBackendSessionId: row.source_backend_session_id,
    forkPending: row.fork_pending === 1,
    createdAt: row.created_at as Timestamp,
    updatedAt: row.updated_at as Timestamp,
  };
}

function mainBranchFromSession(session: Session): SessionBranchRecord {
  return {
    sessionId: session.id,
    name: MAIN_BRANCH_NAME,
    backendSessionId: session.backendSessionId,
    sourceBranchName: null,
    sourceBackendSessionId: null,
    forkPending: false,
    createdAt: session.createdAt,
    updatedAt: session.backendSessionUpdatedAt ?? session.updatedAt,
  };
}

function parseTokenUsageRawTotals(raw: string | null): TokenUsageRawTotals | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const inputTokens = toInt(parsed.input_tokens);
  const rawOutputTokens = toInt(parsed.output_tokens);
  const cacheReadTokens = toInt(parsed.cached_input_tokens ?? parsed.cache_read_input_tokens);
  const cacheWriteTokens = toInt(parsed.cache_creation_input_tokens);
  const reasoningTokens = toInt(parsed.reasoning_output_tokens);
  if (inputTokens + rawOutputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens:
      reasoningTokens > 0 ? Math.max(0, rawOutputTokens - reasoningTokens) : rawOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function currentSessionTimestamp(): Timestamp {
  return sessionTimestamp(Date.now(), "sessions.updatedAt");
}

function heartbeatEnabledByDefault(input: NewSessionInput): 0 | 1 {
  if (input.heartbeatEnabled !== undefined) return input.heartbeatEnabled ? 1 : 0;
  return input.scope !== "child" && input.name !== "heartbeat" ? 1 : 0;
}

function sessionTimestamp(value: unknown, label: string): Timestamp {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer timestamp`);
  }
  return value as Timestamp;
}

// FP v1.0 session-meta contract: validators live in src/domain/sessionMeta.ts
// (single source of truth). Adapter just wires them into write paths so the
// boundary fails loud if a non-conforming row would be written.
function validateSessionMetaForWrite(input: NewSessionInput): void {
  if (input.avatar !== undefined) validateSessionAvatar(input.avatar);
  if (input.alias !== undefined) validateSessionAlias(input.alias);
  if (input.category !== undefined) validateSessionCategory(input.category);
  assertBackendAllowedForCategory(input.backend, input.category ?? "");
}
