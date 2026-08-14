import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type Database from "better-sqlite3";
import {
  isSpawnChildQueuedResult,
  type SpawnChildCompletedResult,
  type SpawnChildInput,
  type SpawnChildResult,
} from "../app/childSession.ts";
import type { ResultSink } from "../domain/childCapabilities.ts";
import { asMessageRunId, asSessionId, asTimestamp, type LarkGroupId, type MessageRunId, type SessionId, type Timestamp } from "../domain/ids.ts";
import { resolveOwnerSessionName, type BackendKind, type Session } from "../domain/session.ts";
import {
  defaultCallerAttestationRegistry,
  type CallerAttestationRegistry,
} from "../domain/callerAttestation.ts";
import type { Logger } from "../ports/Logger.ts";
import type { ChildSessionDefaults } from "../ports/ChildSessionDefaults.ts";
import type { Notifier } from "../app/consoleNotifier.ts";
import { resolveAndValidateModel } from "../app/commands/setModel.ts";
import { resolveAndValidateEffort } from "../app/commands/setEffort.ts";
import { resolveChildRequestedTuple, resolveMainSession } from "../app/childExecutionTuple.ts";
import type { RunOnSessionInput, RunOnSessionResult } from "../app/runOnSession.ts";
import { registerAsyncItem } from "../app/spawnClosure/registerAsyncItem.ts";
import { logClosureEvent } from "../app/spawnClosure/closureLog.ts";
import { runThreePhaseCheck, type PhaseCheckResult } from "../app/spawnClosure/threePhaseCheck.ts";
import { validateSpawnPredicate } from "../app/spawnPredicate/schema.ts";
import type { PredicateLintContext } from "../app/spawnPredicate/lint.ts";
import { loadSqlitePredicateDbRegistry } from "../adapters/predicate-db/sqliteRegistry.ts";
import type { LarkWsHealthSnapshot } from "../adapters/lark-cli/realClient.ts";
import type {
  AcquireBackendMaintenanceLeaseInput,
  AcquireBackendMaintenanceLeaseResult,
  BackendAccountSwitchRecord,
  BackendMaintenanceLease,
  NormalizedSpawnPredicate,
  PatchSpawnPredicateInput,
  RecordBackendAccountSwitchInput,
  ReleaseBackendMaintenanceLeaseInput,
  ReleaseBackendMaintenanceLeaseResult,
  ResultSinkAttemptInput,
  SchedulerTokenUsage,
  SchedulerTokenUsageTotals,
  SpawnAsyncItemRecord,
  SpawnPredicateRecord,
  WatcherStateRecord,
} from "../ports/BindingStore.ts";

export type KimiAcpHealthSnapshot = {
  pid: number | null;
  state: string;
  roundtrip:
    | { ok: true; rttMs: number }
    | { ok: false; error: string };
};

export type ApiDeps = {
  store: {
    findSessionByName(name: string): Promise<Session | null>;
    // Full Session: /api/spawn2.0 walks child→main ancestors for tuple
    // resolution; the /api/run status probe only reads a subset.
    findSessionById(id: SessionId): Promise<Session | null>;
    findLatestMessageRunBySession(id: SessionId): Promise<{
      id: MessageRunId;
      startedAt: number;
      finishedAt: number | null;
      status: string;
      finalMessage: string | null;
      errorMessage: string | null;
    } | null>;
    findRunningMessageRunBySession(id: SessionId): Promise<{
      id: MessageRunId;
      startedAt: number;
      finishedAt: number | null;
      status: string;
      finalMessage: string | null;
      errorMessage: string | null;
    } | null>;
    listActiveSessions(): Promise<Array<{ name: string; status: string; scope: string }>>;
    countBusySessions(): Promise<number>;
    getSchedulerTokenUsage(from: Timestamp, to: Timestamp): Promise<SchedulerTokenUsage[]>;
    countBusySessionsByBackend(backend: BackendKind): Promise<number>;
    clearBackendSessionIdsForBackend(
      backend: BackendKind,
      now: Timestamp,
    ): Promise<{ sessions: number; branches: number }>;
    findBackendAccountSwitch(clientRequestId: string): Promise<BackendAccountSwitchRecord | null>;
    recordBackendAccountSwitch(input: RecordBackendAccountSwitchInput): Promise<void>;
    acquireBackendMaintenanceLease(
      input: AcquireBackendMaintenanceLeaseInput,
    ): Promise<AcquireBackendMaintenanceLeaseResult>;
    releaseBackendMaintenanceLease(
      input: ReleaseBackendMaintenanceLeaseInput,
    ): Promise<ReleaseBackendMaintenanceLeaseResult>;
    getBackendMaintenanceLease(backend: BackendKind): Promise<BackendMaintenanceLease | null>;
    getChildSessionDefaults(): Promise<ChildSessionDefaults>;
    // /api/run needs the target's binding groupId for message_runs.group_id.
    findBySession(id: SessionId): Promise<{ groupId: LarkGroupId } | null>;
    getSpawnPredicate(spawnCommId: string): Promise<SpawnPredicateRecord | null>;
    getWatcherState(spawnCommId: string): Promise<WatcherStateRecord | null>;
    patchSpawnPredicate(input: PatchSpawnPredicateInput): Promise<SpawnPredicateRecord>;
    getSpawnAsyncItem(ref: string): Promise<SpawnAsyncItemRecord | null>;
    getSpawnAsyncItemByComm(commId: string): Promise<SpawnAsyncItemRecord | null>;
    closeSpawnAsyncItemConsumed(ref: string, reason: string, now: Timestamp): Promise<boolean>;
    closeSpawnAsyncItemSyncDelivered(commId: string, reason: string, now: Timestamp): Promise<number>;
    findCrossSessionCommForDedup(clientRequestId: string): Promise<{
      id: string;
      status: "pending" | "completed" | "failed";
      childSessionId: string | null;
      createdAt: number;
    } | null>;
    registerSpawnAsyncItem: Parameters<typeof registerAsyncItem>[0]["store"]["registerSpawnAsyncItem"];
    recordResultSinkAttempt(input: ResultSinkAttemptInput): Promise<void>;
    recordWatcherException(input: {
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
    }): Promise<void>;
  };
  routeSpawnClosureItem?: (input: {
    ref: string;
    commId: string;
    callerSession: string;
    targetSession: string;
  }) => Promise<void>;
  sendLarkText?: (input: { chatId: string; text: string }) => Promise<{ messageId: string }>;
  childSession: {
    spawnChild(input: SpawnChildInput): Promise<SpawnChildResult>;
  };
  closureDb?: Database.Database;
  // Drives a prompt on an EXISTING user-scope session (resumes its main
  // backend_session_id). Powering POST /api/run.
  runOnSession: (input: RunOnSessionInput) => Promise<RunOnSessionResult>;
  notifier: Notifier;
  logger: Logger;
  syncSpawnResponseTimeoutMs?: number;
  /** Runtime caller-provenance registry. Defaults to the process-wide one. */
  callerAttestations?: CallerAttestationRegistry;
  /** Reads the process-owned shared Kimi ACP rather than launching a probe CLI. */
  kimiAcpHealth?: () => Promise<KimiAcpHealthSnapshot>;
  /** Reads the process-owned node-sdk Lark WebSocket ingress without exposing credentials. */
  larkWsHealth?: () => LarkWsHealthSnapshot | Promise<LarkWsHealthSnapshot>;
  /**
   * Disposes the shared Kimi ACP client and re-probes it (the client rebuilds
   * itself via its factory on the next ensureReady). Used after a kimi account
   * switch so the old account's process state is dropped. Absent = recycle not
   * configured; account-switched still clears persisted ids.
   */
  recycleKimiAcp?: () => Promise<KimiAcpHealthSnapshot>;
};

// .strict() is the boundary: the caller presents ONLY the secret the runtime
// injected into its run. Any extra key — most importantly a self-reported
// session name — is rejected, so no consumer can start trusting a claim.
const callerIdentityBodySchema = z.object({
  token: z.string().trim().min(1, "token is required"),
}).strict();

// sm-switch (词元管家) callback after a successful kimi account switch: the
// framework bulk-invalidates every persisted kimi backend_session_id (ACP
// sessions are stored per account) and recycles the shared ACP process.
// .strict(): only the five documented fields are accepted.
const kimiAccountSwitchedSchema = z.object({
  from: z.string().min(1),
  client_request_id: z.string().min(1),
  from_profile: z.string().optional(),
  to_profile: z.string().optional(),
  switched_at: z.string().optional(),
}).strict();

// The platform owns the fence. sm-switch is the sole external caller and is
// identified by this route, not by a caller-controlled body field. The lease
// token is an opaque, per-switch secret; only its SHA-256 digest reaches the
// durable store.
const claudeMaintenanceLeaseSchema = z.object({
  client_request_id: z.string().trim().min(1).max(200),
  lease_token: z.string().trim().min(32).max(512),
}).strict();

const notifyTargetChatIdSchema = z.string()
  .trim()
  .regex(/^oc_[^\s]+$/u, "targetChatId must be a non-empty oc_... string");
const notifyActionContextValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const notifyActionOptionSchema = z.object({
  label: z.string().min(1).max(20),
  value: z.string().min(1).max(64).regex(/^[\x20-\x7E]+$/u, "value must be ASCII"),
  description: z.string().optional(),
}).strict();
const notifyActionsSchema = z.object({
  card_type: z.string().regex(/^[a-z0-9_]{3,64}$/u, "card_type must match ^[a-z0-9_]{3,64}$"),
  options: z.array(notifyActionOptionSchema).min(2).max(5),
  context: z.record(notifyActionContextValueSchema).optional(),
}).strict();
// .strict() rejects any extra top-level key (most importantly `kind`, which
// is reserved for the deprecated watcher-exception fallback path below).
// Without this, a consumer accidentally putting `kind: "..."` in their notify
// body could either be silently dropped (unknown kind) or, worse, get
// mis-routed to the watcher fallback path (which sends to a different chat).
const notifyInputSchema = z.object({
  source: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  level: z.enum(["info", "warn", "error", "success"]).optional(),
  targetChatId: notifyTargetChatIdSchema.optional(),
  target_chat_id: notifyTargetChatIdSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  actions: notifyActionsSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.targetChatId && input.target_chat_id && input.targetChatId !== input.target_chat_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_chat_id"],
      message: "target_chat_id must match targetChatId when both are provided",
    });
  }
}).transform(({ target_chat_id, ...input }) => {
  const targetChatId = input.targetChatId ?? target_chat_id;
  return targetChatId === undefined
    ? input
    : { ...input, targetChatId };
});

const watcherExceptionNotifySchema = z.object({
  kind: z.literal("spawn_exception_transaction_fallback"),
  tx_id: z.string().min(1),
  dedupe_key: z.string().min(1),
  spawn_comm_id: z.string().min(1),
  trigger_signal: z.string().min(1),
  summary: z.string().min(1),
  payload: z.unknown().optional(),
  target_chat_id: notifyTargetChatIdSchema.optional(),
}).strict();

type WatcherExceptionNotify = z.infer<typeof watcherExceptionNotifySchema>;

const YOLO_WATCHER_EXCEPTION_CHAT_ID = "oc_REDACTEDCHATID";
const execFileAsync = promisify(execFile);
const internalSpawnSchema = z.object({
  caller_invocation: z.enum(["async_kickoff", "fire_and_forget"]),
}).strict();
type SpawnInvocationMode = "sync_inline" | z.infer<typeof internalSpawnSchema>["caller_invocation"];
const FRAMEWORK_INTERNAL_SPAWN_CALLERS = new Set(["supermatrix-root"]);
const PREDICATE_WARNING_TARGET_SESSION = "first-principle";
const PREDICATE_WARNING_SOURCE_SESSION = "supermatrix-root";
const DEFAULT_SYNC_SPAWN_RESPONSE_TIMEOUT_MS = 240_000;
const CLAUDE_MAINTENANCE_OWNER = "sm-switch";
const predicateWarningChildDedupe = new Set<string>();
const legacySpawnDisabled = () => process.env.SM_DISABLE_LEGACY_SPAWN === "1";

// Caller-facing sink schema. Deliberately narrower than the domain ResultSink:
//   - http_response is excluded (driven by mode=sync_inline, not user-picked)
//   - chat_post only accepts explicit/parent chatRef; requester/reply_to need
//     spawn-time context the engine does not yet resolve (resultSinkEngine.ts)
//   - parent_continuation_inject takes a session name (resolved to SessionId
//     below) so callers speak in the same vocabulary as /api/spawn target/from
const callerSinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pollable_endpoint") }),
  z.object({ kind: z.literal("audit_only") }),
  z.object({
    kind: z.literal("chat_post"),
    chatRef: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("parent") }),
      z.object({ kind: z.literal("explicit"), chatId: z.string().min(1).max(200) }),
    ]),
    identity: z.enum(["bot", "user"]),
  }),
  z.object({ kind: z.literal("eventbus_publish"), topic: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal("parent_continuation_inject"),
    parentSessionName: z.string().min(1).max(200),
  }),
]);
const callerSinksSchema = z.array(callerSinkSchema).min(1).max(10);

const deliveryAddressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("caller") }),
  z.object({
    kind: z.literal("chat"),
    chatId: z.string().min(1).max(200),
    identity: z.enum(["bot", "user"]).default("bot"),
  }),
  z.object({
    kind: z.literal("session"),
    sessionName: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("topic"),
    topic: z.string().min(1).max(200),
  }),
]);
type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;

const spawn2BackendSchema = z.enum(["claude", "codex", "kimi"]);
const spawn2EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra", "default"]);
const spawn2ExecutionSchema = z.object({
  backend: spawn2BackendSchema.optional(),
  model: z.string().min(1).optional(),
  effort: spawn2EffortSchema.optional(),
}).strict();
const spawn2ClosureTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline") }).strict(),
  z.object({
    type: z.literal("session"),
    session_name: z.string().min(1).max(200),
  }).strict(),
  z.object({
    type: z.literal("topic"),
    topic: z.string().min(1).max(200),
  }).strict(),
  z.object({ type: z.literal("todo_pool") }).strict(),
]);
const spawn2ClosureSchema = z.object({
  kind: z.enum(["message", "artifact", "record", "no_reply"]),
  target: spawn2ClosureTargetSchema.optional(),
}).strict();
// Batch provenance for fan-out spawns. Callers that emit many spawns from one
// logical trigger (e.g. a scheduler run fanning out N rule probes) stamp the
// same origin so the closure fast-path/watcher can merge results into one
// batch_key instead of one-by-one auto:* delivery. See task-class-redesign §4.4.
const spawn2OriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scheduler"),
    task_id: z.string().trim().min(1),
    run_id: z.string().trim().min(1),
    triggered_at: z.number(),
  }).strict(),
  z.object({
    kind: z.literal("message_run"),
    run_id: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("other"),
    key: z.string().trim().min(1),
  }).strict(),
]);
const spawn2BodySchema = z.object({
  from: z.string().trim().min(1),
  target: z.string().trim().min(1),
  prompt: z.string().min(1),
  client_request_id: z.string()
    .min(1)
    .max(240)
    .regex(/^\d{4}-\d{2}-\d{2}:/u, "client_request_id must start with YYYY-MM-DD:"),
  execution: spawn2ExecutionSchema.optional(),
  backend: spawn2BackendSchema.optional(),
  model: z.string().min(1).optional(),
  effort: spawn2EffortSchema.optional(),
  closure: spawn2ClosureSchema,
  origin: spawn2OriginSchema.optional(),
  verification_predicate: z.unknown().optional(),
}).strict();
type Spawn2ClosureTarget = z.infer<typeof spawn2ClosureTargetSchema>;
type Spawn2Origin = z.infer<typeof spawn2OriginSchema>;

const predicatePatchBodySchema = z.object({
  from: z.string().min(1),
  actor_role: z.enum(["owner", "sk", "root"]),
  tx_id: z.string().min(1).optional(),
  reason: z.string().min(1),
  verification_predicate: z.unknown(),
}).strict();

type ParsedSpawnBody = {
  target?: string;
  prompt?: string;
  from?: string;
  backend?: string;
  model?: string;
  supermatrix_internal?: unknown;
  sinks?: unknown;
  delivery_address?: unknown;
  delivery_checks?: unknown;
  verification_predicate?: unknown;
  client_request_id?: string;
};

type PredicateWarning = {
  kind: "missing predicate" | "invalid predicate";
  target: string;
  from: string;
  errors: string[];
};

type MissingFromWarningFields = {
  target: string;
  promptLength: number;
  clientRequestId: string | undefined;
  remoteAddress: string | null;
  remotePort: number | null;
  userAgent: string | string[] | undefined;
  hasVerificationPredicate: boolean;
  hasDeliveryAddress: boolean;
  hasSinks: boolean;
  hasSupermatrixInternal: boolean;
};

export async function startApiServer(deps: ApiDeps, port: number): Promise<Server> {
  const log = deps.logger.child({ mod: "api" });
  const MAX_BIND_RETRIES = 3;
  const RETRY_DELAY_MS = 300;
  const callerAttestations = deps.callerAttestations ?? defaultCallerAttestationRegistry;
  const predicatePatchToken = readPredicatePatchToken();
  const claudeMaintenanceToken = readClaudeMaintenanceToken();
  const predicateValidationContext: PredicateLintContext = {
    dbRegistry: loadSqlitePredicateDbRegistry({ logger: log }),
  };
  if (!predicatePatchToken) {
    log.warn("SM_PREDICATE_PATCH_TOKEN missing; PATCH /api/spawn/:spawn_comm_id/predicate disabled");
  }
  if (!claudeMaintenanceToken) {
    log.warn("SM_CLAUDE_MAINTENANCE_TOKEN missing; Claude maintenance lease API disabled");
  }
  // Closes the dedup window between accepting a spawn2.0 request and
  // childSession inserting its cross_session_log row: a same-key retry that
  // races in before the row exists would pass the DB lookup below.
  const inFlightSpawn2ClientRequestIds = new Set<string>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && url.pathname === "/api/health") {
        const sessions = await deps.store.listActiveSessions();
        const busy = await deps.store.countBusySessions();
        json(res, 200, {
          status: "ok",
          sessions: sessions.length,
          busy,
          uptime: process.uptime(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/scheduler-token-usage") {
        const from = parseNonNegativeEpochMs(url.searchParams.get("from"));
        const to = parseNonNegativeEpochMs(url.searchParams.get("to"));
        if (from === null || to === null || from >= to) {
          json(res, 400, {
            ok: false,
            error: "from and to must be non-negative integer epoch milliseconds with from < to",
          });
          return;
        }
        const tasks = await deps.store.getSchedulerTokenUsage(from, to);
        json(res, 200, {
          ok: true,
          from,
          to,
          tasks,
          totals: sumSchedulerTokenUsage(tasks),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/health/kimi-acp") {
        if (!deps.kimiAcpHealth) {
          json(res, 503, {
            status: "unavailable",
            backend: "kimi",
            pid: null,
            state: "unavailable",
            roundtrip: { ok: false, error: "Kimi ACP health provider is not configured" },
          });
          return;
        }
        try {
          const health = await deps.kimiAcpHealth();
          json(res, health.roundtrip.ok ? 200 : 503, {
            status: health.roundtrip.ok ? "ok" : "degraded",
            backend: "kimi",
            ...health,
          });
        } catch (err) {
          json(res, 503, {
            status: "degraded",
            backend: "kimi",
            pid: null,
            state: "unknown",
            roundtrip: {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return;
      }

      if (method === "GET" && url.pathname === "/api/health/lark-ws") {
        if (!deps.larkWsHealth) {
          json(res, 503, {
            status: "unavailable",
            ingress: "node-sdk-ws",
            state: "unavailable",
            reconnectAttempts: 0,
          });
          return;
        }
        try {
          const health = await deps.larkWsHealth();
          const httpStatus = health.status === "ok" || health.status === "grace" ? 200 : 503;
          json(res, httpStatus, health);
        } catch {
          // Never echo provider errors here: this endpoint is a localwatch
          // machine interface and must not become an accidental credential sink.
          json(res, 503, {
            status: "degraded",
            ingress: "node-sdk-ws",
            state: "failed",
            reconnectAttempts: 0,
            lastError: "Lark SDK WS health provider failed",
          });
        }
        return;
      }

      const claudeMaintenanceStatus = method === "GET"
        && url.pathname === "/api/backends/claude/maintenance/status";
      const claudeMaintenanceMatch = method === "POST"
        && /^\/api\/backends\/claude\/maintenance\/(acquire|release)$/u.exec(url.pathname);
      if (claudeMaintenanceStatus || claudeMaintenanceMatch) {
        if (!claudeMaintenanceToken) {
          // No permissive fallback: without an out-of-band controller secret,
          // this privileged maintenance API is unavailable.
          json(res, 503, { ok: false, error: "claude_maintenance_api_disabled" });
          return;
        }
        if (!hasBearerToken(req, claudeMaintenanceToken)) {
          json(res, 401, { ok: false, error: "missing_bearer_token" });
          return;
        }
        if (!isBearerTokenMatch(req, claudeMaintenanceToken)) {
          json(res, 403, { ok: false, error: "invalid_bearer_token" });
          return;
        }

        if (claudeMaintenanceStatus) {
          try {
            const lease = await deps.store.getBackendMaintenanceLease("claude");
            json(res, 200, lease
              ? {
                  ok: true,
                  backend: "claude",
                  state: "held",
                  lease: maintenanceLeaseResponse(lease),
                }
              : {
                  ok: true,
                  backend: "claude",
                  state: "idle",
                });
          } catch (err) {
            log.error("Claude maintenance status lookup failed", {
              backend: "claude",
              err: err instanceof Error ? err.message : String(err),
            });
            json(res, 503, { ok: false, error: "claude_maintenance_store_unavailable" });
          }
          return;
        }

        if (!claudeMaintenanceMatch) return;
        const action = claudeMaintenanceMatch[1]! as "acquire" | "release";

        const body = await readBody(req, 64 * 1024);
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const parsed = claudeMaintenanceLeaseSchema.safeParse(raw);
        if (!parsed.success) {
          json(res, 400, { ok: false, error: formatZodIssues(parsed.error) });
          return;
        }

        try {
          const now = asTimestamp(Date.now());
          const tokenHash = hashOpaqueSecret(parsed.data.lease_token);
          if (action === "acquire") {
            const result = await deps.store.acquireBackendMaintenanceLease({
              backend: "claude",
              owner: CLAUDE_MAINTENANCE_OWNER,
              tokenHash,
              requestId: parsed.data.client_request_id,
              acquiredAt: now,
            });
            if (result.kind === "running_message_runs") {
              log.info("Claude maintenance acquire deferred: runs in flight", {
                owner: CLAUDE_MAINTENANCE_OWNER,
                requestId: parsed.data.client_request_id,
                runningMessageRunCount: result.runningMessageRunCount,
              });
              json(res, 409, {
                ok: false,
                error: "claude_runs_in_flight",
                backend: "claude",
                runningMessageRuns: result.runningMessageRunCount,
              });
              return;
            }
            if (result.kind === "held") {
              json(res, 409, {
                ok: false,
                error: "claude_maintenance_lease_held",
                backend: "claude",
                lease: maintenanceLeaseResponse(result.lease),
              });
              return;
            }
            log.info("Claude maintenance lease acquired", {
              owner: CLAUDE_MAINTENANCE_OWNER,
              requestId: parsed.data.client_request_id,
              duplicate: result.duplicate,
            });
            json(res, 200, {
              ok: true,
              backend: "claude",
              state: "acquired",
              duplicate: result.duplicate,
              lease: maintenanceLeaseResponse(result.lease),
            });
            return;
          }

          const result = await deps.store.releaseBackendMaintenanceLease({
            backend: "claude",
            owner: CLAUDE_MAINTENANCE_OWNER,
            tokenHash,
            requestId: parsed.data.client_request_id,
            releasedAt: now,
          });
          if (result.kind === "owner_mismatch") {
            json(res, 409, {
              ok: false,
              error: "claude_maintenance_lease_owner_mismatch",
              backend: "claude",
              lease: maintenanceLeaseResponse(result.lease),
            });
            return;
          }
          if (result.kind === "token_mismatch") {
            json(res, 409, {
              ok: false,
              error: "claude_maintenance_lease_token_mismatch",
              backend: "claude",
              lease: maintenanceLeaseResponse(result.lease),
            });
            return;
          }
          log.info("Claude maintenance lease released", {
            owner: CLAUDE_MAINTENANCE_OWNER,
            requestId: parsed.data.client_request_id,
            duplicate: result.duplicate,
          });
          json(res, 200, {
            ok: true,
            backend: "claude",
            state: "released",
            duplicate: result.duplicate,
          });
          return;
        } catch (err) {
          log.error("Claude maintenance lease operation failed", {
            action,
            owner: CLAUDE_MAINTENANCE_OWNER,
            requestId: parsed.data.client_request_id,
            err: err instanceof Error ? err.message : String(err),
          });
          json(res, 503, { ok: false, error: "claude_maintenance_store_unavailable" });
          return;
        }
      }

      if (method === "POST" && url.pathname === "/api/backends/kimi/account-switched") {
        const body = await readBody(req, 64 * 1024);
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const parsed = kimiAccountSwitchedSchema.safeParse(raw);
        if (!parsed.success) {
          const msg = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          json(res, 400, { ok: false, error: msg });
          return;
        }
        // Refuse while any kimi run is in flight — clearing its persisted id
        // mid-run would corrupt the live resume. The idempotency key is NOT
        // consumed, so the caller may retry with the same key later.
        const busy = await deps.store.countBusySessionsByBackend("kimi");
        if (busy > 0) {
          json(res, 409, { ok: false, error: "kimi_runs_in_flight", busyRuns: busy });
          return;
        }
        // The DB clearing is already durable by this point, so a recycle/probe
        // failure must not 500 — report it inside the 200 payload instead.
        const recycleAcp = async (): Promise<Record<string, unknown>> => {
          if (!deps.recycleKimiAcp) return { recycled: false, reason: "not_configured" };
          try {
            const snapshot = await deps.recycleKimiAcp();
            return { recycled: true, roundtrip: snapshot.roundtrip };
          } catch (err) {
            return {
              recycled: true,
              roundtrip: { ok: false, error: err instanceof Error ? err.message : String(err) },
            };
          }
        };
        const existing = await deps.store.findBackendAccountSwitch(parsed.data.client_request_id);
        if (existing) {
          // Duplicate: don't re-clear (counts come from the ledger), but still
          // recycle + probe so a caller whose previous response was lost gets
          // the CURRENT ACP state.
          const acp = await recycleAcp();
          json(res, 200, {
            ok: true,
            duplicate: true,
            clearedSessions: existing.clearedSessions,
            clearedBranches: existing.clearedBranches,
            acp,
          });
          return;
        }
        const now = asTimestamp(Date.now());
        const cleared = await deps.store.clearBackendSessionIdsForBackend("kimi", now);
        await deps.store.recordBackendAccountSwitch({
          clientRequestId: parsed.data.client_request_id,
          backend: "kimi",
          caller: parsed.data.from,
          fromProfile: parsed.data.from_profile ?? null,
          toProfile: parsed.data.to_profile ?? null,
          switchedAt: parsed.data.switched_at ?? null,
          clearedSessions: cleared.sessions,
          clearedBranches: cleared.branches,
          createdAt: now,
        });
        log.info("kimi account switched; cleared persisted backend session ids", {
          from: parsed.data.from,
          clientRequestId: parsed.data.client_request_id,
          clearedSessions: cleared.sessions,
          clearedBranches: cleared.branches,
        });
        const acp = await recycleAcp();
        json(res, 200, {
          ok: true,
          duplicate: false,
          clearedSessions: cleared.sessions,
          clearedBranches: cleared.branches,
          acp,
        });
        return;
      }

      if (method === "GET") {
        // Read-only lookup by comm id, for the heartbeat patrol's pre-inject
        // re-check (it only holds comm ids, not async refs). Never mutates
        // consumption state.
        const byCommMatch = url.pathname.match(/^\/api\/spawn_async_items\/by-comm\/([^/]+)$/u);
        if (byCommMatch) {
          const commId = decodeURIComponent(byCommMatch[1]!);
          const item = await deps.store.getSpawnAsyncItemByComm(commId);
          if (!item) {
            json(res, 404, { ok: false, error: "not found" });
            return;
          }
          json(res, 200, spawnAsyncItemResponse(item));
          return;
        }
        const asyncItemMatch = url.pathname.match(/^\/api\/spawn_async_items\/([^/]+)$/u);
        if (asyncItemMatch) {
          const ref = decodeURIComponent(asyncItemMatch[1]!);
          const item = await deps.store.getSpawnAsyncItem(ref);
          if (!item) {
            json(res, 404, { ok: false, error: "not found" });
            return;
          }
          json(res, 200, spawnAsyncItemResponse(item));
          return;
        }

        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/result$/u);
        if (m) {
          const sessionId = asSessionId(decodeURIComponent(m[1]!));
          const session = await deps.store.findSessionById(sessionId);
          if (!session) {
            json(res, 404, { ok: false, error: `session not found: ${sessionId}` });
            return;
          }
          const run = await deps.store.findLatestMessageRunBySession(sessionId);
          if (!run) {
            json(res, 404, { ok: false, error: `no message_run for session: ${sessionId}` });
            return;
          }
          if (run.status === "running") {
            json(res, 202, {
              ok: true,
              status: "running",
              childSessionId: session.id,
              childSessionName: session.name,
              startedAt: run.startedAt,
            });
            return;
          }
          json(res, 200, {
            ok: true,
            status: run.status,
            childSessionId: session.id,
            childSessionName: session.name,
            backendSessionId: session.backendSessionId,
            finalMessage: run.finalMessage,
            errorMessage: run.errorMessage,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          });
          return;
        }
      }

      // Caller-consumption take endpoint: fetch the result AND atomically
      // record that the caller has it (verdict='caller_consumed'), so the
      // closure fast-path / watcher never push-delivers it afterwards.
      // Consumption is recorded only after the response is confirmed written
      // — a caller that never received the bytes keeps its async delivery.
      // Both successful and synthetic boot-reconcile failure receipts are
      // takeable once their terminal finalMessage is present.
      // The plain GET stays pure-read for diagnostics and monitoring.
      if (method === "POST") {
        const takeMatch = url.pathname.match(/^\/api\/spawn_async_items\/([^/]+)\/take$/u);
        if (takeMatch) {
          const ref = decodeURIComponent(takeMatch[1]!);
          const item = await deps.store.getSpawnAsyncItem(ref);
          if (!item) {
            json(res, 404, { ok: false, error: "not found" });
            return;
          }
          const alreadyConsumed = item.status === "closed" && item.verdict === "caller_consumed";
          const resultReady =
            (item.commStatus === "completed" || item.commStatus === "failed")
            && Boolean(item.finalMessage?.trim());
          const written = await writeJson(
            res,
            200,
            {
              ...spawnAsyncItemResponse(item),
              ...(alreadyConsumed ? { alreadyConsumed: true } : {}),
            },
            { "X-SM-Spawn-Comm-Id": item.commId, "X-SM-Spawn-Async-Ref": item.ref },
          );
          if (written && resultReady && !alreadyConsumed) {
            const consumed = await deps.store.closeSpawnAsyncItemConsumed(
              ref,
              "result taken via POST /api/spawn_async_items/:ref/take",
              Date.now() as Timestamp,
            );
            if (consumed) {
              logClosureEvent(deps.logger, {
                event: "state_transition",
                commId: item.commId,
                targetSession: item.targetSession,
                callerSession: item.callerSession,
                ref,
                toStatus: "closed",
                reason: "caller_consumed via take endpoint",
              });
              if (item.childSessionId) {
                try {
                  await deps.store.recordResultSinkAttempt({
                    id: `sink_take_${randomUUID()}`,
                    spawnCommId: item.commId,
                    childSessionId: item.childSessionId as SessionId,
                    messageRunId: item.messageRunId,
                    sinkIndex: 0,
                    sinkKind: "pollable_endpoint",
                    status: "delivered",
                    note: "caller consumed via take endpoint",
                    createdAt: Date.now() as Timestamp,
                  });
                } catch (err) {
                  deps.logger.warn("take consumption sink record failed", {
                    commId: item.commId,
                    ref,
                    err: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }
          return;
        }
      }

      // Runtime-backed caller provenance. A local CLI presents the token
      // SuperMatrix injected into a run; the runtime maps that token to its
      // registry entry. The caller cannot assert a name in this request, but a
      // same-uid sibling can harvest and replay another Node process's env.
      // Therefore a successful mapping is provenance-only, not caller-bound
      // authentication, and it never carries owner authority.
      // See docs/caller-provenance-boundary.md.
      if (method === "POST" && url.pathname === "/api/caller-identity") {
        const body = await readBody(req, 8 * 1024);
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const parsed = callerIdentityBodySchema.safeParse(raw);
        if (!parsed.success) {
          json(res, 400, {
            ok: false,
            error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
          });
          return;
        }
        const attestation = callerAttestations.resolve(parsed.data.token);
        if (!attestation) {
          json(res, 403, {
            ok: false,
            attested: false,
            ownerAuthority: false,
            error: "unknown or expired caller attestation; treat this caller as unattested",
          });
          return;
        }
        json(res, 200, {
          ok: true,
          attested: true,
          ownerAuthority: false,
          sessionId: attestation.sessionId,
          sessionName: attestation.sessionName,
          ownerSessionName: resolveOwnerSessionName(attestation.sessionName),
          backend: attestation.backend,
          issuedAt: attestation.issuedAt,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/spawn2.0") {
        const body = await readBody(req, 1024 * 1024);
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        if (hasOwnKey(raw, "mode")) {
          json(res, 400, {
            ok: false,
            error: "mode is not supported in /api/spawn2.0 requests; use closure.target to declare the desired outcome",
          });
          return;
        }

        const parsedBody = spawn2BodySchema.safeParse(raw);
        if (!parsedBody.success) {
          json(res, 400, {
            ok: false,
            error: `invalid spawn2.0 body: ${formatZodIssues(parsedBody.error)}`,
          });
          return;
        }
        const parsed = parsedBody.data;
        if (parsed.closure.kind === "no_reply") {
          json(res, 400, { ok: false, error: "closure.kind=no_reply is forbidden in /api/spawn2.0" });
          return;
        }
        if (parsed.closure.kind !== "message") {
          json(res, 400, {
            ok: false,
            error: `unsupported closure.kind for /api/spawn2.0 first slice: ${parsed.closure.kind}`,
          });
          return;
        }
        if (!parsed.closure.target) {
          json(res, 400, {
            ok: false,
            error: "closure.target is required when closure.kind=message",
          });
          return;
        }
        if (parsed.backend && parsed.execution?.backend && parsed.backend !== parsed.execution.backend) {
          json(res, 400, {
            ok: false,
            error: `backend conflict: top-level backend=${parsed.backend} but execution.backend=${parsed.execution.backend}`,
          });
          return;
        }
        if (parsed.model && parsed.execution?.model && parsed.model !== parsed.execution.model) {
          json(res, 400, {
            ok: false,
            error: `model conflict: top-level model=${parsed.model} but execution.model=${parsed.execution.model}`,
          });
          return;
        }
        if (parsed.effort && parsed.execution?.effort && parsed.effort !== parsed.execution.effort) {
          json(res, 400, {
            ok: false,
            error: `effort conflict: top-level effort=${parsed.effort} but execution.effort=${parsed.execution.effort}`,
          });
          return;
        }

        // client_request_id is the caller's idempotency contract (§200): a
        // retry must not spawn a second child. Comms in pending/completed
        // status block reuse; failed comms allow a genuine retry. The
        // in-flight set covers same-process races before the comm row lands.
        const dedupKey = parsed.client_request_id;
        const priorComm = await deps.store.findCrossSessionCommForDedup(dedupKey);
        if (priorComm) {
          const priorItem = await deps.store.getSpawnAsyncItemByComm(priorComm.id);
          json(res, 409, {
            ok: false,
            duplicate: true,
            error: `duplicate client_request_id: ${dedupKey} already registered with status=${priorComm.status}; reuse is only allowed after the prior comm failed`,
            existing: {
              commId: priorComm.id,
              status: priorComm.status,
              childSessionId: priorComm.childSessionId,
              createdAt: priorComm.createdAt,
              // Self-describing follow-up: take the prior comm's result here
              // instead of re-spawning or waiting for the heartbeat push.
              ...(priorItem
                ? { ref: priorItem.ref, resultUrl: `/api/spawn_async_items/${priorItem.ref}/take` }
                : {}),
            },
          });
          return;
        }
        if (inFlightSpawn2ClientRequestIds.has(dedupKey)) {
          json(res, 409, {
            ok: false,
            duplicate: true,
            error: `duplicate client_request_id: ${dedupKey} is currently being processed by another request`,
            existing: { status: "in_flight" },
          });
          return;
        }
        inFlightSpawn2ClientRequestIds.add(dedupKey);
        res.once("close", () => inFlightSpawn2ClientRequestIds.delete(dedupKey));

        const session = await deps.store.findSessionByName(parsed.target);
        if (!session) {
          json(res, 404, { ok: false, error: `session not found: ${parsed.target}` });
          return;
        }
        const fromSession = await deps.store.findSessionByName(parsed.from);
        if (!fromSession) {
          json(res, 404, { ok: false, error: `from session not found: ${parsed.from}` });
          return;
        }

        const childDefaults = await deps.store.getChildSessionDefaults();
        const requestedBackend = parsed.execution?.backend ?? parsed.backend;
        // SpawnChildInput.backend stays a compatibility fallback. The shared
        // child service owns durable-default selection; this effective value
        // is only used to validate fields explicitly supplied by this request.
        const backend = (requestedBackend ?? session.backend) as BackendKind;
        // Resolve the tuple the child will ACTUALLY run with through the same
        // shared resolver childSession.prepareSpawn uses (durable child
        // defaults + override precedence + main-session fallback), so API
        // admission and child execution cannot diverge.
        const mainSession = await resolveMainSession(deps.store, session);
        const requestedModel = parsed.execution?.model ?? parsed.model;
        const requestedEffort = parsed.execution?.effort ?? parsed.effort;
        const backendOverride =
          requestedBackend !== undefined ? { backend } : undefined;
        const effectiveBackend = resolveChildRequestedTuple({
          defaults: childDefaults,
          override: backendOverride,
          main: mainSession,
        }).backend;
        const effort = requestedEffort === undefined
          ? undefined
          : requestedEffort === "default"
            ? null
            : requestedEffort;
        let model: string | null;
        try {
          model =
            requestedModel !== undefined
              ? requestedModel === "default"
                ? null
                : resolveAndValidateModel(requestedModel, effectiveBackend)
              : backend === session.backend
                ? session.model
                : null;
          if (effectiveBackend === backend && backend === "codex" && model !== null) {
            model = resolveAndValidateModel(model, backend);
          }
        } catch (err) {
          json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        // kimi effort is model-aware (kimi-code 0.30.0): K3 models accept a
        // level (mapped to native low/high/max at execution), K2.7 models are
        // fixed-on — reject instead of silently accepting a level that never
        // controls any run. Validated against the EFFECTIVE child tuple (not
        // just the target session model): child defaults may redirect the
        // child to a different backend/model than the target session carries,
        // so e.g. a configured K3 default accepts levels while a configured
        // K2.7 default rejects them here, before any child is created.
        const effectiveTuple = resolveChildRequestedTuple({
          defaults: childDefaults,
          override: {
            ...(backendOverride ?? {}),
            ...(requestedModel !== undefined ? { model } : {}),
            ...(requestedEffort !== undefined ? { effort: effort ?? null } : {}),
          },
          main: mainSession,
        });
        // The effective child MODEL must be validated even when it comes from
        // durable child defaults: explicit request models were validated
        // above, but a persisted default never passed through this request —
        // an invalid default (e.g. a codex model stored under the kimi
        // default) must fail admission here with 400 instead of surfacing as
        // a child execution error after the spawn was accepted.
        if (effectiveTuple.modelSource === "defaults" && effectiveTuple.model !== null) {
          try {
            resolveAndValidateModel(effectiveTuple.model, effectiveTuple.backend);
          } catch (err) {
            json(res, 400, {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
        if (effectiveTuple.backend === "kimi" && effectiveTuple.effort) {
          try {
            resolveAndValidateEffort(effectiveTuple.effort, {
              backend: effectiveTuple.backend,
              model: effectiveTuple.model,
            });
          } catch (err) {
            json(res, 400, {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }

        let verificationPredicate: NormalizedSpawnPredicate | undefined;
        if (parsed.verification_predicate !== undefined) {
          const predicateResult = normalizeVerificationPredicate(
            parsed.verification_predicate,
            predicateValidationContext,
          );
          if (!predicateResult.ok) {
            json(res, 400, {
              ok: false,
              error: `invalid verification_predicate: ${predicateResult.errors.join("; ")}`,
            });
            return;
          }
          verificationPredicate = predicateResult.value;
        }

        const delivery = await resolveSpawn2ClosureTarget(deps, parsed.closure.target);
        if (!delivery.ok) {
          json(res, delivery.status, { ok: false, error: delivery.error });
          return;
        }

        const mode = delivery.mode;
        const resultSinks = delivery.sinks;
        const deliveryAddressKinds = resultSinks.map((sink) => sink.kind);
        const originRunId = await resolveSpawn2OriginRunId(deps, parsed.origin, fromSession.id);
        log.info("api spawn2", {
          target: parsed.target,
          from: parsed.from,
          backend: effectiveBackend,
          mode,
          originRunId,
          originKind: parsed.origin?.kind ?? null,
          closureKind: parsed.closure.kind,
          closureTargetType: parsed.closure.target.type,
          promptLength: parsed.prompt.length,
        });

        const spawnInput: SpawnChildInput = {
          parentId: session.id,
          backend,
          model,
          workdir: session.workdir,
          prompt: withSpawn2DeliveryInstruction(parsed.prompt, parsed.closure.target),
          type: "one_shot_delegation",
          callerInvocation: mode,
          triggerKind: "session",
          resultSinks,
          requestedBy: fromSession.id,
          clientRequestId: parsed.client_request_id,
          originRunId,
        };
        if (verificationPredicate) {
          spawnInput.verificationPredicate = verificationPredicate;
        }
        if (effort !== undefined) {
          spawnInput.effort = effort;
        }
        const executionOverride: NonNullable<SpawnChildInput["executionOverride"]> = {};
        if (parsed.execution?.backend !== undefined || parsed.backend !== undefined) {
          executionOverride.backend = backend;
        }
        if (requestedModel !== undefined) executionOverride.model = model;
        if (requestedEffort !== undefined && effort !== undefined) executionOverride.effort = effort;
        if (Object.keys(executionOverride).length > 0) {
          spawnInput.executionOverride = executionOverride;
        }

        if (mode !== "sync_inline") {
          const ready = await runAsyncSpawnKickoff(deps, spawnInput, log);
          if ("status" in ready && ready.status === "queued") {
            json(res, 200, queuedSpawnResponse(ready));
            return;
          }
          const asyncReady = ready as AsyncSpawnReady;
          const kickoffRegistration = await registerSpawn2TodoPoolKickoff(deps, log, {
            commId: asyncReady.spawnCommId,
            callerSession: parsed.from,
            targetSession: parsed.target,
            clientRequestId: parsed.client_request_id,
            mode,
          });
          if (kickoffRegistration?.ref && asyncReady.spawnCommId) {
            scheduleLateResultClosureRoute(
              deps,
              {
                childSpawnResult: { error: "run_error", reason: "todo_pool child is still running" },
                commId: asyncReady.spawnCommId,
                lateResult: asyncReady.lateResult,
              },
              kickoffRegistration,
              {
                callerSession: parsed.from,
                targetSession: parsed.target,
              },
            );
          }
          const readyResponse = {
            childSessionId: asyncReady.childSessionId,
            childSessionName: asyncReady.childSessionName,
            messageRunId: asyncReady.messageRunId,
            ...(asyncReady.spawnCommId ? { spawnCommId: asyncReady.spawnCommId } : {}),
          };
          json(res, 202, {
            ok: true,
            mode,
            closure: "todo_pool",
            ...readyResponse,
            ...(kickoffRegistration?.ref ? { ref: kickoffRegistration.ref } : {}),
            // Self-describing consumption entry: taking the result here
            // suppresses the heartbeat push delivery (first-come wins).
            ...(kickoffRegistration?.ref
              ? { resultUrl: `/api/spawn_async_items/${kickoffRegistration.ref}/take` }
              : {}),
          });
          return;
        }

        const disconnectSwitch = createCallerDisconnectSwitch(req, res, deps, log, {
          callerSession: parsed.from,
          targetSession: parsed.target,
          mode,
          clientRequestId: parsed.client_request_id,
        });
        const firstAttempt = await runSyncSpawnAttempt(deps, spawnInput, {
          disconnectSwitch,
          logger: log,
          responseTimeoutMs: resolveSyncSpawnResponseTimeoutMs(deps),
        });
        const detached = firstAttempt.detached ?? await disconnectSwitch.detachIfDisconnected();
        if (detached) {
          scheduleLateResultClosureRoute(deps, firstAttempt, detached, {
            callerSession: parsed.from,
            targetSession: parsed.target,
          });
          disconnectSwitch.dispose();
          return;
        }
        if (firstAttempt.result && isSpawnChildQueuedResult(firstAttempt.result)) {
          disconnectSwitch.dispose();
          json(res, 200, queuedSpawnResponse(firstAttempt.result));
          return;
        }

        const firstCheck = runThreePhaseCheck({
          childSpawnResult: firstAttempt.childSpawnResult,
          callerInvocation: mode,
          declaredResultSinks: resultSinks,
          ...(deps.closureDb ? { db: deps.closureDb } : {}),
        });
        logClosureEvent(log, {
          event: "admission_validation",
          commId: firstAttempt.commId ?? null,
          targetSession: parsed.target,
          callerSession: parsed.from,
          mode,
          clientRequestId: parsed.client_request_id,
          deliveryAddressKinds,
          result: "accepted",
        });
        logPhaseCheckResults(log, firstAttempt.commId ?? null, parsed.target, parsed.from, mode, "first", firstCheck.results, deliveryAddressKinds);

        if (firstCheck.allPassed && firstAttempt.result) {
          await writeVerifiedSyncInlineResponse({
            res,
            deps,
            attempt: firstAttempt,
            result: firstAttempt.result,
            disconnectSwitch,
            callerSession: parsed.from,
            targetSession: parsed.target,
          });
          return;
        }

        if (firstCheck.firstFailure?.phase === "communication") {
          disconnectSwitch.dispose();
          json(res, 500, {
            ok: false,
            error: firstAttempt.errorMessage ?? firstCheck.firstFailure.reason,
          });
          return;
        }

        logAsyncSwitch(log, firstAttempt.commId ?? null, parsed.target, parsed.from, mode, firstCheck.firstFailure);
        const asyncRegistration = await respondSwitchedAsync(res, deps, {
          commId: firstAttempt.commId,
          firstFailure: firstCheck.firstFailure,
          callerSession: parsed.from,
          targetSession: parsed.target,
        });
        scheduleLateResultClosureRoute(deps, firstAttempt, asyncRegistration, {
          callerSession: parsed.from,
          targetSession: parsed.target,
        });
        disconnectSwitch.dispose();
        return;
      }

      if (method === "POST" && url.pathname === "/api/spawn") {
        if (legacySpawnDisabled()) {
          json(res, 410, {
            ok: false,
            error: "legacy /api/spawn is disabled; use POST /api/spawn2.0 with from, target, prompt, client_request_id, and closure",
          });
          return;
        }
        const body = await readBody(req, 1024 * 1024);
        let parsed: ParsedSpawnBody;
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        if (hasOwnKey(parsed, "mode")) {
          json(res, 400, {
            ok: false,
            error: "mode is not supported in /api/spawn requests; omit it and let the framework choose async fallback",
          });
          return;
        }
        const { target, prompt } = parsed;

        if (!target || !prompt) {
          json(res, 400, { ok: false, error: "missing target or prompt" });
          return;
        }
        const rawFrom = parsed.from;
        const normalizedFrom = typeof rawFrom === "string" ? rawFrom.trim() : "";
        if (normalizedFrom) {
          parsed.from = normalizedFrom;
        } else {
          delete parsed.from;
          emitMissingFromWarning(log, {
            target,
            promptLength: prompt.length,
            clientRequestId: parsed.client_request_id,
            remoteAddress: req.socket.remoteAddress ?? null,
            remotePort: req.socket.remotePort ?? null,
            userAgent: req.headers["user-agent"],
            hasVerificationPredicate: parsed.verification_predicate !== undefined,
            hasDeliveryAddress: parsed.delivery_address !== undefined,
            hasSinks: parsed.sinks !== undefined,
            hasSupermatrixInternal: parsed.supermatrix_internal !== undefined,
          });
        }

        if (parsed.delivery_checks !== undefined) {
          log.warn("delivery_checks ignored", {
            target,
            from: parsed.from,
            reason: "deprecated by courier delivery model",
          });
        }

        // Public /api/spawn no longer lets callers choose sync vs async.
        // External callers always get the sync closure model; async is either
        // an automatic fallback after sync failure/timeout, or an explicit
        // framework-internal dispatch flag for root-owned watcher/dispatcher
        // paths that cannot hold their inbound transport open.
        let mode: SpawnInvocationMode = "sync_inline";
        if (parsed.supermatrix_internal !== undefined) {
          if (!FRAMEWORK_INTERNAL_SPAWN_CALLERS.has(parsed.from ?? "")) {
            json(res, 403, { ok: false, error: "supermatrix_internal spawn options are restricted to framework callers" });
            return;
          }
          const internal = internalSpawnSchema.safeParse(parsed.supermatrix_internal);
          if (!internal.success) {
            json(res, 400, {
              ok: false,
              error: `invalid supermatrix_internal: ${internal.error.issues.map((i) => i.message).join("; ")}`,
            });
            return;
          }
          mode = internal.data.caller_invocation;
        }

        const session = await deps.store.findSessionByName(target);
        if (!session) {
          json(res, 404, { ok: false, error: `session not found: ${target}` });
          return;
        }

        let requestedBy: SessionId | undefined;
        if (parsed.from) {
          const fromSession = await deps.store.findSessionByName(parsed.from);
          if (fromSession) {
            requestedBy = fromSession.id;
          } else {
            json(res, 404, { ok: false, error: `from session not found: ${parsed.from}` });
            return;
          }
        }

        const childDefaults = await deps.store.getChildSessionDefaults();
        const configuredChildBackend = childDefaults.backend.configured
          ? childDefaults.backend.value
          : null;
        const VALID_BACKENDS: BackendKind[] = ["claude", "codex"];
        let backend: BackendKind = session.backend;
        if (parsed.backend) {
          if (!VALID_BACKENDS.includes(parsed.backend as BackendKind)) {
            json(res, 400, { ok: false, error: `invalid backend: ${parsed.backend} (must be claude or codex)` });
            return;
          }
          backend = parsed.backend as BackendKind;
        }
        const effectiveBackend = (parsed.backend ?? configuredChildBackend ?? backend) as BackendKind;

        let model: string | null;
        try {
          model =
            parsed.model !== undefined
              ? parsed.model === "default"
                ? null
                : resolveAndValidateModel(parsed.model, effectiveBackend)
              : backend === session.backend
                ? session.model
                : null;
          if (effectiveBackend === backend && backend === "codex" && model !== null) {
            model = resolveAndValidateModel(model, backend);
          }
        } catch (err) {
          json(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        const predicateWarnings: PredicateWarning[] = [];
        let verificationPredicate: NormalizedSpawnPredicate | undefined;
        if (parsed.verification_predicate === undefined) {
          predicateWarnings.push({
            kind: "missing predicate",
            target,
            from: parsed.from ?? "self_curl",
            errors: [],
          });
        } else {
          const predicateResult = normalizeVerificationPredicate(
            parsed.verification_predicate,
            predicateValidationContext,
          );
          if (predicateResult.ok) {
            verificationPredicate = predicateResult.value;
          } else {
            predicateWarnings.push({
              kind: "invalid predicate",
              target,
              from: parsed.from ?? "self_curl",
              errors: predicateResult.errors,
            });
          }
        }

        log.info("api spawn", {
          target,
          from: parsed.from,
          backend: effectiveBackend,
          mode,
          promptLength: prompt.length,
        });

        let resultSinks: ResultSink[];
        if (parsed.delivery_address !== undefined && parsed.sinks !== undefined) {
          json(res, 400, {
            ok: false,
            error: "delivery_address and sinks cannot both be provided",
          });
          return;
        }
        if (parsed.delivery_address !== undefined) {
          const deliveryAddress = deliveryAddressSchema.safeParse(parsed.delivery_address);
          if (!deliveryAddress.success) {
            json(res, 400, {
              ok: false,
              error: `invalid delivery_address: ${deliveryAddress.error.issues.map((i) => i.message).join("; ")}`,
            });
            return;
          }
          const resolved = await resolveDeliveryAddress(deps, deliveryAddress.data);
          if (!resolved.ok) {
            json(res, resolved.status, { ok: false, error: resolved.error });
            return;
          }
          resultSinks = resolved.sinks;
        } else if (parsed.sinks !== undefined) {
          // Caller-supplied sinks are meaningful only for framework-internal
          // async dispatch. Public requests are sync_inline and return through
          // the HTTP response, so sinks are not accepted there.
          if (mode === "sync_inline") {
            json(res, 400, {
              ok: false,
              error: "sinks are only supported for framework-internal async dispatch (sync_inline returns the result via HTTP)",
            });
            return;
          } else {
            const sinksResult = callerSinksSchema.safeParse(parsed.sinks);
            if (!sinksResult.success) {
              json(res, 400, {
                ok: false,
                error: `invalid sinks: ${sinksResult.error.issues.map((i) => i.message).join("; ")}`,
              });
              return;
            }
            const resolved: ResultSink[] = [];
            for (const sink of sinksResult.data) {
              if (sink.kind === "parent_continuation_inject") {
                const parentSession = await deps.store.findSessionByName(sink.parentSessionName);
                if (!parentSession) {
                  json(res, 404, {
                    ok: false,
                    error: `parent session not found for continuation sink: ${sink.parentSessionName}`,
                  });
                  return;
                }
                resolved.push({
                  kind: "parent_continuation_inject",
                  parentSessionId: parentSession.id,
                });
              } else {
                resolved.push(sink);
              }
            }
            resultSinks = resolved;
          }
        } else {
          // In async modes the result does NOT come back via the HTTP
          // response; the caller polls GET /api/sessions/:id/result, so we
          // fall back to a pollable sink instead of http_response.
          resultSinks =
            mode === "sync_inline"
              ? [{ kind: "http_response" }]
              : [{ kind: "pollable_endpoint" }];
        }
        log.info("api spawn delivery address resolved", {
          target,
          from: parsed.from,
          delivery_address_kinds: resultSinks.map((sink) => sink.kind),
        });
        const deliveryAddressKinds = resultSinks.map((sink) => sink.kind);

        const spawnInput: SpawnChildInput = {
          parentId: session.id,
          backend,
          model,
          workdir: session.workdir,
          prompt,
          type: "one_shot_delegation",
          callerInvocation: mode,
          triggerKind: requestedBy ? "session" : "self_curl",
          resultSinks,
        };
        const executionOverride: NonNullable<SpawnChildInput["executionOverride"]> = {};
        if (parsed.backend !== undefined) executionOverride.backend = backend;
        if (parsed.model !== undefined) executionOverride.model = model;
        if (Object.keys(executionOverride).length > 0) {
          spawnInput.executionOverride = executionOverride;
        }
        if (requestedBy) spawnInput.requestedBy = requestedBy;
        const spawnInputWithPredicate = spawnInput as SpawnChildInput & {
          verificationPredicate?: NormalizedSpawnPredicate;
          clientRequestId?: string;
        };
        if (verificationPredicate) {
          spawnInputWithPredicate.verificationPredicate = verificationPredicate;
        }
        if (parsed.client_request_id !== undefined) {
          if (typeof parsed.client_request_id !== "string") {
            json(res, 400, { ok: false, error: "client_request_id must be a string" });
            return;
          }
          spawnInputWithPredicate.clientRequestId = parsed.client_request_id;
        }

        if (mode === "sync_inline") {
          const disconnectSwitch = createCallerDisconnectSwitch(req, res, deps, log, {
            callerSession: parsed.from ?? "self_curl",
            targetSession: target,
            mode,
            ...(typeof parsed.client_request_id === "string" ? { clientRequestId: parsed.client_request_id } : {}),
          });
          const stopIfDetached = async (attempt: SyncSpawnAttempt): Promise<boolean> => {
            const detached = attempt.detached ?? await disconnectSwitch.detachIfDisconnected();
            if (!detached) return false;
            scheduleLateResultClosureRoute(deps, attempt, detached, {
              callerSession: parsed.from ?? "self_curl",
              targetSession: target,
            });
            emitPredicateWarnings(deps, predicateWarnings);
            disconnectSwitch.dispose();
            return true;
          };

          const responseTimeoutMs = resolveSyncSpawnResponseTimeoutMs(deps);
          const firstAttempt = await runSyncSpawnAttempt(deps, spawnInput, {
            disconnectSwitch,
            logger: log,
            responseTimeoutMs,
          });
          if (await stopIfDetached(firstAttempt)) return;
          if (firstAttempt.result && isSpawnChildQueuedResult(firstAttempt.result)) {
            emitPredicateWarnings(deps, predicateWarnings);
            disconnectSwitch.dispose();
            json(res, 200, queuedSpawnResponse(firstAttempt.result));
            return;
          }
          const firstCheck = runThreePhaseCheck({
            childSpawnResult: firstAttempt.childSpawnResult,
            callerInvocation: mode,
            declaredResultSinks: resultSinks,
            ...(deps.closureDb ? { db: deps.closureDb } : {}),
          });
          logClosureEvent(log, {
            event: "admission_validation",
            commId: firstAttempt.commId ?? null,
            targetSession: target,
            callerSession: parsed.from ?? "self_curl",
            mode,
            clientRequestId: typeof parsed.client_request_id === "string" ? parsed.client_request_id : undefined,
            deliveryAddressKinds,
            result: "accepted",
          });
          logPhaseCheckResults(log, firstAttempt.commId ?? null, target, parsed.from ?? "self_curl", mode, "first", firstCheck.results, deliveryAddressKinds);

          if (firstCheck.allPassed && firstAttempt.result) {
            emitPredicateWarnings(deps, predicateWarnings);
            await writeVerifiedSyncInlineResponse({
              res,
              deps,
              attempt: firstAttempt,
              result: firstAttempt.result,
              disconnectSwitch,
              callerSession: parsed.from ?? "self_curl",
              targetSession: target,
            });
            return;
          }

          if (firstCheck.firstFailure?.phase === "communication") {
            emitPredicateWarnings(deps, predicateWarnings);
            disconnectSwitch.dispose();
            json(res, 500, {
              ok: false,
              error: firstAttempt.errorMessage ?? firstCheck.firstFailure.reason,
            });
            return;
          }

          if (firstCheck.firstFailure?.failureKind === "run_timeout") {
            logAsyncSwitch(log, firstAttempt.commId ?? null, target, parsed.from ?? "self_curl", mode, firstCheck.firstFailure);
            const asyncRegistration = await respondSwitchedAsync(res, deps, {
              commId: firstAttempt.commId,
              firstFailure: firstCheck.firstFailure,
              callerSession: parsed.from ?? "self_curl",
              targetSession: target,
            });
            scheduleLateResultClosureRoute(deps, firstAttempt, asyncRegistration, {
              callerSession: parsed.from ?? "self_curl",
              targetSession: target,
            });
            emitPredicateWarnings(deps, predicateWarnings);
            disconnectSwitch.dispose();
            return;
          }

          const repeatedCheck = runThreePhaseCheck({
            childSpawnResult: firstAttempt.childSpawnResult,
            callerInvocation: mode,
            declaredResultSinks: resultSinks,
            ...(deps.closureDb ? { db: deps.closureDb } : {}),
          });
          logPhaseCheckResults(log, firstAttempt.commId ?? null, target, parsed.from ?? "self_curl", mode, "repeat", repeatedCheck.results, deliveryAddressKinds);
          if (repeatedCheck.allPassed && firstAttempt.result) {
            emitPredicateWarnings(deps, predicateWarnings);
            await writeVerifiedSyncInlineResponse({
              res,
              deps,
              attempt: firstAttempt,
              result: firstAttempt.result,
              disconnectSwitch,
              callerSession: parsed.from ?? "self_curl",
              targetSession: target,
            });
            return;
          }

          const retryAttempt = await runSyncSpawnAttempt(deps, spawnInput, {
            disconnectSwitch,
            logger: log,
            responseTimeoutMs,
          });
          if (await stopIfDetached(retryAttempt)) return;
          if (retryAttempt.result && isSpawnChildQueuedResult(retryAttempt.result)) {
            emitPredicateWarnings(deps, predicateWarnings);
            disconnectSwitch.dispose();
            json(res, 200, queuedSpawnResponse(retryAttempt.result));
            return;
          }
          logClosureEvent(log, {
            event: "sync_retry",
            commId: retryAttempt.commId ?? null,
            targetSession: target,
            callerSession: parsed.from ?? "self_curl",
            mode,
            clientRequestId: typeof parsed.client_request_id === "string" ? parsed.client_request_id : undefined,
            action: "triggered",
            previousCommId: firstAttempt.commId ?? null,
            reason: repeatedCheck.firstFailure?.reason,
          });
          logClosureEvent(log, {
            event: "admission_validation",
            commId: retryAttempt.commId ?? null,
            targetSession: target,
            callerSession: parsed.from ?? "self_curl",
            mode,
            clientRequestId: typeof parsed.client_request_id === "string" ? parsed.client_request_id : undefined,
            deliveryAddressKinds,
            result: "accepted",
          });
          const retryCheck = runThreePhaseCheck({
            childSpawnResult: retryAttempt.childSpawnResult,
            callerInvocation: mode,
            declaredResultSinks: resultSinks,
            ...(deps.closureDb ? { db: deps.closureDb } : {}),
          });
          logPhaseCheckResults(log, retryAttempt.commId ?? null, target, parsed.from ?? "self_curl", mode, "retry", retryCheck.results, deliveryAddressKinds);
          logClosureEvent(log, {
            event: "sync_retry",
            commId: retryAttempt.commId ?? null,
            targetSession: target,
            callerSession: parsed.from ?? "self_curl",
            mode,
            clientRequestId: typeof parsed.client_request_id === "string" ? parsed.client_request_id : undefined,
            action: "result",
            result: retryCheck.allPassed ? "passed" : "failed",
            reason: retryCheck.firstFailure?.reason,
            previousCommId: firstAttempt.commId ?? null,
          });
          if (retryCheck.allPassed && retryAttempt.result) {
            emitPredicateWarnings(deps, predicateWarnings);
            await writeVerifiedSyncInlineResponse({
              res,
              deps,
              attempt: retryAttempt,
              result: retryAttempt.result,
              disconnectSwitch,
              callerSession: parsed.from ?? "self_curl",
              targetSession: target,
            });
            return;
          }

          if (retryCheck.firstFailure?.phase === "communication") {
            emitPredicateWarnings(deps, predicateWarnings);
            disconnectSwitch.dispose();
            json(res, 500, {
              ok: false,
              error: retryAttempt.errorMessage ?? retryCheck.firstFailure.reason,
            });
            return;
          }

          logAsyncSwitch(log, retryAttempt.commId ?? null, target, parsed.from ?? "self_curl", mode, retryCheck.firstFailure);
          const asyncRegistration = await respondSwitchedAsync(res, deps, {
            commId: retryAttempt.commId,
            firstFailure: retryCheck.firstFailure,
            callerSession: parsed.from ?? "self_curl",
            targetSession: target,
          });
          scheduleLateResultClosureRoute(deps, retryAttempt, asyncRegistration, {
            callerSession: parsed.from ?? "self_curl",
            targetSession: target,
          });
          emitPredicateWarnings(deps, predicateWarnings);
          disconnectSwitch.dispose();
          return;
        }

        // Async: detach the spawn; resolve 202 once the run row is persisted.
        // Background errors are logged only — final status lives in message_runs
        // and is reachable via GET /api/sessions/:id/result.
        type Ready = {
          childSessionId: string;
          childSessionName: string;
          messageRunId: string;
          spawnCommId?: string;
        };
        const ready = await new Promise<Ready | SpawnChildResult>((resolve, reject) => {
          let settled = false;
          spawnInput.onSessionReady = ({ session: child, messageRunId, spawnCommId }) => {
            if (!settled) {
              settled = true;
              resolve({
                childSessionId: child.id,
                childSessionName: child.name,
                messageRunId,
                ...(spawnCommId ? { spawnCommId } : {}),
              });
            }
          };
          void deps.childSession
            .spawnChild(spawnInput)
            .then((result) => {
              if (!settled && isSpawnChildQueuedResult(result)) {
                settled = true;
                resolve(result);
              }
            })
            .catch((err) => {
              if (!settled) {
                settled = true;
                reject(err);
                return;
              }
              log.warn("async spawn failed in background", {
                err: err instanceof Error ? err.message : String(err),
              });
            });
        });

        emitPredicateWarnings(deps, predicateWarnings);
        if ("status" in ready && ready.status === "queued") {
          json(res, 200, queuedSpawnResponse(ready));
          return;
        }
        json(res, 202, {
          ok: true,
          mode,
          ...ready,
        });
        return;
      }

      if (method === "PATCH") {
        const m = url.pathname.match(/^\/api\/spawn\/([^/]+)\/predicate$/u);
        if (m) {
          if (!hasBearerToken(req, predicatePatchToken)) {
            json(res, 401, { ok: false, error: "missing bearer token" });
            return;
          }
          if (!predicatePatchToken) {
            json(res, 403, { ok: false, error: "SM_PREDICATE_PATCH_TOKEN is not configured" });
            return;
          }
          if (!isBearerTokenMatch(req, predicatePatchToken)) {
            json(res, 403, { ok: false, error: "invalid bearer token" });
            return;
          }

          const spawnCommId = decodeURIComponent(m[1]!);
          const body = await readBody(req, 1024 * 1024);
          let raw: unknown;
          try {
            raw = JSON.parse(body);
          } catch {
            json(res, 400, { ok: false, error: "invalid JSON body" });
            return;
          }

          const parsed = predicatePatchBodySchema.safeParse(raw);
          if (!parsed.success) {
            json(res, 400, {
              ok: false,
              error: `invalid predicate patch body: ${formatZodIssues(parsed.error)}`,
            });
            return;
          }

          const current = await deps.store.getSpawnPredicate(spawnCommId);
          if (!current) {
            json(res, 404, { ok: false, error: `spawn predicate not found: ${spawnCommId}` });
            return;
          }

          const normalized = normalizeVerificationPredicate(
            parsed.data.verification_predicate,
            predicateValidationContext,
          );
          if (!normalized.ok) {
            json(res, 400, {
              ok: false,
              error: `invalid verification_predicate: ${normalized.errors.join("; ")}`,
            });
            return;
          }

          const actor = await deps.store.findSessionByName(parsed.data.from);
          if (!actor) {
            json(res, 403, { ok: false, error: `unauthorized predicate patch actor: ${parsed.data.from}` });
            return;
          }

          const watcherState = await deps.store.getWatcherState(spawnCommId);
          if (!isPatchAuthorized(parsed.data, actor.id, current, watcherState)) {
            json(res, 403, { ok: false, error: "predicate patch not authorized" });
            return;
          }

          const patch = await deps.store.patchSpawnPredicate({
            id: makePatchId(spawnCommId),
            spawnCommId,
            actorSessionId: actor.id,
            actorRole: parsed.data.actor_role,
            txId: parsed.data.tx_id ?? null,
            reason: parsed.data.reason,
            normalizedPredicate: normalized.value,
            patchedAt: Date.now() as Timestamp,
          });

          json(res, 200, {
            ok: true,
            spawnCommId,
            version: patch.version,
            predicateHash: patch.predicateHash,
          });
          return;
        }
      }

      if (method === "POST" && url.pathname === "/api/run") {
        // Run a prompt on an EXISTING user-scope session, resuming its main
        // backend_session_id. Equivalent to "user typed in chat" without
        // posting anything to chat. v1 supports sync_inline only — async
        // modes can be added once a polling contract for /api/sessions/:id
        // is agreed.
        const body = await readBody(req, 1024 * 1024);
        let parsed: { target?: string; prompt?: string; from?: string };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const { target, prompt } = parsed;
        if (!target || !prompt) {
          json(res, 400, { ok: false, error: "missing target or prompt" });
          return;
        }
        const session = await deps.store.findSessionByName(target);
        if (!session) {
          json(res, 404, { ok: false, error: `session not found: ${target}` });
          return;
        }
        if (session.scope !== "user") {
          json(res, 400, {
            ok: false,
            error: `target scope must be 'user' (got '${session.scope}'); /api/run does not resume child sessions`,
          });
          return;
        }
        if (session.status === "deleted") {
          json(res, 400, { ok: false, error: `target session is deleted: ${target}` });
          return;
        }
        if (session.status === "error") {
          json(res, 400, {
            ok: false,
            error: `target session in error state — use /restart or /reset first`,
          });
          return;
        }
        let requesterSessionId: SessionId | undefined;
        if (parsed.from) {
          const fromSession = await deps.store.findSessionByName(parsed.from);
          if (!fromSession) {
            json(res, 404, { ok: false, error: `from session not found: ${parsed.from}` });
            return;
          }
          requesterSessionId = fromSession.id;
        }
        // message_runs.group_id is a soft FK — every user-scope session has
        // a binding by lifecycle invariant, but if a hand-edited DB ever
        // breaks that, fail loud rather than silently coerce.
        const binding = await deps.store.findBySession(session.id);
        if (!binding) {
          json(res, 500, {
            ok: false,
            error: `target session has no binding (data inconsistency): ${target}`,
          });
          return;
        }

        log.info("api run", {
          target,
          from: parsed.from,
          backend: session.backend,
          status: session.status,
          promptLength: prompt.length,
        });

        const runInput: RunOnSessionInput = {
          session,
          prompt,
          groupId: binding.groupId,
        };
        if (requesterSessionId) {
          runInput.requesterSessionId = requesterSessionId;
        }
        const result = await deps.runOnSession(runInput);

        if (result.kind === "maintenance") {
          json(res, 423, {
            ok: false,
            error: "backend_maintenance",
            backend: result.backend,
            leaseOwner: result.leaseOwner,
          });
          return;
        }
        if (result.kind === "busy") {
          json(res, 409, {
            ok: false,
            error: `target busy: ${target}`,
            currentRunId: result.currentRunId,
          });
          return;
        }
        if (result.kind === "error") {
          json(res, 200, {
            ok: false,
            target,
            sessionId: session.id,
            runId: result.runId,
            runStatus: result.runStatus,
            finalMessage: result.finalMessage,
            error: result.error,
          });
          return;
        }
        json(res, 200, {
          ok: true,
          target,
          sessionId: session.id,
          runId: result.runId,
          runStatus: result.runStatus,
          finalMessage: result.finalMessage,
          backendSessionId: result.backendSessionId,
        });
        return;
      }

      // Dedicated endpoint for the watcher-exception fallback (formerly
       // multiplexed inside /api/notify via body.kind). Callers should migrate
       // here so the main /api/notify path can enforce strict schema.
      if (method === "POST" && url.pathname === "/api/watcher-exception-notify") {
        const body = await readBody(req, 1024 * 1024);
        let raw: unknown;
        try { raw = JSON.parse(body); }
        catch { json(res, 400, { error: "invalid JSON body" }); return; }
        await handleWatcherExceptionNotify(deps, raw, res, log);
        return;
      }

      if (method === "POST" && url.pathname === "/api/notify") {
        const body = await readBody(req, 1024 * 1024);
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (isRecord(raw) && raw.kind === "spawn_exception_transaction_fallback") {
          // Backward-compatible deprecation path: callers should POST to
          // /api/watcher-exception-notify instead. We still service the request
          // so we don't break watcher-tick.sh mid-flight, but warn loudly to
          // surface remaining call sites in the logs.
          log.warn("watcher exception fallback posted to deprecated path /api/notify; migrate to /api/watcher-exception-notify", {
            spawnCommId: isRecord(raw) && typeof raw.spawn_comm_id === "string" ? raw.spawn_comm_id : null,
          });
          await handleWatcherExceptionNotify(deps, raw, res, log);
          return;
        }
        const parsed = notifyInputSchema.safeParse(raw);
        if (!parsed.success) {
          const msg = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          json(res, 400, { error: msg });
          return;
        }
        try {
          const result = await deps.notifier.notify(parsed.data);
          log.info("notify sent", {
            source: parsed.data.source,
            degraded: result.degraded,
            deduped: result.deduped ?? false,
            code: result.code,
            messageId: result.messageId,
          });
          const responseBody: Record<string, unknown> = { messageId: result.messageId };
          if (result.degraded) {
            responseBody.degraded = true;
            if (result.error) responseBody.error = result.error;
            if (result.code) responseBody.code = result.code;
          }
          if (result.deduped) responseBody.deduped = true;
          json(res, 200, responseBody);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          // Rate-limit failures bubble up as Error("rate limit: source '...' ..."). Map
          // those to 429 so callers can tell "your notify was dropped because you're
          // sending too fast" apart from "the upstream actually broke" (500).
          if (msg.startsWith("rate limit:")) {
            log.warn("notify rate-limited", { err: msg, source: parsed.data.source });
            json(res, 429, { error: msg, code: "rate_limited" });
          } else {
            log.error("notify failed", { err: msg, source: parsed.data.source });
            json(res, 500, { error: msg });
          }
        }
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      log.error("api error", { path: url.pathname, err: message });
      json(res, 500, { ok: false, error: message });
    }
  });

  for (let attempt = 0; attempt <= MAX_BIND_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          log.info("api server listening", { port });
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      server.on("error", (err) => {
        log.error("api server error", { err: err.message });
      });
      return server;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EADDRINUSE" && attempt < MAX_BIND_RETRIES) {
        log.warn("api port in use, retrying", { port, attempt: attempt + 1, maxRetries: MAX_BIND_RETRIES });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to bind api server on port ${port}`);
}

// Resolve the batch_key carried through the closure fast-path/watcher as
// origin_run_id. An explicit body.origin wins so fan-out spawns sharing one
// trigger collapse to a single batch; absent origin falls back to the caller's
// running message run (today's behavior) and ultimately the auto:* hash path.
async function resolveSpawn2OriginRunId(
  deps: ApiDeps,
  origin: Spawn2Origin | undefined,
  fromSessionId: SessionId,
): Promise<MessageRunId | null> {
  if (origin) {
    switch (origin.kind) {
      case "scheduler":
        return asMessageRunId(`scheduler:${origin.task_id}:${origin.run_id}`);
      case "message_run":
        return asMessageRunId(origin.run_id);
      case "other":
        return asMessageRunId(`other:${origin.key}`);
    }
  }
  const originRun = await deps.store.findRunningMessageRunBySession(fromSessionId);
  return originRun?.id ?? null;
}

type SyncSpawnAttempt = {
  childSpawnResult: SpawnChildCompletedResult | { error: "timeout" | "spawn_failed" | "run_error"; reason: string };
  commId?: string;
  lateResult?: Promise<SpawnChildResult>;
  detached?: {
    commId: string;
    ref?: string;
    error?: string;
  };
  errorMessage?: string;
  result?: SpawnChildResult;
};

type CallerDisconnectSwitch = {
  onSessionReady(spawnCommId: string | undefined): void;
  detached: Promise<{ commId: string; ref?: string; error?: string }>;
  detachIfDisconnected(): Promise<{ commId: string; ref?: string; error?: string } | undefined>;
  markResponseWriteFailed(): void;
  dispose(): void;
};

async function runSyncSpawnAttempt(
  deps: ApiDeps,
  input: SpawnChildInput,
  options: { disconnectSwitch?: CallerDisconnectSwitch; logger?: Logger; responseTimeoutMs?: number } = {},
): Promise<SyncSpawnAttempt> {
  let readyCommId: string | undefined;
  const spawnPromise = deps.childSession.spawnChild({
    ...input,
    onSessionReady: async (info) => {
      readyCommId = info.spawnCommId;
      options.disconnectSwitch?.onSessionReady(info.spawnCommId);
      await input.onSessionReady?.(info);
    },
  });

  const backgroundLog = options.logger ?? deps.logger;
  const spawnOutcome = spawnPromise.then(
    (result) => ({ kind: "result" as const, result }),
    (err) => ({ kind: "error" as const, err }),
  );
  const responseTimeout =
    options.responseTimeoutMs !== undefined
      ? syncResponseTimeout(options.responseTimeoutMs, () => readyCommId)
      : undefined;
  const outcome = options.disconnectSwitch
    ? await Promise.race([
        spawnOutcome,
        options.disconnectSwitch.detached.then((detached) => ({ kind: "detached" as const, detached })),
        ...(responseTimeout ? [responseTimeout.promise] : []),
      ])
    : await Promise.race([
        spawnOutcome,
        ...(responseTimeout ? [responseTimeout.promise] : []),
      ]);
  responseTimeout?.clear();

  if (outcome.kind === "detached") {
    void spawnPromise.catch((err) => {
      backgroundLog.warn("detached sync spawn failed after caller disconnect", {
        commId: outcome.detached.commId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    return {
      childSpawnResult: {
        error: "run_error",
        reason: "caller disconnected before sync spawn result could be delivered",
      },
      commId: outcome.detached.commId,
      lateResult: spawnPromise,
      detached: outcome.detached,
    };
  }

  if (outcome.kind === "response_timeout") {
    void spawnPromise.catch((err) => {
      backgroundLog.warn("sync spawn failed after response timeout switch", {
        commId: outcome.commId ?? null,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    return {
      childSpawnResult: outcome.commId
        ? {
            error: "timeout",
            reason: `sync spawn response deadline reached after ${outcome.timeoutMs}ms before child completed`,
          }
        : {
            error: "spawn_failed",
            reason: `sync spawn response deadline reached after ${outcome.timeoutMs}ms before child session started`,
          },
      ...(outcome.commId ? { commId: outcome.commId } : {}),
      lateResult: spawnPromise,
      errorMessage: `sync spawn response deadline reached after ${outcome.timeoutMs}ms`,
    };
  }

  if (outcome.kind === "result") {
    const commId = outcome.result.spawnCommId ?? readyCommId;
    if (isSpawnChildQueuedResult(outcome.result)) {
      return {
        childSpawnResult: {
          error: "spawn_failed",
          reason: "spawn queued before child session started",
        },
        ...(commId ? { commId } : {}),
        result: outcome.result,
      };
    }
    if (options.disconnectSwitch && commId) {
      options.disconnectSwitch.onSessionReady(commId);
      const detached = await options.disconnectSwitch.detachIfDisconnected();
      if (detached) {
        return {
          childSpawnResult: {
            error: "run_error",
            reason: "caller disconnected before sync spawn result could be delivered",
          },
          commId: detached.commId,
          detached,
        };
      }
    }
    return {
      childSpawnResult: outcome.result,
      ...(commId ? { commId } : {}),
      lateResult: spawnPromise,
      result: outcome.result,
    };
  }

  try {
    throw outcome.err;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      childSpawnResult: {
        error: classifySyncSpawnError(message, readyCommId),
        reason: message,
      },
      ...(readyCommId ? { commId: readyCommId } : {}),
      errorMessage: message,
    };
  }
}

function syncResponseTimeout(timeoutMs: number, commId: () => string | undefined): {
  promise: Promise<{ kind: "response_timeout"; timeoutMs: number; commId?: string }>;
  clear: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{ kind: "response_timeout"; timeoutMs: number; commId?: string }>((resolve) => {
    handle = setTimeout(() => {
      const activeCommId = commId();
      resolve({
        kind: "response_timeout",
        timeoutMs,
        ...(activeCommId ? { commId: activeCommId } : {}),
      });
    }, timeoutMs);
    if (typeof handle === "object" && "unref" in handle) handle.unref();
  });
  return {
    promise,
    clear: () => {
      if (handle) clearTimeout(handle);
    },
  };
}

function resolveSyncSpawnResponseTimeoutMs(deps: ApiDeps): number {
  if (deps.syncSpawnResponseTimeoutMs !== undefined) {
    return positiveTimeoutOrDefault(deps.syncSpawnResponseTimeoutMs);
  }
  return positiveTimeoutOrDefault(
    Number(process.env.SM_SPAWN_SYNC_RESPONSE_TIMEOUT_MS),
  );
}

function positiveTimeoutOrDefault(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_SYNC_SPAWN_RESPONSE_TIMEOUT_MS;
}

function classifySyncSpawnError(message: string, commId: string | undefined): "timeout" | "spawn_failed" | "run_error" {
  if (!commId) return "spawn_failed";
  return /timed out|timeout/iu.test(message) ? "timeout" : "run_error";
}

function createCallerDisconnectSwitch(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  deps: ApiDeps,
  logger: Logger,
  input: {
    callerSession: string;
    targetSession: string;
    mode: "sync_inline";
    clientRequestId?: string;
  },
): CallerDisconnectSwitch {
  let disconnected = false;
  let disconnectReason = "caller HTTP connection closed before sync spawn completed";
  let commId: string | undefined;
  let registration: Promise<{ commId: string; ref?: string; error?: string }> | undefined;
  let resolveDetached!: (value: { commId: string; ref?: string; error?: string }) => void;
  const detached = new Promise<{ commId: string; ref?: string; error?: string }>((resolve) => {
    resolveDetached = resolve;
  });

  const failure = (): PhaseCheckResult => ({
    phase: "delivery",
    passed: false,
    reason: disconnectReason,
    failureKind: "late_result",
  });

  const tryRegister = () => {
    if (!disconnected || !commId || registration) return;
    const activeCommId = commId;
    const firstFailure = failure();
    registration = registerAsyncItem({
      store: deps.store,
      commId: activeCommId,
      callerSession: input.callerSession,
      targetSession: input.targetSession,
      firstFailure,
      now: Date.now() as Timestamp,
    }).then(
      ({ ref }) => {
        logClosureEvent(logger, {
          event: "async_switch",
          commId: activeCommId,
          targetSession: input.targetSession,
          callerSession: input.callerSession,
          mode: input.mode,
          clientRequestId: input.clientRequestId,
          decision: "registered",
          ref,
          failedPhase: firstFailure.phase,
          failureKind: firstFailure.failureKind,
          reason: firstFailure.reason,
          nextStatus: ref ? "waiting_child" : undefined,
        });
        logClosureEvent(logger, {
          event: "state_transition",
          commId: activeCommId,
          targetSession: input.targetSession,
          callerSession: input.callerSession,
          mode: input.mode,
          clientRequestId: input.clientRequestId,
          ref,
          toStatus: "waiting_child",
          reason: firstFailure.reason,
        });
        const out = { commId: activeCommId, ref };
        resolveDetached(out);
        return out;
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        logClosureEvent(logger, {
          event: "async_switch",
          commId: activeCommId,
          targetSession: input.targetSession,
          callerSession: input.callerSession,
          mode: input.mode,
          clientRequestId: input.clientRequestId,
          decision: "sync_error",
          failedPhase: firstFailure.phase,
          failureKind: firstFailure.failureKind,
          reason: message,
        });
        const out = { commId: activeCommId, error: message };
        resolveDetached(out);
        return out;
      },
    );
  };

  const markDisconnected = (reason: string, force = false) => {
    if (disconnected || (res.writableEnded && !force)) return;
    disconnected = true;
    disconnectReason = reason;
    tryRegister();
  };

  const onRequestAborted = () => markDisconnected("caller HTTP request aborted before sync spawn completed");
  const onRequestClose = () => {
    if (!req.complete) markDisconnected("caller HTTP request closed before sync spawn completed");
  };
  const onResponseClose = () => {
    if (!res.writableEnded) markDisconnected("caller HTTP response closed before sync spawn completed");
  };
  const refreshDisconnectedState = () => {
    if (res.destroyed && !res.writableEnded) {
      markDisconnected("caller HTTP response closed before sync spawn completed");
      return;
    }
    if (req.aborted) {
      markDisconnected("caller HTTP request aborted before sync spawn completed");
      return;
    }
    if (req.destroyed && !req.complete && !res.writableEnded) {
      markDisconnected("caller HTTP request closed before sync spawn completed");
    }
  };

  req.on("aborted", onRequestAborted);
  req.on("close", onRequestClose);
  res.on("close", onResponseClose);

  return {
    onSessionReady(spawnCommId) {
      if (spawnCommId) {
        commId = spawnCommId;
        refreshDisconnectedState();
        tryRegister();
      }
    },
    detached,
    async detachIfDisconnected() {
      refreshDisconnectedState();
      tryRegister();
      return registration ? await registration : undefined;
    },
    markResponseWriteFailed() {
      markDisconnected("caller HTTP response could not be written after sync spawn completed", true);
    },
    dispose() {
      req.off("aborted", onRequestAborted);
      req.off("close", onRequestClose);
      res.off("close", onResponseClose);
    },
  };
}

async function resolveDeliveryAddress(
  deps: ApiDeps,
  address: DeliveryAddress,
): Promise<{ ok: true; sinks: ResultSink[] } | { ok: false; status: number; error: string }> {
  switch (address.kind) {
    case "caller":
      return { ok: true, sinks: [{ kind: "http_response" }] };
    case "chat":
      return {
        ok: true,
        sinks: [{ kind: "chat_post", chatRef: { kind: "explicit", chatId: address.chatId }, identity: address.identity }],
      };
    case "session": {
      const session = await deps.store.findSessionByName(address.sessionName);
      if (!session) {
        return { ok: false, status: 404, error: `delivery session not found: ${address.sessionName}` };
      }
      return { ok: true, sinks: [{ kind: "parent_continuation_inject", parentSessionId: session.id }] };
    }
    case "topic":
      return { ok: true, sinks: [{ kind: "eventbus_publish", topic: address.topic }] };
  }
}

async function resolveSpawn2ClosureTarget(
  deps: ApiDeps,
  target: Spawn2ClosureTarget,
): Promise<
  | { ok: true; mode: "sync_inline" | "async_kickoff"; sinks: ResultSink[] }
  | { ok: false; status: number; error: string }
> {
  switch (target.type) {
    case "inline":
      return { ok: true, mode: "sync_inline", sinks: [{ kind: "http_response" }] };
    case "session": {
      const session = await deps.store.findSessionByName(target.session_name);
      if (!session) {
        return { ok: false, status: 404, error: `closure target session not found: ${target.session_name}` };
      }
      return {
        ok: true,
        mode: "sync_inline",
        sinks: [{ kind: "parent_continuation_inject", parentSessionId: session.id }],
      };
    }
    case "topic":
      return { ok: true, mode: "sync_inline", sinks: [{ kind: "eventbus_publish", topic: target.topic }] };
    case "todo_pool":
      return { ok: true, mode: "async_kickoff", sinks: [{ kind: "pollable_endpoint" }] };
  }
}

function spawn2DeliveryInstruction(target: Spawn2ClosureTarget): string {
  switch (target.type) {
    case "inline":
      return "交付规则：仅在本回复给结果；同步窗口内直返发起方，超时后框架转为异步结果，供发起方按 resultUrl 取回；勿另行回调。";
    case "session":
      return "交付规则：仅在本回复给结果；框架会转投目标会话，若同步窗口超时，结果会异步保存并由框架继续投递；勿另行回调。";
    case "topic":
      return "交付规则：仅在本回复给结果；框架会发布到目标 topic，若同步窗口超时，结果会异步保存并由框架继续投递；勿另行回调。";
    case "todo_pool":
      return "交付规则：仅在本回复给结果；框架会异步写入待办池，无需向发起方另行回执；若确认发起方无需后续处理，请在最终回复末尾单独写一行：SM_CLOSURE_ACTION: no_action";
  }
}

function withSpawn2DeliveryInstruction(prompt: string, target: Spawn2ClosureTarget): string {
  return `${spawn2DeliveryInstruction(target)}\n\n${prompt}`;
}

type AsyncSpawnReady = {
  childSessionId: string;
  childSessionName: string;
  messageRunId: string;
  spawnCommId?: string;
  lateResult: Promise<SpawnChildResult>;
};

async function runAsyncSpawnKickoff(
  deps: ApiDeps,
  input: SpawnChildInput,
  logger: Logger,
): Promise<AsyncSpawnReady | Extract<SpawnChildResult, { status: "queued" }>> {
  return await new Promise<AsyncSpawnReady | Extract<SpawnChildResult, { status: "queued" }>>((resolve, reject) => {
    let settled = false;
    let lateResult: Promise<SpawnChildResult> | undefined;
    const settle = (value: AsyncSpawnReady | Extract<SpawnChildResult, { status: "queued" }>) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReady = (value: Omit<AsyncSpawnReady, "lateResult">) => {
      const publish = () => {
        if (!lateResult) return;
        settle({ ...value, lateResult });
      };
      if (lateResult) publish();
      else queueMicrotask(publish);
    };
    const spawnPromise = deps.childSession
      .spawnChild({
        ...input,
        onSessionReady: ({ session, messageRunId, spawnCommId }) => {
          settleReady({
            childSessionId: session.id,
            childSessionName: session.name,
            messageRunId,
            ...(spawnCommId ? { spawnCommId } : {}),
          });
        },
      });
    lateResult = spawnPromise;
    void spawnPromise
      .then((result) => {
        if (isSpawnChildQueuedResult(result)) {
          settle(result);
          return;
        }
        settle({
          childSessionId: result.session.id,
          childSessionName: result.session.name,
          messageRunId: result.messageRunId,
          ...(result.spawnCommId ? { spawnCommId: result.spawnCommId } : {}),
          lateResult: spawnPromise,
        });
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        logger.warn("async spawn failed in background", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  });
}

async function registerSpawn2TodoPoolKickoff(
  deps: ApiDeps,
  logger: Logger,
  input: {
    commId: string | undefined;
    callerSession: string;
    targetSession: string;
    clientRequestId: string;
    mode: "async_kickoff" | "fire_and_forget";
  },
): Promise<{ ref: string; status: string } | null> {
  if (!input.commId) return null;
  const firstFailure: PhaseCheckResult = {
    phase: "delivery",
    passed: false,
    reason: "todo_pool kickoff: caller did not wait synchronously; awaiting child closure",
    failureKind: "late_result",
  };
  try {
    const { ref, status } = await registerAsyncItem({
      store: deps.store,
      commId: input.commId,
      callerSession: input.callerSession,
      targetSession: input.targetSession,
      firstFailure,
      now: Date.now() as Timestamp,
    });
    logClosureEvent(logger, {
      event: "async_switch",
      commId: input.commId,
      targetSession: input.targetSession,
      callerSession: input.callerSession,
      mode: input.mode,
      clientRequestId: input.clientRequestId,
      decision: "registered",
      ref,
      failedPhase: firstFailure.phase,
      failureKind: firstFailure.failureKind,
      reason: firstFailure.reason,
      nextStatus: status,
    });
    logClosureEvent(logger, {
      event: "state_transition",
      commId: input.commId,
      targetSession: input.targetSession,
      callerSession: input.callerSession,
      mode: input.mode,
      clientRequestId: input.clientRequestId,
      ref,
      toStatus: status,
      reason: firstFailure.reason,
    });
    return { ref, status };
  } catch (err) {
    logger.warn("spawn2 todo_pool async item registration failed", {
      commId: input.commId,
      callerSession: input.callerSession,
      targetSession: input.targetSession,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function verifiedSpawnResponse(mode: "sync_inline", result: SpawnChildResult) {
  if (isSpawnChildQueuedResult(result)) return queuedSpawnResponse(result);
  return {
    ok: true,
    mode,
    closure: "verified",
    childSessionId: result.session.id,
    childSessionName: result.session.name,
    finalMessage: result.finalMessage,
    backendSessionId: result.backendSessionId,
    spawnCommId: result.spawnCommId,
  };
}

function queuedSpawnResponse(result: Extract<SpawnChildResult, { status: "queued" }>) {
  return {
    ok: true,
    status: "queued",
    ref: result.ref,
    comm_id: result.commId,
    spawnCommId: result.spawnCommId,
    ttlSec: result.ttlSec,
    resultUrl: `/api/spawn_async_items/${result.ref}/take`,
  };
}

async function writeVerifiedSyncInlineResponse(input: {
  res: import("node:http").ServerResponse;
  deps: ApiDeps;
  attempt: SyncSpawnAttempt;
  result: SpawnChildResult;
  disconnectSwitch: CallerDisconnectSwitch;
  callerSession: string;
  targetSession: string;
}): Promise<void> {
  const spawnCommId = input.result.spawnCommId;
  const responseWritten = await writeJson(
    input.res,
    200,
    verifiedSpawnResponse("sync_inline", input.result),
    spawnCommId ? { "X-SM-Spawn-Comm-Id": spawnCommId } : undefined,
  );
  if (responseWritten && !isSpawnChildQueuedResult(input.result)) {
    try {
      await input.deps.store.recordResultSinkAttempt({
        id: `sink_sync_inline_${randomUUID()}`,
        spawnCommId: input.result.spawnCommId ?? null,
        childSessionId: input.result.session.id,
        messageRunId: input.result.messageRunId,
        sinkIndex: 0,
        sinkKind: "http_response",
        status: "delivered",
        note: "sync_inline response written",
        createdAt: Date.now() as Timestamp,
      });
    } catch (err) {
      input.deps.logger.warn("sync_inline response delivery record failed", {
        commId: input.result.spawnCommId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (spawnCommId) {
      try {
        await input.deps.store.closeSpawnAsyncItemSyncDelivered(
          spawnCommId,
          "sync_inline response written; caller received the result over HTTP",
          Date.now() as Timestamp,
        );
      } catch (err) {
        input.deps.logger.warn("sync_inline async item close failed", {
          commId: spawnCommId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    input.disconnectSwitch.dispose();
    return;
  }

  input.disconnectSwitch.markResponseWriteFailed();
  const detached = input.attempt.detached ?? await input.disconnectSwitch.detachIfDisconnected();
  if (detached) {
    scheduleLateResultClosureRoute(input.deps, input.attempt, detached, {
      callerSession: input.callerSession,
      targetSession: input.targetSession,
    });
  }
  input.disconnectSwitch.dispose();
}

function logPhaseCheckResults(
  logger: Logger,
  commId: string | null,
  targetSession: string,
  callerSession: string,
  mode: string,
  attempt: "first" | "repeat" | "retry",
  results: PhaseCheckResult[],
  deliveryAddressKinds: string[],
): void {
  for (const result of results) {
    logClosureEvent(logger, {
      event: "phase_check",
      commId,
      targetSession,
      callerSession,
      mode,
      attempt,
      phase: result.phase,
      passed: result.passed,
      reason: result.reason,
      failureKind: result.failureKind,
      deliveryAddressKinds,
    });
  }
}

function logAsyncSwitch(
  logger: Logger,
  commId: string | null,
  targetSession: string,
  callerSession: string,
  mode: string,
  firstFailure: PhaseCheckResult | undefined,
): void {
  logClosureEvent(logger, {
    event: "async_switch",
    commId,
    targetSession,
    callerSession,
    mode,
    decision: "registered",
    failedPhase: firstFailure?.phase,
    failureKind: firstFailure?.failureKind,
    reason: firstFailure?.reason,
    nextStatus: nextAsyncStatus(firstFailure),
  });
}

async function respondSwitchedAsync(
  res: import("node:http").ServerResponse,
  deps: ApiDeps,
  input: {
    commId: string | undefined;
    firstFailure: PhaseCheckResult | undefined;
    callerSession: string;
    targetSession: string;
  },
): Promise<{ ref: string; status: string } | null> {
  if (!input.commId || !input.firstFailure?.failureKind) {
    json(res, 500, {
      ok: false,
      error: input.firstFailure?.reason ?? "spawn failed before comm_id was created",
    });
    return null;
  }

  const { ref, status } = await registerAsyncItem({
    store: deps.store,
    commId: input.commId,
    callerSession: input.callerSession,
    targetSession: input.targetSession,
    firstFailure: input.firstFailure,
    now: Date.now() as Timestamp,
  });
  logClosureEvent(deps.logger, {
    event: "state_transition",
    commId: input.commId,
    targetSession: input.targetSession,
    callerSession: input.callerSession,
    ref,
    toStatus: status,
    reason: input.firstFailure.reason,
  });

  json(res, 200, {
    ok: false,
    status: "switched_async",
    ref,
    spawnCommId: input.commId,
    resultUrl: `/api/spawn_async_items/${ref}/take`,
    message: `已转异步结果待取；请按 resultUrl 取回终态结果，勿重发同一请求。ref=${ref}`,
  });
  return { ref, status };
}

function scheduleLateResultClosureRoute(
  deps: ApiDeps,
  attempt: SyncSpawnAttempt,
  registration: { ref?: string; error?: string } | null | undefined,
  context: { callerSession: string; targetSession: string },
): void {
  if (!attempt.lateResult || !attempt.commId || !registration?.ref) return;
  const commId = attempt.commId;
  const ref = registration.ref;
  void attempt.lateResult
    .then(async (result) => {
      if (isSpawnChildQueuedResult(result)) return;
      if (!deps.routeSpawnClosureItem) return;
      await deps.routeSpawnClosureItem?.({
        ref,
        commId,
        callerSession: context.callerSession,
        targetSession: context.targetSession,
      });
    })
    .catch((err) => {
      deps.logger.warn("late spawn closure route skipped after background failure", {
        commId,
        ref,
        callerSession: context.callerSession,
        targetSession: context.targetSession,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

function nextAsyncStatus(firstFailure: PhaseCheckResult | undefined): string | undefined {
  if (!firstFailure?.failureKind) return undefined;
  if (firstFailure.failureKind === "run_timeout" || firstFailure.failureKind === "late_result") {
    return "waiting_child";
  }
  return "pending";
}

function json(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  void writeJson(res, status, data);
}

function spawnAsyncItemResponse(item: SpawnAsyncItemRecord): Record<string, unknown> {
  return {
    ok: true,
    ...item,
    resultUrl: `/api/spawn_async_items/${encodeURIComponent(item.ref)}/take`,
  };
}

function parseNonNegativeEpochMs(value: string | null): Timestamp | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return asTimestamp(parsed);
}

function sumSchedulerTokenUsage(tasks: SchedulerTokenUsage[]): SchedulerTokenUsageTotals {
  return tasks.reduce<SchedulerTokenUsageTotals>(
    (totals, task) => ({
      inputTokens: totals.inputTokens + task.inputTokens,
      outputTokens: totals.outputTokens + task.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + task.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + task.cacheWriteTokens,
      reasoningTokens: totals.reasoningTokens + task.reasoningTokens,
      totalTokens: totals.totalTokens + task.totalTokens,
      runCount: totals.runCount + task.runCount,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      runCount: 0,
    },
  );
}

function writeJson(res: import("node:http").ServerResponse, status: number, data: unknown, extraHeaders?: Record<string, string>): Promise<boolean> {
  // Outer catch blocks reach here even when the client (Feishu, fetch with
  // AbortSignal, monitoring probe) has already torn the TCP connection down.
  // Without these guards, writeHead/end on a destroyed socket throws
  // ERR_STREAM_DESTROYED / ERR_HTTP_HEADERS_SENT, masking the original error
  // and surfacing as an unhandled rejection.
  if (res.destroyed || res.writableEnded || res.headersSent) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (written: boolean) => {
      if (settled) return;
      settled = true;
      res.off("finish", onFinish);
      res.off("close", onClose);
      resolve(written);
    };
    const onFinish = () => settle(!res.destroyed);
    const onClose = () => settle(false);
    res.once("finish", onFinish);
    res.once("close", onClose);
    try {
      res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
      res.end(JSON.stringify(data));
    } catch {
      // socket died between the guard above and the actual write — nothing
      // useful we can do, and we must not crash the API server.
      settle(false);
    }
  });
}

function hasOwnKey(input: unknown, key: string): boolean {
  return typeof input === "object" && input !== null && Object.prototype.hasOwnProperty.call(input, key);
}

function readBody(req: import("node:http").IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeVerificationPredicate(input: unknown, context: PredicateLintContext = {}):
  | { ok: true; value: NormalizedSpawnPredicate }
  | { ok: false; errors: string[] } {
  try {
    const value = validateSpawnPredicate(input, context);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, errors: err.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`) };
    }
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

function emitMissingFromWarning(logger: Logger, fields: MissingFromWarningFields): void {
  logger.warn("api spawn missing from", {
    kind: "missing from",
    ...fields,
  });
}

function emitPredicateWarnings(deps: ApiDeps, warnings: PredicateWarning[]): void {
  for (const warning of warnings) {
    const warningId = `predicate-warning-${randomUUID()}`;
    const stack = shortStack();
    const dedupeKey = predicateWarningDedupeKey(warning);
    deps.logger.warn("predicate-schema-warning", {
      warningId,
      dedupeKey,
      kind: warning.kind,
      target: warning.target,
      from: warning.from,
      errors: warning.errors,
      stack,
    });
    if (predicateWarningChildDedupe.has(dedupeKey)) {
      deps.logger.info("predicate-schema-warning fp-spawn deduped", {
        warningId,
        dedupeKey,
        kind: warning.kind,
        target: warning.target,
        from: warning.from,
      });
      continue;
    }
    predicateWarningChildDedupe.add(dedupeKey);
    void spawnPredicateWarningChild(deps, warning, warningId, stack).catch((err) => {
      predicateWarningChildDedupe.delete(dedupeKey);
      deps.logger.warn("predicate-schema-warning fp-spawn failed", {
        warningId,
        dedupeKey,
        kind: warning.kind,
        target: warning.target,
        from: warning.from,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

function predicateWarningDedupeKey(warning: PredicateWarning): string {
  return [
    currentCstDate(),
    warning.kind,
    warning.from,
    warning.target,
    ...warning.errors,
  ].join("\u001f");
}

function currentCstDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function shortStack(): string {
  return new Error().stack?.split("\n").slice(2, 7).join("\n") ?? "";
}

async function spawnPredicateWarningChild(
  deps: ApiDeps,
  warning: PredicateWarning,
  warningId: string,
  stack: string,
): Promise<void> {
  const [target, source] = await Promise.all([
    deps.store.findSessionByName(PREDICATE_WARNING_TARGET_SESSION),
    deps.store.findSessionByName(PREDICATE_WARNING_SOURCE_SESSION),
  ]);
  if (!target || !source) {
    deps.logger.warn("predicate-schema-warning fp-spawn skipped", {
      warningId,
      missingTarget: !target ? PREDICATE_WARNING_TARGET_SESSION : undefined,
      missingSource: !source ? PREDICATE_WARNING_SOURCE_SESSION : undefined,
    });
    return;
  }

  const prompt = renderPredicateWarningPrompt(warning, warningId, stack);
  await deps.childSession.spawnChild({
    parentId: target.id,
    backend: target.backend,
    model: target.model,
    workdir: target.workdir,
    prompt,
    type: "one_shot_delegation",
    callerInvocation: "async_kickoff",
    triggerKind: "session",
    requestedBy: source.id,
    resultSinks: [{ kind: "pollable_endpoint" }],
    clientRequestId: warningId,
    verificationPredicate: validateSpawnPredicate({
      type: "inbox-message",
      session_name: PREDICATE_WARNING_TARGET_SESSION,
      field: "prompt",
      contains_all: ["predicate-schema-warning", warningId],
      expected_window_sec: 600,
    }),
    onSessionReady: ({ session, messageRunId, spawnCommId }) => {
      deps.logger.info("predicate-schema-warning fp-spawn kicked off", {
        warningId,
        childSessionId: session.id,
        childSessionName: session.name,
        messageRunId,
        spawnCommId,
      });
    },
  });
}

function renderPredicateWarningPrompt(warning: PredicateWarning, warningId: string, stack: string): string {
  return [
    "[predicate-schema-warning]",
    `warning_id: ${warningId}`,
    `from: ${warning.from}`,
    `target: ${warning.target}`,
    `kind: ${warning.kind}`,
    "action: record this warning for the FP spawn-predicate migration dashboard; do not spawn any other session.",
    warning.errors.length > 0 ? "errors:\n" + warning.errors.map((error) => `- ${error}`).join("\n") : "errors: none",
    "stack:",
    stack,
  ].join("\n");
}

// Shared handler used by both /api/watcher-exception-notify (canonical) and the
// deprecated /api/notify + body.kind path. Centralizes the parse/log/respond
// boilerplate so the two routes share one implementation.
async function handleWatcherExceptionNotify(
  deps: ApiDeps,
  raw: unknown,
  res: import("node:http").ServerResponse,
  log: Logger,
): Promise<void> {
  const parsed = watcherExceptionNotifySchema.safeParse(raw);
  if (!parsed.success) {
    json(res, 400, {
      ok: false,
      error: `invalid watcher exception notify body: ${formatZodIssues(parsed.error)}`,
    });
    return;
  }
  try {
    const result = await recordAndNotifyWatcherException(deps, parsed.data);
    log.error("watcher exception fallback notified", {
      exceptionId: result.exceptionId,
      spawnCommId: parsed.data.spawn_comm_id,
      triggerSignal: parsed.data.trigger_signal,
      larkMessageId: result.larkMessageId,
    });
    json(res, 200, {
      ok: true,
      exception_id: result.exceptionId,
      lark_message_id: result.larkMessageId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    log.error("watcher exception fallback notify failed", {
      err: msg,
      spawnCommId: parsed.data.spawn_comm_id,
      triggerSignal: parsed.data.trigger_signal,
    });
    json(res, 500, { ok: false, error: msg });
  }
}

async function recordAndNotifyWatcherException(
  deps: ApiDeps,
  input: WatcherExceptionNotify,
): Promise<{ exceptionId: string; larkMessageId: string }> {
  const exceptionId = `watcher_exception_${randomUUID()}`;
  const ts = Date.now() as Timestamp;
  const payload = input.payload === undefined ? null : JSON.stringify(input.payload);
  const text = renderWatcherExceptionText(input);

  let larkMessageId: string | null = null;
  try {
    larkMessageId = await sendWatcherExceptionText(deps, text, input.target_chat_id);
  } catch (err) {
    await deps.store.recordWatcherException({
      id: exceptionId,
      ts,
      spawnCommId: input.spawn_comm_id,
      triggerSignal: input.trigger_signal,
      txId: input.tx_id,
      dedupeKey: input.dedupe_key,
      summary: input.summary,
      payload,
      larkMessageId: null,
      resolvedAt: null,
    });
    throw err;
  }

  await deps.store.recordWatcherException({
    id: exceptionId,
    ts,
    spawnCommId: input.spawn_comm_id,
    triggerSignal: input.trigger_signal,
    txId: input.tx_id,
    dedupeKey: input.dedupe_key,
    summary: input.summary,
    payload,
    larkMessageId,
    resolvedAt: null,
  });

  return { exceptionId, larkMessageId };
}

async function sendWatcherExceptionText(
  deps: ApiDeps,
  text: string,
  targetChatId: string | undefined,
): Promise<string> {
  const chatId = targetChatId ?? YOLO_WATCHER_EXCEPTION_CHAT_ID;
  if (deps.sendLarkText) {
    const result = await deps.sendLarkText({
      chatId,
      text,
    });
    return result.messageId;
  }
  return sendLarkTextViaCli(chatId, text);
}

function renderWatcherExceptionText(input: WatcherExceptionNotify): string {
  const lines = [
    "[error] supermatrix-root: spawn exception transaction fallback",
    input.summary,
    `tx_id: ${input.tx_id}`,
    `dedupe_key: ${input.dedupe_key}`,
    `spawn_comm_id: ${input.spawn_comm_id}`,
    `trigger_signal: ${input.trigger_signal}`,
  ];
  if (input.payload !== undefined) {
    lines.push(`payload: ${JSON.stringify(input.payload).slice(0, 4000)}`);
  }
  return lines.join("\n");
}

type LarkSendEnvelope = {
  ok?: boolean;
  error?: { type?: string; message?: string };
  data?: { message_id?: string };
};

async function sendLarkTextViaCli(chatId: string, text: string): Promise<string> {
  let stdout = "";
  try {
    const result = await execFileAsync(
      "lark-cli",
      ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--text", text],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    stdout = String(result.stdout ?? "");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    stdout = e.stdout ?? "";
    if (!stdout) {
      throw new Error(`lark-cli notify failed: ${e.stderr?.trim() || e.message}`);
    }
  }

  let parsed: LarkSendEnvelope;
  try {
    parsed = JSON.parse(stdout) as LarkSendEnvelope;
  } catch {
    throw new Error(`lark-cli notify returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (parsed.ok === false) {
    throw new Error(
      `lark-cli notify error [${parsed.error?.type ?? "unknown"}]: ${parsed.error?.message ?? "unknown"}`,
    );
  }
  const messageId = parsed.data?.message_id;
  if (!messageId) throw new Error("lark-cli notify ok without message_id");
  return messageId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPredicatePatchToken(): string | null {
  return readLocalSecret("SM_PREDICATE_PATCH_TOKEN");
}

function readClaudeMaintenanceToken(): string | null {
  return readLocalSecret("SM_CLAUDE_MAINTENANCE_TOKEN");
}

function readLocalSecret(name: string): string | null {
  const envToken = process.env[name]?.trim();
  if (envToken) return envToken;

  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0 || trimmed.slice(0, separator) !== name) continue;
      return unquoteEnvValue(trimmed.slice(separator + 1)).trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hashOpaqueSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function maintenanceLeaseResponse(lease: BackendMaintenanceLease): {
  owner: string;
  requestId: string;
  acquiredAt: Timestamp;
} {
  return {
    owner: lease.owner,
    requestId: lease.requestId,
    acquiredAt: lease.acquiredAt,
  };
}

function hasBearerToken(req: import("node:http").IncomingMessage, _expected: string | null): boolean {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") && header.slice("Bearer ".length).trim().length > 0;
}

function isBearerTokenMatch(req: import("node:http").IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim() === expected;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function isPatchAuthorized(
  input: z.infer<typeof predicatePatchBodySchema>,
  actorSessionId: SessionId,
  current: SpawnPredicateRecord,
  watcherState: WatcherStateRecord | null,
): boolean {
  if (input.actor_role === "owner") {
    return current.fromSessionId === actorSessionId;
  }
  if (input.actor_role === "sk") {
    return (input.from === "socail-king" || input.from === "sk-watcher") &&
      Boolean(input.tx_id) &&
      (watcherState?.patchCount24h ?? 0) < 3;
  }
  return (
    (input.from === "supermatrix-root" || input.from === "codexroot") &&
    input.reason.startsWith("manual-root-override:")
  );
}

function makePatchId(spawnCommId: string): string {
  const safe = spawnCommId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
  return `spp_${safe}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
