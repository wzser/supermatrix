import { homedir } from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync, createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveOwnerSessionName } from "../domain/session.ts";
import { SqliteBindingStore } from "../adapters/store-sqlite/index.ts";
import { NodeWorkspaceFs } from "../adapters/workspace-node/index.ts";
import { createPinoLogger } from "../adapters/logger-pino/index.ts";
import { ClaudeBackend } from "../adapters/backend-claude/index.ts";
import { CodexBackend } from "../adapters/backend-codex/index.ts";
import { runCodexForkBootstrap } from "../adapters/backend-codex/forkBootstrap.ts";
import { createCodexModelAvailabilityProbe } from "../adapters/backend-codex/modelAvailabilityProbe.ts";
import { createRouteAwareCodexModelAvailability } from "../adapters/backend-codex/routeAwareModelAvailability.ts";
import {
  isCodexRouteOverrideActive,
  resolveCodexRouteOverride,
} from "../adapters/backend-codex/routeState.ts";
import { KimiBackend } from "../adapters/backend-kimi/index.ts";
import { disableCardAskWhenBrokerUnhealthy } from "../adapters/card-ask/config.ts";
import { InMemoryEventBus } from "../adapters/event-bus-memory/index.ts";
import { InMemoryTopicBus } from "../adapters/topic-bus-memory/index.ts";
import { LarkCliGateway } from "../adapters/lark-cli/index.ts";
import {
  DRIVE_COMMENT_EVENT_TYPE,
  DRIVE_COMMENT_SUBSCRIPTION_IDENTITIES,
  createRealLarkClient,
  reconcileDriveCommentSubscription,
  type DriveCommentSubscriptionReconcileResult,
} from "../adapters/lark-cli/realClient.ts";
import { createLarkCliAutoFileSender } from "../adapters/lark-cli/autoFileSender.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asTimestamp,
  type LarkGroupId,
  type SessionId,
} from "../domain/ids.ts";
import type { DriveCommentHandler, DriveCommentSource } from "../ports/LarkGateway.ts";
import type { Logger } from "../ports/Logger.ts";
import type { AgentBackend, BackendRegistry } from "../ports/AgentBackend.ts";
import type { Clock } from "../ports/Clock.ts";
import type { BootOrphanedSpawnComm } from "../ports/BindingStore.ts";
import { createSessionLifecycle } from "../app/sessionLifecycle.ts";
import { errorMessage } from "../app/errorMessage.ts";
import { createAutoFileDelivery } from "../app/autoFileDelivery.ts";
import { createReplier } from "../app/replier.ts";
import { buildCommandRegistry } from "../app/commandRegistry.ts";
import { createCommandRouter } from "../app/commandRouter.ts";
import { createDispatcher, type PendingNextEntry } from "../app/dispatcher.ts";
import { createContinuationDispatcher } from "../app/continuationDispatcher.ts";
import { deliverResultSinks } from "../app/resultSinkEngine.ts";
import { recoverSpawnCommOrphans } from "../app/spawnClosure/orphanSweep.ts";
import { createHelpHandler } from "../app/commands/help.ts";
import { createListHandler } from "../app/commands/listSessions.ts";
import { createTokensHandler } from "../app/commands/tokens.ts";
import { createUsageHandler } from "../app/commands/usage.ts";
import { createStatusHandler } from "../app/commands/status.ts";
import { createWorkspaceLockHandler } from "../app/commands/workspaceLock.ts";
import { createLogHandler } from "../app/commands/log.ts";
import { createHeartbeatHandler } from "../app/commands/heartbeat.ts";
import { createCloneHandler, createNewHandler } from "../app/commands/newSession.ts";
import { createDeleteHandler } from "../app/commands/deleteSession.ts";
import { createCancelHandler } from "../app/commands/cancelSession.ts";
import { createResetHandler } from "../app/commands/resetSession.ts";
import { createRestartHandler } from "../app/commands/restartSession.ts";
import { createReloadHandler } from "../app/commands/reload.ts";
import { createBranchHandler } from "../app/commands/branch.ts";
import { createSetModelHandler } from "../app/commands/setModel.ts";
import { createSetBackendHandler, type ScheduledTaskReviewRequest } from "../app/commands/setBackend.ts";
import { createSetEffortHandler } from "../app/commands/setEffort.ts";
import { restoreBackendRuntimeDefaults } from "../app/backendRuntimeDefaultsBoot.ts";
import { createSetTimeoutHandler } from "../app/commands/setTimeout.ts";
import { createSkillsHandler } from "../app/commands/skills.ts";
import { createNextHandler } from "../app/commands/next.ts";
import { createNowHandler } from "../app/commands/now.ts";
import { createSpawnChildHandler } from "../app/commands/spawnChild.ts";
import { createTodoHandler, createIdeaHandler } from "../app/commands/todo.ts";
import { createBtwHandler } from "../app/commands/btw.ts";
import { createSelfCheckHandler } from "../app/commands/selfCheck.ts";
import { createRankHandler } from "../app/commands/rank.ts";
import { createSessionBranchService } from "../app/sessionBranches.ts";
import { createProcessLifecycle } from "../app/processLifecycle.ts";
import type { ProcessLifecycle } from "../app/processLifecycle.ts";
import { createChildCompletionNotifier } from "../app/childCompletionNotice.ts";
import { createMiniMaxChildCompletionSummaryProvider } from "../app/childCompletionSummary.ts";
import { createChildSessionService } from "../app/childSession.ts";
import {
  isCodexModelAtCapacity,
  isConfirmedCodexModelUnavailable,
} from "../adapters/backend-codex/modelUnavailable.ts";
import { routeCompletedSpawnClosure } from "../app/spawnClosure/fastPathRoute.ts";
import { createDriveCommentMentionProcessor } from "../app/driveCommentMentions.ts";
import { createFileDriveCommentMentionRegistryLoader } from "../app/driveCommentMentionRegistry.ts";
import { createConsoleNotifier } from "../app/consoleNotifier.ts";
import { startKimiAutonomousTurnWatch } from "../app/kimiAutonomousTurnWatch.ts";
import { resolveNotifyDryRun, withNotifyDryRun } from "../app/notifyDryRun.ts";
import { runChecks, hasFail } from "../app/bootSelfCheck/index.ts";
import { localDepsCheck } from "../app/bootSelfCheck/checks/localDeps.ts";
import { createAgentLarkCliShimCheck } from "../app/bootSelfCheck/checks/agentLarkCliShim.ts";
import {
  dualInstanceCheck,
  cleanupBootstrapPidFile,
} from "../app/bootSelfCheck/checks/dualInstance.ts";
import { supervisorPresenceCheck } from "../app/bootSelfCheck/checks/supervisorPresence.ts";
import { schedulerHealthCheck } from "../app/bootSelfCheck/checks/schedulerHealth.ts";
import { reconcileBackendProcessesCheck } from "../app/bootSelfCheck/checks/reconcileBackendProcesses.ts";
import { createBootOrphanedSpawnReporter } from "../app/bootSelfCheck/bootOrphanedSpawnReporter.ts";
import { createCodexRuntimeConfigCheck } from "../app/bootSelfCheck/checks/codexRuntimeConfig.ts";
import { reconcileCodexRuntimeConfigs } from "../app/reconcileCodexRuntimeConfigs.ts";
import { runOnSession } from "../app/runOnSession.ts";
import { cleanupPendingForceReloadNudge } from "../app/forceReloadNudge.ts";
import {
  renderStderrFailReport,
  renderAnnounceCheckSection,
} from "../app/bootSelfCheck/formatReport.ts";
import { startApiServer } from "./apiServer.ts";
import { startSourceWatcher } from "./sourceWatcher.ts";
import { createCliCompatibilityChecks } from "./cliCompatibilityChecks.ts";
import { createPsProcessLister } from "../adapters/process-lister-ps/index.ts";
import { createManagedSqliteSnapshot } from "../../scripts/managed-sqlite-snapshot.ts";
import {
  consumeRestartProvenance,
  readFreshRestartProvenance,
  writeRestartProvenance,
} from "./restartProvenance.ts";
// Note: bootstrap (cli layer) may import from adapters — it's the composition root.

export type AppConfig = {
  rootGroupId: string;
  rootUserId: string;
  workspaceRoot: string;
  dbPath: string;
  backend: "claude" | "codex" | "kimi";
  logLevel: "debug" | "info" | "warn" | "error";
  larkAppId: string;
  larkAppSecret: string;
  botOpenId?: string;
  larkCliPath: string;
  apiPort: number;
  shutdownGraceTimeoutMs: number;
  spawnOrphanThresholdSec: number;
  gitActorSessionName: string;
  cardAskGatePath: string;
  mentionRegistryPath: string;
};

export type App = {
  lifecycle: ProcessLifecycle;
  start(): Promise<void>;
  stop(): Promise<void>;
};

/** @deprecated Use domain `resolveOwnerSessionName`; kept as the notify-path name. */
export function resolveNotifyOwnerName(name: string): string {
  return resolveOwnerSessionName(name);
}

type NotifyDefaultChatStore = {
  findSessionByName(name: string): Promise<{ id: SessionId } | null>;
  findBySession(sessionId: SessionId): Promise<{ groupId: LarkGroupId } | null>;
};

export function createNotifyDefaultChatResolver(
  store: NotifyDefaultChatStore,
  logger: Pick<Logger, "warn">,
): (source: string) => Promise<string | null> {
  return async (source: string): Promise<string | null> => {
    const owner = resolveNotifyOwnerName(source);
    try {
      const session = await store.findSessionByName(owner);
      if (!session) return null;
      const binding = await store.findBySession(session.id);
      return binding?.groupId ?? null;
    } catch (err) {
      logger.warn("resolveDefaultChat lookup failed", { source, owner, err: errorMessage(err) });
      return null;
    }
  };
}

export const DEFAULT_SHUTDOWN_GRACE_TIMEOUT_MS = 20_000;
export type TimeoutResult = "completed" | "timed_out";

type ClosableServer = {
  close(callback?: (err?: Error) => void): unknown;
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
};

class DispatcherNotReadyError extends Error {
  constructor() {
    super("continuation fired before dispatcher ready");
    this.name = "DispatcherNotReadyError";
  }
}

type DriveCommentProcessor = {
  handle(source: DriveCommentSource): Promise<void>;
  sweepQueuedMentions(): Promise<number>;
};

export function createLateBoundDriveCommentHandler(
  resolveProcessor: () => DriveCommentProcessor | undefined,
  logger: Pick<ReturnType<typeof createPinoLogger>, "error">,
): DriveCommentHandler {
  return async (source) => {
    const processor = resolveProcessor();
    if (!processor) {
      logger.error("drive comment event received before processor ready", {
        eventId: source.eventId,
        fileToken: source.fileToken,
        commentId: source.commentId,
      });
      throw new Error("drive comment processor not ready");
    }
    await processor.handle(source);
  };
}

export async function reconcileDriveCommentSubscriptionAtStartup(deps: {
  reconcile: () => Promise<DriveCommentSubscriptionReconcileResult>;
  logger: Pick<Logger, "info" | "error">;
}): Promise<void> {
  try {
    const result = await deps.reconcile();
    for (const identityResult of result.identities) {
      if (identityResult.finalStatus === true) {
        deps.logger.info("drive comment subscription reconciled", identityResult);
      } else {
        deps.logger.error("drive comment subscription reconciliation failed", identityResult);
      }
    }
  } catch (err) {
    deps.logger.error("drive comment subscription reconciliation failed", {
      eventType: DRIVE_COMMENT_EVENT_TYPE,
      identities: DRIVE_COMMENT_SUBSCRIPTION_IDENTITIES.map((identity) => ({
        identity,
        initialStatus: null,
        createAttempted: null,
        finalStatus: null,
      })),
      error: errorMessage(err),
    });
  }
}

function assertPositiveTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
}

export async function runWithTimeout(
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<TimeoutResult> {
  assertPositiveTimeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(() => "completed" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeServerWithTimeout(
  server: ClosableServer,
  timeoutMs: number,
): Promise<TimeoutResult> {
  assertPositiveTimeout(timeoutMs);

  return await new Promise<TimeoutResult>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        if (server.closeAllConnections) {
          server.closeAllConnections();
        } else {
          server.closeIdleConnections?.();
        }
      } finally {
        resolve("timed_out");
      }
    }, timeoutMs);

    try {
      server.close((err?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve("completed");
      });
    } catch (err) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
      }
      reject(err);
    }
  });
}

const envSchema = z.object({
  SM_ROOT_GROUP_ID: z.string().min(1),
  SM_ROOT_USER_ID: z.string().min(1),
  SM_WORKSPACE_ROOT: z.string().min(1),
  SM_DB_PATH: z.string().min(1),
  SM_BACKEND: z.enum(["claude", "codex", "kimi"]).default("claude"),
  SM_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_BOT_OPEN_ID: z.string().optional(),
  SM_LARK_CLI_PATH: z.string().optional(),
  SM_API_PORT: z.coerce.number().int().default(3501),
  SM_SHUTDOWN_GRACE_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_SHUTDOWN_GRACE_TIMEOUT_MS),
  SM_SPAWN_ORPHAN_THRESHOLD_SEC: z.coerce.number().int().positive().default(60),
  SM_SESSION_NAME: z.string().optional(),
  SM_MENTION_REGISTRY_PATH: z.string().optional(),
});

export function validateEnv(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.parse({
    SM_ROOT_GROUP_ID: env["SM_ROOT_GROUP_ID"],
    SM_ROOT_USER_ID: env["SM_ROOT_USER_ID"],
    SM_WORKSPACE_ROOT: env["SM_WORKSPACE_ROOT"],
    SM_DB_PATH: env["SM_DB_PATH"],
    SM_BACKEND: env["SM_BACKEND"],
    SM_LOG_LEVEL: env["SM_LOG_LEVEL"],
    LARK_APP_ID: env["LARK_APP_ID"],
    LARK_APP_SECRET: env["LARK_APP_SECRET"],
    LARK_BOT_OPEN_ID: env["LARK_BOT_OPEN_ID"],
    SM_LARK_CLI_PATH: env["SM_LARK_CLI_PATH"],
    SM_API_PORT: env["SM_API_PORT"],
    SM_SHUTDOWN_GRACE_TIMEOUT_MS: env["SM_SHUTDOWN_GRACE_TIMEOUT_MS"],
    SM_SPAWN_ORPHAN_THRESHOLD_SEC: env["SM_SPAWN_ORPHAN_THRESHOLD_SEC"],
    SM_SESSION_NAME: env["SM_SESSION_NAME"],
    SM_MENTION_REGISTRY_PATH: env["SM_MENTION_REGISTRY_PATH"],
  });

  return {
    rootGroupId: parsed.SM_ROOT_GROUP_ID,
    rootUserId: parsed.SM_ROOT_USER_ID,
    workspaceRoot: parsed.SM_WORKSPACE_ROOT,
    dbPath: parsed.SM_DB_PATH,
    backend: parsed.SM_BACKEND,
    logLevel: parsed.SM_LOG_LEVEL,
    larkAppId: parsed.LARK_APP_ID,
    larkAppSecret: parsed.LARK_APP_SECRET,
    ...(parsed.LARK_BOT_OPEN_ID?.trim() ? { botOpenId: parsed.LARK_BOT_OPEN_ID.trim() } : {}),
    larkCliPath: parsed.SM_LARK_CLI_PATH ?? path.resolve("node_modules/.bin/lark-cli"),
    apiPort: parsed.SM_API_PORT,
    shutdownGraceTimeoutMs: parsed.SM_SHUTDOWN_GRACE_TIMEOUT_MS,
    spawnOrphanThresholdSec: parsed.SM_SPAWN_ORPHAN_THRESHOLD_SEC,
    gitActorSessionName: parsed.SM_SESSION_NAME?.trim() || defaultGitActorSessionName(parsed.SM_BACKEND),
    cardAskGatePath: path.join(path.dirname(parsed.SM_DB_PATH), "card-ask-gate.json"),
    mentionRegistryPath: parsed.SM_MENTION_REGISTRY_PATH
      ?? path.join(parsed.SM_WORKSPACE_ROOT, "pinglunmaster", "registry", "mention-routes.json"),
  };
}

function defaultGitActorSessionName(backend: AppConfig["backend"]): string {
  return backend === "codex" ? "codexroot" : "supermatrix-root";
}

export async function bootstrap(env: Record<string, string | undefined>): Promise<App> {
  const cfg = validateEnv(env);
  const logger = createPinoLogger(cfg.logLevel);
  const processLister = createPsProcessLister();
  const agentLarkCliShimCheck = createAgentLarkCliShimCheck({
    shimPath: path.resolve("scripts/shims/lark-cli"),
    installPath: path.join(homedir(), ".local/bin/lark-cli"),
  });

  // Boot self-check — pre-wiring phase (cheap probes, dual-instance lock,
  // supervisor classification, scheduler reachability, local deps with
  // auto-repair for lark-cli). Fails loudly BEFORE constructing the store
  // and before Lark starts, so a broken config never reaches announce.
  const preChecks = [
    localDepsCheck,
    agentLarkCliShimCheck,
    dualInstanceCheck,
    supervisorPresenceCheck,
    schedulerHealthCheck,
    ...createCliCompatibilityChecks(),
  ];
  const preResults = await runChecks(
    "pre-wiring",
    "execute",
    { cfg, logger, processLister },
    preChecks,
  );
  if (hasFail(preResults)) {
    process.stderr.write(renderStderrFailReport(preResults) + "\n");
    process.exit(1);
  }

  const restartProvenance = consumeRestartProvenance(cfg.dbPath);
  if (restartProvenance) {
    logger.info("boot restart provenance", restartProvenance);
  }

  // Store
  const store = new SqliteBindingStore(cfg.dbPath);
  const migrationResult = await store.init();
  if (migrationResult.degraded.length > 0) {
    for (const d of migrationResult.degraded) {
      logger.warn("optional migration degraded", {
        version: d.version, file: d.file, error: d.error,
      });
    }
  }
  restoreBackendRuntimeDefaults(await store.listBackendRuntimeDefaults(), (row, error) => {
    logger.warn("ignoring invalid persisted backend runtime defaults", {
      backend: row.backend,
      error,
    });
  });
  await store.resetBusySessionsOnBoot(asTimestamp(Date.now()));
  const pendingRuntimeConfigsApplied = await store.drainPendingSessionRuntimeConfigs();
  if (pendingRuntimeConfigsApplied > 0) {
    logger.info("applied pending session runtime configs on boot", { count: pendingRuntimeConfigsApplied });
  }

  const backupBeforeCodexResumeClear = async (input: {
    sessionId: SessionId;
    branchName: string;
    failedRunId: string;
    errorClass: "array_above_max_length";
  }) => {
    const result = await createManagedSqliteSnapshot({
      sourceDbPath: cfg.dbPath,
      auditDbPath: cfg.dbPath,
      managedRoot: path.join(path.dirname(cfg.dbPath), "managed-sqlite-snapshots"),
      owner: "codexroot",
      operationId: `codex-resume-recovery:${input.failedRunId}`,
      reason: `Codex ${input.errorClass} resume recovery for ${input.sessionId}/${input.branchName}`,
      expiryHours: 72,
    });
    return { snapshotPath: result.receipt.snapshotPath, receiptPath: result.receiptPath };
  };

  // One account-aware probe is shared by boot reconciliation and all later
  // Codex admission paths so cache and evidence stay coherent. Route awareness
  // wraps it at this single point: while an sm-switch route serves the runs,
  // probing a catalog model it does not serve only produces a 400
  // model_not_served, so callers get an explicit `skipped` result instead.
  const codexModelAvailability = createRouteAwareCodexModelAvailability(
    createCodexModelAvailabilityProbe(),
  );

  // Instantiate KimiBackend early so its getAcpPid() can be injected into the
  // post-wiring reconcile check. The ACP process itself is lazy-spawned on
  // first use, so constructing KimiBackend here is cheap.
  const kimiBackend = new KimiBackend();
  const pendingBootOrphanedSpawnComms: BootOrphanedSpawnComm[] = [];
  let bootOrphanedSpawnCommReporter: ReturnType<typeof createBootOrphanedSpawnReporter> | null = null;
  const trackBootOrphanedSpawnComms = async (comms: BootOrphanedSpawnComm[]): Promise<void> => {
    if (comms.length === 0) return;
    if (!bootOrphanedSpawnCommReporter) {
      pendingBootOrphanedSpawnComms.push(...comms);
      return;
    }
    for (const comm of comms) {
      try {
        await bootOrphanedSpawnCommReporter([comm]);
      } catch (err) {
        logger.warn("boot orphaned spawn comm watcher-exception failed", {
          comm_id: comm.commId,
          err: errorMessage(err),
        });
      }
    }
  };

  // Boot self-check — post-wiring phase (reconcile DB ↔ process world).
  // This supersedes the previous blunt resetRunningMessageRunsOnBoot call.
  // resetRunningMessageRunsOnBoot remains in the store as a defensive fallback
  // used only if the reconciler itself throws.
  let postResults: Awaited<ReturnType<typeof runChecks>> = [];
  try {
    postResults = await runChecks(
      "post-wiring",
      "execute",
      {
        cfg,
        logger,
        processLister,
        store,
        getKimiAcpPid: () => kimiBackend.getAcpPid(),
        onBootOrphanedSpawnComm: (comm) => {
          pendingBootOrphanedSpawnComms.push(comm);
        },
        ...(restartProvenance ? { restartProvenance } : {}),
      },
      [
        reconcileBackendProcessesCheck,
        createCodexRuntimeConfigCheck({
          reconcile: () => reconcileCodexRuntimeConfigs({ store, availability: codexModelAvailability }),
        }),
      ],
    );
  } catch (err) {
    const errMsg = errorMessage(err);
    logger.error("reconciler threw — falling back to resetRunningMessageRunsOnBoot", {
      err: errMsg,
    });
    await store.resetRunningMessageRunsOnBoot(asTimestamp(Date.now()));
    // Surface the fallback in the startup announce so the operator knows
    // the reconciler didn't run its normal course.
    postResults = [
      {
        name: "reconcile-backend-processes",
        status: "warn",
        message: `reconciler 异常：${errMsg} — 已回退到粗暴清理`,
      },
    ];
  }
  if (hasFail(postResults)) {
    process.stderr.write(renderStderrFailReport(postResults) + "\n");
    process.exit(1);
  }

  // Collect all check results from both phases for the startup announce.
  const allBootResults = [...preResults, ...postResults];

  // Clean up stale child sessions from previous runs
  const CHILD_MAX_IDLE_MS = 60 * 60 * 1000; // 60 minutes
  const CHILD_MAX_ERROR_MS = 5 * 60 * 1000; // 5 minutes
  const STUCK_BUSY_CHILD_MS = 5 * 60 * 1000; // 5 minutes
  const bootCutoff = asTimestamp(Date.now() - CHILD_MAX_IDLE_MS);
  const bootCleaned = await store.cleanupStaleChildSessions(bootCutoff);
  if (bootCleaned.count > 0) {
    logger.info("boot: cleaned stale child sessions", { count: bootCleaned.count });
  }
  await trackBootOrphanedSpawnComms(bootCleaned.failedComms);
  const bootErrorCutoff = asTimestamp(Date.now() - CHILD_MAX_ERROR_MS);
  const bootErrorCleaned = await store.cleanupErroredChildSessions(bootErrorCutoff);
  if (bootErrorCleaned.count > 0) {
    logger.info("boot: cleaned errored child sessions", { count: bootErrorCleaned.count });
  }
  await trackBootOrphanedSpawnComms(bootErrorCleaned.failedComms);
  // Also repair failed orphan comms from the immediately preceding console,
  // whose process died before the new receipt path could run.
  const recoveredBootReceipts = await store.recoverBootOrphanedSpawnReceipts(asTimestamp(Date.now()));
  if (recoveredBootReceipts.length > 0) {
    logger.info("boot: recovered orphaned spawn failure receipts", {
      count: recoveredBootReceipts.length,
      commIds: recoveredBootReceipts.map((comm) => comm.commId),
    });
  }
  const stuckCutoff = asTimestamp(Date.now() - STUCK_BUSY_CHILD_MS);
  const stuckCleaned = await store.cleanupStuckBusyChildren(stuckCutoff);
  if (stuckCleaned > 0) {
    logger.info("boot: cleaned stuck busy children", { count: stuckCleaned });
  }

  // Filesystem + templates
  const fs = new NodeWorkspaceFs({
    gitActorSessionName: cfg.gitActorSessionName,
    gitUserEmail: `${cfg.gitActorSessionName}@supermatrix.local`,
  });

  // Clock
  const clock: Clock = { now: () => asTimestamp(Date.now()) };

  // Lark gateway with real lark-cli shell-out client
  const larkClient = createRealLarkClient({
    larkCliPath: cfg.larkCliPath,
    botAppId: cfg.larkAppId,
    botAppSecret: cfg.larkAppSecret,
    ...(cfg.botOpenId ? { botOpenId: cfg.botOpenId } : {}),
    ownerUserId: cfg.rootUserId,
    driveCommentPollPath: path.join(path.dirname(cfg.dbPath), "drive-comment-watches.json"),
  });
  let driveCommentProcessor: DriveCommentProcessor | undefined;
  const lark = new LarkCliGateway({
    client: larkClient,
    attachmentDir: (groupId: LarkGroupId, dateIso: string) =>
      asAbsolutePath(path.join(cfg.workspaceRoot, ".attachments", groupId, dateIso)),
    logger: logger.child({ mod: "lark" }),
    driveCommentHandler: createLateBoundDriveCommentHandler(
      () => driveCommentProcessor,
      logger.child({ mod: "driveComment" }),
    ),
  });

  // Event bus
  const eventBus = new InMemoryEventBus(logger.child({ mod: "eventBus" }));
  const topicBus = new InMemoryTopicBus({ logger: logger.child({ mod: "topicBus" }) });

  // Backends (kimiBackend was instantiated early above for reconcile; reuse it here)
  const backends: Record<string, AgentBackend> = {
    claude: new ClaudeBackend(),
    codex: new CodexBackend({
      onEffortNormalized: (evidence) => {
        logger.warn("codex effort normalized for cli", evidence);
      },
    }),
    kimi: kimiBackend,
  };
  const backendRegistry: BackendRegistry = {
    get(kind) {
      const b = backends[kind];
      if (!b) throw new Error(`unknown backend: ${kind}`);
      return b;
    },
    async cancel(sessionId) {
      // Try all backends — we don't know which one owns the session
      for (const b of Object.values(backends)) {
        try { await b.cancel(sessionId); } catch { /* ignore */ }
      }
    },
  };

  // Lifecycle
  const lifecycle = createSessionLifecycle({
    store,
    fs,
    lark,
    clock,
    workspaceRoot: asAbsolutePath(cfg.workspaceRoot),
    // The single global session catalog. Each workspace symlinks to it.
    catalogPath: asAbsolutePath(path.join(cfg.workspaceRoot, "session-catalog.json")),
    principlesTemplatesDir: asAbsolutePath(
      path.join(cfg.workspaceRoot, "first-principle", "templates"),
    ),
    claudeMdTemplatePath: asAbsolutePath(
      path.join(cfg.workspaceRoot, "first-principle", "templates", "claude-md-base.md"),
    ),
    agentsMdTemplatePath: asAbsolutePath(
      path.join(cfg.workspaceRoot, "first-principle", "templates", "agents-md-base.md"),
    ),
    gitignorePath: asAbsolutePath(path.resolve("templates/gitignore.default")),
    ownerUserId: cfg.rootUserId,
    idFactory: () => "sess_" + randomUUID().slice(0, 8),
    cancelBackend: async (sessionId) => {
      await backendRegistry.cancel(sessionId as SessionId);
    },
    eventBus,
  });

  // Child session service.
  //
  // The continuation dispatcher needs the inbound dispatcher (to synthesize
  // parent-side messages), but the inbound dispatcher needs child session
  // handlers (for /spawn / /btw commands). We break that cycle with a
  // late-bound arrow: the continuation dispatcher holds a reference to
  // `dispatcher` that resolves after `dispatcher` is constructed below.
  let dispatcher: ReturnType<typeof createDispatcher>;
  const continuationDispatcher = createContinuationDispatcher({
    store,
    clock,
    idFactory: () => "cont_" + randomUUID().slice(0, 8),
    dispatcher: {
      handleInbound: async (msg) => {
        if (!dispatcher) {
          logger.warn("continuation fired before dispatcher ready; needs retry/adjudication", {
            childSessionId: msg.userId,
          });
          throw new DispatcherNotReadyError();
        }
        await dispatcher.handleInbound(msg);
      },
    },
    logger,
  });
  const childCompletionSummaryProvider = createMiniMaxChildCompletionSummaryProvider(env, logger);
  const childSessionDeps: Parameters<typeof createChildSessionService>[0] = {
    store,
    backendRegistry,
    clock,
    eventBus,
    availability: codexModelAvailability,
    codexRuntimeRecovery: {
      isModelUnavailable: isConfirmedCodexModelUnavailable,
      isCapacityError: isCodexModelAtCapacity,
      backupBeforeResumeClear: backupBeforeCodexResumeClear,
    },
    topicBus,
    idFactory: () => "sess_child_" + randomUUID().slice(0, 8),
    deliverSinks: async (session, finalMessage) => {
      return await deliverResultSinks(session, finalMessage, {
        store,
        logger,
        topicBus,
        injectContinuation: continuationDispatcher.injectContinuation,
        postToChat: async (groupId, text, identity) => {
          await lark.sendMessage(groupId, text, identity);
        },
      });
    },
    completionNotifier: createChildCompletionNotifier({
      store,
      lark,
      logger,
      ...(childCompletionSummaryProvider ? { summaryProvider: childCompletionSummaryProvider } : {}),
    }),
  };
  const childSession = createChildSessionService(childSessionDeps);
  driveCommentProcessor = createDriveCommentMentionProcessor({
    callerSessionName: "pinglunmaster",
    store,
    lark,
    childSession,
    mentionRegistry: createFileDriveCommentMentionRegistryLoader({
      registryPath: cfg.mentionRegistryPath,
    }),
    clock,
    logger: logger.child({ mod: "driveComment" }),
  });

  // Console-group notifier — hard target for POST /api/notify. Callers are
  // trusted loopback sessions (watchdog/scheduler/first-principle/...) so we
  // reuse the /api/spawn binding model (no auth).
  const CONSOLE_GROUP_ID = cfg.rootGroupId;
  const execFileP = promisify(execFile);
  type LarkEnvelope = {
    ok: boolean;
    data?: { message_id?: string };
    error?: { type?: string; message?: string };
  };
  const notifyLogger = logger.child({ mod: "notify" });
  // 30s timeout protects /api/notify from hanging forever if lark-cli stalls
  // (network jitter, hung OAuth refresh, etc). Without this, an upstream Feishu
  // outage froze every consumer waiting on /api/notify.
  const NOTIFY_CLI_TIMEOUT_MS = 30_000;
  const runNotifyCli = async (args: string[]): Promise<string> => {
    let stdout = "";
    let stderr = "";
    try {
      const r = await execFileP(cfg.larkCliPath, args, {
        env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
        maxBuffer: 10 * 1024 * 1024,
        timeout: NOTIFY_CLI_TIMEOUT_MS,
      });
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      // execFile sets killed=true + signal=SIGTERM (or similar) when timeout fires.
      if (e.killed && (e.signal === "SIGTERM" || e.code === undefined)) {
        throw new Error(`lark-cli ${args[0]} ${args[1] ?? ""} timed out after ${NOTIFY_CLI_TIMEOUT_MS}ms`);
      }
      if (!stdout) {
        throw new Error(
          `lark-cli ${args[0]} ${args[1] ?? ""} failed: ${stderr.trim() || e.message}`,
        );
      }
    }
    // lark-cli often writes non-fatal warnings to stderr while still producing
    // a valid JSON envelope on stdout (e.g. "token will expire in 7 days").
    // Don't swallow them — surface as warn so operators see them.
    if (stderr.trim().length > 0) {
      notifyLogger.warn("lark-cli stderr", { stderr: stderr.trim().slice(0, 500), argv: args.slice(0, 2) });
    }
    let parsed: LarkEnvelope;
    try {
      parsed = JSON.parse(stdout) as LarkEnvelope;
    } catch {
      throw new Error(`lark-cli notify returned non-JSON: ${stdout.slice(0, 200)}`);
    }
    if (parsed.ok === false) {
      throw new Error(
        `lark-cli notify error [${parsed.error?.type ?? "unknown"}]: ${parsed.error?.message ?? "unknown"}`,
      );
    }
    const id = parsed.data?.message_id;
    if (!id) throw new Error("lark-cli notify ok without message_id");
    return id;
  };
  // Structural events sink for /api/notify. Lazy-opened jsonl writer; failure
  // to open never blocks notify. Path overridable via SM_NOTIFY_EVENTS_LOG.
  const NOTIFY_EVENTS_LOG = process.env.SM_NOTIFY_EVENTS_LOG ?? "/tmp/console-notify-events.jsonl";
  let notifyEventsStream: WriteStream | null = null;
  const notifyEventsSink = (event: unknown) => {
    try {
      if (!notifyEventsStream) notifyEventsStream = createWriteStream(NOTIFY_EVENTS_LOG, { flags: "a" });
      notifyEventsStream.write(JSON.stringify(event) + "\n");
    } catch (e) {
      notifyLogger.warn("notify events sink write failed", { err: e instanceof Error ? e.message : String(e) });
    }
  };
  // Dev/test guard: a process running under vitest (or a dev instance with
  // SM_NOTIFY_DRY_RUN=1) renders the card but never shells out to lark-cli, so
  // it cannot deliver into a real group. Production sets neither → live.
  const notifyDryRun = resolveNotifyDryRun(process.env);
  if (notifyDryRun.dryRun) {
    notifyLogger.warn("notify: dry-run armed — /api/notify will not deliver to Feishu", {
      reason: notifyDryRun.reason,
    });
  }
  const notifier = createConsoleNotifier({
    sender: withNotifyDryRun({
      sendCard: async (content, targetChatId) => ({
        messageId: await runNotifyCli([
          "im", "+messages-send",
          "--as", "bot",
          "--chat-id", targetChatId ?? CONSOLE_GROUP_ID,
          "--msg-type", "interactive",
          "--content", content,
        ]),
      }),
      sendText: async (text, targetChatId) => ({
        messageId: await runNotifyCli([
          "im", "+messages-send",
          "--as", "bot",
          "--chat-id", targetChatId ?? CONSOLE_GROUP_ID,
          "--text", text,
        ]),
      }),
    }, notifyDryRun, notifyLogger, CONSOLE_GROUP_ID),
    clock,
    logger: notifyLogger,
    onEvent: notifyEventsSink,
    // Default delivery target when caller omits targetChatId: the source
    // owner session's bound group, not the shared Console group. Spawned child
    // sources resolve through their parent owner before looking up bindings.
    resolveDefaultChat: createNotifyDefaultChatResolver(store, notifyLogger),
  });


  // Replier
  const autoFileDelivery = createAutoFileDelivery({
    sendFile: createLarkCliAutoFileSender({ larkCliPath: cfg.larkCliPath }),
    // Lets relative artifact paths in a final message (e.g. `sop/x.md`) resolve
    // against the source session's own workdir, so they deliver instead of
    // silently dropping (only absolute /Users paths worked before).
    resolveSessionWorkdir: async (sessionName: string): Promise<string | null> => {
      try {
        const session = await store.findSessionByName(sessionName);
        return session?.workdir ?? null;
      } catch (err) {
        logger.warn("resolveSessionWorkdir lookup failed", { sessionName, err: errorMessage(err) });
        return null;
      }
    },
  });
  const replier = createReplier({
    lark,
    clock,
    monotonic: () => performance.now(),
    idFactory: () => "mr_" + randomUUID().slice(0, 8),
    autoFileDelivery,
  });

  // Command registry + handlers
  const registry = buildCommandRegistry();
  const resolveUserGroupSession = async (groupId: LarkGroupId) => {
    const binding = await store.findByGroup(groupId);
    if (!binding) return null;
    const session = await store.findSessionById(binding.sessionId);
    return session ? { name: session.name, id: session.id } : null;
  };
  const heartbeatControlPath =
    process.env["SM_HEARTBEAT_CONTROL_PATH"] ??
    path.join(cfg.workspaceRoot, "heartbeat", "scripts", "heartbeat-control");
  const runHeartbeatControl = async (input: {
    action: "pause" | "resume" | "status";
    sessionName: string;
    minutes?: number;
    permanent?: boolean;
    reason?: string;
  }) => {
    const args =
      input.action === "pause"
        ? [
            heartbeatControlPath,
            "pause",
            "--session",
            input.sessionName,
            ...(input.permanent ? ["--permanent"] : ["--minutes", String(input.minutes ?? 60)]),
            "--reason",
            input.reason ?? "",
          ]
        : input.action === "resume"
          ? [heartbeatControlPath, "resume", "--session", input.sessionName, "--reason", input.reason ?? ""]
          : [heartbeatControlPath, "status", "--session", input.sessionName];
    const result = await execFileP("python3", args, {
      env: { ...process.env, SM_RUNTIME_ROOT: path.dirname(path.dirname(cfg.dbPath)) },
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout || "{}") as { status?: string; expires_at?: string };
  };
  registry["help"].handler = createHelpHandler(registry);
  registry["list"].handler = createListHandler({ store, clock });
  registry["tokens"].handler = createTokensHandler({ store, clock });
  // sm-switch owns the collection side; /usage only reads the snapshot it
  // publishes next to the runtime DB (SuperMatrixRuntime/data/sm-switch/).
  const quotaSnapshotPath =
    process.env["SM_QUOTA_SNAPSHOT_PATH"] ??
    path.join(path.dirname(cfg.dbPath), "sm-switch", "quota-snapshot.json");
  registry["usage"].handler = createUsageHandler({
    clock,
    loadSnapshotText: async () => {
      try {
        return await readFile(quotaSnapshotPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  });
  registry["status"].handler = createStatusHandler({ store, clock, resolveUserGroupSession });
  registry["lock"].handler = createWorkspaceLockHandler({ store, resolveUserGroupSession }, true);
  registry["unlock"].handler = createWorkspaceLockHandler({ store, resolveUserGroupSession }, false);
  registry["log"].handler = createLogHandler({ store, resolveUserGroupSession });
  registry["heartbeat"].handler = createHeartbeatHandler({ store, resolveUserGroupSession, heartbeatControl: runHeartbeatControl });
  registry["new"].handler = createNewHandler({ lifecycle, store });
  registry["clone"].handler = createCloneHandler({
    lifecycle,
    store,
    resolveUserGroupSession,
  });
  registry["delete"].handler = createDeleteHandler({ lifecycle, resolveUserGroupSession });
  let clearPendingNextForCancel = (_sessionId: string) => 0;
  registry["cancel"].handler = createCancelHandler({
    store,
    cancel: async (sessionId) => {
      await backendRegistry.cancel(sessionId as SessionId);
    },
    clearPendingNext: (sessionId) => clearPendingNextForCancel(sessionId),
    resolveUserGroupSession,
  });
  registry["reset"].handler = createResetHandler({ lifecycle, resolveUserGroupSession });
  registry["restart"].handler = createRestartHandler({ lifecycle, resolveUserGroupSession });
  const branchService = createSessionBranchService({ store });
  registry["branch"].handler = createBranchHandler({
    store,
    branchService,
    clock,
    codexForkInitializer: (input) =>
      runCodexForkBootstrap({
        sourceBackendSessionId: input.sourceBackendSessionId,
        sessionName: input.sessionName,
        branchName: input.branchName,
        workdir: input.workdir,
        model: input.model,
        effort: input.effort,
        onEffortNormalized: (evidence) => {
          logger.warn("codex fork effort normalized for cli", evidence);
        },
      }),
  });
  registry["model"].handler = createSetModelHandler({
    store,
    resolveUserGroupSession,
    resolveCodexRouteOverride: (intendedModel) => resolveCodexRouteOverride(intendedModel),
    syncSessionTable: lifecycle.syncSessionTable,
  });
  registry["backend"].handler = createSetBackendHandler({
    store,
    resolveUserGroupSession,
    renameGroup: async (groupId, newBackend) => {
      const currentName = await lark.getGroupName(groupId);
      const suffixRe = /-(claude|codex|kimi)$/u;
      const newName = suffixRe.test(currentName)
        ? currentName.replace(suffixRe, `-${newBackend}`)
        : `${currentName}-${newBackend}`;
      await lark.renameGroup(groupId, newName);
    },
    listScheduledTasks: createScheduledTaskLister(logger),
    requestScheduledTaskReview: createScheduledTaskReviewRequester({
      apiBase: `http://127.0.0.1:${cfg.apiPort}`,
    }),
    regenerateCatalog: lifecycle.regenerateCatalog,
    syncSessionTable: lifecycle.syncSessionTable,
  });
  registry["effort"].handler = createSetEffortHandler({
    store,
    resolveUserGroupSession,
    syncSessionTable: lifecycle.syncSessionTable,
  });
  registry["timeout"].handler = createSetTimeoutHandler({ store, resolveUserGroupSession });
  registry["rank"].handler = createRankHandler({
    store,
    logger,
  });
  registry["spawn"].handler = createSpawnChildHandler({ store, childSession, lark });
  registry["todo"].handler = createTodoHandler({ store, childSession, lark, clock });
  registry["idea"].handler = createIdeaHandler({ store, childSession, lark, clock });
  const btw = createBtwHandler({
    store,
    childSession,
    backend: {
      cancel: async (sessionId) => {
        await backendRegistry.cancel(sessionId);
      },
    },
    lark,
    clock,
    logger,
  });
  registry["btw"].handler = btw.handler;
  registry["selfcheck"].handler = createSelfCheckHandler({
    runChecks: async () =>
      runChecks(
        "runtime",
        "observe",
        { cfg, logger, processLister, store },
        [
          localDepsCheck,
          agentLarkCliShimCheck,
          supervisorPresenceCheck,
          schedulerHealthCheck,
          reconcileBackendProcessesCheck,
        ],
      ),
  });
  registry["skills"].handler = createSkillsHandler({ store, fs, userHome: homedir(), resolveUserGroupSession });

  // Pending /next store — in-memory FIFO queues shared between handler and dispatcher.
  const pendingNextMap = new Map<string, PendingNextEntry[]>();
  const hasPendingNext = (id: string) => (pendingNextMap.get(id)?.length ?? 0) > 0;
  const enqueuePendingNext = (id: string, entry: PendingNextEntry) => {
    const queue = pendingNextMap.get(id);
    if (queue) {
      queue.push(entry);
    } else {
      pendingNextMap.set(id, [entry]);
    }
  };
  const shiftPendingNext = (id: string) => {
    const queue = pendingNextMap.get(id);
    const entry = queue?.shift();
    if (queue && queue.length === 0) pendingNextMap.delete(id);
    return entry;
  };
  const restorePendingNextFront = (id: string, entry: PendingNextEntry) => {
    const queue = pendingNextMap.get(id);
    if (queue) {
      queue.unshift(entry);
    } else {
      pendingNextMap.set(id, [entry]);
    }
  };
  clearPendingNextForCancel = (id: string) => {
    const count = pendingNextMap.get(id)?.length ?? 0;
    pendingNextMap.delete(id);
    return count;
  };
  registry["next"].handler = createNextHandler({
    store,
    resolveUserGroupSession,
    enqueuePendingNext,
  });
  registry["now"].handler = createNowHandler({ store, backendRegistry });

  const processLifecycle = createProcessLifecycle({
    logger: logger.child({ mod: "lifecycle" }),
    onExit: async (reason, source) => {
      logger.info("restart: exiting", { reason, source });
      try {
        const registeredIntent = source === "signal"
          ? readFreshRestartProvenance(cfg.dbPath)
          : null;
        const recorded = registeredIntent ?? writeRestartProvenance(cfg.dbPath, {
          restartId: `smr-${Date.now()}-${process.pid}`,
          requestedAtMs: Date.now(),
          source: source === "signal"
            ? "unattributed_external_signal"
            : (source ?? "unknown_internal_restart"),
          reason,
          path: source === "src-watcher"
            ? "src/cli/sourceWatcher.ts"
            : reason.startsWith("/reload")
              ? "command:/reload"
              : "src/app/processLifecycle.ts",
          ...(source === "signal" ? { signal: reason.includes("SIGINT") ? "SIGINT" : "SIGTERM" } : {}),
          ...(source === "signal" ? {} : { requesterPid: process.pid }),
          targetPid: process.pid,
        });
        logger.info("restart provenance recorded", recorded);
      } catch (err) {
        logger.warn("failed to write restart provenance", { err: errorMessage(err) });
      }
      try {
        const result = await runWithTimeout(gracefulStop, cfg.shutdownGraceTimeoutMs);
        if (result === "timed_out") {
          logger.error("restart: graceful stop timed out; forcing process exit", {
            timeoutMs: cfg.shutdownGraceTimeoutMs,
          });
        }
      } catch (err) {
        logger.error("restart: graceful stop failed; forcing process exit", { err: errorMessage(err) });
      } finally {
        process.exit(0);
      }
    },
  });
  registry["reload"].handler = createReloadHandler({
    lifecycle: processLifecycle,
    store,
  });

  // Router + dispatcher
  const router = createCommandRouter(registry);
  dispatcher = createDispatcher({
    store,
    lark,
    router,
    backend: backendRegistry,
    childSession,
    replier,
    rootGroupId: asLarkGroupId(cfg.rootGroupId),
    ownerUserId: cfg.rootUserId,
    clock,
    idFactory: () => "mr_" + randomUUID().slice(0, 8),
    eventBus,
    lifecycle: processLifecycle,
    pendingNext: {
      has: hasPendingNext,
      shift: shiftPendingNext,
      restoreFront: restorePendingNextFront,
    },
    logger,
    monotonic: () => performance.now(),
    cardAskGatePath: cfg.cardAskGatePath,
    cardAskHealthFilter: disableCardAskWhenBrokerUnhealthy,
    codexRuntimeRecovery: {
      availability: codexModelAvailability,
      isModelUnavailable: isConfirmedCodexModelUnavailable,
      isCapacityError: isCodexModelAtCapacity,
      backupBeforeResumeClear: backupBeforeCodexResumeClear,
    },
    isCodexRouteOverrideActive: () => isCodexRouteOverrideActive(),
  });

  // API server — bound inside start() so port bind errors surface
  // before lark.start() / startup announce. Keeps crash loops quiet.
  let apiServer: Awaited<ReturnType<typeof startApiServer>> | undefined;

  let disposeWatcher: (() => void) | undefined;
  let stopKimiAutonomousWatch: (() => void) | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let driveCommentSweepTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const gracefulStop = async () => {
    if (stopped) return;
    stopped = true;
    disposeWatcher?.();
    stopKimiAutonomousWatch?.();
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (driveCommentSweepTimer) clearInterval(driveCommentSweepTimer);
    btw.shutdown();
    if (apiServer) {
      const apiCloseTimeoutMs = Math.min(5_000, cfg.shutdownGraceTimeoutMs);
      const result = await closeServerWithTimeout(apiServer, apiCloseTimeoutMs);
      if (result === "timed_out") {
        logger.warn("api server close timed out; continuing shutdown", { timeoutMs: apiCloseTimeoutMs });
      }
    }
    try {
      await kimiBackend.dispose();
    } catch (err) {
      logger.error("kimiBackend.dispose threw", { err: errorMessage(err) });
    }
    try {
      await lark.stop();
    } catch (err) {
      logger.error("lark.stop threw", { err: errorMessage(err) });
    }
    try {
      await eventBus.stop();
    } catch (err) {
      logger.error("eventBus.stop threw", { err: errorMessage(err) });
    }
    try {
      cleanupBootstrapPidFile(cfg.dbPath);
    } catch {
      // best-effort
    }
    try {
      await store.close();
    } catch (err) {
      logger.error("store.close threw", { err: errorMessage(err) });
    }
  };

  return {
    lifecycle: processLifecycle,
    async start() {
      // Bind API port first — fail fast (and quietly) on EADDRINUSE so
      // restart-loop churn never reaches lark.start()/startup announce.
      const apiDeps: Parameters<typeof startApiServer>[0] = {
        store,
        childSession,
        routeSpawnClosureItem: async (input) => {
          await routeCompletedSpawnClosure({
            ref: input.ref,
            commId: input.commId,
            store,
            heartbeatEnqueuePath:
              process.env["SPAWN_CLOSURE_HEARTBEAT_ENQUEUE"] ??
              path.join(cfg.workspaceRoot, "heartbeat", "scripts", "enqueue-heartbeat-todo"),
            sourceSession: "supermatrix-root",
            now: clock.now(),
            logger,
            // Heartbeat push is impossible for this caller; the card lands in
            // the caller's own bound group so the parked result gets taken
            // instead of dying silently.
            notifyUndeliverable: async (undeliverable) => {
              await notifier.notify({
                source: undeliverable.callerSession,
                title: "结果已就绪但无法自动送达",
                body: [
                  `spawn ${undeliverable.callerSession} -> ${undeliverable.targetSession} 的结果已完成，`,
                  "但你的 session 未开启 heartbeat 投递，框架无法自动送回。",
                  `请自取：curl -sX POST http://127.0.0.1:${cfg.apiPort}/api/spawn_async_items/${undeliverable.ref}/take`,
                  `原因：${undeliverable.reason}`,
                ].join("\n"),
                level: "warn",
                metadata: {
                  comm_id: undeliverable.commId,
                  async_ref: undeliverable.ref,
                  verdict: "delivery_unsupported_caller_heartbeat_disabled",
                },
              });
            },
          });
        },
        runOnSession: (input) =>
          runOnSession(
            {
              store,
              backendRegistry,
              clock,
              idFactory: () => "mr_" + randomUUID().slice(0, 8),
              eventBus,
              logger,
              codexRuntimeRecovery: {
                availability: codexModelAvailability,
                isModelUnavailable: isConfirmedCodexModelUnavailable,
                isCapacityError: isCodexModelAtCapacity,
                backupBeforeResumeClear: backupBeforeCodexResumeClear,
              },
            },
            input,
          ),
        notifier,
        logger: logger.child({ mod: "api" }),
        closureDb: store.db,
        kimiAcpHealth: () => kimiBackend.probeAcpHealth(),
        larkWsHealth: () => larkClient.getWsHealth(),
        // Recycle after a kimi account switch: dispose drops the old account's
        // ACP process; probeAcpHealth's ensureAcpReady then rebuilds the client
        // (KimiBackend is constructed with the default acpClientFactory) and
        // round-trips against the fresh process.
        recycleKimiAcp: async () => {
          await kimiBackend.dispose();
          return kimiBackend.probeAcpHealth();
        },
      };
      apiServer = await startApiServer(apiDeps, cfg.apiPort);
      bootOrphanedSpawnCommReporter = createBootOrphanedSpawnReporter({
        store,
        deliver: async (input) => {
          const response = await fetch(
            `http://127.0.0.1:${cfg.apiPort}/api/watcher-exception-notify`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
            },
          );
          const body = await response.json().catch(() => null) as {
            ok?: unknown;
            error?: unknown;
            lark_message_id?: unknown;
          } | null;
          if (!response.ok || body?.ok !== true || typeof body.lark_message_id !== "string") {
            throw new Error(
              `watcher-exception notify failed: HTTP ${response.status} ${typeof body?.error === "string" ? body.error : "invalid response"}`,
            );
          }
        },
      });
      await trackBootOrphanedSpawnComms(pendingBootOrphanedSpawnComms.splice(0));
      recoverSpawnCommOrphans({
        db: store.db,
        now: clock.now(),
        thresholdSec: cfg.spawnOrphanThresholdSec,
        source: "startup",
        logger,
      });
      await eventBus.start();
      const bootQueuedParents = await childSession.drainSpawnQueues();
      if (bootQueuedParents > 0) {
        logger.info("boot: kicked spawn queue drain", { parentCount: bootQueuedParents });
      }
      const bootSettledDriveComments = await driveCommentProcessor.sweepQueuedMentions();
      if (bootSettledDriveComments > 0) {
        logger.info("boot: settled queued drive comment spawns", { count: bootSettledDriveComments });
      }
      logger.info("supermatrix starting", { backend: cfg.backend });
      disposeWatcher = startSourceWatcher({
        srcDir: path.resolve("src"),
        lifecycle: processLifecycle,
        logger: logger.child({ mod: "srcWatcher" }),
      });
      const CHILD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
      const DRIVE_COMMENT_SWEEP_INTERVAL_MS = 30_000;
      driveCommentSweepTimer = setInterval(async () => {
        try {
          const settled = await driveCommentProcessor.sweepQueuedMentions();
          if (settled > 0) {
            logger.info("settled queued drive comment spawns", { count: settled });
          }
        } catch (err) {
          logger.error("drive comment queued sweep failed", { err: errorMessage(err) });
        }
      }, DRIVE_COMMENT_SWEEP_INTERVAL_MS);
      cleanupTimer = setInterval(async () => {
        try {
          const cutoff = asTimestamp(Date.now() - CHILD_MAX_IDLE_MS);
          const cleaned = await store.cleanupStaleChildSessions(cutoff);
          if (cleaned.count > 0) {
            logger.info("cleaned stale child sessions", { count: cleaned.count });
          }
          await trackBootOrphanedSpawnComms(cleaned.failedComms);
          const errorCutoff = asTimestamp(Date.now() - CHILD_MAX_ERROR_MS);
          const errorCleaned = await store.cleanupErroredChildSessions(errorCutoff);
          if (errorCleaned.count > 0) {
            logger.info("cleaned errored child sessions", { count: errorCleaned.count });
          }
          await trackBootOrphanedSpawnComms(errorCleaned.failedComms);
          const busyCutoff = asTimestamp(Date.now() - STUCK_BUSY_CHILD_MS);
          const stuckCleaned = await store.cleanupStuckBusyChildren(busyCutoff);
          if (stuckCleaned > 0) {
            logger.info("cleaned stuck busy children", { count: stuckCleaned });
          }
          const queuedParents = await childSession.drainSpawnQueues();
          if (queuedParents > 0) {
            logger.info("kicked spawn queue drain", { parentCount: queuedParents });
          }
        } catch (err) {
          logger.error("child session cleanup failed", { err: errorMessage(err) });
        }
      }, CHILD_CLEANUP_INTERVAL_MS);
      // Surface kimi CLI autonomous turns (background-notification-driven,
      // ACP-invisible): session busy state + a standard replier streaming
      // card titled `auto-turn-<cliTurnId>`. Separate replier instance
      // without autoFileDelivery — synthetic streams must not trigger
      // artifact delivery.
      stopKimiAutonomousWatch = startKimiAutonomousTurnWatch({
        store,
        replier: createReplier({
          lark,
          clock,
          monotonic: () => performance.now(),
        }),
        clock,
        eventBus,
        logger,
      });
      await lark.start(async (msg) => {
        try {
          await dispatcher.handleInbound(msg);
        } catch (err) {
          logger.error("dispatcher error", { err: errorMessage(err) });
        }
      });
      await reconcileDriveCommentSubscriptionAtStartup({
        reconcile: () => reconcileDriveCommentSubscription({ larkCliPath: cfg.larkCliPath }),
        logger: logger.child({ mod: "driveCommentSubscription" }),
      });
      // Announce recovery to console group (include reload source if available).
      // Cooldown: skip announcement if we restarted within the last 60s to
      // prevent message spam during rapid restart loops.
      const ANNOUNCE_COOLDOWN_MS = 60_000;
      const announceTimestampPath = path.join(path.dirname(cfg.dbPath), ".last-announce-ts");
      try {
        let shouldAnnounce = true;
        let lastAnnounceTs: number | undefined;
        try {
          lastAnnounceTs = parseInt(readFileSync(announceTimestampPath, "utf-8").trim(), 10);
          if (Date.now() - lastAnnounceTs < ANNOUNCE_COOLDOWN_MS) {
            shouldAnnounce = false;
            logger.info("skipping startup announce (cooldown)");
          }
        } catch {
          // file doesn't exist — first run
        }

        if (shouldAnnounce) {
          writeFileSync(announceTimestampPath, String(Date.now()), "utf-8");
          const count = await store.countActiveSessions();
          let uptimeTag = "";
          if (lastAnnounceTs) {
            const elapsed = Date.now() - lastAnnounceTs;
            const hours = Math.floor(elapsed / 3_600_000);
            const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
            uptimeTag = `，距上次启动 ${hours}h ${minutes}m`;
          }
          const sourceTag = restartProvenance
            ? `，重启来源：${restartProvenance.source}`
              + `，原因：${restartProvenance.reason}`
              + `，路径：${restartProvenance.path}`
              + `，restart_id：${restartProvenance.restartId}`
            : "";
          if (migrationResult.degraded.length > 0) {
            for (const d of migrationResult.degraded) {
              allBootResults.push({
                name: `migration-${d.version}`,
                status: "warn",
                message: `optional migration ${d.file} 降级: ${d.error}`,
              });
            }
          }
          const checkSection = renderAnnounceCheckSection(allBootResults);
          await lark.sendMessage(
            asLarkGroupId(cfg.rootGroupId),
            `✅ SuperMatrix 已恢复服务（${count} 个 active session${uptimeTag}${sourceTag}）${checkSection}`,
          );
        }
      } catch (err) {
        logger.warn("startup announce failed", { err: errorMessage(err) });
      }

      const nudgeCleanup = cleanupPendingForceReloadNudge(cfg.dbPath);
      if (nudgeCleanup.removed) {
        logger.info("removed stale force reload nudge file without dispatch");
      }
    },
    async stop() {
      await gracefulStop();
    },
  };
}

export function createScheduledTaskReviewRequester(
  deps: {
    apiBase: string;
  },
): (request: ScheduledTaskReviewRequest) => Promise<void> {
  const apiBase = deps.apiBase.replace(/\/+$/u, "");

  return async (request) => {
    const date = new Date(request.backendSwitchAuditCreatedAt).toISOString().slice(0, 10);
    const clientRequestId = `${date}:backend-switch-task-review:${request.sessionName}:${request.backendSwitchAuditId}`;
    const response = await fetch(`${apiBase}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        from: "supermatrix-root",
        target: "scheduler",
        client_request_id: clientRequestId,
        closure: { kind: "message", target: { type: "todo_pool" } },
        prompt: [
          "Backend switch scheduled-task compatibility review.",
          `Session: ${request.sessionName}`,
          `Transition: ${request.previousBackend} -> ${request.newBackend}`,
          "Review only enabled scheduler v2 tasks whose owner exactly equals the session name. Do not infer ownership from target, model, or prompt text.",
          "Assess whether each in-scope task prompt depends on the previous backend.",
          "Make only necessary scheduler-authorized task changes. Preserve cron, owner, type, closure, timeout, and unrelated configuration.",
          "Do not change target or model to bypass a validation failure. Report findings and any changes to the task owner; record a no-change result when no adaptation is needed.",
        ].join("\n"),
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`scheduler review spawn failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
  };
}

// Best-effort read-only query against the external scheduler service.
// Returns [] when the scheduler is not configured, unreachable, or slow —
// /backend is a user-visible command and must not block on scheduler health.
export function createScheduledTaskLister(
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): (sessionName: string) => Promise<
  Array<{ id: string; cronExpression: string; prompt: string }>
> {
  return async (sessionName) => {
    const base = deriveSchedulerBaseUrl();
    try {
      const res = await fetch(`${base}/tasks?enabled=true`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        logger.warn("scheduler /tasks non-2xx", { status: res.status });
        return [];
      }
      const tasks = (await res.json()) as Array<{
        id: string;
        name?: string;
        cron: string;
        description?: string;
        owner?: string | null;
        ownerSession?: string | null;
        config?: Record<string, unknown>;
      }>;
      return tasks
        .filter((t) => t.ownerSession === sessionName || t.owner === sessionName)
        .map((t) => ({
          id: t.name ?? t.id,
          cronExpression: t.cron,
          prompt: extractPromptFromTask(t),
        }));
    } catch (err) {
      logger.warn("scheduler task query failed", { err: errorMessage(err) });
      return [];
    }
  };
}

// Scheduler v2 runs on localhost:3502. Port 3500 is the legacy v1 API and may
// return an empty task list even when v2 owns active recurring tasks.
// Fall back to the loopback default when no env is set so /backend's cron
// block works out of the box without relying on the shell environment.
const DEFAULT_SCHEDULER_BASE_URL = "http://127.0.0.1:3502";

function deriveSchedulerBaseUrl(): string {
  const explicit = process.env["SM_SCHEDULER_BASE_URL"];
  if (explicit) return explicit.replace(/\/+$/u, "");
  const health = process.env["SM_SCHEDULER_HEALTH_URL"];
  if (health) {
    try {
      const u = new URL(health);
      return `${u.protocol}//${u.host}`;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_SCHEDULER_BASE_URL;
}

function extractPromptFromTask(task: {
  description?: string;
  config?: Record<string, unknown>;
}): string {
  const cfg = task.config as Record<string, unknown> | undefined;
  const body = cfg?.["body"] as Record<string, unknown> | undefined;
  const prompt = body?.["prompt"];
  if (typeof prompt === "string" && prompt.length > 0) return prompt;
  const text = body?.["text"];
  if (typeof text === "string" && text.length > 0) return text;
  const command = cfg?.["command"];
  if (typeof command === "string" && command.length > 0) return command;
  return task.description ?? "";
}
