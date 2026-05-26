import { homedir } from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { SqliteBindingStore } from "../adapters/store-sqlite/index.ts";
import { NodeWorkspaceFs } from "../adapters/workspace-node/index.ts";
import { createPinoLogger } from "../adapters/logger-pino/index.ts";
import { ClaudeBackend } from "../adapters/backend-claude/index.ts";
import { CodexBackend } from "../adapters/backend-codex/index.ts";
import { KimiBackend } from "../adapters/backend-kimi/index.ts";
import { InMemoryEventBus } from "../adapters/event-bus-memory/index.ts";
import { InMemoryTopicBus } from "../adapters/topic-bus-memory/index.ts";
import { LarkCliGateway } from "../adapters/lark-cli/index.ts";
import { createRealLarkClient } from "../adapters/lark-cli/realClient.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asTimestamp,
  type LarkGroupId,
  type SessionId,
} from "../domain/ids.ts";
import type { AgentBackend, BackendRegistry } from "../ports/AgentBackend.ts";
import type { Clock } from "../ports/Clock.ts";
import { createSessionLifecycle } from "../app/sessionLifecycle.ts";
import { errorMessage } from "../app/errorMessage.ts";
import { createReplier } from "../app/replier.ts";
import { buildCommandRegistry } from "../app/commandRegistry.ts";
import { createCommandRouter } from "../app/commandRouter.ts";
import { createDispatcher, type PendingNextEntry } from "../app/dispatcher.ts";
import { createContinuationDispatcher } from "../app/continuationDispatcher.ts";
import { createStaWritebackPoller } from "../app/staWritebackPoller.ts";
import { deliverResultSinks } from "../app/resultSinkEngine.ts";
import { recoverSpawnCommOrphans } from "../app/spawnClosure/orphanSweep.ts";
import { createHelpHandler } from "../app/commands/help.ts";
import { createListHandler } from "../app/commands/listSessions.ts";
import { createTokensHandler } from "../app/commands/tokens.ts";
import { createStatusHandler } from "../app/commands/status.ts";
import { createLogHandler } from "../app/commands/log.ts";
import { createStaWritebackHandler } from "../app/commands/staWriteback.ts";
import { createHeartbeatHandler } from "../app/commands/heartbeat.ts";
import { createNewHandler } from "../app/commands/newSession.ts";
import { createDeleteHandler } from "../app/commands/deleteSession.ts";
import { createCancelHandler } from "../app/commands/cancelSession.ts";
import { createResetHandler } from "../app/commands/resetSession.ts";
import { createRestartHandler } from "../app/commands/restartSession.ts";
import { createReloadHandler } from "../app/commands/reload.ts";
import { createSetModelHandler } from "../app/commands/setModel.ts";
import { createSetBackendHandler } from "../app/commands/setBackend.ts";
import { createSetEffortHandler } from "../app/commands/setEffort.ts";
import { createSetTimeoutHandler } from "../app/commands/setTimeout.ts";
import { createSkillsHandler } from "../app/commands/skills.ts";
import { createNextHandler } from "../app/commands/next.ts";
import { createSpawnChildHandler } from "../app/commands/spawnChild.ts";
import { createTodoHandler } from "../app/commands/todo.ts";
import { createBtwHandler } from "../app/commands/btw.ts";
import { createSelfCheckHandler } from "../app/commands/selfCheck.ts";
import { createRankHandler } from "../app/commands/rank.ts";
import { createProcessLifecycle } from "../app/processLifecycle.ts";
import type { ProcessLifecycle } from "../app/processLifecycle.ts";
import { createChildSessionService } from "../app/childSession.ts";
import { createConsoleNotifier } from "../app/consoleNotifier.ts";
import { runChecks, hasFail } from "../app/bootSelfCheck/index.ts";
import { localDepsCheck } from "../app/bootSelfCheck/checks/localDeps.ts";
import {
  dualInstanceCheck,
  cleanupBootstrapPidFile,
} from "../app/bootSelfCheck/checks/dualInstance.ts";
import { supervisorPresenceCheck } from "../app/bootSelfCheck/checks/supervisorPresence.ts";
import { schedulerHealthCheck } from "../app/bootSelfCheck/checks/schedulerHealth.ts";
import { reconcileBackendProcessesCheck } from "../app/bootSelfCheck/checks/reconcileBackendProcesses.ts";
import { createCodexDefaultModelCheck } from "../app/bootSelfCheck/checks/codexDefaultModel.ts";
import { createKimiAcpHealthCheck } from "../app/bootSelfCheck/checks/kimiAcpHealth.ts";
import { resolveCodexDefaultModel } from "../adapters/backend-codex/defaultModelResolver.ts";
import { runOnSession } from "../app/runOnSession.ts";
import {
  renderStderrFailReport,
  renderAnnounceCheckSection,
} from "../app/bootSelfCheck/formatReport.ts";
import { startApiServer } from "./apiServer.ts";
import { startSourceWatcher } from "./sourceWatcher.ts";
import { createPsProcessLister } from "../adapters/process-lister-ps/index.ts";
// Note: bootstrap (cli layer) may import from adapters — it's the composition root.

export type AppConfig = {
  rootGroupId: string;
  rootUserId: string;
  workspaceRoot: string;
  dbPath: string;
  backend: "claude" | "codex" | "kimi";
  logLevel: "debug" | "info" | "warn" | "error";
  larkAppId: string;
  larkCliPath: string;
  apiPort: number;
  shutdownGraceTimeoutMs: number;
  spawnOrphanThresholdSec: number;
};

export type App = {
  lifecycle: ProcessLifecycle;
  start(): Promise<void>;
  stop(): Promise<void>;
};

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
  SM_LARK_CLI_PATH: z.string().optional(),
  SM_API_PORT: z.coerce.number().int().default(3501),
  SM_SHUTDOWN_GRACE_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_SHUTDOWN_GRACE_TIMEOUT_MS),
  SM_SPAWN_ORPHAN_THRESHOLD_SEC: z.coerce.number().int().positive().default(60),
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
    SM_LARK_CLI_PATH: env["SM_LARK_CLI_PATH"],
    SM_API_PORT: env["SM_API_PORT"],
    SM_SHUTDOWN_GRACE_TIMEOUT_MS: env["SM_SHUTDOWN_GRACE_TIMEOUT_MS"],
    SM_SPAWN_ORPHAN_THRESHOLD_SEC: env["SM_SPAWN_ORPHAN_THRESHOLD_SEC"],
  });

  return {
    rootGroupId: parsed.SM_ROOT_GROUP_ID,
    rootUserId: parsed.SM_ROOT_USER_ID,
    workspaceRoot: parsed.SM_WORKSPACE_ROOT,
    dbPath: parsed.SM_DB_PATH,
    backend: parsed.SM_BACKEND,
    logLevel: parsed.SM_LOG_LEVEL,
    larkAppId: parsed.LARK_APP_ID,
    larkCliPath: parsed.SM_LARK_CLI_PATH ?? path.resolve("node_modules/.bin/lark-cli"),
    apiPort: parsed.SM_API_PORT,
    shutdownGraceTimeoutMs: parsed.SM_SHUTDOWN_GRACE_TIMEOUT_MS,
    spawnOrphanThresholdSec: parsed.SM_SPAWN_ORPHAN_THRESHOLD_SEC,
  };
}

export async function bootstrap(env: Record<string, string | undefined>): Promise<App> {
  const cfg = validateEnv(env);
  const logger = createPinoLogger(cfg.logLevel);
  const processLister = createPsProcessLister();

  // Boot self-check — pre-wiring phase (cheap probes, dual-instance lock,
  // supervisor classification, scheduler reachability, local deps with
  // auto-repair for lark-cli). Fails loudly BEFORE constructing the store
  // and before Lark starts, so a broken config never reaches announce.
  const preChecks = [
    localDepsCheck,
    dualInstanceCheck,
    supervisorPresenceCheck,
    schedulerHealthCheck,
    createCodexDefaultModelCheck({ resolve: () => resolveCodexDefaultModel() }),
    createKimiAcpHealthCheck({
      probe: async () => {
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileP = promisify(execFile);
          const cmd = process.env["SM_KIMI_CLI_PATH"] ?? "kimi";
          const { stdout } = await execFileP(cmd, ["info"], { timeout: 5_000 });
          const m = stdout.match(/kimi-cli version:\s*(\S+)/);
          return { kind: "ok" as const, version: m?.[1] ?? "unknown" };
        } catch (err) {
          return { kind: "fail" as const, error: errorMessage(err) };
        }
      },
    }),
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
  await store.resetBusySessionsOnBoot(asTimestamp(Date.now()));

  // Instantiate KimiBackend early so its getAcpPid() can be injected into the
  // post-wiring reconcile check. The ACP process itself is lazy-spawned on
  // first use, so constructing KimiBackend here is cheap.
  const kimiBackend = new KimiBackend();

  // Boot self-check — post-wiring phase (reconcile DB ↔ process world).
  // This supersedes the previous blunt resetRunningMessageRunsOnBoot call.
  // resetRunningMessageRunsOnBoot remains in the store as a defensive fallback
  // used only if the reconciler itself throws.
  let postResults: Awaited<ReturnType<typeof runChecks>> = [];
  try {
    postResults = await runChecks(
      "post-wiring",
      "execute",
      { cfg, logger, processLister, store, getKimiAcpPid: () => kimiBackend.getAcpPid() },
      [reconcileBackendProcessesCheck],
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
  if (bootCleaned > 0) {
    logger.info("boot: cleaned stale child sessions", { count: bootCleaned });
  }
  const bootErrorCutoff = asTimestamp(Date.now() - CHILD_MAX_ERROR_MS);
  const bootErrorCleaned = await store.cleanupErroredChildSessions(bootErrorCutoff);
  if (bootErrorCleaned > 0) {
    logger.info("boot: cleaned errored child sessions", { count: bootErrorCleaned });
  }
  const stuckCutoff = asTimestamp(Date.now() - STUCK_BUSY_CHILD_MS);
  const stuckCleaned = await store.cleanupStuckBusyChildren(stuckCutoff);
  if (stuckCleaned > 0) {
    logger.info("boot: cleaned stuck busy children", { count: stuckCleaned });
  }

  // Filesystem + templates
  const fs = new NodeWorkspaceFs({
    gitUserName: "SuperMatrix Console",
    gitUserEmail: "console@supermatrix.local",
  });

  // Clock
  const clock: Clock = { now: () => asTimestamp(Date.now()) };

  // Lark gateway with real lark-cli shell-out client
  const larkClient = createRealLarkClient({
    larkCliPath: cfg.larkCliPath,
    botAppId: cfg.larkAppId,
    ownerUserId: cfg.rootUserId,
  });
  const lark = new LarkCliGateway({
    client: larkClient,
    attachmentDir: (groupId: LarkGroupId, dateIso: string) =>
      asAbsolutePath(path.join(cfg.workspaceRoot, ".attachments", groupId, dateIso)),
    logger: logger.child({ mod: "lark" }),
  });

  // Event bus
  const eventBus = new InMemoryEventBus(logger.child({ mod: "eventBus" }));
  const topicBus = new InMemoryTopicBus({ logger: logger.child({ mod: "topicBus" }) });

  // Backends (kimiBackend was instantiated early above for reconcile; reuse it here)
  const backends: Record<string, AgentBackend> = {
    claude: new ClaudeBackend(),
    codex: new CodexBackend(),
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
  const childSessionDeps: Parameters<typeof createChildSessionService>[0] = {
    store,
    backendRegistry,
    clock,
    eventBus,
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
  };
  const childSession = createChildSessionService(childSessionDeps);

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
  const runNotifyCli = async (args: string[]): Promise<string> => {
    let stdout = "";
    try {
      const r = await execFileP(cfg.larkCliPath, args, {
        env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = r.stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      if (!stdout) {
        throw new Error(
          `lark-cli ${args[0]} ${args[1] ?? ""} failed: ${e.stderr?.trim() || e.message}`,
        );
      }
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
  const notifier = createConsoleNotifier({
    sender: {
      sendCard: async (content) => ({
        messageId: await runNotifyCli([
          "im", "+messages-send",
          "--as", "bot",
          "--chat-id", CONSOLE_GROUP_ID,
          "--msg-type", "interactive",
          "--content", content,
        ]),
      }),
      sendText: async (text) => ({
        messageId: await runNotifyCli([
          "im", "+messages-send",
          "--as", "bot",
          "--chat-id", CONSOLE_GROUP_ID,
          "--text", text,
        ]),
      }),
    },
    clock,
    logger: logger.child({ mod: "notify" }),
  });


  // Replier
  const replier = createReplier({
    lark,
    clock,
    monotonic: () => performance.now(),
    idFactory: () => "mr_" + randomUUID().slice(0, 8),
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
  registry["status"].handler = createStatusHandler({ store, clock, resolveUserGroupSession });
  registry["log"].handler = createLogHandler({ store, resolveUserGroupSession });
  registry["sta-writeback"].handler = createStaWritebackHandler({ store });
  registry["heartbeat"].handler = createHeartbeatHandler({ store, resolveUserGroupSession, heartbeatControl: runHeartbeatControl });
  registry["new"].handler = createNewHandler({ lifecycle });
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
  registry["model"].handler = createSetModelHandler({ store, resolveUserGroupSession });
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
    regenerateCatalog: lifecycle.regenerateCatalog,
  });
  registry["effort"].handler = createSetEffortHandler({ store, resolveUserGroupSession });
  registry["timeout"].handler = createSetTimeoutHandler({ store, resolveUserGroupSession });
  registry["rank"].handler = createRankHandler({
    store,
    logger,
  });
  registry["spawn"].handler = createSpawnChildHandler({ store, childSession, lark });
  registry["todo"].handler = createTodoHandler({ store, childSession, lark, clock });
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

  const processLifecycle = createProcessLifecycle({
    logger: logger.child({ mod: "lifecycle" }),
    onExit: async (reason, source) => {
      logger.info("restart: exiting", { reason, source });
      const reloadSourcePath = path.join(path.dirname(cfg.dbPath), ".reload-source");
      try {
        writeFileSync(reloadSourcePath, source ?? "unknown", "utf-8");
      } catch (err) {
        logger.warn("failed to write reload source file", { err: errorMessage(err) });
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
  registry["reload"].handler = createReloadHandler({ lifecycle: processLifecycle, store });

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
  });

  // API server — bound inside start() so port bind errors surface
  // before lark.start() / startup announce. Keeps crash loops quiet.
  let apiServer: Awaited<ReturnType<typeof startApiServer>> | undefined;

  let disposeWatcher: (() => void) | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let stopStaWritebackPoller: (() => void) | undefined;
  let stopped = false;

  const gracefulStop = async () => {
    if (stopped) return;
    stopped = true;
    disposeWatcher?.();
    stopStaWritebackPoller?.();
    if (cleanupTimer) clearInterval(cleanupTimer);
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
        runOnSession: (input) =>
          runOnSession(
            {
              store,
              backendRegistry,
              clock,
              idFactory: () => "mr_" + randomUUID().slice(0, 8),
              eventBus,
              logger,
            },
            input,
          ),
        notifier,
        logger: logger.child({ mod: "api" }),
        closureDb: store.db,
      };
      apiServer = await startApiServer(apiDeps, cfg.apiPort);
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
      logger.info("supermatrix starting", { backend: cfg.backend });
      disposeWatcher = startSourceWatcher({
        srcDir: path.resolve("src"),
        lifecycle: processLifecycle,
        logger: logger.child({ mod: "srcWatcher" }),
      });
      const CHILD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
      cleanupTimer = setInterval(async () => {
        try {
          const cutoff = asTimestamp(Date.now() - CHILD_MAX_IDLE_MS);
          const cleaned = await store.cleanupStaleChildSessions(cutoff);
          if (cleaned > 0) {
            logger.info("cleaned stale child sessions", { count: cleaned });
          }
          const errorCutoff = asTimestamp(Date.now() - CHILD_MAX_ERROR_MS);
          const errorCleaned = await store.cleanupErroredChildSessions(errorCutoff);
          if (errorCleaned > 0) {
            logger.info("cleaned errored child sessions", { count: errorCleaned });
          }
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
      await lark.start(async (msg) => {
        try {
          await dispatcher.handleInbound(msg);
        } catch (err) {
          logger.error("dispatcher error", { err: errorMessage(err) });
        }
      });
      stopStaWritebackPoller = createStaWritebackPoller({
        larkCliPath: cfg.larkCliPath,
        botAppId: cfg.larkAppId,
        store,
        router,
        lark,
        logger: logger.child({ mod: "staWritebackPoller" }),
      }).start();

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

        const reloadSourcePath = path.join(path.dirname(cfg.dbPath), ".reload-source");
        let reloadSource: string | undefined;
        try {
          reloadSource = readFileSync(reloadSourcePath, "utf-8").trim();
          unlinkSync(reloadSourcePath);
        } catch {
          // file doesn't exist — cold start, not a reload
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
          const sourceTag = reloadSource ? `，触发来源：${reloadSource}` : "";
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
    },
    async stop() {
      await gracefulStop();
    },
  };
}

// Best-effort read-only query against the external scheduler service.
// Returns [] when the scheduler is not configured, unreachable, or slow —
// /backend is a user-visible command and must not block on scheduler health.
function createScheduledTaskLister(
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
        cron: string;
        description?: string;
        ownerSession?: string | null;
        config?: Record<string, unknown>;
      }>;
      return tasks
        .filter((t) => t.ownerSession === sessionName)
        .map((t) => ({
          id: t.id,
          cronExpression: t.cron,
          prompt: extractPromptFromTask(t),
        }));
    } catch (err) {
      logger.warn("scheduler task query failed", { err: errorMessage(err) });
      return [];
    }
  };
}

// Scheduler runs on localhost:3500 as a PM2-managed service (see
// scripts/repair/fix-port-in-use.sh and docs/reviews/WORKSPACES_REVIEW.md).
// Fall back to the loopback default when no env is set so /backend's cron
// block works out of the box without relying on the shell environment.
const DEFAULT_SCHEDULER_BASE_URL = "http://127.0.0.1:3500";

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
  const text = body?.["text"];
  if (typeof text === "string" && text.length > 0) return text;
  const command = cfg?.["command"];
  if (typeof command === "string" && command.length > 0) return command;
  return task.description ?? "";
}
