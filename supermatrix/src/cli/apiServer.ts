import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { asSessionId, type LarkGroupId, type MessageRunId, type SessionId, type Timestamp } from "../domain/ids.ts";
import type { BackendKind, Session } from "../domain/session.ts";
import type { Logger } from "../ports/Logger.ts";
import type { Notifier } from "../app/consoleNotifier.ts";
import { resolveAndValidateModel } from "../app/commands/setModel.ts";
import type { RunOnSessionInput, RunOnSessionResult } from "../app/runOnSession.ts";
import { registerAsyncItem } from "../app/spawnClosure/registerAsyncItem.ts";
import { logClosureEvent } from "../app/spawnClosure/closureLog.ts";
import { runThreePhaseCheck, type PhaseCheckResult } from "../app/spawnClosure/threePhaseCheck.ts";
import { validateSpawnPredicate } from "../app/spawnPredicate/schema.ts";
import type { PredicateLintContext } from "../app/spawnPredicate/lint.ts";
import { loadSqlitePredicateDbRegistry } from "../adapters/predicate-db/sqliteRegistry.ts";
import type {
  NormalizedSpawnPredicate,
  PatchSpawnPredicateInput,
  SpawnPredicateRecord,
  WatcherStateRecord,
} from "../ports/BindingStore.ts";

export type ApiDeps = {
  store: {
    findSessionByName(name: string): Promise<Session | null>;
    findSessionById(id: SessionId): Promise<{
      id: SessionId;
      name: string;
      status: string;
      backendSessionId: string | null;
    } | null>;
    findLatestMessageRunBySession(id: SessionId): Promise<{
      id: MessageRunId;
      startedAt: number;
      finishedAt: number | null;
      status: string;
      finalMessage: string | null;
      errorMessage: string | null;
    } | null>;
    listActiveSessions(): Promise<Array<{ name: string; status: string; scope: string }>>;
    countBusySessions(): Promise<number>;
    // /api/run needs the target's binding groupId for message_runs.group_id.
    findBySession(id: SessionId): Promise<{ groupId: LarkGroupId } | null>;
    getSpawnPredicate(spawnCommId: string): Promise<SpawnPredicateRecord | null>;
    getWatcherState(spawnCommId: string): Promise<WatcherStateRecord | null>;
    patchSpawnPredicate(input: PatchSpawnPredicateInput): Promise<SpawnPredicateRecord>;
    registerSpawnAsyncItem: Parameters<typeof registerAsyncItem>[0]["store"]["registerSpawnAsyncItem"];
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
};

const notifyInputSchema = z.object({
  source: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  level: z.enum(["info", "warn", "error"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const watcherExceptionNotifySchema = z.object({
  kind: z.literal("spawn_exception_transaction_fallback"),
  tx_id: z.string().min(1),
  dedupe_key: z.string().min(1),
  spawn_comm_id: z.string().min(1),
  trigger_signal: z.string().min(1),
  summary: z.string().min(1),
  payload: z.unknown().optional(),
}).strict();

type WatcherExceptionNotify = z.infer<typeof watcherExceptionNotifySchema>;

const WATCHER_EXCEPTION_CHAT_ID = process.env.SM_WATCHER_EXCEPTION_CHAT_ID ?? process.env.SM_ROOT_GROUP_ID ?? "";
const execFileAsync = promisify(execFile);
const internalSpawnSchema = z.object({
  caller_invocation: z.enum(["async_kickoff", "fire_and_forget"]),
}).strict();
type SpawnInvocationMode = "sync_inline" | z.infer<typeof internalSpawnSchema>["caller_invocation"];
const FRAMEWORK_INTERNAL_SPAWN_CALLERS = new Set(["supermatrix-root"]);
const PREDICATE_WARNING_TARGET_SESSION = "first-principle";
const PREDICATE_WARNING_SOURCE_SESSION = "supermatrix-root";
const DEFAULT_SYNC_SPAWN_RESPONSE_TIMEOUT_MS = 240_000;

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
  const predicatePatchToken = readPredicatePatchToken();
  const predicateValidationContext: PredicateLintContext = {
    dbRegistry: loadSqlitePredicateDbRegistry({ logger: log }),
  };
  if (!predicatePatchToken) {
    log.warn("SM_PREDICATE_PATCH_TOKEN missing; PATCH /api/spawn/:spawn_comm_id/predicate disabled");
  }

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

      if (method === "GET") {
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

      if (method === "POST" && url.pathname === "/api/spawn") {
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

        const VALID_BACKENDS: BackendKind[] = ["claude", "codex"];
        let backend: BackendKind = session.backend;
        if (parsed.backend) {
          if (!VALID_BACKENDS.includes(parsed.backend as BackendKind)) {
            json(res, 400, { ok: false, error: `invalid backend: ${parsed.backend} (must be claude or codex)` });
            return;
          }
          backend = parsed.backend as BackendKind;
        }

        let model: string | null;
        try {
          model =
            parsed.model !== undefined
              ? parsed.model === "default"
                ? null
                : resolveAndValidateModel(parsed.model, backend)
              : backend === session.backend
                ? session.model
                : null;
          if (backend === "codex" && model !== null) {
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
          backend,
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
            disconnectSwitch.dispose();
            json(res, 200, verifiedSpawnResponse(mode, firstAttempt.result));
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
            await respondSwitchedAsync(res, deps, {
              commId: firstAttempt.commId,
              firstFailure: firstCheck.firstFailure,
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
            disconnectSwitch.dispose();
            json(res, 200, verifiedSpawnResponse(mode, firstAttempt.result));
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
            disconnectSwitch.dispose();
            json(res, 200, verifiedSpawnResponse(mode, retryAttempt.result));
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
          await respondSwitchedAsync(res, deps, {
            commId: retryAttempt.commId,
            firstFailure: retryCheck.firstFailure,
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
          const parsedFallback = watcherExceptionNotifySchema.safeParse(raw);
          if (!parsedFallback.success) {
            json(res, 400, {
              ok: false,
              error: `invalid watcher exception notify body: ${formatZodIssues(parsedFallback.error)}`,
            });
            return;
          }
          try {
            const result = await recordAndNotifyWatcherException(deps, parsedFallback.data);
            log.error("watcher exception fallback notified", {
              exceptionId: result.exceptionId,
              spawnCommId: parsedFallback.data.spawn_comm_id,
              triggerSignal: parsedFallback.data.trigger_signal,
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
              spawnCommId: parsedFallback.data.spawn_comm_id,
              triggerSignal: parsedFallback.data.trigger_signal,
            });
            json(res, 500, { ok: false, error: msg });
          }
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
            messageId: result.messageId,
          });
          if (result.degraded) {
            json(res, 200, {
              messageId: result.messageId,
              degraded: true,
              error: result.error,
            });
          } else {
            json(res, 200, { messageId: result.messageId });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          log.error("notify failed", { err: msg, source: parsed.data.source });
          json(res, 500, { error: msg });
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

type SyncSpawnAttempt = {
  childSpawnResult: SpawnChildCompletedResult | { error: "timeout" | "spawn_failed" | "run_error"; reason: string };
  commId?: string;
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

  const markDisconnected = (reason: string) => {
    if (disconnected || res.writableEnded) return;
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
  };
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
): Promise<void> {
  if (!input.commId || !input.firstFailure?.failureKind) {
    json(res, 500, {
      ok: false,
      error: input.firstFailure?.reason ?? "spawn failed before comm_id was created",
    });
    return;
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
    message: `已转后台跟进，ref=${ref}`,
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
  // Outer catch blocks reach here even when the client (Feishu, fetch with
  // AbortSignal, monitoring probe) has already torn the TCP connection down.
  // Without these guards, writeHead/end on a destroyed socket throws
  // ERR_STREAM_DESTROYED / ERR_HTTP_HEADERS_SENT, masking the original error
  // and surfacing as an unhandled rejection.
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch {
    // socket died between the guard above and the actual write — nothing
    // useful we can do, and we must not crash the API server.
  }
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
    deps.logger.warn("predicate-schema-warning", {
      warningId,
      kind: warning.kind,
      target: warning.target,
      from: warning.from,
      errors: warning.errors,
      stack,
    });
    void spawnPredicateWarningChild(deps, warning, warningId, stack).catch((err) => {
      deps.logger.warn("predicate-schema-warning fp-spawn failed", {
        warningId,
        kind: warning.kind,
        target: warning.target,
        from: warning.from,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
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
    larkMessageId = await sendYoloWatcherExceptionText(deps, text);
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

async function sendYoloWatcherExceptionText(deps: ApiDeps, text: string): Promise<string> {
  if (!WATCHER_EXCEPTION_CHAT_ID) {
    throw new Error("SM_WATCHER_EXCEPTION_CHAT_ID or SM_ROOT_GROUP_ID is required for watcher exception fallback");
  }
  if (deps.sendLarkText) {
    const result = await deps.sendLarkText({
      chatId: WATCHER_EXCEPTION_CHAT_ID,
      text,
    });
    return result.messageId;
  }
  return sendLarkTextViaCli(WATCHER_EXCEPTION_CHAT_ID, text);
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
  const envToken = process.env.SM_PREDICATE_PATCH_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^SM_PREDICATE_PATCH_TOKEN=(.*)$/u);
      if (!match) continue;
      return unquoteEnvValue(match[1]!).trim() || null;
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
    return input.from === "socail-king" && Boolean(input.tx_id) && (watcherState?.patchCount24h ?? 0) < 3;
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
