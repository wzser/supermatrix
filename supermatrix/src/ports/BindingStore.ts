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
  Session,
  SessionCategory,
  SessionStatus,
} from "../domain/session.ts";
import type {
  PredicateEvaluationResultState,
  PredicateTriggerSignal,
  SpawnPredicate,
} from "../domain/spawnPredicate.ts";
import type { Scope } from "../domain/scope.ts";
import type { AttachmentRef, AttachmentKind } from "../domain/attachment.ts";

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
};

export type RankRow = {
  senderId: string;
  total: number;
  inputChars: number;
  top3Sessions: Array<{ sessionName: string; count: number }>;
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
  cardId: CardId | null;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  status: RunStatus;
  finalMessage: string | null;
  errorMessage: string | null;
};

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
  getSessionHeartbeatEnabled(id: SessionId): Promise<boolean>;
  updateSessionHeartbeatEnabled(id: SessionId, enabled: boolean): Promise<void>;
  listHeartbeatEnabledSessions(): Promise<Session[]>;
  updateSessionBackendSessionId(id: SessionId, backendSessionId: string | null): Promise<void>;
  updateSessionInactivityTimeout(id: SessionId, seconds: number | null): Promise<void>;
  updateSessionMaxRuntime(id: SessionId, seconds: number | null): Promise<void>;
  updateSessionBackend(id: SessionId, backend: BackendKind): Promise<void>;
  countActiveSessions(): Promise<number>;
  countBusySessions(): Promise<number>;
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
  recordTokenUsage(input: TokenUsageInput): Promise<void>;
  getLatestTokenUsageRawTotals(sessionId: SessionId): Promise<TokenUsageRawTotals | null>;
  getTokenUsageSummary(
    sessionId: SessionId,
    cutoffs: TokenUsageWindowCutoffs
  ): Promise<TokenUsageSummary>;
  countActiveChildrenByParent(parentId: SessionId): Promise<number>;
  cleanupStaleChildSessions(cutoff: Timestamp): Promise<number>;
  cleanupErroredChildSessions(cutoff: Timestamp): Promise<number>;
  cleanupStuckBusyChildren(cutoff: Timestamp): Promise<number>;

  logCrossSessionComm(input: NewCrossSessionComm, spawnPredicate?: NewSpawnPredicateInput): Promise<void>;
  createSpawnPredicate(input: NewSpawnPredicateInput): Promise<SpawnPredicateRecord>;
  getSpawnPredicate(spawnCommId: string): Promise<SpawnPredicateRecord | null>;
  patchSpawnPredicate(input: PatchSpawnPredicateInput): Promise<SpawnPredicateRecord>;
  listOpenSpawnPredicates(cutoffMs: Timestamp, limit?: number): Promise<OpenSpawnPredicateRecord[]>;
  upsertWatcherState(input: UpsertWatcherStateInput): Promise<void>;
  getWatcherState(spawnCommId: string): Promise<WatcherStateRecord | null>;
  registerSpawnAsyncItem(input: RegisterSpawnAsyncItemInput): Promise<void>;
  enqueueSpawnQueueItem(input: EnqueueSpawnQueueItemInput): Promise<void>;
  countPendingSpawnQueueItemsByParent(parentId: SessionId): Promise<number>;
  claimNextSpawnQueueItem(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem | null>;
  expireSpawnQueueItemsByParent(parentId: SessionId, now: Timestamp): Promise<SpawnQueueItem[]>;
  markSpawnQueueItemFailed(id: string, now: Timestamp): Promise<void>;
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
