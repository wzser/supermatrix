import type { Binding } from "../../src/domain/binding.ts";
import type { LarkGroupId, MessageRunId, SessionId, Timestamp } from "../../src/domain/ids.ts";
import { asTimestamp } from "../../src/domain/ids.ts";
import type { Session, SessionStatus } from "../../src/domain/session.ts";
import type {
  AttachmentRef,
  BindingStore,
  CrossSessionComm,
  DisplayNameEntry,
  EnqueueSpawnQueueItemInput,
  GetRankStatsInput,
  MessageRun,
  NewCrossSessionComm,
  NewMessageRunInput,
  NewSessionInput,
  NewSpawnPredicateInput,
  OpenSpawnPredicateRecord,
  PatchSpawnPredicateInput,
  RankStats,
  RegisterSpawnAsyncItemInput,
  RecordWatcherExceptionInput,
  ResultSinkAttempt,
  ResultSinkAttemptInput,
  RunStatus,
  SpawnQueueItem,
  SpawnPredicateRecord,
  TokenUsageRawTotals,
  UpsertWatcherStateInput,
  WatcherStateRecord,
} from "../../src/ports/BindingStore.ts";

function notImpl(name: string): never {
  throw new Error(`fakeBindingStore: ${name} not implemented`);
}

export function createFakeBindingStore(): BindingStore & {
  seedSession(s: Session): void;
  seedBinding(b: Binding): void;
  seedAttachments(sessionId: SessionId, refs: AttachmentRef[]): void;
  seedTokenUsageRawTotals(sessionId: SessionId, totals: TokenUsageRawTotals | null): void;
  _getMessageRun(id: MessageRunId): MessageRun | null;
  _listMessageRuns(): MessageRun[];
  _listCrossSessionComms(): CrossSessionComm[];
  _listSpawnAsyncItems(): RegisterSpawnAsyncItemInput[];
  _listSpawnQueueItems(): SpawnQueueItem[];
} {
  const sessions = new Map<SessionId, Session>();
  const bindings = new Map<LarkGroupId, Binding>();
  const messageRuns = new Map<MessageRunId, MessageRun>();
  const attachments = new Map<SessionId, AttachmentRef[]>();
  const crossSessionComms = new Map<string, CrossSessionComm>();
  const spawnAsyncItems: RegisterSpawnAsyncItemInput[] = [];
  const spawnQueueItems = new Map<string, SpawnQueueItem>();
  const tokenUsageRawTotals = new Map<SessionId, TokenUsageRawTotals | null>();
  const heartbeatEnabled = new Set<SessionId>();

  function seedSession(s: Session): void {
    sessions.set(s.id, { ...s });
  }

  function seedBinding(b: Binding): void {
    bindings.set(b.groupId, { ...b });
  }

  function seedAttachments(sessionId: SessionId, refs: AttachmentRef[]): void {
    attachments.set(sessionId, [...refs]);
  }

  function seedTokenUsageRawTotals(sessionId: SessionId, totals: TokenUsageRawTotals | null): void {
    tokenUsageRawTotals.set(sessionId, totals ? { ...totals } : null);
  }

  return {
    seedSession,
    seedBinding,
    seedAttachments,
    seedTokenUsageRawTotals,
    _getMessageRun(id: MessageRunId): MessageRun | null {
      const r = messageRuns.get(id);
      return r ? { ...r } : null;
    },
    _listMessageRuns(): MessageRun[] {
      return [...messageRuns.values()].map((r) => ({ ...r }));
    },
    _listCrossSessionComms(): CrossSessionComm[] {
      return [...crossSessionComms.values()].map((c) => ({ ...c }));
    },
    _listSpawnAsyncItems(): RegisterSpawnAsyncItemInput[] {
      return spawnAsyncItems.map((item) => ({ ...item }));
    },
    _listSpawnQueueItems(): SpawnQueueItem[] {
      return [...spawnQueueItems.values()].map((item) => ({ ...item }));
    },

    async init(): Promise<void> {},
    async close(): Promise<void> {},

    async createSession(input: NewSessionInput): Promise<Session> {
      const session: Session = {
        id: input.id,
        name: input.name,
        alias: input.alias ?? "",
        avatar: input.avatar ?? "",
        category: input.category ?? "", fpManaged: null,
        scope: input.scope,
        backend: input.backend,
        model: input.model ?? null,
        effort: null,
        thinking: false,
        modelLocked: false,
        workdir: input.workdir,
        backendSessionId: null,
        chatName: null,
        purpose: input.purpose,
        status: "idle",
        parentId: input.parentId ?? null,
        depth: input.depth ?? 0,
        inactivityTimeoutS: null,
        maxRuntimeS: null,
        childType: input.childType ?? null,
        triggerKind: input.triggerKind ?? null,
        postIdentity: input.postIdentity ?? null,
        callerInvocation: input.callerInvocation ?? null,
        continuationHook: input.continuationHook ?? null,
        capabilityPayload: input.capabilityPayload ?? null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      sessions.set(session.id, session);
      if (input.scope !== "child" && input.name !== "heartbeat") {
        heartbeatEnabled.add(session.id);
      }
      return { ...session };
    },

    async findSessionById(id: SessionId): Promise<Session | null> {
      return sessions.get(id) ?? null;
    },

    async findSessionByName(name: string): Promise<Session | null> {
      for (const s of sessions.values()) {
        if (s.name === name) return { ...s };
      }
      return null;
    },

    async listAllSessions(): Promise<Session[]> {
      return [...sessions.values()].map((s) => ({ ...s }));
    },

    async listActiveSessions(): Promise<Session[]> {
      return [...sessions.values()]
        .filter((s) => s.status !== "deleted")
        .map((s) => ({ ...s }));
    },

    async listActiveSessionsByBackend(backend?: string): Promise<Session[]> {
      return [...sessions.values()]
        .filter((s) => s.scope === "user" && s.status !== "deleted" && (!backend || s.backend === backend))
        .map((s) => ({ ...s }));
    },

    async updateSessionStatus(id: SessionId, status: SessionStatus, now: Timestamp): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, status, updatedAt: now });
    },

    async updateSessionModel(id: SessionId, model: string | null): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, model, updatedAt: asTimestamp(Date.now()) });
    },

    async updateSessionEffort(id: SessionId, effort: string | null): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, effort: effort as Session["effort"], updatedAt: asTimestamp(Date.now()) });
    },

    async updateSessionThinking(id: SessionId, thinking: boolean): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, thinking, updatedAt: asTimestamp(Date.now()) });
    },

    async updateSessionModelLocked(id: SessionId, locked: boolean): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, modelLocked: locked, updatedAt: asTimestamp(Date.now()) });
    },

    async getSessionHeartbeatEnabled(id: SessionId): Promise<boolean> {
      return heartbeatEnabled.has(id);
    },

    async updateSessionHeartbeatEnabled(id: SessionId, enabled: boolean): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      if (enabled) {
        heartbeatEnabled.add(id);
      } else {
        heartbeatEnabled.delete(id);
      }
      sessions.set(id, { ...s, updatedAt: asTimestamp(Date.now()) });
    },

    async listHeartbeatEnabledSessions(): Promise<Session[]> {
      return [...sessions.values()]
        .filter(
          (s) =>
            heartbeatEnabled.has(s.id) &&
            s.status !== "deleted" &&
            s.scope !== "child" &&
            s.name !== "heartbeat",
        )
        .sort((a, b) => a.updatedAt - b.updatedAt || a.name.localeCompare(b.name))
        .map((s) => ({ ...s }));
    },

    async updateSessionBackendSessionId(id: SessionId, backendSessionId: string | null): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, backendSessionId, updatedAt: asTimestamp(Date.now()) });
    },

    async updateSessionInactivityTimeout(id: SessionId, seconds: number | null): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, inactivityTimeoutS: seconds, updatedAt: asTimestamp(Date.now()) });
    },

    async updateSessionMaxRuntime(id: SessionId, seconds: number | null): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, maxRuntimeS: seconds, updatedAt: asTimestamp(Date.now()) });
    },

    async updateSessionBackend(id: SessionId, backend: string): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, backend: backend as Session["backend"], updatedAt: asTimestamp(Date.now()) });
    },

    async countActiveSessions(): Promise<number> {
      return [...sessions.values()].filter((s) => s.status !== "deleted").length;
    },

    async countBusySessions(): Promise<number> {
      return [...sessions.values()].filter((s) => s.status === "busy").length;
    },

    async findNonConformingAvatars(): Promise<Array<{ name: string; avatar: string }>> {
      const re = /^[A-Za-z0-9]+$/u;
      return [...sessions.values()]
        .filter((s) => s.status !== "deleted" && s.scope !== "child" && s.avatar !== "")
        .filter((s) => !(s.avatar.length === 27 && re.test(s.avatar)))
        .map((s) => ({ name: s.name, avatar: s.avatar }));
    },

    async createBinding(groupId: LarkGroupId, sessionId: SessionId, now: Timestamp): Promise<Binding> {
      const binding: Binding = { groupId, sessionId, createdAt: now };
      bindings.set(groupId, binding);
      return { ...binding };
    },

    async findByGroup(groupId: LarkGroupId): Promise<Binding | null> {
      return bindings.get(groupId) ?? null;
    },

    async findBySession(sessionId: SessionId): Promise<Binding | null> {
      for (const b of bindings.values()) {
        if (b.sessionId === sessionId) return { ...b };
      }
      return null;
    },

    async deleteBinding(groupId: LarkGroupId): Promise<void> {
      bindings.delete(groupId);
    },

    async createSessionWithBinding(
      input: NewSessionInput,
      groupId: LarkGroupId
    ): Promise<{ session: Session; binding: Binding }> {
      const existing = [...sessions.values()].find((s) => s.name === input.name);
      if (existing) throw new Error(`fakeBindingStore: name already exists: ${input.name}`);
      const session: Session = {
        id: input.id,
        name: input.name,
        alias: input.alias ?? "",
        avatar: input.avatar ?? "",
        category: input.category ?? "", fpManaged: null,
        scope: input.scope,
        backend: input.backend,
        model: input.model ?? null,
        effort: null,
        thinking: false,
        modelLocked: false,
        workdir: input.workdir,
        backendSessionId: null,
        chatName: null,
        purpose: input.purpose,
        status: "idle",
        parentId: input.parentId ?? null,
        depth: input.depth ?? 0,
        inactivityTimeoutS: null,
        maxRuntimeS: null,
        childType: null,
        triggerKind: null,
        postIdentity: null,
        callerInvocation: null,
        continuationHook: null,
        capabilityPayload: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      sessions.set(session.id, session);
      const binding: Binding = { groupId, sessionId: session.id, createdAt: input.createdAt };
      bindings.set(groupId, binding);
      return { session: { ...session }, binding: { ...binding } };
    },

    async deleteSessionAndBinding(sessionId: SessionId): Promise<void> {
      const now = asTimestamp(Date.now());
      const s = sessions.get(sessionId);
      if (s) {
        sessions.set(sessionId, { ...s, status: "deleted", updatedAt: now });
      }
      for (const [gid, b] of bindings.entries()) {
        if (b.sessionId === sessionId) {
          bindings.delete(gid);
          break;
        }
      }
      // Cascade: mirror sqlite store — children in non-terminal states are
      // marked deleted. Error rows are preserved for retention/audit.
      for (const [cid, c] of sessions) {
        if (
          c.parentId === sessionId &&
          c.scope === "child" &&
          c.status !== "deleted" &&
          c.status !== "error"
        ) {
          sessions.set(cid, { ...c, status: "deleted", updatedAt: now });
        }
      }
    },

    async recordAttachment(input: Omit<AttachmentRef, "id">): Promise<AttachmentRef> {
      const ref: AttachmentRef = {
        ...input,
        id: "att_" + Math.random().toString(36).slice(2, 8),
      };
      const list = attachments.get(input.sessionId) ?? [];
      list.push(ref);
      attachments.set(input.sessionId, list);
      return ref;
    },

    async listSessionAttachments(sessionId: SessionId): Promise<AttachmentRef[]> {
      return attachments.get(sessionId) ?? [];
    },

    async startMessageRun(input: NewMessageRunInput): Promise<MessageRunId> {
      const run: MessageRun = {
        id: input.id,
        sessionId: input.sessionId,
        groupId: input.groupId,
        prompt: input.prompt,
        cardId: null,
        startedAt: input.startedAt,
        finishedAt: null,
        status: "running",
        finalMessage: null,
        errorMessage: null,
      };
      messageRuns.set(input.id, run);
      return input.id;
    },

    async finishMessageRun(
      id: MessageRunId,
      status: RunStatus,
      finalMessage?: string,
      error?: string
    ): Promise<void> {
      const run = messageRuns.get(id);
      if (!run) return;
      messageRuns.set(id, {
        ...run,
        status,
        finishedAt: asTimestamp(Date.now()),
        finalMessage: finalMessage ?? null,
        errorMessage: error ?? null,
      });
    },

    async setMessageRunCardId() {
      notImpl("setMessageRunCardId");
    },

    async findRunningMessageRunBySession(sessionId: SessionId): Promise<MessageRun | null> {
      for (const run of messageRuns.values()) {
        if (run.sessionId === sessionId && run.status === "running") {
          return { ...run };
        }
      }
      return null;
    },

    async findLatestMessageRunBySession(sessionId: SessionId): Promise<MessageRun | null> {
      let latest: MessageRun | null = null;
      for (const run of messageRuns.values()) {
        if (run.sessionId !== sessionId) continue;
        if (!latest || run.startedAt > latest.startedAt) latest = run;
      }
      return latest ? { ...latest } : null;
    },

    async listRecentCompletedMessageRuns(sessionId: SessionId, limit: number): Promise<MessageRun[]> {
      const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
      return [...messageRuns.values()]
        .filter(
          (run) =>
            run.sessionId === sessionId &&
            run.status === "completed" &&
            run.prompt !== "" &&
            run.finalMessage !== null &&
            run.finalMessage !== ""
        )
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, safeLimit)
        .map((run) => ({ ...run }));
    },

    async resetBusySessionsOnBoot() {
      notImpl("resetBusySessionsOnBoot");
    },

    async resetRunningMessageRunsOnBoot() {
      notImpl("resetRunningMessageRunsOnBoot");
    },

    async findAllSessionsWithBackendSessionId() {
      notImpl("findAllSessionsWithBackendSessionId");
    },

    async findRunningMessageRuns() {
      notImpl("findRunningMessageRuns");
    },

    async markMessageRunTimeout() {
      notImpl("markMessageRunTimeout");
    },

    async recordTokenUsage() {
      // no-op: token-usage-aware tests set up their own store; default fake
      // tolerates callers that record usage incidentally (e.g. dispatcher tests).
    },

    async getLatestTokenUsageRawTotals(sessionId: SessionId) {
      const totals = tokenUsageRawTotals.get(sessionId);
      return totals ? { ...totals } : null;
    },

    async getTokenUsageSummary() {
      const empty = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rowCount: 0,
      };
      return { today: empty, last7Days: empty, cumulative: empty };
    },

    async countActiveChildrenByParent(parentId: SessionId): Promise<number> {
      return [...sessions.values()].filter(
        (s) => s.parentId === parentId && s.status === "busy"
      ).length;
    },

    async cleanupStaleChildSessions(cutoff: Timestamp): Promise<number> {
      let count = 0;
      for (const [id, s] of sessions) {
        if (s.scope === "child" && s.status === "idle" && s.updatedAt < cutoff) {
          sessions.set(id, { ...s, status: "deleted", updatedAt: cutoff });
          count++;
        }
      }
      return count;
    },

    async cleanupErroredChildSessions(cutoff: Timestamp): Promise<number> {
      let count = 0;
      for (const [id, s] of sessions) {
        if (s.scope === "child" && s.status === "error" && s.updatedAt < cutoff) {
          sessions.set(id, { ...s, status: "deleted", updatedAt: cutoff });
          count++;
        }
      }
      return count;
    },

    async cleanupStuckBusyChildren(cutoff: Timestamp): Promise<number> {
      let count = 0;
      for (const [id, s] of sessions) {
        if (
          s.scope === "child" &&
          s.status === "busy" &&
          s.backendSessionId === null &&
          s.updatedAt < cutoff
        ) {
          sessions.set(id, { ...s, status: "error", updatedAt: cutoff });
          count++;
        }
      }
      return count;
    },

    async logCrossSessionComm(input: NewCrossSessionComm): Promise<void> {
      crossSessionComms.set(input.id, {
        ...input,
        childModel: input.childModel ?? null,
        clientRequestId: input.clientRequestId ?? null,
        childSessionId: null,
        status: "pending",
        resultPreview: null,
        finalMessage: null,
        messageRunId: null,
        errorMessage: null,
        finishedAt: null,
        bitableRecordId: null,
        syncedAt: null,
      });
    },

    async createSpawnPredicate(_input: NewSpawnPredicateInput): Promise<SpawnPredicateRecord> {
      return notImpl("createSpawnPredicate");
    },

    async getSpawnPredicate(_spawnCommId: string): Promise<SpawnPredicateRecord | null> {
      return notImpl("getSpawnPredicate");
    },

    async patchSpawnPredicate(_input: PatchSpawnPredicateInput): Promise<SpawnPredicateRecord> {
      return notImpl("patchSpawnPredicate");
    },

    async listOpenSpawnPredicates(_cutoffMs: Timestamp, _limit?: number): Promise<OpenSpawnPredicateRecord[]> {
      return notImpl("listOpenSpawnPredicates");
    },

    async upsertWatcherState(_input: UpsertWatcherStateInput): Promise<void> {
      return notImpl("upsertWatcherState");
    },

    async getWatcherState(_spawnCommId: string): Promise<WatcherStateRecord | null> {
      return notImpl("getWatcherState");
    },

    async registerSpawnAsyncItem(input: RegisterSpawnAsyncItemInput): Promise<void> {
      spawnAsyncItems.push({ ...input });
    },

    async enqueueSpawnQueueItem(input: EnqueueSpawnQueueItemInput): Promise<void> {
      spawnQueueItems.set(input.id, {
        id: input.id,
        parentId: input.parentId,
        spawnInputJson: input.spawnInputJson,
        callerSession: input.callerSession ?? null,
        commId: input.commId,
        status: "pending",
        createdAt: input.createdAt,
        dispatchedAt: null,
        ttlSec: input.ttlSec,
        updatedAt: input.createdAt,
      });
    },

    async countPendingSpawnQueueItemsByParent(parentId: SessionId): Promise<number> {
      return [...spawnQueueItems.values()]
        .filter((item) => item.parentId === parentId && item.status === "pending")
        .length;
    },

    async claimNextSpawnQueueItem(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem | null> {
      const item = [...spawnQueueItems.values()]
        .filter((candidate) => candidate.parentId === parentId && candidate.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
      if (!item) return null;
      const claimed: SpawnQueueItem = {
        ...item,
        status: "dispatched",
        dispatchedAt: now,
        updatedAt: now,
      };
      spawnQueueItems.set(item.id, claimed);
      return { ...claimed };
    },

    async expireSpawnQueueItemsByParent(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem[]> {
      const expired: SpawnQueueItem[] = [];
      for (const [id, item] of spawnQueueItems) {
        if (
          item.parentId === parentId &&
          item.status === "pending" &&
          item.createdAt + item.ttlSec * 1000 <= now
        ) {
          const next: SpawnQueueItem = { ...item, status: "expired", updatedAt: now };
          spawnQueueItems.set(id, next);
          expired.push({ ...next });
        }
      }
      return expired.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    },

    async markSpawnQueueItemFailed(id: string, now: Timestamp): Promise<void> {
      const item = spawnQueueItems.get(id);
      if (!item) return;
      spawnQueueItems.set(id, { ...item, status: "failed", updatedAt: now });
    },

    async recordWatcherException(_input: RecordWatcherExceptionInput): Promise<void> {
      return notImpl("recordWatcherException");
    },

    async recordResultSinkAttempt(_input: ResultSinkAttemptInput): Promise<void> {
      return notImpl("recordResultSinkAttempt");
    },

    async listResultSinkAttemptsBySpawn(_spawnCommId: string): Promise<ResultSinkAttempt[]> {
      return notImpl("listResultSinkAttemptsBySpawn");
    },

    async finishCrossSessionComm(
      id: string,
      status: "completed" | "failed",
      childSessionId?: string,
      resultPreview?: string,
      error?: string,
      finalMessage?: string,
      messageRunId?: MessageRunId,
    ): Promise<void> {
      const comm = crossSessionComms.get(id);
      if (!comm) return;
      crossSessionComms.set(id, {
        ...comm,
        status,
        childSessionId: childSessionId ?? null,
        resultPreview: resultPreview ?? null,
        finalMessage: finalMessage ?? null,
        messageRunId: messageRunId ?? null,
        errorMessage: error ?? null,
        finishedAt: asTimestamp(Date.now()),
      });
    },

    async listCrossSessionComms(
      sessionId: SessionId,
      direction: "from" | "to",
      limit = 50,
    ): Promise<CrossSessionComm[]> {
      const key = direction === "from" ? "fromSessionId" : "toSessionId";
      return [...crossSessionComms.values()]
        .filter((c) => c[key] === sessionId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },

    async listAllCrossSessionComms(limit = 10000): Promise<CrossSessionComm[]> {
      return [...crossSessionComms.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },

    async listUnsyncedCrossSessionComms(): Promise<CrossSessionComm[]> {
      return [...crossSessionComms.values()]
        .filter((c) => c.bitableRecordId === null)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async listStaleSyncedCrossSessionComms(): Promise<CrossSessionComm[]> {
      return [...crossSessionComms.values()]
        .filter((c) => c.bitableRecordId !== null && c.finishedAt !== null && (c.syncedAt === null || c.syncedAt < c.finishedAt))
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async markCrossSessionCommSynced(id: string, bitableRecordId: string): Promise<void> {
      const comm = crossSessionComms.get(id);
      if (!comm) return;
      crossSessionComms.set(id, { ...comm, bitableRecordId, syncedAt: asTimestamp(Date.now()) });
    },

    async getRankStats(_input: GetRankStatsInput): Promise<RankStats> {
      return { rows: [], trackingSince: null };
    },

    async getDisplayNames(_senderIds: string[]): Promise<Map<string, DisplayNameEntry>> {
      return new Map();
    },
  };
}
