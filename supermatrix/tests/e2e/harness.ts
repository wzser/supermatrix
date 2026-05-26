import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";
import { NodeWorkspaceFs } from "../../src/adapters/workspace-node/index.ts";
import { createSessionLifecycle } from "../../src/app/sessionLifecycle.ts";
import { createReplier } from "../../src/app/replier.ts";
import { buildCommandRegistry } from "../../src/app/commandRegistry.ts";
import { createCommandRouter } from "../../src/app/commandRouter.ts";
import { createDispatcher, type PendingNextEntry } from "../../src/app/dispatcher.ts";
import { createHelpHandler } from "../../src/app/commands/help.ts";
import { createListHandler } from "../../src/app/commands/listSessions.ts";
import { createStatusHandler } from "../../src/app/commands/status.ts";
import { createLogHandler } from "../../src/app/commands/log.ts";
import { createNewHandler } from "../../src/app/commands/newSession.ts";
import { createDeleteHandler } from "../../src/app/commands/deleteSession.ts";
import { createCancelHandler } from "../../src/app/commands/cancelSession.ts";
import { createResetHandler } from "../../src/app/commands/resetSession.ts";
import { createRestartHandler } from "../../src/app/commands/restartSession.ts";
import { createNextHandler } from "../../src/app/commands/next.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asTimestamp,
  type LarkGroupId,
  type SessionId,
} from "../../src/domain/ids.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import type { BackendRegistry, RunInput } from "../../src/ports/AgentBackend.ts";
import type { Clock } from "../../src/ports/Clock.ts";
import { makeFakeBackend } from "./fakes/fakeAgentBackend.ts";
import { makeE2eLark, type E2ELarkHarness } from "./fakes/fakeLarkGatewayE2E.ts";

export type Harness = {
  store: SqliteBindingStore;
  lark: E2ELarkHarness;
  emitInbound: E2ELarkHarness["emitInbound"];
  setScript(script: (input: RunInput) => AgentEvent[]): void;
  rootGroupId: LarkGroupId;
  cleanup(): Promise<void>;
};

export async function createHarness(opts: {
  script?: (input: RunInput) => AgentEvent[];
}): Promise<Harness> {
  const tmp = mkdtempSync(path.join(tmpdir(), "sm-e2e-"));
  const dbPath = path.join(tmp, "sm.db");
  const workspaceRoot = path.join(tmp, "workspace");

  const store = new SqliteBindingStore(dbPath);
  await store.init();

  const fs = new NodeWorkspaceFs({
    gitUserName: "e2e",
    gitUserEmail: "e2e@local",
  });

  const larkHarness = makeE2eLark();
  const backend = makeFakeBackend(opts.script ?? (() => [])) as ReturnType<typeof makeFakeBackend> & {
    setScript(next: (input: RunInput) => AgentEvent[]): void;
  };
  const backendRegistry: BackendRegistry = {
    get: () => backend,
    cancel: async (sid) => { await backend.cancel(sid as SessionId); },
  };

  let tick = 0;
  const clock: Clock = {
    now: () => asTimestamp(Date.UTC(2026, 3, 11, 0, 0, 0) + tick++ * 1000),
  };

  let seq = 0;
  const genSessId = () => "sess_" + String(++seq).padStart(3, "0");

  const resolveUserGroupSession = async (groupId: LarkGroupId) => {
    const b = await store.findByGroup(groupId);
    if (!b) return null;
    const s = await store.findSessionById(b.sessionId);
    return s ? { name: s.name, id: s.id } : null;
  };

  const lifecycle = createSessionLifecycle({
    store,
    fs,
    lark: larkHarness.gateway,
    clock,
    workspaceRoot: asAbsolutePath(workspaceRoot),
    catalogPath: asAbsolutePath(path.join(workspaceRoot, "session-catalog.json")),
    principlesTemplatesDir: asAbsolutePath(
      path.join(workspaceRoot, "first-principle", "templates"),
    ),
    claudeMdTemplatePath: asAbsolutePath(path.resolve("templates/claude-md-base.md")),
    agentsMdTemplatePath: asAbsolutePath(path.resolve("templates/agents-md-base.md")),
    gitignorePath: asAbsolutePath(path.resolve("templates/gitignore.default")),
    ownerUserId: "u_owner",
    idFactory: genSessId,
    cancelBackend: async (sessionId) => {
      await backendRegistry.cancel(sessionId as SessionId);
    },
  });

  const replier = createReplier({
    lark: larkHarness.gateway,
    clock,
    monotonic: () => tick * 1000,
    reminderSchedule: [],
    idFactory: () => "mr_" + Math.random().toString(36).slice(2, 8),
  });

  const registry = buildCommandRegistry();
  registry.help.handler = createHelpHandler(registry);
  registry.list.handler = createListHandler({ store, clock });
  registry.status.handler = createStatusHandler({ store, clock, resolveUserGroupSession });
  registry.log.handler = createLogHandler({ store, resolveUserGroupSession });
  registry.new.handler = createNewHandler({ lifecycle });
  registry.delete.handler = createDeleteHandler({ lifecycle, resolveUserGroupSession });
  let clearPendingNextForCancel = (_sessionId: string) => 0;
  registry.cancel.handler = createCancelHandler({
    store,
    cancel: async (sid) => { await backendRegistry.cancel(sid as SessionId); },
    clearPendingNext: (sessionId) => clearPendingNextForCancel(sessionId),
    resolveUserGroupSession,
  });
  registry.reset.handler = createResetHandler({ lifecycle, resolveUserGroupSession });
  registry.restart.handler = createRestartHandler({ lifecycle, resolveUserGroupSession });

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
  registry.next.handler = createNextHandler({
    store,
    resolveUserGroupSession,
    enqueuePendingNext,
  });

  const router = createCommandRouter(registry);
  const rootGroupId = asLarkGroupId("g_root");
  const dispatcher = createDispatcher({
    store,
    lark: larkHarness.gateway,
    router,
    backend: backendRegistry,
    replier,
    rootGroupId,
    clock,
    idFactory: () => asMessageRunId("mr_" + Math.random().toString(36).slice(2, 8)),
    pendingNext: {
      has: hasPendingNext,
      shift: shiftPendingNext,
      restoreFront: restorePendingNextFront,
    },
  });

  await larkHarness.gateway.start(async (msg) => {
    await dispatcher.handleInbound(msg);
  });

  return {
    store,
    lark: larkHarness,
    emitInbound: larkHarness.emitInbound,
    setScript: (next) => backend.setScript(next),
    rootGroupId,
    async cleanup() {
      await larkHarness.gateway.stop();
      await store.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
