import type { Binding } from "../../src/domain/binding.ts";
import type { LarkGroupId, MessageRunId, SessionId, Timestamp } from "../../src/domain/ids.ts";
import { asTimestamp } from "../../src/domain/ids.ts";
import { RuntimeConfigConflictError } from "../../src/ports/BindingStore.ts";
import type {
  ChildSessionDefaults,
  ChildSessionDefaultsPatch,
} from "../../src/ports/ChildSessionDefaults.ts";
import {
  CANONICAL_MAIN_SESSION_DEFAULTS,
  type SessionRuntimeSettings,
  type SessionRuntimeSettingsPatch,
} from "../../src/ports/SessionRuntimeSettings.ts";
import type {
  BackendKind,
  EffortLevel,
  Session,
  SessionStatus,
} from "../../src/domain/session.ts";
import {
  MAIN_BRANCH_NAME,
  validateBranchName,
  type NewSessionBranchInput,
  type SessionBranchRecord,
} from "../../src/domain/sessionBranch.ts";
import type {
  AcquireBackendMaintenanceLeaseInput,
  AcquireBackendMaintenanceLeaseResult,
  AttachmentRef,
  BackendAccountSwitchRecord,
  BackendMaintenanceLease,
  BackendMaintenanceLeaseEvent,
  RecordBackendAccountSwitchInput,
  ReleaseBackendMaintenanceLeaseInput,
  ReleaseBackendMaintenanceLeaseResult,
  BindingStore,
  BootChildCleanupResult,
  BootOrphanedSpawnComm,
  ClaimDriveCommentMentionInput,
  CrossSessionComm,
  DisplayNameEntry,
  DriveCommentMentionRecord,
  EnqueueSpawnQueueItemInput,
  FinishDriveCommentMentionInput,
  GetRankStatsInput,
  MessageRun,
  MessageRunAdmissionInput,
  MessageRunAdmissionResult,
  NewCrossSessionComm,
  NewMessageRunInput,
  NewSessionInput,
  NewSpawnPredicateInput,
  OpenSpawnPredicateRecord,
  PatchSpawnPredicateInput,
  RankStats,
  RegisterSpawnAsyncItemInput,
  RecordResponseLogInput,
  RecordWatcherExceptionInput,
  FinishResponseLogInput,
  ResultSinkAttempt,
  ResultSinkAttemptInput,
  ResponseLogRecord,
  RunStatus,
  SessionRuntimeConfigAudit,
  SessionRuntimeConfigAuditSnapshot,
  SessionRuntimeConfigMutation,
  SessionRuntimeConfigPending,
  SessionRuntimeConfigRequested,
  SpawnAsyncItemDeliveredClosure,
  SpawnAsyncItemRecord,
  SpawnQueueItem,
  SpawnPredicateRecord,
  TokenUsageRawTotals,
  UpsertWatcherStateInput,
  WatcherStateRecord,
} from "../../src/ports/BindingStore.ts";

function notImpl(name: string): never {
  throw new Error(`fakeBindingStore: ${name} not implemented`);
}

function cloneRuntimeConfigAudit(audit: SessionRuntimeConfigAudit): SessionRuntimeConfigAudit {
  return structuredClone(audit);
}

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
  snapshot: SessionRuntimeConfigMutation["expected"],
): SessionRuntimeConfigAuditSnapshot {
  return {
    backend: snapshot.backend,
    model: snapshot.model,
    effort: snapshot.effort,
    resumeCleared: snapshot.backendSessionId === null,
  };
}

function runtimeConfigMatches(session: Session, mutation: SessionRuntimeConfigMutation): boolean {
  return session.backend === mutation.expected.backend
    && session.model === mutation.expected.model
    && session.effort === mutation.expected.effort
    && session.backendSessionId === mutation.expected.backendSessionId;
}

function defaultSessionRuntimeSettings(
  sessionId: SessionId,
  updatedAt: Timestamp,
  backend?: BackendKind,
): SessionRuntimeSettings {
  const defaults = backend
    ? CANONICAL_MAIN_SESSION_DEFAULTS[backend]
    : { mainModelDefault: null, mainEffortDefault: null };
  return {
    sessionId,
    ...defaults,
    childBackend: { configured: false, value: null },
    childModel: { configured: false, value: null },
    childEffort: { configured: false, value: null },
    updatedAt,
  };
}

function applySessionRuntimeSettingsPatch(
  current: SessionRuntimeSettings,
  patch: SessionRuntimeSettingsPatch,
  updatedAt: Timestamp = asTimestamp(Date.now()),
): SessionRuntimeSettings {
  return {
    ...current,
    ...(Object.hasOwn(patch, "mainModelDefault")
      ? { mainModelDefault: patch.mainModelDefault ?? null }
      : {}),
    ...(Object.hasOwn(patch, "mainEffortDefault")
      ? { mainEffortDefault: patch.mainEffortDefault ?? null }
      : {}),
    ...(Object.hasOwn(patch, "childBackend")
      ? { childBackend: structuredClone(patch.childBackend ?? { configured: false, value: null }) }
      : {}),
    ...(Object.hasOwn(patch, "childModel")
      ? { childModel: structuredClone(patch.childModel ?? { configured: false, value: null }) }
      : {}),
    ...(Object.hasOwn(patch, "childEffort")
      ? { childEffort: structuredClone(patch.childEffort ?? { configured: false, value: null }) }
      : {}),
    updatedAt,
  };
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
  _listSessionRuntimeConfigAudit(): SessionRuntimeConfigAudit[];
  _getPendingSessionRuntimeConfig(sessionId: SessionId): SessionRuntimeConfigPending | null;
} {
  const sessions = new Map<SessionId, Session>();
  const bindings = new Map<LarkGroupId, Binding>();
  const messageRuns = new Map<MessageRunId, MessageRun>();
  const branches = new Map<string, SessionBranchRecord>();
  const activeBranches = new Map<SessionId, string>();
  const attachments = new Map<SessionId, AttachmentRef[]>();
  const crossSessionComms = new Map<string, CrossSessionComm>();
  const spawnAsyncItems: Array<RegisterSpawnAsyncItemInput & {
    attemptCount?: number;
    lastAttemptAt?: Timestamp | null;
    verdict?: string | null;
    verdictReason?: string | null;
  }> = [];
  const spawnQueueItems = new Map<string, SpawnQueueItem>();
  const tokenUsageRawTotals = new Map<SessionId, TokenUsageRawTotals | null>();
  const backendRuntimeDefaults = new Map<BackendKind, {
    backend: BackendKind;
    model: string | null;
    effort: EffortLevel | null;
    updatedAt: Timestamp;
  }>();
  const sessionRuntimeSettings = new Map<SessionId, SessionRuntimeSettings>();
  let childSessionDefaults: ChildSessionDefaults = {
    backend: { configured: false, value: null },
    model: { configured: false, value: null },
    effort: { configured: false, value: null },
    updatedAt: null,
  };
  const heartbeatEnabled = new Set<SessionId>();
  const workspaceLocked = new Set<SessionId>();
  const runtimeConfigAudit: SessionRuntimeConfigAudit[] = [];
  const pendingRuntimeConfigs = new Map<SessionId, SessionRuntimeConfigPending & {
    requested: SessionRuntimeConfigRequested;
    catalogSource: string;
    catalogFingerprint: string;
  }>();
  const backendAccountSwitches = new Map<string, BackendAccountSwitchRecord>();
  const backendMaintenanceLeases = new Map<BackendKind, {
    lease: BackendMaintenanceLease;
    tokenHash: string;
  }>();
  const backendMaintenanceLeaseEvents: BackendMaintenanceLeaseEvent[] = [];
  let backendMaintenanceLeaseEventId = 0;

  function recordBackendMaintenanceLeaseEvent(
    input: Omit<BackendMaintenanceLeaseEvent, "id">,
  ): void {
    backendMaintenanceLeaseEvents.push({ id: ++backendMaintenanceLeaseEventId, ...input });
  }

  function countRunningMessageRunsByBackend(backend: BackendKind): number {
    return [...messageRuns.values()].filter((run) =>
      run.status === "running" && sessions.get(run.sessionId)?.backend === backend,
    ).length;
  }

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

  function branchKey(sessionId: SessionId, name: string): string {
    return `${sessionId}:${name}`;
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
      updatedAt: session.updatedAt,
    };
  }

  function findBranch(sessionId: SessionId, name: string): SessionBranchRecord | null {
    const normalized = validateBranchName(name);
    if (normalized === MAIN_BRANCH_NAME) {
      const session = sessions.get(sessionId);
      return session ? mainBranchFromSession(session) : null;
    }
    const branch = branches.get(branchKey(sessionId, normalized));
    return branch ? { ...branch } : null;
  }

  function failPendingSpawnCommsForChildSession(
    childSessionId: SessionId,
    reason: string,
  ): BootOrphanedSpawnComm[] {
    const failed: BootOrphanedSpawnComm[] = [];
    for (const [id, comm] of crossSessionComms.entries()) {
      if (comm.status !== "pending" || comm.childSessionId !== childSessionId) continue;
      const childId = comm.childSessionId as SessionId;
      crossSessionComms.set(id, {
        ...comm,
        status: "failed",
        errorMessage: reason,
        finishedAt: asTimestamp(Date.now()),
      });
      failed.push({
        commId: id,
        callerSessionId: comm.fromSessionId,
        callerSessionName: sessions.get(comm.fromSessionId)?.name ?? comm.fromSessionId,
        targetSessionName: sessions.get(comm.toSessionId)?.name ?? comm.toSessionId,
        childSessionId: childId,
        childSessionName: sessions.get(childId)?.name ?? childId,
      });
    }
    return failed;
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
    _listSessionRuntimeConfigAudit(): SessionRuntimeConfigAudit[] {
      return runtimeConfigAudit.map(cloneRuntimeConfigAudit);
    },
    _getPendingSessionRuntimeConfig(sessionId: SessionId): SessionRuntimeConfigPending | null {
      const pending = pendingRuntimeConfigs.get(sessionId);
      return pending ? structuredClone({
        sessionId: pending.sessionId,
        projected: pending.projected,
        createdAt: pending.createdAt,
        updatedAt: pending.updatedAt,
      }) : null;
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
        effort: input.effort ?? null,
        thinking: input.thinking ?? false,
        modelLocked: false,
        effortLocked: false,
        workdir: input.workdir,
        backendSessionId: null,
        chatName: null,
        purpose: input.purpose,
        status: "idle",
        affiliatedTo: input.affiliatedTo ?? null,
        parentId: input.parentId ?? null,
        depth: input.depth ?? 0,
        inactivityTimeoutS: input.inactivityTimeoutS ?? null,
        maxRuntimeS: input.maxRuntimeS ?? null,
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
      if (input.scope !== "child") {
        sessionRuntimeSettings.set(
          session.id,
          defaultSessionRuntimeSettings(session.id, session.updatedAt, session.backend),
        );
      }
      const heartbeatOn = input.heartbeatEnabled
        ?? (input.scope !== "child" && input.name !== "heartbeat");
      if (heartbeatOn) {
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

    async updateSessionEffortLocked(id: SessionId, locked: boolean): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      sessions.set(id, { ...s, effortLocked: locked, updatedAt: asTimestamp(Date.now()) });
    },

    async getBackendRuntimeDefaults(backend: BackendKind) {
      const value = backendRuntimeDefaults.get(backend);
      return value ? { ...value } : null;
    },

    async listBackendRuntimeDefaults() {
      return [...backendRuntimeDefaults.values()].map((value) => ({ ...value }));
    },

    async updateBackendRuntimeDefaults(
      backend: BackendKind,
      patch: { model?: string | null; effort?: EffortLevel | null },
    ): Promise<void> {
      const current = backendRuntimeDefaults.get(backend) ?? {
        backend,
        model: null,
        effort: null,
        updatedAt: asTimestamp(0),
      };
      backendRuntimeDefaults.set(backend, {
        backend,
        model: Object.hasOwn(patch, "model") ? patch.model ?? null : current.model,
        effort: Object.hasOwn(patch, "effort") ? patch.effort ?? null : current.effort,
        updatedAt: asTimestamp(Date.now()),
      });
    },

    async getChildSessionDefaults(): Promise<ChildSessionDefaults> {
      return structuredClone(childSessionDefaults);
    },

    async updateChildSessionDefaults(patch: ChildSessionDefaultsPatch): Promise<void> {
      const hasBackend = Object.hasOwn(patch, "backend");
      const hasModel = Object.hasOwn(patch, "model");
      const hasEffort = Object.hasOwn(patch, "effort");
      if (!hasBackend && !hasModel && !hasEffort) return;
      childSessionDefaults = {
        backend: hasBackend
          ? { ...(patch.backend ?? { configured: false, value: null }) }
          : childSessionDefaults.backend,
        model: hasModel
          ? { ...(patch.model ?? { configured: false, value: null }) }
          : childSessionDefaults.model,
        effort: hasEffort
          ? { ...(patch.effort ?? { configured: false, value: null }) }
          : childSessionDefaults.effort,
        updatedAt: asTimestamp(Date.now()),
      };
    },

    async compareAndSetChildSessionDefaults(
      expected: ChildSessionDefaults,
      patch: ChildSessionDefaultsPatch,
    ): Promise<boolean> {
      if (
        childSessionDefaults.backend.configured !== expected.backend.configured
        || childSessionDefaults.backend.value !== expected.backend.value
        || childSessionDefaults.model.configured !== expected.model.configured
        || childSessionDefaults.model.value !== expected.model.value
        || childSessionDefaults.effort.configured !== expected.effort.configured
        || childSessionDefaults.effort.value !== expected.effort.value
        || childSessionDefaults.updatedAt !== expected.updatedAt
      ) {
        return false;
      }
      const hasBackend = Object.hasOwn(patch, "backend");
      const hasModel = Object.hasOwn(patch, "model");
      const hasEffort = Object.hasOwn(patch, "effort");
      if (!hasBackend && !hasModel && !hasEffort) return false;
      childSessionDefaults = {
        backend: hasBackend
          ? { ...(patch.backend ?? { configured: false, value: null }) }
          : childSessionDefaults.backend,
        model: hasModel
          ? { ...(patch.model ?? { configured: false, value: null }) }
          : childSessionDefaults.model,
        effort: hasEffort
          ? { ...(patch.effort ?? { configured: false, value: null }) }
          : childSessionDefaults.effort,
        updatedAt: asTimestamp(Date.now()),
      };
      return true;
    },

    async getSessionRuntimeSettings(sessionId: SessionId): Promise<SessionRuntimeSettings | null> {
      const value = sessionRuntimeSettings.get(sessionId);
      return value ? structuredClone(value) : null;
    },

    async updateSessionRuntimeSettings(
      sessionId: SessionId,
      patch: SessionRuntimeSettingsPatch,
    ): Promise<void> {
      const current = sessionRuntimeSettings.get(sessionId)
        ?? defaultSessionRuntimeSettings(
          sessionId,
          asTimestamp(Date.now()),
          sessions.get(sessionId)?.backend,
        );
      sessionRuntimeSettings.set(sessionId, applySessionRuntimeSettingsPatch(current, patch));
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

    async getSessionWorkspaceLocked(id: SessionId): Promise<boolean> {
      return workspaceLocked.has(id);
    },

    async updateSessionWorkspaceLocked(id: SessionId, locked: boolean): Promise<void> {
      const s = sessions.get(id);
      if (!s) throw new Error(`fakeBindingStore: session not found: ${id}`);
      if (locked) {
        workspaceLocked.add(id);
      } else {
        workspaceLocked.delete(id);
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
      const updatedAt = asTimestamp(Date.now());
      sessions.set(id, {
        ...s,
        backendSessionId,
        backendSessionUpdatedAt: backendSessionId ? updatedAt : null,
        updatedAt,
      });
    },

    async getActiveBranch(sessionId: SessionId): Promise<SessionBranchRecord> {
      const activeName = activeBranches.get(sessionId) ?? MAIN_BRANCH_NAME;
      const active = findBranch(sessionId, activeName);
      if (active) return active;
      const main = findBranch(sessionId, MAIN_BRANCH_NAME);
      if (!main) throw new Error(`fakeBindingStore: session not found: ${sessionId}`);
      activeBranches.set(sessionId, MAIN_BRANCH_NAME);
      return main;
    },

    async listSessionBranches(sessionId: SessionId): Promise<SessionBranchRecord[]> {
      const main = findBranch(sessionId, MAIN_BRANCH_NAME);
      if (!main) return [];
      const named = [...branches.values()]
        .filter((branch) => branch.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
        .map((branch) => ({ ...branch }));
      return [main, ...named];
    },

    async findSessionBranch(sessionId: SessionId, name: string): Promise<SessionBranchRecord | null> {
      return findBranch(sessionId, name);
    },

    async createSessionBranch(input: NewSessionBranchInput): Promise<SessionBranchRecord> {
      const name = validateBranchName(input.name);
      if (name === MAIN_BRANCH_NAME) throw new Error("main branch already exists");
      const key = branchKey(input.sessionId, name);
      if (branches.has(key)) throw new Error(`branch already exists: ${name}`);
      const createdAt = input.createdAt;
      const branch: SessionBranchRecord = {
        sessionId: input.sessionId,
        name,
        backendSessionId: input.backendSessionId ?? null,
        sourceBranchName: input.sourceBranchName ?? null,
        sourceBackendSessionId: input.sourceBackendSessionId ?? null,
        forkPending: Boolean(input.forkPending),
        createdAt,
        updatedAt: createdAt,
      };
      branches.set(key, branch);
      return { ...branch };
    },

    async setActiveBranch(sessionId: SessionId, branchName: string): Promise<void> {
      const name = validateBranchName(branchName);
      const branch = findBranch(sessionId, name);
      if (!branch) throw new Error(`branch not found: ${name}`);
      activeBranches.set(sessionId, name);
    },

    async updateSessionBranchBackendSessionId(
      sessionId: SessionId,
      branchName: string,
      backendSessionId: string,
      now: Timestamp,
    ): Promise<void> {
      const name = validateBranchName(branchName);
      if (name === MAIN_BRANCH_NAME) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`fakeBindingStore: session not found: ${sessionId}`);
        sessions.set(sessionId, {
          ...session,
          backendSessionId,
          backendSessionUpdatedAt: backendSessionId ? now : null,
          updatedAt: now,
        });
        return;
      }
      const key = branchKey(sessionId, name);
      const branch = branches.get(key);
      if (!branch) throw new Error(`branch not found: ${name}`);
      branches.set(key, {
        ...branch,
        backendSessionId,
        forkPending: false,
        updatedAt: now,
      });
    },

    async clearSessionBranchBackendSessionId(
      sessionId: SessionId,
      branchName: string,
      now: Timestamp,
    ): Promise<void> {
      const name = validateBranchName(branchName);
      if (name === MAIN_BRANCH_NAME) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`fakeBindingStore: session not found: ${sessionId}`);
        sessions.set(sessionId, {
          ...session,
          backendSessionId: null,
          backendSessionUpdatedAt: null,
          updatedAt: now,
        });
        return;
      }
      const key = branchKey(sessionId, name);
      const branch = branches.get(key);
      if (!branch) throw new Error(`branch not found: ${name}`);
      branches.set(key, {
        ...branch,
        backendSessionId: null,
        sourceBackendSessionId: null,
        forkPending: false,
        updatedAt: now,
      });
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

    async applySessionRuntimeConfigMutations(
      mutations: readonly SessionRuntimeConfigMutation[],
    ): Promise<{ updated: number }> {
      const nextSessions = new Map(
        [...sessions.entries()].map(([id, session]) => [id, { ...session }]),
      );
      const nextAudit = runtimeConfigAudit.map(cloneRuntimeConfigAudit);
      const auditIds = new Set(nextAudit.map((audit) => audit.id));
      const nextSettings = new Map(
        [...sessionRuntimeSettings.entries()].map(([id, settings]) => [
          id,
          structuredClone(settings),
        ]),
      );

      for (const mutation of mutations) {
        const session = nextSessions.get(mutation.sessionId);
        const guardMatches = mutation.guard.kind === "idle"
          ? session?.status !== "busy" && session?.status !== "deleted"
          : session?.status === "busy"
            && messageRuns.get(mutation.guard.messageRunId)?.sessionId === mutation.sessionId
            && messageRuns.get(mutation.guard.messageRunId)?.status === "running";
        if (!session || !runtimeConfigMatches(session, mutation) || !guardMatches) {
          throw new RuntimeConfigConflictError(mutation.sessionId);
        }
        if (auditIds.has(mutation.audit.id)) {
          throw new Error(`UNIQUE constraint failed: session_runtime_config_audit.id`);
        }
        auditIds.add(mutation.audit.id);
        nextSessions.set(mutation.sessionId, {
          ...session,
          ...mutation.after,
          backendSessionUpdatedAt: mutation.after.backendSessionId === null
            ? null
            : session.backendSessionUpdatedAt ?? null,
          updatedAt: mutation.audit.createdAt,
        });
        if (mutation.settingsPatch) {
          const settings = nextSettings.get(mutation.sessionId)
            ?? defaultSessionRuntimeSettings(
              mutation.sessionId,
              mutation.audit.createdAt,
              session.backend,
            );
          nextSettings.set(
            mutation.sessionId,
            applySessionRuntimeSettingsPatch(settings, mutation.settingsPatch, mutation.audit.createdAt),
          );
        }
        nextAudit.push({
          ...structuredClone(mutation.audit),
          requested: projectRuntimeConfigRequested(mutation.audit.requested),
          sessionId: mutation.sessionId,
          before: projectRuntimeConfigAuditSnapshot(mutation.expected),
          after: projectRuntimeConfigAuditSnapshot(mutation.after),
        });
      }

      sessions.clear();
      for (const [id, session] of nextSessions) sessions.set(id, session);
      sessionRuntimeSettings.clear();
      for (const [id, settings] of nextSettings) sessionRuntimeSettings.set(id, settings);
      runtimeConfigAudit.splice(0, runtimeConfigAudit.length, ...nextAudit);
      return { updated: mutations.length };
    },

    async getPendingSessionRuntimeConfig(sessionId: SessionId): Promise<SessionRuntimeConfigPending | null> {
      const pending = pendingRuntimeConfigs.get(sessionId);
      return pending ? structuredClone({
        sessionId: pending.sessionId,
        projected: pending.projected,
        createdAt: pending.createdAt,
        updatedAt: pending.updatedAt,
      }) : null;
    },

    async queueSessionRuntimeConfigMutation(mutation: SessionRuntimeConfigMutation): Promise<void> {
      const session = sessions.get(mutation.sessionId);
      if (!session || session.status !== "busy") throw new RuntimeConfigConflictError(mutation.sessionId);
      const pending = pendingRuntimeConfigs.get(mutation.sessionId);
      const expected = pending?.projected ?? {
        backend: session.backend,
        model: session.model,
        effort: session.effort,
        backendSessionId: session.backendSessionId,
      };
      if (
        expected.backend !== mutation.expected.backend
        || expected.model !== mutation.expected.model
        || expected.effort !== mutation.expected.effort
        || expected.backendSessionId !== mutation.expected.backendSessionId
      ) throw new RuntimeConfigConflictError(mutation.sessionId);
      pendingRuntimeConfigs.set(mutation.sessionId, {
        sessionId: mutation.sessionId,
        projected: structuredClone(mutation.after),
        requested: projectRuntimeConfigRequested(mutation.audit.requested),
        catalogSource: mutation.audit.catalogSource,
        catalogFingerprint: mutation.audit.catalogFingerprint,
        createdAt: pending?.createdAt ?? mutation.audit.createdAt,
        updatedAt: mutation.audit.createdAt,
      });
      runtimeConfigAudit.push({
        ...structuredClone(mutation.audit),
        requested: projectRuntimeConfigRequested(mutation.audit.requested),
        sessionId: mutation.sessionId,
        before: projectRuntimeConfigAuditSnapshot(mutation.expected),
        after: projectRuntimeConfigAuditSnapshot(mutation.after),
      });
    },

    async drainPendingSessionRuntimeConfig(sessionId) {
      const pending = pendingRuntimeConfigs.get(sessionId);
      if (!pending) return { kind: "none" as const };
      const session = sessions.get(sessionId);
      if (!session || session.status === "deleted" || session.backend !== pending.projected.backend) {
        pendingRuntimeConfigs.delete(sessionId);
        runtimeConfigAudit.push({
          id: `cfg_pending_reject_${runtimeConfigAudit.length}`,
          sessionId,
          trigger: "pending-runtime-config",
          before: projectRuntimeConfigAuditSnapshot(pending.projected),
          requested: structuredClone(pending.requested),
          after: projectRuntimeConfigAuditSnapshot(pending.projected),
          decision: "reject",
          reason: "pending runtime config can no longer apply",
          catalogSource: pending.catalogSource,
          catalogFingerprint: pending.catalogFingerprint,
          createdAt: asTimestamp(Date.now()),
        });
        return { kind: "rejected" as const, reason: "pending runtime config can no longer apply" };
      }
      if (session.status === "busy") return { kind: "deferred" as const };
      sessions.set(sessionId, {
        ...session,
        model: pending.projected.model,
        effort: pending.projected.effort,
        updatedAt: asTimestamp(Date.now()),
      });
      pendingRuntimeConfigs.delete(sessionId);
      runtimeConfigAudit.push({
        id: `cfg_pending_apply_${runtimeConfigAudit.length}`,
        sessionId,
        trigger: "pending-runtime-config",
        before: projectRuntimeConfigAuditSnapshot({
          backend: session.backend,
          model: session.model,
          effort: session.effort,
          backendSessionId: session.backendSessionId,
        }),
        requested: structuredClone(pending.requested),
        after: projectRuntimeConfigAuditSnapshot({
          backend: session.backend,
          model: pending.projected.model,
          effort: pending.projected.effort,
          backendSessionId: session.backendSessionId,
        }),
        decision: "apply",
        reason: "queued runtime config applied after active run",
        catalogSource: pending.catalogSource,
        catalogFingerprint: pending.catalogFingerprint,
        createdAt: asTimestamp(Date.now()),
      });
      return { kind: "applied" as const };
    },

    async drainPendingSessionRuntimeConfigs(): Promise<number> {
      let applied = 0;
      for (const sessionId of [...pendingRuntimeConfigs.keys()]) {
        if ((await this.drainPendingSessionRuntimeConfig(sessionId)).kind === "applied") applied += 1;
      }
      return applied;
    },

    async guardIdleSessionRuntimeConfig(sessionId, expected) {
      const session = sessions.get(sessionId);
      if (!session || session.status === "busy" || session.status === "deleted"
        || session.backend !== expected.backend || session.model !== expected.model
        || session.effort !== expected.effort || session.backendSessionId !== expected.backendSessionId) {
        throw new RuntimeConfigConflictError(sessionId);
      }
      return {
        backend: session.backend, model: session.model, effort: session.effort,
        backendSessionId: session.backendSessionId,
      };
    },

    async listSessionRuntimeConfigAudit(sessionId: SessionId): Promise<SessionRuntimeConfigAudit[]> {
      return runtimeConfigAudit
        .filter((audit) => audit.sessionId === sessionId)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .map(cloneRuntimeConfigAudit);
    },

    async countActiveSessions(): Promise<number> {
      return [...sessions.values()].filter((s) => s.status !== "deleted").length;
    },

    async countBusySessions(): Promise<number> {
      return [...sessions.values()].filter((s) => s.status === "busy").length;
    },

    async countBusySessionsByBackend(backend: BackendKind): Promise<number> {
      return [...sessions.values()]
        .filter((s) => s.backend === backend && s.status === "busy")
        .length;
    },

    async clearBackendSessionIdsForBackend(
      backend: BackendKind,
      now: Timestamp,
    ): Promise<{ sessions: number; branches: number }> {
      let clearedSessions = 0;
      let clearedBranches = 0;
      for (const [id, session] of sessions) {
        if (session.backend !== backend || session.status === "deleted") continue;
        if (session.backendSessionId !== null) {
          sessions.set(id, {
            ...session,
            backendSessionId: null,
            backendSessionUpdatedAt: null,
            updatedAt: now,
          });
          clearedSessions += 1;
        }
      }
      for (const [key, branch] of branches) {
        const session = sessions.get(branch.sessionId);
        if (!session || session.backend !== backend || session.status === "deleted") continue;
        if (
          branch.backendSessionId !== null
          || branch.sourceBackendSessionId !== null
          || branch.forkPending
        ) {
          branches.set(key, {
            ...branch,
            backendSessionId: null,
            sourceBackendSessionId: null,
            forkPending: false,
            updatedAt: now,
          });
          clearedBranches += 1;
        }
      }
      return { sessions: clearedSessions, branches: clearedBranches };
    },

    async findBackendAccountSwitch(clientRequestId: string): Promise<BackendAccountSwitchRecord | null> {
      const record = backendAccountSwitches.get(clientRequestId);
      return record ? { ...record } : null;
    },

    async recordBackendAccountSwitch(input: RecordBackendAccountSwitchInput): Promise<void> {
      if (backendAccountSwitches.has(input.clientRequestId)) {
        throw new Error(`fakeBindingStore: duplicate backend account switch: ${input.clientRequestId}`);
      }
      backendAccountSwitches.set(input.clientRequestId, {
        clientRequestId: input.clientRequestId,
        backend: input.backend,
        caller: input.caller,
        fromProfile: input.fromProfile ?? null,
        toProfile: input.toProfile ?? null,
        switchedAt: input.switchedAt ?? null,
        clearedSessions: input.clearedSessions,
        clearedBranches: input.clearedBranches,
        createdAt: input.createdAt,
      });
    },

    async acquireBackendMaintenanceLease(
      input: AcquireBackendMaintenanceLeaseInput,
    ): Promise<AcquireBackendMaintenanceLeaseResult> {
      const existing = backendMaintenanceLeases.get(input.backend);
      if (existing) {
        if (existing.lease.owner === input.owner && existing.tokenHash === input.tokenHash) {
          recordBackendMaintenanceLeaseEvent({
            backend: input.backend, action: "acquire", outcome: "duplicate", owner: input.owner,
            requestId: input.requestId, leaseOwner: existing.lease.owner,
            runningMessageRunCount: 0, createdAt: input.acquiredAt,
          });
          return { kind: "acquired", duplicate: true, lease: { ...existing.lease } };
        }
        recordBackendMaintenanceLeaseEvent({
          backend: input.backend, action: "acquire", outcome: "held", owner: input.owner,
          requestId: input.requestId, leaseOwner: existing.lease.owner,
          runningMessageRunCount: 0, createdAt: input.acquiredAt,
        });
        return { kind: "held", lease: { ...existing.lease } };
      }
      const runningMessageRunCount = countRunningMessageRunsByBackend(input.backend);
      if (runningMessageRunCount > 0) {
        recordBackendMaintenanceLeaseEvent({
          backend: input.backend, action: "acquire", outcome: "running_message_runs", owner: input.owner,
          requestId: input.requestId, leaseOwner: null,
          runningMessageRunCount, createdAt: input.acquiredAt,
        });
        return { kind: "running_message_runs", backend: input.backend, runningMessageRunCount };
      }
      const lease: BackendMaintenanceLease = {
        backend: input.backend, owner: input.owner, requestId: input.requestId, acquiredAt: input.acquiredAt,
      };
      backendMaintenanceLeases.set(input.backend, { lease, tokenHash: input.tokenHash });
      recordBackendMaintenanceLeaseEvent({
        backend: input.backend, action: "acquire", outcome: "acquired", owner: input.owner,
        requestId: input.requestId, leaseOwner: input.owner,
        runningMessageRunCount: 0, createdAt: input.acquiredAt,
      });
      return { kind: "acquired", duplicate: false, lease: { ...lease } };
    },

    async releaseBackendMaintenanceLease(
      input: ReleaseBackendMaintenanceLeaseInput,
    ): Promise<ReleaseBackendMaintenanceLeaseResult> {
      const existing = backendMaintenanceLeases.get(input.backend);
      if (!existing) {
        recordBackendMaintenanceLeaseEvent({
          backend: input.backend, action: "release", outcome: "not_held", owner: input.owner,
          requestId: input.requestId, leaseOwner: null,
          runningMessageRunCount: 0, createdAt: input.releasedAt,
        });
        return { kind: "released", duplicate: true };
      }
      if (existing.lease.owner !== input.owner) {
        recordBackendMaintenanceLeaseEvent({
          backend: input.backend, action: "release", outcome: "owner_mismatch", owner: input.owner,
          requestId: input.requestId, leaseOwner: existing.lease.owner,
          runningMessageRunCount: 0, createdAt: input.releasedAt,
        });
        return { kind: "owner_mismatch", lease: { ...existing.lease } };
      }
      if (existing.tokenHash !== input.tokenHash) {
        recordBackendMaintenanceLeaseEvent({
          backend: input.backend, action: "release", outcome: "token_mismatch", owner: input.owner,
          requestId: input.requestId, leaseOwner: existing.lease.owner,
          runningMessageRunCount: 0, createdAt: input.releasedAt,
        });
        return { kind: "token_mismatch", lease: { ...existing.lease } };
      }
      backendMaintenanceLeases.delete(input.backend);
      recordBackendMaintenanceLeaseEvent({
        backend: input.backend, action: "release", outcome: "released", owner: input.owner,
        requestId: input.requestId, leaseOwner: existing.lease.owner,
        runningMessageRunCount: 0, createdAt: input.releasedAt,
      });
      return { kind: "released", duplicate: false, lease: { ...existing.lease } };
    },

    async getBackendMaintenanceLease(backend: BackendKind): Promise<BackendMaintenanceLease | null> {
      const existing = backendMaintenanceLeases.get(backend);
      return existing ? { ...existing.lease } : null;
    },

    async listBackendMaintenanceLeaseEvents(
      backend: BackendKind,
      limit = 100,
    ): Promise<BackendMaintenanceLeaseEvent[]> {
      const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 100;
      return backendMaintenanceLeaseEvents
        .filter((event) => event.backend === backend)
        .sort((a, b) => b.id - a.id)
        .slice(0, safeLimit)
        .map((event) => ({ ...event }));
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
        effort: input.effort ?? null,
        thinking: input.thinking ?? false,
        modelLocked: false,
        effortLocked: false,
        workdir: input.workdir,
        backendSessionId: null,
        chatName: null,
        purpose: input.purpose,
        status: "idle",
        affiliatedTo: input.affiliatedTo ?? null,
        parentId: input.parentId ?? null,
        depth: input.depth ?? 0,
        inactivityTimeoutS: input.inactivityTimeoutS ?? null,
        maxRuntimeS: input.maxRuntimeS ?? null,
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
      if (input.scope !== "child") {
        sessionRuntimeSettings.set(
          session.id,
          defaultSessionRuntimeSettings(session.id, session.updatedAt, session.backend),
        );
      }
      const heartbeatOn = input.heartbeatEnabled
        ?? (input.scope !== "child" && input.name !== "heartbeat");
      if (heartbeatOn) heartbeatEnabled.add(session.id);
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

    async admitMessageRun(input: MessageRunAdmissionInput): Promise<MessageRunAdmissionResult> {
      const session = sessions.get(input.sessionId);
      if (!session) return { kind: "not_admittable", status: null };
      const isAdmittable = session.status === "idle"
        || (input.allowInitializing === true && session.status === "initializing");
      if (!isAdmittable) {
        const running = [...messageRuns.values()].find(
          (run) => run.sessionId === input.sessionId && run.status === "running",
        );
        return running
          ? { kind: "busy", currentRunId: running.id }
          : { kind: "not_admittable", status: session.status };
      }
      const maintenance = backendMaintenanceLeases.get(session.backend);
      if (maintenance) {
        return { kind: "maintenance", backend: session.backend, lease: { ...maintenance.lease } };
      }
      const running = [...messageRuns.values()].find(
        (run) => run.sessionId === input.sessionId && run.status === "running",
      );
      if (running) return { kind: "busy", currentRunId: running.id };
      const previousStatus = session.status;
      sessions.set(session.id, { ...session, status: "busy", updatedAt: input.startedAt });
      messageRuns.set(input.id, {
        id: input.id,
        sessionId: input.sessionId,
        groupId: input.groupId,
        prompt: input.prompt,
        branchName: input.branchName ?? MAIN_BRANCH_NAME,
        cardId: null,
        startedAt: input.startedAt,
        finishedAt: null,
        status: "running",
        finalMessage: null,
        errorMessage: null,
      });
      return {
        kind: "admitted",
        backend: session.backend,
        runtimeConfig: {
          backend: session.backend,
          model: session.model,
          effort: session.effort,
          backendSessionId: session.backendSessionId,
        },
        previousStatus: previousStatus as "idle" | "initializing",
        messageRunId: input.id,
      };
    },

    async startMessageRun(input: NewMessageRunInput): Promise<MessageRunId> {
      const run: MessageRun = {
        id: input.id,
        sessionId: input.sessionId,
        groupId: input.groupId,
        prompt: input.prompt,
        branchName: input.branchName ?? MAIN_BRANCH_NAME,
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

    async listRecentMessageRuns(sessionId: SessionId, limit: number, branchName?: string): Promise<MessageRun[]> {
      const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
      return [...messageRuns.values()]
        .filter((run) => run.sessionId === sessionId && (!branchName || run.branchName === branchName))
        .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
        .slice(0, safeLimit)
        .map((run) => ({ ...run }));
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

    async timeoutMessageRunAndFailPendingSpawnComms(): Promise<BootOrphanedSpawnComm[]> {
      return notImpl("timeoutMessageRunAndFailPendingSpawnComms");
    },

    async recoverBootOrphanedSpawnReceipts(): Promise<BootOrphanedSpawnComm[]> {
      return [];
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

    async getSchedulerTokenUsage() {
      return [];
    },

    async countActiveChildrenByParent(parentId: SessionId): Promise<number> {
      return [...sessions.values()].filter(
        (s) => s.parentId === parentId && s.status === "busy"
      ).length;
    },

    async cleanupStaleChildSessions(cutoff: Timestamp): Promise<BootChildCleanupResult> {
      let count = 0;
      const failedComms: BootOrphanedSpawnComm[] = [];
      for (const [id, s] of sessions) {
        if (s.scope === "child" && s.status === "idle" && s.updatedAt < cutoff) {
          failedComms.push(...failPendingSpawnCommsForChildSession(id, "orphaned by console restart"));
          sessions.set(id, { ...s, status: "deleted", updatedAt: cutoff });
          count++;
        }
      }
      return { count, failedComms };
    },

    async cleanupErroredChildSessions(cutoff: Timestamp): Promise<BootChildCleanupResult> {
      let count = 0;
      const failedComms: BootOrphanedSpawnComm[] = [];
      for (const [id, s] of sessions) {
        if (s.scope === "child" && s.status === "error" && s.updatedAt < cutoff) {
          failedComms.push(...failPendingSpawnCommsForChildSession(id, "orphaned by console restart"));
          sessions.set(id, { ...s, status: "deleted", updatedAt: cutoff });
          count++;
        }
      }
      return { count, failedComms };
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
        originRunId: input.originRunId ?? null,
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

    async findCrossSessionCommForDedup(clientRequestId: string) {
      const match = [...crossSessionComms.values()]
        .filter((c) => c.clientRequestId === clientRequestId && c.status !== "failed")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!match) return null;
      return {
        id: match.id,
        status: match.status,
        childSessionId: match.childSessionId,
        createdAt: match.createdAt,
      };
    },

    async attachCrossSessionChild(id: string, childSessionId: SessionId, messageRunId: MessageRunId): Promise<void> {
      const comm = crossSessionComms.get(id);
      if (!comm) return;
      crossSessionComms.set(id, {
        ...comm,
        childSessionId,
        messageRunId,
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
    async getSpawnAsyncItem(ref: string): Promise<SpawnAsyncItemRecord | null> {
      const item = spawnAsyncItems.find((candidate) => candidate.ref === ref);
      if (!item) return null;
      const comm = crossSessionComms.get(item.commId);
      return {
        ...item,
        attemptCount: item.attemptCount ?? 0,
        status: item.status ?? "pending",
        verdict: item.verdict ?? null,
        verdictReason: item.verdictReason ?? null,
        lastAttemptAt: item.lastAttemptAt ?? null,
        childSessionId: comm?.childSessionId ?? null,
        messageRunId: comm?.messageRunId ?? null,
        commStatus: comm?.status ?? null,
        finalMessage: comm?.finalMessage ?? null,
        errorMessage: comm?.errorMessage ?? null,
        originRunId: comm?.originRunId ?? null,
      };
    },
    async getSpawnAsyncItemByComm(commId: string): Promise<SpawnAsyncItemRecord | null> {
      const item = [...spawnAsyncItems]
        .filter((candidate) => candidate.commId === commId)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
      if (!item) return null;
      return this.getSpawnAsyncItem(item.ref);
    },
    async listSpawnAsyncItemsByCallerSession(callerSession: string, limit = 100): Promise<SpawnAsyncItemRecord[]> {
      const rows = spawnAsyncItems
        .filter((candidate) => candidate.callerSession === callerSession)
        .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt))
        .slice(0, limit);
      const items: SpawnAsyncItemRecord[] = [];
      for (const row of rows) {
        const item = await this.getSpawnAsyncItem(row.ref);
        if (item) items.push(item);
      }
      return items;
    },
    async closeSpawnAsyncItemConsumed(ref: string, reason: string, now: Timestamp): Promise<boolean> {
      const index = spawnAsyncItems.findIndex((candidate) => candidate.ref === ref);
      if (index < 0) return false;
      const item = spawnAsyncItems[index]!;
      const status = item.status ?? "pending";
      // Take may steal an in-flight push (delivering) before finalize.
      if (status !== "pending" && status !== "waiting_child" && status !== "delivering") return false;
      spawnAsyncItems[index] = {
        ...item,
        status: "closed",
        verdict: "caller_consumed",
        verdictReason: reason,
        updatedAt: now,
      };
      return true;
    },
    async closeSpawnAsyncItemSyncDelivered(commId: string, reason: string, now: Timestamp): Promise<number> {
      let changes = 0;
      for (let index = 0; index < spawnAsyncItems.length; index += 1) {
        const item = spawnAsyncItems[index]!;
        if (item.commId !== commId) continue;
        const status = item.status ?? "pending";
        if (status !== "pending" && status !== "waiting_child" && status !== "delivering") continue;
        spawnAsyncItems[index] = {
          ...item,
          status: "closed",
          verdict: "delivered",
          verdictReason: reason,
          updatedAt: now,
        };
        changes += 1;
      }
      return changes;
    },
    async claimSpawnAsyncItemForDelivery(ref: string, now: Timestamp): Promise<SpawnAsyncItemRecord | null> {
      const index = spawnAsyncItems.findIndex((candidate) => candidate.ref === ref);
      if (index < 0) return null;
      const item = spawnAsyncItems[index]!;
      const status = item.status ?? "pending";
      if (status !== "pending" && status !== "waiting_child") return null;
      const record = await this.getSpawnAsyncItem(ref);
      spawnAsyncItems[index] = { ...item, status: "delivering", lastAttemptAt: now, updatedAt: now };
      return record;
    },
    async markSpawnAsyncItemAdjudicationEscalated(ref: string, reason: string, now: Timestamp): Promise<void> {
      const index = spawnAsyncItems.findIndex((candidate) => candidate.ref === ref);
      if (index < 0) return;
      const item = spawnAsyncItems[index]!;
      const isTerminalSuccess =
        item.status === "closed" && (item.verdict === "delivered" || item.verdict === "caller_consumed");
      if (isTerminalSuccess) return;
      spawnAsyncItems[index] = {
        ...item,
        status: "closed",
        verdict: "escalated",
        verdictReason: reason,
        updatedAt: now,
      };
    },
    async markSpawnAsyncItemDelivered(
      ref: string,
      closure: SpawnAsyncItemDeliveredClosure,
      now: Timestamp,
    ): Promise<boolean> {
      const index = spawnAsyncItems.findIndex((candidate) => candidate.ref === ref);
      if (index < 0) return false;
      const item = spawnAsyncItems[index]!;
      if ((item.status ?? "pending") !== "delivering") return false;
      spawnAsyncItems[index] = {
        ...item,
        attemptCount: (item.attemptCount ?? 0) + 1,
        status: "closed",
        verdict: closure.verdict,
        verdictReason: closure.reason,
        lastAttemptAt: now,
        updatedAt: now,
      };
      return true;
    },
    async parkSpawnAsyncItemDeliveryUnsupported(ref: string, reason: string, now: Timestamp): Promise<boolean> {
      const index = spawnAsyncItems.findIndex((candidate) => candidate.ref === ref);
      if (index < 0) return false;
      const item = spawnAsyncItems[index]!;
      if ((item.status ?? "pending") !== "delivering") return false;
      spawnAsyncItems[index] = {
        ...item,
        status: "parked",
        verdict: "delivery_unsupported_caller_heartbeat_disabled",
        verdictReason: reason,
        lastAttemptAt: now,
        updatedAt: now,
      };
      return true;
    },
    async releaseSpawnAsyncItemDelivery(ref: string, previousStatus: "pending" | "waiting_child", now: Timestamp): Promise<void> {
      const index = spawnAsyncItems.findIndex((candidate) => candidate.ref === ref);
      if (index < 0) return;
      const item = spawnAsyncItems[index]!;
      if ((item.status ?? "pending") !== "delivering") return;
      spawnAsyncItems[index] = { ...item, status: previousStatus, updatedAt: now };
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

    async claimDriveCommentMention(_input: ClaimDriveCommentMentionInput): Promise<boolean> {
      return notImpl("claimDriveCommentMention");
    },

    async finishDriveCommentMention(_input: FinishDriveCommentMentionInput): Promise<void> {
      return notImpl("finishDriveCommentMention");
    },

    async findDriveCommentMention(_dedupeKey: string): Promise<DriveCommentMentionRecord | null> {
      return notImpl("findDriveCommentMention");
    },

    async recordResponseLog(_input: RecordResponseLogInput): Promise<void> {
      return notImpl("recordResponseLog");
    },

    async finishResponseLog(_input: FinishResponseLogInput): Promise<void> {
      return notImpl("finishResponseLog");
    },

    async findResponseLog(_responseId: string): Promise<ResponseLogRecord | null> {
      return notImpl("findResponseLog");
    },

    async listPendingResponseLogs(_limit?: number): Promise<ResponseLogRecord[]> {
      return notImpl("listPendingResponseLogs");
    },

    async markResponseLogMirrorOk(
      _responseId: string,
      _recordId: string,
      _now: Timestamp,
    ): Promise<void> {
      return notImpl("markResponseLogMirrorOk");
    },

    async markResponseLogMirrorFailed(
      _responseId: string,
      _error: string,
      _now: Timestamp,
    ): Promise<void> {
      return notImpl("markResponseLogMirrorFailed");
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
