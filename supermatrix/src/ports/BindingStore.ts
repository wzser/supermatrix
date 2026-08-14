import type { Binding } from "../domain/binding.ts";
import type {
  CallerInvocation,
  CapabilityPayload,
  ChildSessionType,
  ContinuationHook,
  PostIdentity,
  TriggerKind,
} from "../domain/childCapabilities.ts";
import type {
  AbsolutePath,
  CardId,
  LarkGroupId,
  MessageRunId,
  SessionId,
  Timestamp,
} from "../domain/ids.ts";
import type {
  BackendKind,
  EffortLevel,
  Session,
  SessionCategory,
  SessionStatus,
} from "../domain/session.ts";
import type {
  NewSessionBranchInput,
  SessionBranchRecord,
} from "../domain/sessionBranch.ts";
import type {
  PredicateEvaluationResultState,
  PredicateTriggerSignal,
  SpawnPredicate,
} from "../domain/spawnPredicate.ts";
import type { Scope } from "../domain/scope.ts";
import type { AttachmentRef, AttachmentKind } from "../domain/attachment.ts";
import type {
  ChildSessionDefaults,
  ChildSessionDefaultsPatch,
} from "./ChildSessionDefaults.ts";
import type {
  SessionRuntimeSettings,
  SessionRuntimeSettingsPatch,
} from "./SessionRuntimeSettings.ts";

export type { AttachmentRef, AttachmentKind };

export type NewSessionInput = {
  id: SessionId;
  name: string;
  scope: Scope;
  backend: BackendKind;
  workdir: AbsolutePath;
  purpose: string;
  createdAt: Timestamp;
  model?: string | null;
  effort?: EffortLevel | null;
  // Backend-neutral settings that may be seeded atomically at creation time
  // (for example by `/new clone`). Backend context and model/effort locks
  // intentionally always start fresh.
  thinking?: boolean;
  inactivityTimeoutS?: number | null;
  maxRuntimeS?: number | null;
  heartbeatEnabled?: boolean;
  affiliatedTo?: string | null;
  parentId?: SessionId | null;
  depth?: number;
  // Optional session-meta fields. Format-validated at write time per FP v1.0
  // contract (workspaces/first-principle/rules/session-meta-fields.md). In
  // production these are written by FP scripts, not by SuperMatrix code.
  // chat_name is intentionally absent — contract §4 option (a):
  // no new chat_name writers; existing rows untouched.
  alias?: string;
  avatar?: string;
  category?: SessionCategory;
  childType?: ChildSessionType | null;
  triggerKind?: TriggerKind | null;
  postIdentity?: PostIdentity | null;
  callerInvocation?: CallerInvocation | null;
  continuationHook?: ContinuationHook | null;
  capabilityPayload?: CapabilityPayload | null;
};

export type NewAttachmentInput = Omit<AttachmentRef, "id">;

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "timeout";

export type NewMessageRunInput = {
  id: MessageRunId;
  sessionId: SessionId;
  groupId: LarkGroupId;
  prompt: string;
  startedAt: Timestamp;
  senderId?: string;  // Feishu open_id (ou_ prefix); NULL for historical rows
  branchName?: string;
};

export type RankRow = {
  senderId: string;
  total: number;
  inputChars: number;
  top3Sessions: Array<{ sessionName: string; count: number }>;
  allSessions: Array<{ sessionName: string; count: number }>;
};

export type RankStats = {
  rows: RankRow[];
  trackingSince: number | null;
};

export type GetRankStatsInput =
  | { scope: "global" }
  | { scope: "group"; groupId: LarkGroupId };

export type DisplayNameEntry = {
  displayName: string;
  fetchedAt: number;
};

export type MessageRun = {
  id: MessageRunId;
  sessionId: SessionId;
  groupId: LarkGroupId;
  prompt: string;
  branchName: string;
  cardId: CardId | null;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  status: RunStatus;
  finalMessage: string | null;
  errorMessage: string | null;
};

export type SessionRuntimeConfigSnapshot = Pick<
  Session,
  "backend" | "model" | "effort" | "backendSessionId"
>;

export type SessionRuntimeConfigAuditSnapshot = Pick<
  SessionRuntimeConfigSnapshot,
  "backend" | "model" | "effort"
> & {
  resumeCleared: boolean;
};

export type RuntimeConfigMutationGuard =
  | { kind: "idle" }
  | { kind: "active-run"; messageRunId: MessageRunId };

export type SessionRuntimeConfigRequested = {
  backend?: BackendKind;
  model?: string | null;
  effort?: EffortLevel | null;
};

export type SessionRuntimeConfigMutation = {
  sessionId: SessionId;
  expected: SessionRuntimeConfigSnapshot;
  after: SessionRuntimeConfigSnapshot;
  guard: RuntimeConfigMutationGuard;
  settingsPatch?: SessionRuntimeSettingsPatch;
  audit: {
    id: string;
    trigger: string;
    requested: SessionRuntimeConfigRequested;
    decision: string;
    reason: string;
    catalogSource: string;
    catalogFingerprint: string;
    createdAt: Timestamp;
  };
};

export type SessionRuntimeConfigAudit = SessionRuntimeConfigMutation["audit"] & {
  sessionId: SessionId;
  before: SessionRuntimeConfigAuditSnapshot;
  after: SessionRuntimeConfigAuditSnapshot;
};

export type SessionRuntimeConfigPending = {
  sessionId: SessionId;
  projected: SessionRuntimeConfigSnapshot;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type DrainPendingSessionRuntimeConfigResult =
  | { kind: "none" }
  | { kind: "deferred" }
  | { kind: "applied" }
  | { kind: "rejected"; reason: string };

export class RuntimeConfigConflictError extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`runtime config mutation conflict: ${sessionId}`);
    this.name = "RuntimeConfigConflictError";
  }
}

export type TokenUsageInput = {
  sessionId: SessionId;
  messageRunId: MessageRunId;
  backend: BackendKind;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  rawUsageJson: string | null;
  createdAt: Timestamp;
};

export type TokenUsageRawTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type TokenUsageWindow = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  rowCount: number;
};

export type TokenUsageSummary = {
  today: TokenUsageWindow;
  last7Days: TokenUsageWindow;
  cumulative: TokenUsageWindow;
};

export type TokenUsageWindowCutoffs = {
  todayStart: Timestamp;
  weekStart: Timestamp;
};

export type SchedulerTokenUsageTotals = TokenUsageRawTotals & {
  totalTokens: number;
  runCount: number;
};

export type SchedulerTokenUsage = SchedulerTokenUsageTotals & {
  taskId: string;
};

// "spawn" = request-side: a requester asked a target to spawn a child.
// "continuation" = notification-side: a child finished and pinged its parent
// via a synthesized system event. Both share the same columns; only the
// direction and semantics of message_run_id / final_message differ. See
// step 6 of the child-session redesign plan.
// "resume_main" = request-side: a requester asked a target to run a prompt
// on its existing main backend session via /api/run. No child is created;
// child_session_id stays NULL and message_run_id points at the run that
// happened on the target session itself.
export type CrossSessionCommKind = "spawn" | "continuation" | "resume_main";

export type NewCrossSessionComm = {
  id: string;
  fromSessionId: SessionId;
  toSessionId: SessionId;
  kind: CrossSessionCommKind;
  prompt: string;
  childModel?: string | null;
  clientRequestId?: string | null;
  originRunId?: MessageRunId | null;
  createdAt: Timestamp;
};

export type NormalizedSpawnPredicate = {
  predicate: SpawnPredicate;
  canonicalJson: string;
  predicateHash: string;
  predicate_hash: string;
};

export type CrossSessionComm = NewCrossSessionComm & {
  childSessionId: string | null;
  status: "pending" | "completed" | "failed";
  resultPreview: string | null;
  finalMessage: string | null;
  messageRunId: MessageRunId | null;
  errorMessage: string | null;
  finishedAt: Timestamp | null;
  bitableRecordId: string | null;
  syncedAt: Timestamp | null;
  childModel: string | null;
  clientRequestId: string | null;
  originRunId: MessageRunId | null;
};

// A spawn whose child was made unrecoverable by boot reconcile. The store
// returns the caller and child identities with the terminalization so
// bootstrap can notify the caller after Lark is ready.
export type BootOrphanedSpawnComm = {
  commId: string;
  callerSessionId: SessionId;
  callerSessionName: string;
  targetSessionName: string;
  childSessionId: SessionId;
  childSessionName: string;
};

export type BootChildCleanupResult = {
  count: number;
  failedComms: BootOrphanedSpawnComm[];
};

export type SpawnPredicateStatus = "active" | "disabled";

export type NewSpawnPredicateInput = {
  spawnCommId: string;
  ownerSessionId: SessionId;
  createdBySessionId: SessionId;
  normalizedPredicate: NormalizedSpawnPredicate;
  createdAt: Timestamp;
};

export type SpawnPredicateRecord = {
  spawnCommId: string;
  ownerSessionId: SessionId;
  createdBySessionId: SessionId;
  lastPatchedBySessionId: SessionId | null;
  fromSessionId: SessionId | null;
  toSessionId: SessionId | null;
  predicate: SpawnPredicate;
  predicateJson: string;
  predicateHash: string;
  version: number;
  status: SpawnPredicateStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type SpawnPredicatePatchRole = "owner" | "sk" | "root";

export type PatchSpawnPredicateInput = {
  id: string;
  spawnCommId: string;
  actorSessionId: SessionId;
  actorRole: SpawnPredicatePatchRole;
  txId?: string | null;
  reason: string;
  normalizedPredicate: NormalizedSpawnPredicate;
  patchedAt: Timestamp;
};

export type WatcherStateRecord = {
  spawnCommId: string;
  lastRunAt: Timestamp | null;
  lastRunResult: PredicateEvaluationResultState | null;
  lastRunError: string | null;
  lastRunDurationMs: number | null;
  consecutiveFalseCount: number;
  consecutiveTransientFailCount: number;
  patchCount24h: number;
  transactionStartedAt: Timestamp | null;
  lastTriggerSignal: PredicateTriggerSignal | null;
  nextEligibleAt: Timestamp | null;
  closedAt: Timestamp | null;
  leaseOwner: string | null;
  leaseExpiresAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type UpsertWatcherStateInput = Partial<Omit<WatcherStateRecord, "spawnCommId" | "createdAt" | "updatedAt">> & {
  spawnCommId: string;
  updatedAt: Timestamp;
};

export type OpenSpawnPredicateRecord = {
  predicate: SpawnPredicateRecord;
  watcherState: WatcherStateRecord | null;
};

export type ResultSinkAttemptStatus = "delivered" | "skipped" | "failed";

export type ResultSinkAttemptInput = {
  id: string;
  spawnCommId?: string | null;
  childSessionId: SessionId;
  messageRunId?: MessageRunId | null;
  sinkIndex: number;
  sinkKind: string;
  status: ResultSinkAttemptStatus;
  note?: string | null;
  errorMessage?: string | null;
  createdAt: Timestamp;
};

export type ResultSinkAttempt = ResultSinkAttemptInput & {
  spawnCommId: string | null;
  messageRunId: MessageRunId | null;
  note: string | null;
  errorMessage: string | null;
};

export type SpawnAsyncItemFailedPhase = "communication" | "execution" | "delivery";
export type SpawnAsyncItemFailureKind =
  | "spawn_not_started"
  | "run_error"
  | "run_timeout"
  | "empty_output"
  | "delivery_missing"
  | "late_result";
export type SpawnAsyncItemStatus =
  | "pending"
  | "waiting_child"
  | "delivering"
  | "re_driving"
  | "adjudicating"
  | "closed"
  | "parked";

export type RegisterSpawnAsyncItemInput = {
  ref: string;
  commId: string;
  callerSession: string;
  targetSession: string;
  failedPhase: SpawnAsyncItemFailedPhase;
  failureKind: SpawnAsyncItemFailureKind;
  status?: SpawnAsyncItemStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type SpawnAsyncItemRecord = RegisterSpawnAsyncItemInput & {
  attemptCount: number;
  status: SpawnAsyncItemStatus;
  verdict: string | null;
  verdictReason: string | null;
  lastAttemptAt: Timestamp | null;
  childSessionId: string | null;
  messageRunId: MessageRunId | null;
  commStatus: CrossSessionComm["status"] | null;
  finalMessage: string | null;
  errorMessage: string | null;
  clientRequestId?: string | null;
  originRunId: MessageRunId | null;
};

export type DeliverableSpawnAsyncItemStatus = Extract<SpawnAsyncItemStatus, "pending" | "waiting_child">;

export type SpawnAsyncItemDeliveredClosure = {
  verdict: "delivered" | "adjudication_result_recorded";
  reason: string;
};

export type SpawnQueueStatus = "pending" | "dispatched" | "expired" | "failed";

export type EnqueueSpawnQueueItemInput = {
  id: string;
  parentId: SessionId;
  spawnInputJson: string;
  callerSession?: SessionId | null;
  commId: string;
  createdAt: Timestamp;
  ttlSec: number;
};

export type SpawnQueueItem = {
  id: string;
  parentId: SessionId;
  spawnInputJson: string;
  callerSession: SessionId | null;
  commId: string;
  status: SpawnQueueStatus;
  createdAt: Timestamp;
  dispatchedAt: Timestamp | null;
  ttlSec: number;
  updatedAt: Timestamp;
};

export type RecordWatcherExceptionInput = {
  id: string;
  ts: Timestamp;
  spawnCommId: string | null;
  triggerSignal: string;
  txId: string | null;
  dedupeKey: string | null;
  summary: string;
  payload: string | null;
  larkMessageId: string | null;
  resolvedAt: Timestamp | null;
};

export type DriveCommentMentionStatus = "processing" | "completed" | "failed";

export type ClaimDriveCommentMentionInput = {
  dedupeKey: string;
  eventId: string;
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId?: string | null;
  fromUserId?: string | null;
  targetSession: string;
  matchedRule: string;
  now: Timestamp;
};

export type FinishDriveCommentMentionInput = {
  dedupeKey: string;
  status: Exclude<DriveCommentMentionStatus, "processing">;
  resultText?: string | null;
  errorMessage?: string | null;
  now: Timestamp;
};

export type DriveCommentMentionRecord = {
  dedupeKey: string;
  eventId: string;
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId: string | null;
  fromUserId: string | null;
  targetSession: string;
  matchedRule: string;
  status: DriveCommentMentionStatus;
  resultText: string | null;
  errorMessage: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
};

export type ResponseLogSource = "im" | "doc_comment" | "base_comment" | "wiki_comment";
export type ResponseLogStatus = "sent" | "failed" | "skipped" | "deferred";
export type ResponseLogMirrorStatus = "pending" | "ok" | "failed";

export type RecordResponseLogInput = {
  responseId: string;
  source: ResponseLogSource;
  sourceRef: string;
  sourceUrl?: string | null;
  mentioner?: string | null;
  mentionedAt: Timestamp;
  triggerText?: string | null;
  createdAt: Timestamp;
};

export type FinishResponseLogInput = {
  responseId: string;
  responseStatus: Exclude<ResponseLogStatus, "deferred">;
  responseText?: string | null;
  responseAt: Timestamp;
  responseError?: string | null;
  now: Timestamp;
};

export type ResponseLogRecord = {
  id: number;
  responseId: string;
  source: ResponseLogSource;
  sourceRef: string;
  sourceUrl: string | null;
  mentioner: string | null;
  mentionedAt: Timestamp;
  triggerText: string | null;
  responseText: string | null;
  responseAt: Timestamp | null;
  responseStatus: ResponseLogStatus;
  responseError: string | null;
  mirrorStatus: ResponseLogMirrorStatus;
  mirrorRecordId: string | null;
  mirrorSyncedAt: Timestamp | null;
  mirrorError: string | null;
  mirrorRetryCount: number;
  createdAt: Timestamp;
};

export type BackendAccountSwitchRecord = {
  clientRequestId: string;
  backend: BackendKind;
  caller: string;
  fromProfile: string | null;
  toProfile: string | null;
  switchedAt: string | null;
  clearedSessions: number;
  clearedBranches: number;
  createdAt: Timestamp;
};

export type RecordBackendAccountSwitchInput = Omit<BackendAccountSwitchRecord, "fromProfile" | "toProfile" | "switchedAt"> & {
  fromProfile?: string | null;
  toProfile?: string | null;
  switchedAt?: string | null;
};

// A backend maintenance lease fences new work for one backend while its
// credentials/configuration are being changed out of process. `tokenHash` is
// deliberately private to the storage adapter: callers present an opaque
// lease token, but neither the active lease nor its audit log stores it raw.
export type BackendMaintenanceLease = {
  backend: BackendKind;
  owner: string;
  requestId: string;
  acquiredAt: Timestamp;
};

export type AcquireBackendMaintenanceLeaseInput = {
  backend: BackendKind;
  owner: string;
  tokenHash: string;
  requestId: string;
  acquiredAt: Timestamp;
};

export type AcquireBackendMaintenanceLeaseResult =
  | { kind: "acquired"; duplicate: boolean; lease: BackendMaintenanceLease }
  | { kind: "running_message_runs"; backend: BackendKind; runningMessageRunCount: number }
  | { kind: "held"; lease: BackendMaintenanceLease };

export type ReleaseBackendMaintenanceLeaseInput = {
  backend: BackendKind;
  owner: string;
  tokenHash: string;
  requestId: string;
  releasedAt: Timestamp;
};

export type ReleaseBackendMaintenanceLeaseResult =
  | { kind: "released"; duplicate: false; lease: BackendMaintenanceLease }
  | { kind: "released"; duplicate: true }
  | { kind: "owner_mismatch"; lease: BackendMaintenanceLease }
  | { kind: "token_mismatch"; lease: BackendMaintenanceLease };

export type BackendMaintenanceLeaseEvent = {
  id: number;
  backend: BackendKind;
  action: "acquire" | "release";
  outcome:
    | "acquired"
    | "duplicate"
    | "running_message_runs"
    | "held"
    | "released"
    | "not_held"
    | "owner_mismatch"
    | "token_mismatch";
  owner: string;
  requestId: string;
  leaseOwner: string | null;
  runningMessageRunCount: number;
  createdAt: Timestamp;
};

export type MessageRunAdmissionInput = NewMessageRunInput & {
  // New child rows are initialized before the unified run-admission point.
  // No caller may name arbitrary source states; this narrow opt-in is only for
  // the child lifecycle and still atomically transitions initializing → busy.
  allowInitializing?: boolean;
};

export type MessageRunAdmissionResult =
  | {
      kind: "admitted";
      backend: BackendKind;
      // Snapshot read inside the same transaction as the lease check. Callers
      // must execute this tuple rather than a pre-admission session snapshot.
      runtimeConfig: SessionRuntimeConfigSnapshot;
      previousStatus: "idle" | "initializing";
      messageRunId: MessageRunId;
    }
  | { kind: "maintenance"; backend: BackendKind; lease: BackendMaintenanceLease }
  | { kind: "busy"; currentRunId: MessageRunId | null }
  | { kind: "not_admittable"; status: SessionStatus | null };

export type BindingStore = {
  init(): Promise<unknown>;
  close(): Promise<void>;

  createSession(input: NewSessionInput): Promise<Session>;
  findSessionById(id: SessionId): Promise<Session | null>;
  findSessionByName(name: string): Promise<Session | null>;
  listAllSessions(): Promise<Session[]>;
  listActiveSessions(): Promise<Session[]>;
  listActiveSessionsByBackend(backend?: BackendKind): Promise<Session[]>;
  updateSessionStatus(id: SessionId, status: SessionStatus, now: Timestamp): Promise<void>;
  updateSessionModel(id: SessionId, model: string | null): Promise<void>;
  updateSessionEffort(id: SessionId, effort: string | null): Promise<void>;
  updateSessionThinking(id: SessionId, thinking: boolean): Promise<void>;
  updateSessionModelLocked(id: SessionId, locked: boolean): Promise<void>;
  updateSessionEffortLocked(id: SessionId, locked: boolean): Promise<void>;
  getBackendRuntimeDefaults(backend: BackendKind): Promise<{
    backend: BackendKind;
    model: string | null;
    effort: EffortLevel | null;
    updatedAt: Timestamp;
  } | null>;
  listBackendRuntimeDefaults(): Promise<Array<{
    backend: BackendKind;
    model: string | null;
    effort: EffortLevel | null;
    updatedAt: Timestamp;
  }>>;
  updateBackendRuntimeDefaults(
    backend: BackendKind,
    patch: { model?: string | null; effort?: EffortLevel | null },
  ): Promise<void>;
  getChildSessionDefaults(): Promise<ChildSessionDefaults>;
  updateChildSessionDefaults(patch: ChildSessionDefaultsPatch): Promise<void>;
  compareAndSetChildSessionDefaults(
    expected: ChildSessionDefaults,
    patch: ChildSessionDefaultsPatch,
  ): Promise<boolean>;
  getSessionRuntimeSettings(sessionId: SessionId): Promise<SessionRuntimeSettings | null>;
  updateSessionRuntimeSettings(
    sessionId: SessionId,
    patch: SessionRuntimeSettingsPatch,
  ): Promise<void>;
  getSessionHeartbeatEnabled(id: SessionId): Promise<boolean>;
  updateSessionHeartbeatEnabled(id: SessionId, enabled: boolean): Promise<void>;
  getSessionWorkspaceLocked(id: SessionId): Promise<boolean>;
  updateSessionWorkspaceLocked(id: SessionId, locked: boolean): Promise<void>;
  listHeartbeatEnabledSessions(): Promise<Session[]>;
  updateSessionBackendSessionId(id: SessionId, backendSessionId: string | null): Promise<void>;
  updateSessionInactivityTimeout(id: SessionId, seconds: number | null): Promise<void>;
  updateSessionMaxRuntime(id: SessionId, seconds: number | null): Promise<void>;
  updateSessionBackend(id: SessionId, backend: BackendKind): Promise<void>;
  applySessionRuntimeConfigMutations(
    mutations: readonly SessionRuntimeConfigMutation[],
  ): Promise<{ updated: number }>;
  getPendingSessionRuntimeConfig(sessionId: SessionId): Promise<SessionRuntimeConfigPending | null>;
  queueSessionRuntimeConfigMutation(mutation: SessionRuntimeConfigMutation): Promise<void>;
  drainPendingSessionRuntimeConfig(
    sessionId: SessionId,
  ): Promise<DrainPendingSessionRuntimeConfigResult>;
  drainPendingSessionRuntimeConfigs(): Promise<number>;
  guardIdleSessionRuntimeConfig(
    sessionId: SessionId,
    expected: SessionRuntimeConfigSnapshot,
  ): Promise<SessionRuntimeConfigSnapshot>;
  listSessionRuntimeConfigAudit(sessionId: SessionId): Promise<SessionRuntimeConfigAudit[]>;
  getActiveBranch(sessionId: SessionId): Promise<SessionBranchRecord>;
  listSessionBranches(sessionId: SessionId): Promise<SessionBranchRecord[]>;
  findSessionBranch(sessionId: SessionId, name: string): Promise<SessionBranchRecord | null>;
  createSessionBranch(input: NewSessionBranchInput): Promise<SessionBranchRecord>;
  setActiveBranch(sessionId: SessionId, branchName: string, now: Timestamp): Promise<void>;
  updateSessionBranchBackendSessionId(
    sessionId: SessionId,
    branchName: string,
    backendSessionId: string,
    now: Timestamp,
  ): Promise<void>;
  clearSessionBranchBackendSessionId(
    sessionId: SessionId,
    branchName: string,
    now: Timestamp,
  ): Promise<void>;
  countActiveSessions(): Promise<number>;
  countBusySessions(): Promise<number>;
  countBusySessionsByBackend(backend: BackendKind): Promise<number>;
  // Bulk invalidation after a backend account switch (e.g. Kimi ACP sessions
  // are stored per account, so every persisted id dies on switch). Clears the
  // session-level resume id and every branch resume/fork reference in one
  // transaction; deleted sessions are left untouched.
  clearBackendSessionIdsForBackend(
    backend: BackendKind,
    now: Timestamp,
  ): Promise<{ sessions: number; branches: number }>;
  findBackendAccountSwitch(clientRequestId: string): Promise<BackendAccountSwitchRecord | null>;
  recordBackendAccountSwitch(input: RecordBackendAccountSwitchInput): Promise<void>;
  // Both methods use BEGIN IMMEDIATE. Acquire checks every running
  // message_runs row for the backend and writes the lease in one transaction;
  // admission checks the lease and creates the run in one transaction.
  acquireBackendMaintenanceLease(
    input: AcquireBackendMaintenanceLeaseInput,
  ): Promise<AcquireBackendMaintenanceLeaseResult>;
  releaseBackendMaintenanceLease(
    input: ReleaseBackendMaintenanceLeaseInput,
  ): Promise<ReleaseBackendMaintenanceLeaseResult>;
  // Read-only active-lease lookup for maintenance status surfaces. It must not
  // create an audit record, alter lease lifetime, or otherwise mutate state.
  getBackendMaintenanceLease(backend: BackendKind): Promise<BackendMaintenanceLease | null>;
  listBackendMaintenanceLeaseEvents(
    backend: BackendKind,
    limit?: number,
  ): Promise<BackendMaintenanceLeaseEvent[]>;
  // FP v1.0 contract maintenance hook (read-only): returns user-scope,
  // non-deleted sessions whose `avatar` is non-empty AND fails the
  // file_token format. Adapter MUST NOT rewrite the rows; FP runs the
  // migration playbook out-of-band per contract §1 Migration.
  findNonConformingAvatars(): Promise<Array<{ name: string; avatar: string }>>;

  createBinding(groupId: LarkGroupId, sessionId: SessionId, now: Timestamp): Promise<Binding>;
  findByGroup(groupId: LarkGroupId): Promise<Binding | null>;
  findBySession(sessionId: SessionId): Promise<Binding | null>;
  deleteBinding(groupId: LarkGroupId): Promise<void>;

  createSessionWithBinding(
    session: NewSessionInput,
    groupId: LarkGroupId
  ): Promise<{ session: Session; binding: Binding }>;
  deleteSessionAndBinding(sessionId: SessionId): Promise<void>;

  recordAttachment(input: NewAttachmentInput): Promise<AttachmentRef>;
  listSessionAttachments(sessionId: SessionId): Promise<AttachmentRef[]>;

  // The sole real run admission point. It serializes the backend maintenance
  // fence, per-session running-row check, message_runs insert, and status
  // transition so no preflight/session-busy race can start a fenced backend.
  admitMessageRun(input: MessageRunAdmissionInput): Promise<MessageRunAdmissionResult>;
  startMessageRun(input: NewMessageRunInput): Promise<MessageRunId>;
  finishMessageRun(
    id: MessageRunId,
    status: RunStatus,
    finalMessage?: string,
    error?: string,
    // JSON-encoded user-facing stream events (replier StreamLogEntry[]).
    // Persisted so past runs' full reply (especially codex commentary) can
    // be recovered. May be undefined when the migration has degraded; the
    // adapter writes NULL in that case.
    streamLogJson?: string,
  ): Promise<void>;
  setMessageRunCardId(id: MessageRunId, cardId: CardId): Promise<void>;
  findRunningMessageRunBySession(sessionId: SessionId): Promise<MessageRun | null>;
  findLatestMessageRunBySession(sessionId: SessionId): Promise<MessageRun | null>;
  listRecentMessageRuns(sessionId: SessionId, limit: number, branchName?: string): Promise<MessageRun[]>;
  listRecentCompletedMessageRuns(sessionId: SessionId, limit: number): Promise<MessageRun[]>;
  getRankStats(input: GetRankStatsInput): Promise<RankStats>;
  getDisplayNames(senderIds: string[]): Promise<Map<string, DisplayNameEntry>>;
  resetBusySessionsOnBoot(now: Timestamp): Promise<number>;
  resetRunningMessageRunsOnBoot(now: Timestamp): Promise<number>;
  findAllSessionsWithBackendSessionId(): Promise<Array<{
    id: SessionId;
    backendSessionId: string;
    status: SessionStatus;
    workdir: AbsolutePath;
  }>>;
  findRunningMessageRuns(): Promise<Array<{
    id: MessageRunId;
    sessionId: SessionId;
    startedAt: Timestamp;
  }>>;
  markMessageRunTimeout(id: MessageRunId, reason: string, now: Timestamp): Promise<void>;
  timeoutMessageRunAndFailPendingSpawnComms(
    id: MessageRunId,
    reason: string,
    now: Timestamp,
  ): Promise<BootOrphanedSpawnComm[]>;
  /** Rebuild caller-takeable failure receipts left by an earlier boot. */
  recoverBootOrphanedSpawnReceipts(now: Timestamp): Promise<BootOrphanedSpawnComm[]>;
  recordTokenUsage(input: TokenUsageInput): Promise<void>;
  getLatestTokenUsageRawTotals(sessionId: SessionId): Promise<TokenUsageRawTotals | null>;
  getTokenUsageSummary(
    sessionId: SessionId,
    cutoffs: TokenUsageWindowCutoffs
  ): Promise<TokenUsageSummary>;
  getSchedulerTokenUsage(from: Timestamp, to: Timestamp): Promise<SchedulerTokenUsage[]>;
  countActiveChildrenByParent(parentId: SessionId): Promise<number>;
  cleanupStaleChildSessions(cutoff: Timestamp): Promise<BootChildCleanupResult>;
  cleanupErroredChildSessions(cutoff: Timestamp): Promise<BootChildCleanupResult>;
  cleanupStuckBusyChildren(cutoff: Timestamp): Promise<number>;

  logCrossSessionComm(input: NewCrossSessionComm, spawnPredicate?: NewSpawnPredicateInput): Promise<void>;
  // Latest non-failed comm registered under this client_request_id, used by
  // /api/spawn2.0 to reject duplicate keys before spawning a second child.
  findCrossSessionCommForDedup(clientRequestId: string): Promise<{
    id: string;
    status: "pending" | "completed" | "failed";
    childSessionId: string | null;
    createdAt: number;
  } | null>;
  attachCrossSessionChild(id: string, childSessionId: SessionId, messageRunId: MessageRunId): Promise<void>;
  createSpawnPredicate(input: NewSpawnPredicateInput): Promise<SpawnPredicateRecord>;
  getSpawnPredicate(spawnCommId: string): Promise<SpawnPredicateRecord | null>;
  patchSpawnPredicate(input: PatchSpawnPredicateInput): Promise<SpawnPredicateRecord>;
  listOpenSpawnPredicates(cutoffMs: Timestamp, limit?: number): Promise<OpenSpawnPredicateRecord[]>;
  upsertWatcherState(input: UpsertWatcherStateInput): Promise<void>;
  getWatcherState(spawnCommId: string): Promise<WatcherStateRecord | null>;
  registerSpawnAsyncItem(input: RegisterSpawnAsyncItemInput): Promise<void>;
  getSpawnAsyncItem(ref: string): Promise<SpawnAsyncItemRecord | null>;
  /** Latest async item registered for a comm (most recent registration wins). */
  getSpawnAsyncItemByComm(commId: string): Promise<SpawnAsyncItemRecord | null>;
  /** Async items registered for a caller session, oldest-updated first. */
  listSpawnAsyncItemsByCallerSession(callerSession: string, limit?: number): Promise<SpawnAsyncItemRecord[]>;
  /**
   * Caller-consumption ledger: marks that the caller fetched the result
   * itself over an HTTP channel. CAS pending/waiting_child/delivering →
   * closed with verdict='caller_consumed'; returns true when this call
   * consumed. Take is allowed to steal an in-flight push (after claim,
   * before finalize).
   */
  closeSpawnAsyncItemConsumed(ref: string, reason: string, now: Timestamp): Promise<boolean>;
  /**
   * Sync-inline HTTP delivery ledger: closes all non-terminal items for
   * the comm (pending/waiting_child/delivering → closed, verdict='delivered').
   * No ref filter. Returns affected row count; 0 is a normal no-op when
   * pure sync registered no async item.
   */
  closeSpawnAsyncItemSyncDelivered(commId: string, reason: string, now: Timestamp): Promise<number>;
  claimSpawnAsyncItemForDelivery(ref: string, now: Timestamp): Promise<SpawnAsyncItemRecord | null>;
  /**
   * Escalation must never overwrite a terminal success verdict
   * ('delivered' / 'caller_consumed'): those are the read-only transport
   * delivery proof consumed via GET /api/spawn_async_items/by-comm/:commId.
   */
  markSpawnAsyncItemAdjudicationEscalated(ref: string, reason: string, now: Timestamp): Promise<void>;
  /**
   * CAS delivering → closed, stamping the closure outcome so read-only
   * observers (GET by-comm) can distinguish a successful delivery from
   * other closed states. 'delivered' means the caller has (or already had)
   * the completed result; 'adjudication_result_recorded' closes the
   * adjudication spawn's own bookkeeping item. Returns true when this
   * call won the CAS (false if take or another closer stole the item).
   */
  markSpawnAsyncItemDelivered(ref: string, closure: SpawnAsyncItemDeliveredClosure, now: Timestamp): Promise<boolean>;
  /**
   * CAS delivering → parked for a delivery channel the caller can never
   * accept (caller heartbeat disabled). Terminal on the first failure: the
   * attempt counter is deliberately NOT incremented, because retrying an
   * unsupported channel would only burn the budget on identical failures.
   * The completed result stays readable via POST /:ref/take.
   */
  parkSpawnAsyncItemDeliveryUnsupported(ref: string, reason: string, now: Timestamp): Promise<boolean>;
  releaseSpawnAsyncItemDelivery(ref: string, previousStatus: DeliverableSpawnAsyncItemStatus, now: Timestamp): Promise<void>;
  enqueueSpawnQueueItem(input: EnqueueSpawnQueueItemInput): Promise<void>;
  countPendingSpawnQueueItemsByParent(parentId: SessionId): Promise<number>;
  claimNextSpawnQueueItem(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem | null>;
  expireSpawnQueueItemsByParent(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem[]>;
  markSpawnQueueItemFailed(id: string, now: Timestamp): Promise<void>;
  claimDriveCommentMention(input: ClaimDriveCommentMentionInput): Promise<boolean>;
  finishDriveCommentMention(input: FinishDriveCommentMentionInput): Promise<void>;
  findDriveCommentMention(dedupeKey: string): Promise<DriveCommentMentionRecord | null>;
  recordResponseLog(input: RecordResponseLogInput): Promise<void>;
  finishResponseLog(input: FinishResponseLogInput): Promise<void>;
  findResponseLog(responseId: string): Promise<ResponseLogRecord | null>;
  listPendingResponseLogs(limit?: number): Promise<ResponseLogRecord[]>;
  markResponseLogMirrorOk(responseId: string, recordId: string, now: Timestamp): Promise<void>;
  markResponseLogMirrorFailed(responseId: string, error: string, now: Timestamp): Promise<void>;
  recordWatcherException(input: RecordWatcherExceptionInput): Promise<void>;
  recordResultSinkAttempt(input: ResultSinkAttemptInput): Promise<void>;
  listResultSinkAttemptsBySpawn(spawnCommId: string): Promise<ResultSinkAttempt[]>;
  finishCrossSessionComm(
    id: string,
    status: "completed" | "failed",
    childSessionId?: string,
    resultPreview?: string,
    error?: string,
    finalMessage?: string,
    messageRunId?: MessageRunId,
  ): Promise<void>;
  listCrossSessionComms(sessionId: SessionId, direction: "from" | "to", limit?: number): Promise<CrossSessionComm[]>;
  listAllCrossSessionComms(limit?: number): Promise<CrossSessionComm[]>;
  listUnsyncedCrossSessionComms(): Promise<CrossSessionComm[]>;
  listStaleSyncedCrossSessionComms(): Promise<CrossSessionComm[]>;
  markCrossSessionCommSynced(id: string, bitableRecordId: string): Promise<void>;
};
