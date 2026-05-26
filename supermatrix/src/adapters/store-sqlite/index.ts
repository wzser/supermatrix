import type { Binding } from "../../domain/binding.ts";
import type { AbsolutePath, CardId, LarkGroupId, MessageRunId, SessionId, Timestamp } from "../../domain/ids.ts";
import type { Session, SessionStatus } from "../../domain/session.ts";
import {
  isConformingAvatar,
  validateSessionAlias,
  validateSessionAvatar,
  validateSessionCategory,
} from "../../domain/sessionMeta.ts";
import type {
  AttachmentRef,
  BindingStore,
  CrossSessionComm,
  DisplayNameEntry,
  GetRankStatsInput,
  MessageRun,
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
  RecordWatcherExceptionInput,
  ResultSinkAttempt,
  ResultSinkAttemptInput,
  RunStatus,
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
import { openDb, type Db } from "./db.ts";
import { applyMigrations, type MigrationResult } from "./migrations.ts";
export type { MigrationResult } from "./migrations.ts";
import { rowToSession, type SessionRow } from "./rowMappers.ts";

const RANK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RANK_LINK_RE = /data:[^\s"'<>]+|https?:\/\/[^\s"'<>]+|www\.[^\s"'<>]+/giu;

function countRankInputChars(prompt: string): number {
  return prompt.replace(RANK_LINK_RE, "").trim().length;
}

export class SqliteBindingStore implements BindingStore {
  readonly db: Db;

  constructor(path: string) {
    this.db = openDb(path);
  }

  async init(): Promise<MigrationResult> {
    const result = await applyMigrations(this.db);

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
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, name, alias, avatar, category, scope, backend, model, workdir, backend_session_id, purpose, status, parent_id, depth, inactivity_timeout_s, max_runtime_s, child_type, trigger_kind, post_identity, caller_invocation, continuation_hook, capability_payload, heartbeat_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'initializing', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.workdir,
        input.purpose,
        input.parentId ?? null,
        input.depth ?? 0,
        input.childType ?? null,
        input.triggerKind ?? null,
        input.postIdentity ?? null,
        input.callerInvocation ?? null,
        input.continuationHook ?? null,
        input.capabilityPayload ? JSON.stringify(input.capabilityPayload) : null,
        heartbeatEnabledByDefault(input),
        createdAt,
        createdAt
      );
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
      .prepare("UPDATE sessions SET backend_session_id = ?, updated_at = ? WHERE id = ?")
      .run(backendSessionId, updatedAt, id);
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
           (id, name, alias, avatar, category, scope, backend, model, workdir, backend_session_id, purpose, status, parent_id, depth, inactivity_timeout_s, max_runtime_s, heartbeat_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'initializing', ?, ?, NULL, NULL, ?, ?, ?)`
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
          input.workdir,
          input.purpose,
          input.parentId ?? null,
          input.depth ?? 0,
          heartbeatEnabledByDefault(input),
          createdAt,
          createdAt
        );
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

  async startMessageRun(input: NewMessageRunInput): Promise<MessageRunId> {
    if (this.hasSenderIdColumn()) {
      this.db
        .prepare(
          `INSERT INTO message_runs
           (id, session_id, group_id, prompt, card_id, started_at, finished_at, status,
            final_message, error_message, sender_id)
           VALUES (?, ?, ?, ?, NULL, ?, NULL, 'running', NULL, NULL, ?)`
        )
        .run(
          input.id,
          input.sessionId,
          input.groupId,
          input.prompt,
          input.startedAt,
          input.senderId ?? null,
        );
      return input.id;
    }
    // Degraded path: sender_id column not present (migration rolled back)
    this.db
      .prepare(
        `INSERT INTO message_runs
         (id, session_id, group_id, prompt, card_id, started_at, finished_at, status,
          final_message, error_message)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, 'running', NULL, NULL)`
      )
      .run(
        input.id,
        input.sessionId,
        input.groupId,
        input.prompt,
        input.startedAt,
      );
    return input.id;
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
      cardId: row.card_id as CardId | null,
      startedAt: row.started_at as Timestamp,
      finishedAt: row.finished_at as Timestamp | null,
      status: row.status as RunStatus,
      finalMessage: row.final_message,
      errorMessage: row.error_message,
    };
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
    const realUserFilter = "mr.sender_id GLOB 'ou_*'";
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
      .map((row) => ({
        senderId: row.senderId,
        total: row.total,
        inputChars: row.inputChars,
        top3Sessions: groupIdFilter != null
          ? []
          : Array.from(row.sessions.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([sessionName, count]) => ({ sessionName, count })),
      }));

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

  async recordTokenUsage(input: TokenUsageInput): Promise<void> {
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
        input.inputTokens,
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

  async cleanupStaleChildSessions(cutoff: Timestamp): Promise<number> {
    const timestamp = sessionTimestamp(cutoff, "sessions.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = 'deleted', updated_at = ?
         WHERE scope = 'child' AND status = 'idle' AND updated_at < ?`
      )
      .run(timestamp, timestamp);
    return result.changes;
  }

  async cleanupErroredChildSessions(cutoff: Timestamp): Promise<number> {
    const timestamp = sessionTimestamp(cutoff, "sessions.updatedAt");
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = 'deleted', updated_at = ?
         WHERE scope = 'child' AND status = 'error' AND updated_at < ?`
      )
      .run(timestamp, timestamp);
    return result.changes;
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
         (id, from_session_id, to_session_id, kind, prompt, child_model, client_request_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(input.id, input.fromSessionId, input.toSessionId, input.kind, input.prompt,
           input.childModel ?? null, input.clientRequestId ?? null, input.createdAt);
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
}
