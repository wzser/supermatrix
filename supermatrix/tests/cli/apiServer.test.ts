import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { startApiServer, type ApiDeps } from "../../src/cli/apiServer.ts";
import type { SpawnChildInput, SpawnChildResult } from "../../src/app/childSession.ts";
import { asAbsolutePath, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { ChildSessionDefaults } from "../../src/ports/ChildSessionDefaults.ts";
import { resetCodexModelCatalogForTests } from "../../src/ports/CodexModelCatalog.ts";

function mkSession(overrides: Partial<Session> & Pick<Session, "id" | "name">): Session {
  return {
    alias: "",
    avatar: "",
    category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/" + overrides.name),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "idle",
    parentId: null,
    depth: 0,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: null,
    triggerKind: null,
    postIdentity: null,
    callerInvocation: null,
    continuationHook: null,
    capabilityPayload: null,
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
    ...overrides,
  };
}

function validSpawnPredicate(token = "comm_test_predicate_12345678") {
  return {
    type: "inbox-message",
    session_name: "target",
    field: "prompt",
    contains_all: [token],
  };
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
  if (lastError) throw lastError;
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

type PatchState = {
  patchCount24h: number;
  spawnPredicate: {
    spawnCommId: string;
    fromSessionId: Session["id"];
    ownerSessionId: Session["id"];
    version: number;
  };
  runningRunId: string | null;
  childDefaults: ChildSessionDefaults;
  predicatePatches: unknown[];
  kimiBusyCount: number;
  accountSwitches: Map<string, {
    clientRequestId: string;
    backend: string;
    caller: string;
    fromProfile: string | null;
    toProfile: string | null;
    switchedAt: string | null;
    clearedSessions: number;
    clearedBranches: number;
    createdAt: number;
  }>;
  clearCalls: Array<{ backend: string; now: number }>;
  existingComms: Array<{
    id: string;
    status: "pending" | "completed" | "failed";
    childSessionId: string | null;
    createdAt: number;
    clientRequestId: string;
  }>;
};

type TestDeps = ApiDeps & {
  captured: {
    spawnInputs: SpawnChildInput[];
    watcherExceptions: unknown[];
    asyncItems: unknown[];
    closureRoutes: Array<{ ref: string; commId: string; callerSession: string; targetSession: string }>;
    resultSinkAttempts: unknown[];
    syncDeliveredClosures: Array<{ commId: string; reason: string }>;
    larkTexts: Array<{ chatId: string; text: string }>;
    loggerInfos: Array<{ message: string; fields?: Record<string, unknown> }>;
    loggerWarns: Array<{ message: string; fields?: Record<string, unknown> }>;
  };
  state: PatchState;
  sendLarkText(input: { chatId: string; text: string }): Promise<{ messageId: string }>;
};

function makeDeps(): TestDeps {
  const captured = {
    spawnInputs: [] as SpawnChildInput[],
    watcherExceptions: [] as unknown[],
    asyncItems: [] as unknown[],
    closureRoutes: [] as Array<{ ref: string; commId: string; callerSession: string; targetSession: string }>,
    resultSinkAttempts: [] as unknown[],
    syncDeliveredClosures: [] as Array<{ commId: string; reason: string }>,
    larkTexts: [] as Array<{ chatId: string; text: string }>,
    loggerInfos: [] as Array<{ message: string; fields?: Record<string, unknown> }>,
    loggerWarns: [] as Array<{ message: string; fields?: Record<string, unknown> }>,
  };
  const state = {
    patchCount24h: 0,
    spawnPredicate: {
      spawnCommId: "comm_patch_1712345678",
      fromSessionId: asSessionId("sess_caller"),
      ownerSessionId: asSessionId("sess_caller"),
      version: 1,
    },
    runningRunId: null,
    childDefaults: {
      backend: { configured: false, value: null },
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
      updatedAt: null,
    },
    predicatePatches: [] as unknown[],
    kimiBusyCount: 0,
    accountSwitches: new Map<string, {
      clientRequestId: string;
      backend: string;
      caller: string;
      fromProfile: string | null;
      toProfile: string | null;
      switchedAt: string | null;
      clearedSessions: number;
      clearedBranches: number;
      createdAt: number;
    }>(),
    clearCalls: [] as Array<{ backend: string; now: number }>,
    existingComms: [] as Array<{
      id: string;
      status: "pending" | "completed" | "failed";
      childSessionId: string | null;
      createdAt: number;
      clientRequestId: string;
    }>,
  };
  return {
    captured,
    store: {
      async findSessionByName(name: string) {
        if (name === "target") {
          return mkSession({
            id: asSessionId("sess_target"),
            name: "target",
            model: "claude-opus-4-7",
          });
        }
        if (name === "caller") {
          return mkSession({
            id: asSessionId("sess_caller"),
            name: "caller",
          });
        }
        if (name === "first-principle") {
          return mkSession({
            id: asSessionId("sess_first_principle"),
            name: "first-principle",
          });
        }
        if (name === "supermatrix-root") {
          return mkSession({
            id: asSessionId("sess_supermatrix_root"),
            name: "supermatrix-root",
          });
        }
        if (name === "codexroot") {
          return mkSession({
            id: asSessionId("sess_codexroot"),
            name: "codexroot",
          });
        }
        if (name === "socail-king") {
          return mkSession({
            id: asSessionId("sess_socail_king"),
            name: "socail-king",
          });
        }
        if (name === "sk-watcher") {
          return mkSession({
            id: asSessionId("sess_sk_watcher"),
            name: "sk-watcher",
            backend: "kimi",
          });
        }
        if (name === "kimi-k3-target") {
          return mkSession({
            id: asSessionId("sess_kimi_k3_target"),
            name: "kimi-k3-target",
            backend: "kimi",
            model: "kimi-code/k3",
          });
        }
        return null;
      },
      async findSessionById() {
        return null;
      },
      async findLatestMessageRunBySession() {
        return null;
      },
      async findRunningMessageRunBySession(sessionId: Session["id"]) {
        if (sessionId !== asSessionId("sess_caller") || !state.runningRunId) return null;
        return {
          id: asMessageRunId(state.runningRunId),
          sessionId,
          groupId: "oc_test",
          prompt: "caller prompt",
          cardId: null,
          startedAt: asTimestamp(1),
          finishedAt: null,
          status: "running",
          finalMessage: null,
          errorMessage: null,
        };
      },
      async listActiveSessions() {
        return [];
      },
      async countBusySessions() {
        return 0;
      },
      async getSchedulerTokenUsage() {
        return [];
      },
      async countBusySessionsByBackend() {
        return state.kimiBusyCount;
      },
      async clearBackendSessionIdsForBackend(backend: string, now: number) {
        state.clearCalls.push({ backend, now });
        return { sessions: 3, branches: 2 };
      },
      async findBackendAccountSwitch(clientRequestId: string) {
        return state.accountSwitches.get(clientRequestId) ?? null;
      },
      async recordBackendAccountSwitch(input: {
        clientRequestId: string;
        backend: string;
        caller: string;
        fromProfile?: string | null;
        toProfile?: string | null;
        switchedAt?: string | null;
        clearedSessions: number;
        clearedBranches: number;
        createdAt: number;
      }) {
        state.accountSwitches.set(input.clientRequestId, {
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
      async acquireBackendMaintenanceLease() {
        throw new Error("acquireBackendMaintenanceLease should not be called from these tests");
      },
      async releaseBackendMaintenanceLease() {
        throw new Error("releaseBackendMaintenanceLease should not be called from these tests");
      },
      async getBackendMaintenanceLease() {
        throw new Error("getBackendMaintenanceLease should not be called from these tests");
      },
      async getChildSessionDefaults() {
        return structuredClone(state.childDefaults);
      },
      async findBySession() {
        return null;
      },
      async getSpawnPredicate(spawnCommId: string) {
        if (spawnCommId !== state.spawnPredicate.spawnCommId) return null;
        return {
          ...state.spawnPredicate,
          createdBySessionId: asSessionId("sess_caller"),
          lastPatchedBySessionId: null,
          toSessionId: asSessionId("sess_target"),
          predicate: {
            type: "inbox-message",
            session_name: "target",
            field: "final_message",
            contains_all: ["existing", "comm_patch_1712345678"],
            expected_window_sec: 600,
            evaluation_timeout_ms: 10000,
            retry_on_transient_fail: 2,
            since: { kind: "spawn_created_at" },
            min_count: 1,
          },
          predicateJson: "{}",
          predicateHash: "sha256:old",
          status: "active",
          createdAt: asTimestamp(1),
          updatedAt: asTimestamp(1),
        };
      },
      async getWatcherState() {
        return {
          spawnCommId: state.spawnPredicate.spawnCommId,
          lastRunAt: null,
          lastRunResult: null,
          lastRunError: null,
          lastRunDurationMs: null,
          consecutiveFalseCount: 0,
          consecutiveTransientFailCount: 0,
          patchCount24h: state.patchCount24h,
          transactionStartedAt: null,
          lastTriggerSignal: null,
          nextEligibleAt: null,
          closedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          createdAt: asTimestamp(1),
          updatedAt: asTimestamp(1),
        };
      },
      async patchSpawnPredicate(input: unknown) {
        state.predicatePatches.push(input);
        const nextVersion = state.spawnPredicate.version + state.predicatePatches.length;
        return {
          ...state.spawnPredicate,
          createdBySessionId: asSessionId("sess_caller"),
          lastPatchedBySessionId: asSessionId("sess_caller"),
          toSessionId: asSessionId("sess_target"),
          predicate: {
            type: "inbox-message",
            session_name: "target",
            field: "final_message",
            contains_all: ["patched", "comm_patch_1712345678"],
            expected_window_sec: 600,
            evaluation_timeout_ms: 10000,
            retry_on_transient_fail: 2,
            since: { kind: "spawn_created_at" },
            min_count: 1,
          },
          predicateJson: "{}",
          predicateHash: "sha256:new",
          status: "active",
          createdAt: asTimestamp(1),
          updatedAt: asTimestamp(2),
          version: nextVersion,
        };
      },
      async getSpawnAsyncItem() {
        return null;
      },
      async getSpawnAsyncItemByComm() {
        return null;
      },
      async closeSpawnAsyncItemConsumed() {
        return false;
      },
      async closeSpawnAsyncItemSyncDelivered(commId: string, reason: string) {
        captured.syncDeliveredClosures.push({ commId, reason });
        return 0;
      },
      async recordWatcherException(input: unknown) {
        captured.watcherExceptions.push(input);
      },
      async registerSpawnAsyncItem(input: unknown) {
        captured.asyncItems.push(input);
      },
      async recordResultSinkAttempt(input: unknown) {
        captured.resultSinkAttempts.push(input);
      },
      async findCrossSessionCommForDedup(clientRequestId: string) {
        const match = [...state.existingComms]
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
    },
    childSession: {
      async spawnChild(input: SpawnChildInput) {
        captured.spawnInputs.push(input);
        // Invoke onSessionReady so async modes resolve the 202 promise.
        if (input.onSessionReady) {
          await input.onSessionReady({
            session: {
              id: asSessionId("sess_child_xx"),
              name: "child_xx",
            } as unknown as Parameters<NonNullable<SpawnChildInput["onSessionReady"]>>[0]["session"],
            messageRunId: "run_xx" as unknown as Parameters<NonNullable<SpawnChildInput["onSessionReady"]>>[0]["messageRunId"],
            spawnCommId: "comm_child_xx_12345678",
          });
        }
        return {
          session: mkSession({
            id: asSessionId("sess_child_xx"),
            name: "child_xx",
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          finalMessage: "done",
          backendSessionId: null,
          messageRunId: asMessageRunId("mr_child_xx"),
          spawnCommId: "comm_child_xx_12345678",
        };
      },
    },
    async routeSpawnClosureItem(input: { ref: string; commId: string; callerSession: string; targetSession: string }) {
      captured.closureRoutes.push(input);
    },
    runOnSession: async () => {
      throw new Error("runOnSession should not be called from /api/spawn tests");
    },
    notifier: {
      async notify() {
        throw new Error("notifier should not be called");
      },
    },
    async sendLarkText(input: { chatId: string; text: string }) {
      captured.larkTexts.push(input);
      return { messageId: "om_notify_123" };
    },
    logger: {
      debug() {},
      info(message: string, fields?: Record<string, unknown>) {
        captured.loggerInfos.push(fields === undefined ? { message } : { message, fields });
      },
      warn(message: string, fields?: Record<string, unknown>) {
        captured.loggerWarns.push(fields === undefined ? { message } : { message, fields });
      },
      error() {},
      child() {
        return this;
      },
    } as unknown as ApiDeps["logger"],
    state,
  } as TestDeps;
}

describe("apiServer GET /api/health/lark-ws", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;

  beforeEach(async () => {
    deps = makeDeps();
    deps.larkWsHealth = async () => ({
      status: "ok",
      ingress: "node-sdk-ws",
      state: "connected",
      startedAt: 1_754_355_200_000,
      stateSince: 1_754_355_201_000,
      lastConnectTime: 1_754_355_201_000,
      reconnectAttempts: 0,
    });
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("returns the real in-process SDK WS snapshot rather than process health", async () => {
    const res = await fetch(`${baseUrl}/api/health/lark-ws`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      ingress: "node-sdk-ws",
      state: "connected",
      startedAt: 1_754_355_200_000,
      stateSince: 1_754_355_201_000,
      lastConnectTime: 1_754_355_201_000,
      reconnectAttempts: 0,
    });
  });

  test("keeps a bounded SDK reconnect grace machine-readable and non-failing", async () => {
    deps.larkWsHealth = async () => ({
      status: "grace",
      ingress: "node-sdk-ws",
      state: "reconnecting",
      startedAt: 1_754_355_200_000,
      stateSince: 1_754_355_230_000,
      graceUntil: 1_754_355_320_000,
      lastConnectTime: 1_754_355_230_000,
      nextConnectTime: 1_754_355_240_000,
      reconnectAttempts: 1,
    });

    const res = await fetch(`${baseUrl}/api/health/lark-ws`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "grace",
      state: "reconnecting",
      graceUntil: 1_754_355_320_000,
      reconnectAttempts: 1,
    });
  });

  test("returns a machine-readable failure for a terminal SDK WS state", async () => {
    deps.larkWsHealth = async () => ({
      status: "degraded",
      ingress: "node-sdk-ws",
      state: "failed",
      startedAt: 1_754_355_200_000,
      stateSince: 1_754_355_203_000,
      reconnectAttempts: 3,
      lastError: "WebSocket reconnect exhausted",
    });

    const res = await fetch(`${baseUrl}/api/health/lark-ws`);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      status: "degraded",
      ingress: "node-sdk-ws",
      state: "failed",
      startedAt: 1_754_355_200_000,
      stateSince: 1_754_355_203_000,
      reconnectAttempts: 3,
      lastError: "WebSocket reconnect exhausted",
    });
  });
});

describe("apiServer GET /api/health/kimi-acp", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;

  beforeEach(async () => {
    const deps = makeDeps();
    (deps as ApiDeps & {
      kimiAcpHealth?: () => Promise<unknown>;
    }).kimiAcpHealth = async () => ({
      pid: 424242,
      state: "ready",
      roundtrip: { ok: true, rttMs: 7 },
    });
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("returns the injected shared Kimi ACP roundtrip instead of main-port liveness", async () => {
    const res = await fetch(`${baseUrl}/api/health/kimi-acp`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      backend: "kimi",
      pid: 424242,
      state: "ready",
      roundtrip: { ok: true, rttMs: 7 },
    });
  });
});

describe("apiServer GET /api/scheduler-token-usage", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;
  let calls: Array<{ from: number; to: number }>;

  const tasks = [
    {
      taskId: "alpha",
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      totalTokens: 20,
      runCount: 2,
    },
    {
      taskId: "beta",
      inputTokens: 8,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 1,
      reasoningTokens: 0,
      totalTokens: 14,
      runCount: 1,
    },
  ];

  beforeEach(async () => {
    deps = makeDeps();
    calls = [];
    Object.assign(deps.store, {
      async getSchedulerTokenUsage(from: number, to: number) {
        calls.push({ from, to });
        return tasks;
      },
    });
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("returns scheduler task usage and response totals for a valid half-open window", async () => {
    const res = await fetch(`${baseUrl}/api/scheduler-token-usage?from=0&to=1`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      from: 0,
      to: 1,
      tasks,
      totals: {
        inputTokens: 18,
        outputTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 3,
        reasoningTokens: 1,
        totalTokens: 34,
        runCount: 3,
      },
    });
    expect(calls).toEqual([{ from: 0, to: 1 }]);
  });

  test.each([
    ["missing from", "?to=1"],
    ["negative from", "?from=-1&to=1"],
    ["fractional from", "?from=0.5&to=1"],
    ["non-numeric to", "?from=0&to=one"],
    ["equal bounds", "?from=1&to=1"],
    ["reversed bounds", "?from=2&to=1"],
  ])("returns 400 for %s", async (_label, query) => {
    const res = await fetch(`${baseUrl}/api/scheduler-token-usage${query}`);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe("apiServer POST /api/backends/kimi/account-switched", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;
  let recycleCalls: number;

  const postSwitch = (body: unknown) =>
    fetch(`${baseUrl}/api/backends/kimi/account-switched`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    deps = makeDeps();
    recycleCalls = 0;
    (deps as ApiDeps).recycleKimiAcp = async () => {
      recycleCalls += 1;
      return { pid: 515151, state: "ready", roundtrip: { ok: true, rttMs: 3 } };
    };
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("first call clears both tables, records the switch, and recycles ACP", async () => {
    const res = await postSwitch({
      from: "sm-switch",
      client_request_id: "2026-07-31:sm-switch:kimi:work-to-personal",
      from_profile: "work",
      to_profile: "personal",
      switched_at: "2026-07-31T09:00:00Z",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      clearedSessions: 3,
      clearedBranches: 2,
      acp: { recycled: true, roundtrip: { ok: true, rttMs: 3 } },
    });
    expect(deps.state.clearCalls).toHaveLength(1);
    expect(deps.state.clearCalls[0]!.backend).toBe("kimi");
    expect(recycleCalls).toBe(1);
    expect(deps.state.accountSwitches.get("2026-07-31:sm-switch:kimi:work-to-personal")).toMatchObject({
      backend: "kimi",
      caller: "sm-switch",
      fromProfile: "work",
      toProfile: "personal",
      switchedAt: "2026-07-31T09:00:00Z",
      clearedSessions: 3,
      clearedBranches: 2,
    });
  });

  test("same client_request_id replays as duplicate without re-clearing", async () => {
    const body = { from: "sm-switch", client_request_id: "req-dup-1" };
    await postSwitch(body);

    const res = await postSwitch(body);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      duplicate: true,
      clearedSessions: 3,
      clearedBranches: 2,
      acp: { recycled: true, roundtrip: { ok: true, rttMs: 3 } },
    });
    // Clearing ran once; recycle still ran again so a lost first response can
    // observe the current ACP state.
    expect(deps.state.clearCalls).toHaveLength(1);
    expect(recycleCalls).toBe(2);
  });

  test("busy kimi runs get 409 without consuming the idempotency key", async () => {
    deps.state.kimiBusyCount = 2;
    const body = { from: "sm-switch", client_request_id: "req-busy-1" };

    const busyRes = await postSwitch(body);

    expect(busyRes.status).toBe(409);
    await expect(busyRes.json()).resolves.toEqual({
      ok: false,
      error: "kimi_runs_in_flight",
      busyRuns: 2,
    });
    expect(deps.state.clearCalls).toHaveLength(0);
    expect(deps.state.accountSwitches.has("req-busy-1")).toBe(false);

    // Once the runs drain, the SAME key succeeds as a fresh (non-duplicate) call.
    deps.state.kimiBusyCount = 0;
    const okRes = await postSwitch(body);
    expect(okRes.status).toBe(200);
    await expect(okRes.json()).resolves.toMatchObject({ ok: true, duplicate: false });
  });

  test("extra top-level fields are rejected with 400", async () => {
    const res = await postSwitch({
      from: "sm-switch",
      client_request_id: "req-strict-1",
      token: "sneaky",
    });

    expect(res.status).toBe(400);
    expect(deps.state.clearCalls).toHaveLength(0);
  });

  test("missing recycleKimiAcp dep still clears and reports not_configured", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const bareDeps = makeDeps();
    server = await startApiServer(bareDeps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await postSwitch({ from: "sm-switch", client_request_id: "req-nodep-1" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      clearedSessions: 3,
      clearedBranches: 2,
      acp: { recycled: false, reason: "not_configured" },
    });
    expect(bareDeps.state.clearCalls).toHaveLength(1);
  });

  test("recycle failure is reported inside a 200, not as a 500", async () => {
    (deps as ApiDeps).recycleKimiAcp = async () => {
      throw new Error("acp process exploded");
    };

    const res = await postSwitch({ from: "sm-switch", client_request_id: "req-recycle-fail" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      clearedSessions: 3,
      clearedBranches: 2,
      acp: { recycled: true, roundtrip: { ok: false, error: "acp process exploded" } },
    });
  });
});

describe("apiServer POST /api/spawn", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;
  let previousPatchToken: string | undefined;
  let previousLegacySpawnDisabled: string | undefined;

  beforeEach(async () => {
    previousPatchToken = process.env.SM_PREDICATE_PATCH_TOKEN;
    previousLegacySpawnDisabled = process.env.SM_DISABLE_LEGACY_SPAWN;
    process.env.SM_PREDICATE_PATCH_TOKEN = "test-predicate-token";
    process.env.SM_DISABLE_LEGACY_SPAWN = "0";
    resetCodexModelCatalogForTests([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
    ]);
    deps = makeDeps();
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousPatchToken === undefined) {
      delete process.env.SM_PREDICATE_PATCH_TOKEN;
    } else {
      process.env.SM_PREDICATE_PATCH_TOKEN = previousPatchToken;
    }
    if (previousLegacySpawnDisabled === undefined) {
      delete process.env.SM_DISABLE_LEGACY_SPAWN;
    } else {
      process.env.SM_DISABLE_LEGACY_SPAWN = previousLegacySpawnDisabled;
    }
    resetCodexModelCatalogForTests();
  });

  test("rejects caller-supplied mode before spawning", async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "target",
        from: "caller",
        prompt: "hello",
        mode: "async_kickoff",
        verification_predicate: validSpawnPredicate("comm_mode_ignore_12345678"),
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body).toMatchObject({
      ok: false,
      error: "mode is not supported in /api/spawn requests; omit it and let the framework choose async fallback",
    });
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("can disable the legacy spawn endpoint with an explicit env switch", async () => {
    const previous = process.env.SM_DISABLE_LEGACY_SPAWN;
    process.env.SM_DISABLE_LEGACY_SPAWN = "1";
    try {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_legacy_disabled_12345678"),
        }),
      });
      expect(res.status).toBe(410);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body).toMatchObject({
        ok: false,
        error: "legacy /api/spawn is disabled; use POST /api/spawn2.0 with from, target, prompt, client_request_id, and closure",
      });
      expect(deps.captured.spawnInputs).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env.SM_DISABLE_LEGACY_SPAWN;
      } else {
        process.env.SM_DISABLE_LEGACY_SPAWN = previous;
      }
    }
  });

  test("honors framework-internal async flag for supermatrix-root callers", async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "target",
        from: "supermatrix-root",
        prompt: "hello",
        supermatrix_internal: { caller_invocation: "async_kickoff" },
        verification_predicate: validSpawnPredicate("comm_internal_mode_12345678"),
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; mode?: string; childSessionId?: string };
    expect(body).toMatchObject({ ok: true, mode: "async_kickoff", childSessionId: "sess_child_xx" });
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]!.callerInvocation).toBe("async_kickoff");
    expect(deps.captured.spawnInputs[0]!.resultSinks).toEqual([{ kind: "pollable_endpoint" }]);
  });

  test("warns on missing from but still runs the anonymous sync spawn", async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "target",
        prompt: "hello",
        verification_predicate: validSpawnPredicate("comm_missing_from_strict_12345678"),
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]!.requestedBy).toBeUndefined();
    expect(deps.captured.loggerWarns).toContainEqual(
      expect.objectContaining({
        message: "api spawn missing from",
        fields: expect.objectContaining({
          kind: "missing from",
          target: "target",
          promptLength: 5,
          hasVerificationPredicate: true,
        }),
      }),
    );
  });

  describe("delivery_address", () => {
    test("defaults old callers to the HTTP response delivery address and logs it", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_delivery_default_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.resultSinks).toEqual([{ kind: "http_response" }]);
      expect(deps.captured.loggerInfos).toContainEqual(
        expect.objectContaining({
          message: "api spawn delivery address resolved",
          fields: expect.objectContaining({
            target: "target",
            from: "caller",
            delivery_address_kinds: ["http_response"],
          }),
        }),
      );
    });

    test("accepts an explicit chat delivery address", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          delivery_address: { kind: "chat", chatId: "oc_delivery_123", identity: "bot" },
          verification_predicate: validSpawnPredicate("comm_delivery_chat_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.resultSinks).toEqual([
        { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_delivery_123" }, identity: "bot" },
      ]);
    });

    test("accepts an explicit session delivery address after resolving the session name", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          delivery_address: { kind: "session", sessionName: "caller" },
          verification_predicate: validSpawnPredicate("comm_delivery_session_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.resultSinks).toEqual([
        { kind: "parent_continuation_inject", parentSessionId: "sess_caller" },
      ]);
    });

    test("accepts an explicit topic delivery address", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          delivery_address: { kind: "topic", topic: "spawn.delivery.done" },
          verification_predicate: validSpawnPredicate("comm_delivery_topic_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.resultSinks).toEqual([
        { kind: "eventbus_publish", topic: "spawn.delivery.done" },
      ]);
    });

    test("rejects an explicit session delivery address that cannot be resolved", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          delivery_address: { kind: "session", sessionName: "missing-session" },
          verification_predicate: validSpawnPredicate("comm_delivery_bad_session_12345678"),
        }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toMatchObject({
        ok: false,
        error: "delivery session not found: missing-session",
      });
      expect(deps.captured.spawnInputs).toHaveLength(0);
    });
  });

  test("ignores deprecated delivery_checks and logs a warning", async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "target",
        from: "caller",
        prompt: "hello",
        verification_predicate: validSpawnPredicate("comm_delivery_checks_bad_12345678"),
        delivery_checks: [{ kind: "db_row", table: "deliveries" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.loggerWarns).toContainEqual({
      message: "delivery_checks ignored",
      fields: expect.objectContaining({
        target: "target",
        from: "caller",
        reason: "deprecated by courier delivery model",
      }),
    });
  });

  describe("closure verification", () => {
    test("sync_inline returns closure=verified when the first child result passes", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_verified_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; closure?: string; finalMessage?: string };
      expect(body.ok).toBe(true);
      expect(body.closure).toBe("verified");
      expect(body.finalMessage).toBe("done");
      expect(deps.captured.spawnInputs).toHaveLength(1);
    });

    test("sync_inline retries once when the first child output is empty and the retry passes", async () => {
      const outcomes = ["", "done"];
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        const finalMessage = outcomes.shift() ?? "";
        return {
          session: mkSession({
            id: asSessionId(`sess_child_${deps.captured.spawnInputs.length}`),
            name: `child_${deps.captured.spawnInputs.length}`,
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          finalMessage,
          backendSessionId: null,
          messageRunId: asMessageRunId(`mr_child_${deps.captured.spawnInputs.length}`),
          spawnCommId: `comm_retry_${deps.captured.spawnInputs.length}`,
        };
      };

      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_retry_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; closure?: string; finalMessage?: string };
      expect(body.ok).toBe(true);
      expect(body.closure).toBe("verified");
      expect(body.finalMessage).toBe("done");
      expect(deps.captured.spawnInputs).toHaveLength(2);
    });

    test("sync_inline switches to async when the retry still fails with a comm_id", async () => {
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        const n = deps.captured.spawnInputs.length;
        return {
          session: mkSession({
            id: asSessionId(`sess_child_empty_${n}`),
            name: `child_empty_${n}`,
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          finalMessage: "",
          backendSessionId: null,
          messageRunId: asMessageRunId(`mr_child_empty_${n}`),
          spawnCommId: `comm_empty_${n}`,
        };
      };

      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_async_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status?: string; ref?: string };
      expect(body).toMatchObject({ ok: false, status: "switched_async" });
      expect(body.ref).toMatch(/^async_/);
      expect(deps.captured.spawnInputs).toHaveLength(2);
      expect(deps.captured.asyncItems).toHaveLength(1);
      expect(deps.captured.asyncItems[0]).toMatchObject({
        commId: "comm_empty_2",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "execution",
        failureKind: "empty_output",
      });
    });

    test("sync_inline logs closure events by comm_id when first failure retries then switches async", async () => {
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        const n = deps.captured.spawnInputs.length;
        return {
          session: mkSession({
            id: asSessionId(`sess_child_logged_${n}`),
            name: `child_logged_${n}`,
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          finalMessage: "",
          backendSessionId: null,
          messageRunId: asMessageRunId(`mr_child_logged_${n}`),
          spawnCommId: `comm_logged_${n}`,
        };
      };

      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_logged_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status?: string; ref?: string };
      expect(body).toMatchObject({ ok: false, status: "switched_async" });

      const closureRows = [...deps.captured.loggerInfos, ...deps.captured.loggerWarns]
        .filter((row) => row.message === "spawn closure")
        .filter((row) => row.fields?.comm_id === "comm_logged_2")
        .map((row) => row.fields);

      expect(closureRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ closure_event: "admission_validation", result: "accepted", delivery_address_kinds: ["http_response"] }),
          expect.objectContaining({ closure_event: "sync_retry", action: "triggered" }),
          expect.objectContaining({ closure_event: "sync_retry", action: "result", result: "failed" }),
          expect.objectContaining({ closure_event: "phase_check", attempt: "retry", phase: "communication" }),
          expect.objectContaining({ closure_event: "phase_check", attempt: "retry", phase: "execution" }),
          expect.objectContaining({ closure_event: "phase_check", attempt: "retry", phase: "delivery" }),
          expect.objectContaining({
            closure_event: "async_switch",
            decision: "registered",
            failed_phase: "execution",
            failure_kind: "empty_output",
            next_status: "pending",
          }),
          expect.objectContaining({
            closure_event: "state_transition",
            to_status: "pending",
          }),
        ]),
      );
    });

    test("sync_inline timeout switches async without retry when comm_id exists", async () => {
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        await input.onSessionReady?.({
          session: mkSession({
            id: asSessionId("sess_child_timeout"),
            name: "child_timeout",
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          messageRunId: asMessageRunId("mr_timeout"),
          spawnCommId: "comm_timeout_1",
        });
        throw new Error("child session child_timeout timed out after 60s");
      };

      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_timeout_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status?: string };
      expect(body).toMatchObject({ ok: false, status: "switched_async" });
      expect(deps.captured.spawnInputs).toHaveLength(1);
      expect(deps.captured.asyncItems[0]).toMatchObject({
        commId: "comm_timeout_1",
        failedPhase: "execution",
        failureKind: "run_timeout",
        status: "waiting_child",
      });
      expect(body).toMatchObject({
        status: "switched_async",
        message: expect.stringContaining("已转异步结果待取"),
      });
    });

    test("sync_inline response deadline switches to async before the caller headers timeout", async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      deps = makeDeps();
      deps.syncSpawnResponseTimeoutMs = 20;
      server = await startApiServer(deps, 0);
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;

      let resolveSpawn!: () => void;
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        await input.onSessionReady?.({
          session: mkSession({
            id: asSessionId("sess_child_response_timeout"),
            name: "child_response_timeout",
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          messageRunId: asMessageRunId("mr_response_timeout"),
          spawnCommId: "comm_response_timeout_1",
        });
        await new Promise<void>((resolve) => {
          resolveSpawn = resolve;
        });
        return {
          session: mkSession({
            id: asSessionId("sess_child_response_timeout"),
            name: "child_response_timeout",
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          finalMessage: "late done",
          backendSessionId: null,
          messageRunId: asMessageRunId("mr_response_timeout"),
          spawnCommId: "comm_response_timeout_1",
        };
      };

      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "long child",
          verification_predicate: validSpawnPredicate("comm_response_timeout_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status?: string; spawnCommId?: string; ref?: string };
      expect(body).toMatchObject({
        ok: false,
        status: "switched_async",
        spawnCommId: "comm_response_timeout_1",
      });
      expect(deps.captured.spawnInputs).toHaveLength(1);
      expect(deps.captured.asyncItems[0]).toMatchObject({
        commId: "comm_response_timeout_1",
        failedPhase: "execution",
        failureKind: "run_timeout",
        status: "waiting_child",
      });
      resolveSpawn();
      await eventually(() => {
        expect(deps.captured.closureRoutes).toEqual([
          {
            ref: body.ref,
            commId: "comm_response_timeout_1",
            callerSession: "caller",
            targetSession: "target",
          },
        ]);
      });
    });

    test("sync_inline returns queued receipt without retrying closure checks", async () => {
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        return {
          status: "queued",
          ref: "spawnq_api_1",
          commId: "comm_queue_1",
          spawnCommId: "comm_queue_1",
          parentId: asSessionId("sess_target"),
          queuedAt: asTimestamp(1234),
          ttlSec: 86_400,
        } as unknown as SpawnChildResult;
      };

      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_queued_12345678"),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status?: string; ref?: string; comm_id?: string; spawnCommId?: string };
      expect(body).toMatchObject({
        ok: true,
        status: "queued",
        ref: "spawnq_api_1",
        comm_id: "comm_queue_1",
        spawnCommId: "comm_queue_1",
      });
      expect(deps.captured.spawnInputs).toHaveLength(1);
      expect(deps.captured.asyncItems).toHaveLength(0);
      const closureRows = [...deps.captured.loggerInfos, ...deps.captured.loggerWarns]
        .filter((row) => row.message === "spawn closure");
      expect(closureRows).toHaveLength(0);
    });

    test("sync_inline caller disconnect switches the running child to async late_result without retry", async () => {
      let resolveReady!: () => void;
      let releaseChild!: (result: SpawnChildResult) => void;
      const childReady = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const childResult = new Promise<SpawnChildResult>((resolve) => {
        releaseChild = resolve;
      });

      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        await input.onSessionReady?.({
          session: mkSession({
            id: asSessionId("sess_child_disconnect"),
            name: "child_disconnect",
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          messageRunId: asMessageRunId("mr_disconnect"),
          spawnCommId: "comm_disconnect_1",
        });
        resolveReady();
        return childResult;
      };

      const controller = new AbortController();
      const request = fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_disconnect_12345678"),
        }),
      }).catch((err: unknown) => err);

      await childReady;
      controller.abort();

      await eventually(() => {
        expect(deps.captured.asyncItems).toHaveLength(1);
      });

      expect(deps.captured.asyncItems[0]).toMatchObject({
        commId: "comm_disconnect_1",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "delivery",
        failureKind: "late_result",
        status: "waiting_child",
      });
      expect(deps.captured.spawnInputs).toHaveLength(1);

      releaseChild({
        session: mkSession({
          id: asSessionId("sess_child_disconnect"),
          name: "child_disconnect",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        finalMessage: "done after disconnect",
        backendSessionId: null,
        messageRunId: asMessageRunId("mr_disconnect"),
        spawnCommId: "comm_disconnect_1",
      });

      const aborted = await request;
      expect(aborted).toBeInstanceOf(Error);
      expect((aborted as Error).name).toBe("AbortError");
    });

    test("sync_inline caller disconnect uses final result comm_id when ready callback had none", async () => {
      let resolveReady!: () => void;
      let releaseChild!: (result: SpawnChildResult) => void;
      const childReady = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const childResult = new Promise<SpawnChildResult>((resolve) => {
        releaseChild = resolve;
      });
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        await input.onSessionReady?.({
          session: mkSession({
            id: asSessionId("sess_child_late_comm"),
            name: "child_late_comm",
            scope: "child",
            parentId: asSessionId("sess_target"),
            depth: 1,
          }),
          messageRunId: asMessageRunId("mr_late_comm"),
        });
        resolveReady();
        return childResult;
      };

      const controller = new AbortController();
      const request = fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_late_comm_12345678"),
        }),
      }).catch((err: unknown) => err);

      await childReady;
      controller.abort();
      const aborted = await request;
      expect(aborted).toBeInstanceOf(Error);
      expect((aborted as Error).name).toBe("AbortError");
      await new Promise((resolve) => setTimeout(resolve, 50));

      releaseChild({
        session: mkSession({
          id: asSessionId("sess_child_late_comm"),
          name: "child_late_comm",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        finalMessage: "done after disconnect",
        backendSessionId: null,
        messageRunId: asMessageRunId("mr_late_comm"),
        spawnCommId: "comm_late_comm_1",
      });

      await eventually(() => {
        expect(deps.captured.asyncItems).toHaveLength(1);
      });
      expect(deps.captured.asyncItems[0]).toMatchObject({
        commId: "comm_late_comm_1",
        callerSession: "caller",
        targetSession: "target",
        failedPhase: "delivery",
        failureKind: "late_result",
        status: "waiting_child",
      });
      expect(deps.captured.spawnInputs).toHaveLength(1);
    });

    test("spawn failure before comm_id returns a synchronous error and does not register async", async () => {
      deps.childSession.spawnChild = async (input: SpawnChildInput) => {
        deps.captured.spawnInputs.push(input);
        throw new Error("parent target already has 5 active children");
      };

      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_closure_spawnfail_12345678"),
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("parent target already has 5 active children");
      expect(deps.captured.spawnInputs).toHaveLength(1);
      expect(deps.captured.asyncItems).toHaveLength(0);
    });
  });

  describe("model selection", () => {
    test("inherits target session model when model is omitted and backend matches", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_model_inherit_12345678"),
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.model).toBe("claude-opus-4-7");
      expect(deps.captured.spawnInputs[0]).not.toHaveProperty("executionOverride");
    });

    test("resolves explicit model alias against selected backend", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          model: "sonnet",
          verification_predicate: validSpawnPredicate("comm_model_alias_12345678"),
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.model).toBe("claude-sonnet-5");
      expect(deps.captured.spawnInputs[0]!.executionOverride).toEqual({
        model: "claude-sonnet-5",
      });
    });

    test("default model override clears inherited model", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          model: "default",
          verification_predicate: validSpawnPredicate("comm_model_default_12345678"),
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.model).toBeNull();
      expect(deps.captured.spawnInputs[0]!.executionOverride).toEqual({ model: null });
    });

    test("backend override does not inherit incompatible parent model", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          backend: "codex",
          verification_predicate: validSpawnPredicate("comm_backend_codex_12345678"),
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.model).toBeNull();
      expect(deps.captured.spawnInputs[0]!.executionOverride).toEqual({ backend: "codex" });
    });

    test("rejects unknown codex model before spawning and lists available models", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          backend: "codex",
          model: "gpt-5.3",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('未知 codex 模型 "gpt-5.3"');
      expect(body.error).toContain(
        "gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini",
      );
      expect(deps.captured.spawnInputs).toHaveLength(0);
    });
  });

  describe("sinks field", () => {
    test("rejects caller-supplied mode before parsing caller-supplied sinks", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          mode: "async_kickoff",
          verification_predicate: validSpawnPredicate("comm_sinks_eventbus_12345678"),
          sinks: [
            { kind: "eventbus_publish", topic: "child.done.test" },
            { kind: "parent_continuation_inject", parentSessionName: "caller" },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body).toMatchObject({
        ok: false,
        error: "mode is not supported in /api/spawn requests; omit it and let the framework choose async fallback",
      });
      expect(deps.captured.spawnInputs).toHaveLength(0);
    });

    test("rejects caller-supplied mode even with chat_post sink", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          mode: "async_kickoff",
          verification_predicate: validSpawnPredicate("comm_sinks_chat_12345678"),
          sinks: [
            { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_abc" }, identity: "bot" },
          ],
        }),
      });
      expect(res.status).toBe(400);
      expect(deps.captured.spawnInputs).toHaveLength(0);
    });

    test("rejects sinks on sync_inline mode", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_sinks_sync_12345678"),
          sinks: [{ kind: "pollable_endpoint" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/sync_inline/);
      expect(deps.captured.spawnInputs).toHaveLength(0);
    });

    test("rejects http_response sink from sync caller", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_sinks_http_12345678"),
          sinks: [{ kind: "http_response" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/sync_inline/);
    });

    test("rejects unknown sink kind from sync caller", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_sinks_unknown_12345678"),
          sinks: [{ kind: "teleport_to_mars" }],
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects parent_continuation_inject from sync caller before resolving parent", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_sinks_parent_12345678"),
          sinks: [{ kind: "parent_continuation_inject", parentSessionName: "nobody" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/sync_inline/);
    });

    test("rejects eventbus_publish from sync caller", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_sinks_topic_12345678"),
          sinks: [{ kind: "eventbus_publish", topic: "" }],
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects empty sinks array from sync caller", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: validSpawnPredicate("comm_sinks_empty_12345678"),
          sinks: [],
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects caller-supplied mode even without sinks", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          mode: "async_kickoff",
          verification_predicate: validSpawnPredicate("comm_sinks_default_12345678"),
        }),
      });
      expect(res.status).toBe(400);
      expect(deps.captured.spawnInputs).toHaveLength(0);
    });
  });

  describe("verification_predicate rollback warn policy", () => {
    test("missing predicate accepts spawn and routes a predicate-bearing FP warning", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.parentId).toBe("sess_target");
      expect((deps.captured.spawnInputs[0]! as SpawnChildInput & { verificationPredicate?: unknown }).verificationPredicate).toBeUndefined();
      await eventually(() => {
        expect(deps.captured.spawnInputs.some((input) => input.parentId === "sess_first_principle")).toBe(true);
      });
      const warningSpawn = deps.captured.spawnInputs.find((input) => input.parentId === "sess_first_principle")!;
      expect(warningSpawn).toMatchObject({
        requestedBy: "sess_supermatrix_root",
        callerInvocation: "async_kickoff",
        triggerKind: "session",
        resultSinks: [{ kind: "pollable_endpoint" }],
        verificationPredicate: {
          predicate: {
            type: "inbox-message",
            session_name: "first-principle",
            field: "prompt",
            expected_window_sec: 600,
          },
        },
      });
      expect(warningSpawn.prompt).toContain("predicate-schema-warning");
      expect(warningSpawn.prompt).toContain("missing predicate");
      expect(warningSpawn.prompt).toContain("from: caller");
      const containsAll = warningSpawn.verificationPredicate?.predicate.type === "inbox-message"
        ? warningSpawn.verificationPredicate.predicate.contains_all
        : [];
      expect(containsAll).toContain("predicate-schema-warning");
      expect(containsAll?.some((token) => token.startsWith("predicate-warning-"))).toBe(true);
      expect(deps.captured.loggerWarns).toContainEqual(
        expect.objectContaining({
          message: "predicate-schema-warning",
          fields: expect.objectContaining({
            kind: "missing predicate",
            target: "target",
          }),
        }),
      );
    });

    test("invalid predicate accepts spawn and routes a predicate-bearing FP warning", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: {
            type: "inbox-message",
            session_name: "target",
            field: "prompt",
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs[0]!.parentId).toBe("sess_target");
      expect((deps.captured.spawnInputs[0]! as SpawnChildInput & { verificationPredicate?: unknown }).verificationPredicate).toBeUndefined();
      await eventually(() => {
        expect(deps.captured.spawnInputs.some((input) => input.parentId === "sess_first_principle")).toBe(true);
      });
      const warningSpawn = deps.captured.spawnInputs.find((input) => input.parentId === "sess_first_principle")!;
      expect(warningSpawn.prompt).toContain("invalid predicate");
      expect(warningSpawn.prompt).toContain("inbox-message must include contains_all, contains_any, or regex");
      expect(warningSpawn.verificationPredicate).toMatchObject({
        predicate: {
          type: "inbox-message",
          session_name: "first-principle",
          field: "prompt",
          contains_all: expect.arrayContaining(["predicate-schema-warning"]),
        },
      });
      expect(deps.captured.loggerWarns).toContainEqual(
        expect.objectContaining({
          message: "predicate-schema-warning",
          fields: expect.objectContaining({
            kind: "invalid predicate",
            target: "target",
            errors: expect.arrayContaining(["inbox-message must include contains_all, contains_any, or regex"]),
          }),
        }),
      );
    });

    test("predicate without from accepts spawn but logs that attribution is missing", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          prompt: "hello",
          verification_predicate: {
            type: "inbox-message",
            session_name: "target",
            field: "prompt",
            contains_all: ["comm_missing_from_12345678"],
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.captured.spawnInputs).toHaveLength(1);
      const actual = deps.captured.spawnInputs.find((input) => input.parentId === "sess_target");
      expect(actual).toBeTruthy();
      expect(actual!.requestedBy).toBeUndefined();
      expect((actual! as SpawnChildInput & { verificationPredicate?: unknown }).verificationPredicate).toMatchObject({
        predicate: {
          type: "inbox-message",
          contains_all: ["comm_missing_from_12345678"],
        },
      });
      expect(deps.captured.loggerWarns).toContainEqual(
        expect.objectContaining({
          message: "api spawn missing from",
          fields: expect.objectContaining({
            kind: "missing from",
            target: "target",
            promptLength: 5,
            hasVerificationPredicate: true,
          }),
        }),
      );
    });

    test("valid predicate with from is passed through to spawnChild", async () => {
      const res = await fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "target",
          from: "caller",
          prompt: "hello",
          verification_predicate: {
            type: "inbox-message",
            session_name: "target",
            field: "prompt",
            contains_all: ["comm_valid_predicate_12345678"],
          },
        }),
      });
      expect(res.status).toBe(200);
      const actual = deps.captured.spawnInputs.find((input) => input.parentId === "sess_target");
      expect(actual).toBeTruthy();
      expect((actual! as SpawnChildInput & { verificationPredicate?: unknown }).verificationPredicate).toMatchObject({
        predicate: {
          type: "inbox-message",
          contains_all: ["comm_valid_predicate_12345678"],
        },
      });
    });
  });

  describe("PATCH /api/spawn/:spawn_comm_id/predicate", () => {
    const validPredicate = {
      type: "inbox-message",
      session_name: "target",
      field: "final_message",
      contains_all: ["patch-token", "comm_patch_1712345678"],
      expected_window_sec: 600,
    };

    test("owner path patches when from owns the cross-session comm", async () => {
      const res = await fetch(`${baseUrl}/api/spawn/comm_patch_1712345678/predicate`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-predicate-token",
        },
        body: JSON.stringify({
          from: "caller",
          actor_role: "owner",
          reason: "owner refined predicate",
          verification_predicate: validPredicate,
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.state.predicatePatches).toHaveLength(1);
    });

    test("sk path patches with tx_id and patch_count_24h below limit", async () => {
      deps.state.patchCount24h = 2;
      const res = await fetch(`${baseUrl}/api/spawn/comm_patch_1712345678/predicate`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-predicate-token",
        },
        body: JSON.stringify({
          from: "socail-king",
          actor_role: "sk",
          tx_id: "tx-2026-05-14-001",
          reason: "Pattern A adjustment",
          verification_predicate: validPredicate,
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.state.predicatePatches).toHaveLength(1);
    });

    test("sk-watcher path patches with tx_id and patch_count_24h below limit", async () => {
      deps.state.patchCount24h = 2;
      const res = await fetch(`${baseUrl}/api/spawn/comm_patch_1712345678/predicate`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-predicate-token",
        },
        body: JSON.stringify({
          from: "sk-watcher",
          actor_role: "sk",
          tx_id: "tx-2026-06-01-001",
          reason: "Pattern A adjustment",
          verification_predicate: validPredicate,
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.state.predicatePatches).toHaveLength(1);
    });

    test("root path patches with manual override reason", async () => {
      const res = await fetch(`${baseUrl}/api/spawn/comm_patch_1712345678/predicate`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-predicate-token",
        },
        body: JSON.stringify({
          from: "codexroot",
          actor_role: "root",
          reason: "manual-root-override: repair predicate after incident review",
          verification_predicate: validPredicate,
        }),
      });
      expect(res.status).toBe(200);
      expect(deps.state.predicatePatches).toHaveLength(1);
    });

    test("returns 403 when owner from does not match cross-session owner", async () => {
      const res = await fetch(`${baseUrl}/api/spawn/comm_patch_1712345678/predicate`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-predicate-token",
        },
        body: JSON.stringify({
          from: "codexroot",
          actor_role: "owner",
          reason: "wrong owner",
          verification_predicate: validPredicate,
        }),
      });
      expect(res.status).toBe(403);
      expect(deps.state.predicatePatches).toHaveLength(0);
    });

    test("returns 401 when bearer token is missing", async () => {
      const res = await fetch(`${baseUrl}/api/spawn/comm_patch_1712345678/predicate`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "caller",
          actor_role: "owner",
          reason: "owner refined predicate",
          verification_predicate: validPredicate,
        }),
      });
      expect(res.status).toBe(401);
      expect(deps.state.predicatePatches).toHaveLength(0);
    });
  });
});

describe("apiServer POST /api/spawn2.0", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;

  beforeEach(async () => {
    resetCodexModelCatalogForTests([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
    ]);
    deps = makeDeps();
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetCodexModelCatalogForTests();
  });

  test("accepts execution.backend=kimi and inline message closure", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:inline",
        execution: { backend: "kimi" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; closure?: string; finalMessage?: string };
    expect(body).toMatchObject({ ok: true, closure: "verified", finalMessage: "done" });
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      backend: "kimi",
      model: null,
      callerInvocation: "sync_inline",
      resultSinks: [{ kind: "http_response" }],
      clientRequestId: "2026-05-26:caller:target:inline",
    });
  });

  test("rejects a non-default effort override for backend=kimi on the fixed-on default model", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-17:caller:target:kimi-effort",
        execution: { backend: "kimi", effort: "high" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("thinking 固定为 on");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("accepts a K3 effort override for backend=kimi and passes it to the child", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-31:caller:target:kimi-k3-effort",
        execution: { backend: "kimi", model: "k3", effort: "low" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      backend: "kimi",
      model: "kimi-code/k3",
      effort: "low",
      executionOverride: {
        backend: "kimi",
        model: "kimi-code/k3",
        effort: "low",
      },
    });
  });

  test("rejects ultracode for backend=kimi even on a K3 model (claude-only token)", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-31:caller:target:kimi-k3-ultracode",
        execution: { backend: "kimi", model: "k3", effort: "ultracode" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("ultracode");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("allows effort=default for backend=kimi (clears to null)", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-17:caller:target:kimi-effort-default",
        execution: { backend: "kimi", effort: "default" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]!.effort).toBeNull();
    expect(deps.captured.spawnInputs[0]!.executionOverride).toEqual({
      backend: "kimi",
      effort: null,
    });
  });

  test("accepts execution effort across a backend override", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-17:caller:target:execution-effort",
        execution: { backend: "codex", effort: "ultra" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      backend: "codex",
      model: null,
      effort: "ultra",
      executionOverride: {
        backend: "codex",
        effort: "ultra",
      },
    });
  });

  test("maps a top-level default effort override to null", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-17:caller:target:default-effort",
        effort: "default",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]!.effort).toBeNull();
    expect(deps.captured.spawnInputs[0]!.executionOverride).toEqual({ effort: null });
  });

  test("validates an explicit model against the configured global child backend", async () => {
    deps.state.childDefaults.backend = { configured: true, value: "codex" };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "use the configured backend",
        client_request_id: "2026-07-18:caller:target:configured-default-model",
        execution: { model: "gpt-5.5" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      // The service owns default resolution, so this stays the legacy fallback.
      backend: "claude",
      executionOverride: { model: "gpt-5.5" },
    });
  });

  test("rejects a concrete effort against the configured kimi child backend", async () => {
    deps.state.childDefaults.backend = { configured: true, value: "kimi" };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "use the configured backend",
        client_request_id: "2026-07-18:caller:target:configured-kimi-effort",
        execution: { effort: "high" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("accepts a level when the effective child-default model is K3 (validation uses the child tuple, not the target session model)", async () => {
    deps.state.childDefaults.backend = { configured: true, value: "kimi" };
    deps.state.childDefaults.model = { configured: true, value: "kimi-code/k3" };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        // The target session is claude with a claude model — validating the
        // effort against THAT tuple would wrongly reject; the child actually
        // runs the configured kimi/k3 default, which accepts levels.
        target: "target",
        prompt: "use the configured K3 child default",
        client_request_id: "2026-07-31:caller:target:configured-k3-effort",
        execution: { effort: "low" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
  });

  test("rejects a level when the effective child-default model is K2.7 even though the target session runs K3 (before any child executes)", async () => {
    deps.state.childDefaults.backend = { configured: true, value: "kimi" };
    deps.state.childDefaults.model = { configured: true, value: "kimi-code/kimi-for-coding" };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        // The target session itself runs K3 — validating against it would
        // wrongly accept; the child actually runs the configured K2.7
        // default (fixed-on), so the API must reject up front.
        target: "kimi-k3-target",
        prompt: "use the configured K2.7 child default",
        client_request_id: "2026-07-31:caller:kimi-k3-target:configured-k27-effort",
        execution: { effort: "high" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("thinking 固定为 on");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("rejects an invalid direct execution model against the effective backend even with no effort in the request", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "foreign model, no effort",
        client_request_id: "2026-07-31:caller:target:kimi-foreign-model",
        execution: { backend: "kimi", model: "gpt-5.5" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("codex");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("rejects an invalid kimi default model from persistent child defaults even when the request omits model/effort (400 before any child executes)", async () => {
    deps.state.childDefaults.backend = { configured: true, value: "kimi" };
    deps.state.childDefaults.model = { configured: true, value: "gpt-5.5" };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "invalid persisted default model, no request model/effort",
        client_request_id: "2026-07-31:caller:target:invalid-kimi-default-model",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("codex");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("rejects a kimi model persisted under a non-kimi default backend even when the request omits model/effort (400 before any child executes)", async () => {
    deps.state.childDefaults.backend = { configured: true, value: "codex" };
    deps.state.childDefaults.model = { configured: true, value: "kimi-code/k3" };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "kimi model under codex default backend, no request model/effort",
        client_request_id: "2026-07-31:caller:target:kimi-model-codex-default",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("kimi");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("records the exact http_response delivery only after an inline response is written", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-15:caller:target:inline-response-evidence",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, finalMessage: "done" });
    expect(deps.captured.resultSinkAttempts).toEqual([
      expect.objectContaining({
        spawnCommId: "comm_child_xx_12345678",
        childSessionId: "sess_child_xx",
        messageRunId: "mr_child_xx",
        sinkIndex: 0,
        sinkKind: "http_response",
        status: "delivered",
        note: "sync_inline response written",
      }),
    ]);
  });

  test("sync_inline closes open async item as delivered after response is written", async () => {
    const openItem = {
      status: "waiting_child",
      verdict: null as string | null,
      verdictReason: null as string | null,
      commId: "comm_child_xx_12345678",
    };
    Object.assign(deps.store, {
      async closeSpawnAsyncItemSyncDelivered(commId: string, reason: string) {
        deps.captured.syncDeliveredClosures.push({ commId, reason });
        if (
          openItem.commId === commId
          && (openItem.status === "pending"
            || openItem.status === "waiting_child"
            || openItem.status === "delivering")
        ) {
          openItem.status = "closed";
          openItem.verdict = "delivered";
          openItem.verdictReason = reason;
          return 1;
        }
        return 0;
      },
    });

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-30:caller:target:inline-sync-delivered",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, finalMessage: "done" });
    expect(deps.captured.syncDeliveredClosures).toEqual([
      {
        commId: "comm_child_xx_12345678",
        reason: "sync_inline response written; caller received the result over HTTP",
      },
    ]);
    expect(openItem).toMatchObject({
      status: "closed",
      verdict: "delivered",
      verdictReason: "sync_inline response written; caller received the result over HTTP",
    });
  });

  test("uses caller running message run as origin run id", async () => {
    deps.state.runningRunId = "mr_caller_batch_1";

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "fan out work",
        client_request_id: "2026-05-26:caller:target:batch",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      originRunId: "mr_caller_batch_1",
    });
    expect(deps.captured.spawnInputs[0]).not.toHaveProperty("executionOverride");
  });

  test("synthesizes origin run id from scheduler origin", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "fan out rule probes",
        client_request_id: "2026-05-28:caller:target:rule_01",
        closure: { kind: "message", target: { type: "inline" } },
        origin: {
          kind: "scheduler",
          task_id: "amzdata-daily-inspection",
          run_id: "run_abc123",
          triggered_at: 1717000000000,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      originRunId: "scheduler:amzdata-daily-inspection:run_abc123",
    });
  });

  test("scheduler origin takes precedence over caller running message run", async () => {
    deps.state.runningRunId = "mr_caller_batch_1";

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "fan out rule probes",
        client_request_id: "2026-05-28:caller:target:rule_02",
        closure: { kind: "message", target: { type: "inline" } },
        origin: {
          kind: "scheduler",
          task_id: "amzdata-daily-inspection",
          run_id: "run_abc123",
          triggered_at: 1717000000000,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      originRunId: "scheduler:amzdata-daily-inspection:run_abc123",
    });
  });

  test("uses run_id directly for message_run origin", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "fan out work",
        client_request_id: "2026-05-28:caller:target:mr",
        closure: { kind: "message", target: { type: "inline" } },
        origin: { kind: "message_run", run_id: "mr_explicit_42" },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      originRunId: "mr_explicit_42",
    });
  });

  test("synthesizes origin run id from other origin key", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "fan out work",
        client_request_id: "2026-05-28:caller:target:other",
        closure: { kind: "message", target: { type: "inline" } },
        origin: { kind: "other", key: "nightly-batch-7" },
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      originRunId: "other:nightly-batch-7",
    });
  });

  test("rejects an origin with an unknown kind", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "fan out work",
        client_request_id: "2026-05-28:caller:target:bogus",
        closure: { kind: "message", target: { type: "inline" } },
        origin: { kind: "bogus", key: "x" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("invalid spawn2.0 body");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test.each([
    {
      label: "inline",
      closure: { kind: "message", target: { type: "inline" } },
      expectedStatus: 200,
      instruction: "交付规则：仅在本回复给结果；同步窗口内直返发起方，超时后框架转为异步结果，供发起方按 resultUrl 取回；勿另行回调。",
    },
    {
      label: "session",
      closure: { kind: "message", target: { type: "session", session_name: "caller" } },
      expectedStatus: 200,
      instruction: "交付规则：仅在本回复给结果；框架会转投目标会话，若同步窗口超时，结果会异步保存并由框架继续投递；勿另行回调。",
    },
    {
      label: "topic",
      closure: { kind: "message", target: { type: "topic", topic: "ops.delivery" } },
      expectedStatus: 200,
      instruction: "交付规则：仅在本回复给结果；框架会发布到目标 topic，若同步窗口超时，结果会异步保存并由框架继续投递；勿另行回调。",
    },
    {
      label: "todo_pool",
      closure: { kind: "message", target: { type: "todo_pool" } },
      expectedStatus: 202,
      instruction: "交付规则：仅在本回复给结果；框架会异步写入待办池，无需向发起方另行回执；若确认发起方无需后续处理，请在最终回复末尾单独写一行：SM_CLOSURE_ACTION: no_action",
    },
  ])("injects an accurate delivery rule for $label closure", async ({ closure, expectedStatus, instruction }) => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "return the launch notes",
        client_request_id: `2026-08-06:caller:target:${closure.target.type}-delivery-rule`,
        closure,
      }),
    });

    expect(res.status).toBe(expectedStatus);
    expect(deps.captured.spawnInputs[0]!.prompt).toBe(`${instruction}\n\nreturn the launch notes`);
  });

  test("routes a completed inline timeout item through closure watcher for Heartbeat delivery", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    deps = makeDeps();
    deps.syncSpawnResponseTimeoutMs = 20;
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    let resolveSpawn!: () => void;
    deps.childSession.spawnChild = async (input: SpawnChildInput) => {
      deps.captured.spawnInputs.push(input);
      await input.onSessionReady?.({
        session: mkSession({
          id: asSessionId("sess_child_spawn2_timeout"),
          name: "child_spawn2_timeout",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        messageRunId: asMessageRunId("mr_spawn2_timeout"),
        spawnCommId: "comm_spawn2_timeout_1",
      });
      await new Promise<void>((resolve) => {
        resolveSpawn = resolve;
      });
      return {
        session: mkSession({
          id: asSessionId("sess_child_spawn2_timeout"),
          name: "child_spawn2_timeout",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        finalMessage: "spawn2 late done",
        backendSessionId: null,
        messageRunId: asMessageRunId("mr_spawn2_timeout"),
        spawnCommId: "comm_spawn2_timeout_1",
      };
    };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "long child",
        client_request_id: "2026-05-26:caller:target:inline-timeout",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status?: string; spawnCommId?: string; ref?: string };
    expect(body).toMatchObject({
      ok: false,
      status: "switched_async",
      spawnCommId: "comm_spawn2_timeout_1",
    });
    expect(deps.captured.asyncItems[0]).toMatchObject({
      commId: "comm_spawn2_timeout_1",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "execution",
      failureKind: "run_timeout",
      status: "waiting_child",
    });

    resolveSpawn();
    await eventually(() => {
      expect(deps.captured.closureRoutes).toEqual([
        {
          ref: body.ref,
          commId: "comm_spawn2_timeout_1",
          callerSession: "caller",
          targetSession: "target",
        },
      ]);
    });
  });

  test("rejects conflicting top-level backend and execution.backend", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:conflict",
        backend: "codex",
        execution: { backend: "kimi" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body).toMatchObject({
      ok: false,
      error: "backend conflict: top-level backend=codex but execution.backend=kimi",
    });
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("rejects conflicting top-level effort and execution.effort", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-17:caller:target:effort-conflict",
        effort: "low",
        execution: { effort: "high" },
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body).toMatchObject({
      ok: false,
      error: "effort conflict: top-level effort=low but execution.effort=high",
    });
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("rejects no_reply closure", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:no-reply",
        closure: { kind: "no_reply" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body).toMatchObject({
      ok: false,
      error: "closure.kind=no_reply is forbidden in /api/spawn2.0",
    });
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("requires date-scoped client_request_id", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "caller:target:missing-date",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("client_request_id must start with YYYY-MM-DD:");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("rejects duplicate client_request_id while the prior comm is pending", async () => {
    deps.state.existingComms.push({
      id: "comm_dup_pending",
      status: "pending",
      childSessionId: "sess_child_prev",
      createdAt: 1000,
      clientRequestId: "2026-07-04:caller:target:dup-pending",
    });

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-04:caller:target:dup-pending",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      duplicate?: boolean;
      error?: string;
      existing?: { commId: string; status: string; childSessionId: string | null };
    };
    expect(body).toMatchObject({
      ok: false,
      duplicate: true,
      existing: { commId: "comm_dup_pending", status: "pending", childSessionId: "sess_child_prev" },
    });
    expect(body.error).toContain("duplicate client_request_id");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("rejects duplicate client_request_id after the prior comm completed", async () => {
    deps.state.existingComms.push({
      id: "comm_dup_done",
      status: "completed",
      childSessionId: "sess_child_prev",
      createdAt: 1000,
      clientRequestId: "2026-07-04:caller:target:dup-done",
    });

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-04:caller:target:dup-done",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; duplicate?: boolean; existing?: { status: string } };
    expect(body).toMatchObject({
      ok: false,
      duplicate: true,
      existing: { commId: "comm_dup_done", status: "completed" },
    });
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("allows reusing a client_request_id whose prior comm failed", async () => {
    deps.state.existingComms.push({
      id: "comm_dup_failed",
      status: "failed",
      childSessionId: null,
      createdAt: 1000,
      clientRequestId: "2026-07-04:caller:target:dup-failed",
    });

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-04:caller:target:dup-failed",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(deps.captured.spawnInputs).toHaveLength(1);
  });

  test("rejects concurrent duplicate while the first request is still in flight", async () => {
    // Reproduces the 2026-07-04 incident shape: the first request has passed
    // validation but its comm row is not in the DB yet (spawn still running),
    // and a retry with the same key arrives on a second connection.
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let signalEntered!: () => void;
    const spawnEntered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const originalSpawnChild = deps.childSession.spawnChild;
    deps.childSession.spawnChild = async (input) => {
      signalEntered();
      await spawnGate;
      return originalSpawnChild(input);
    };

    const first = fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-04:caller:target:dup-inflight",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });
    await spawnEntered;

    const second = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-04:caller:target:dup-inflight",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { ok: boolean; duplicate?: boolean; existing?: { status: string } };
    expect(secondBody).toMatchObject({ ok: false, duplicate: true, existing: { status: "in_flight" } });

    releaseSpawn();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
  });

  test("routes todo_pool closure through async kickoff, registers a waiting_child async item, and exposes its ref", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:todo-pool",
        closure: { kind: "message", target: { type: "todo_pool" } },
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      ok: boolean;
      mode?: string;
      closure?: string;
      childSessionId?: string;
      ref?: string;
      spawnCommId?: string;
    };
    expect(body).toMatchObject({
      ok: true,
      mode: "async_kickoff",
      closure: "todo_pool",
      childSessionId: "sess_child_xx",
      spawnCommId: "comm_child_xx_12345678",
    });
    expect(typeof body.ref).toBe("string");
    expect(body.ref).toMatch(/^async_/);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.spawnInputs[0]).toMatchObject({
      callerInvocation: "async_kickoff",
      resultSinks: [{ kind: "pollable_endpoint" }],
      clientRequestId: "2026-05-26:caller:target:todo-pool",
    });
    expect(deps.captured.spawnInputs[0]?.prompt).toContain("SM_CLOSURE_ACTION: no_action");
    // Heartbeat closure watcher only sees rows in spawn_async_items, so the
    // kickoff must register the item in waiting_child status with late_result
    // semantics — that combination is the one the watcher routes via deliver.
    expect(deps.captured.asyncItems).toHaveLength(1);
    expect(deps.captured.asyncItems[0]).toMatchObject({
      commId: "comm_child_xx_12345678",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "delivery",
      failureKind: "late_result",
      status: "waiting_child",
    });
    await eventually(() => {
      expect(deps.captured.closureRoutes).toEqual([
        {
          ref: body.ref,
          commId: "comm_child_xx_12345678",
          callerSession: "caller",
          targetSession: "target",
        },
      ]);
    });
  });

  test("todo_pool closure returns trigger failure when child launch fails before ready", async () => {
    deps.childSession.spawnChild = async (input: SpawnChildInput) => {
      deps.captured.spawnInputs.push(input);
      throw new Error("spawn codex ENOENT");
    };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-02:caller:target:codex-enoent",
        backend: "codex",
        closure: { kind: "message", target: { type: "todo_pool" } },
      }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error?: string; childSessionId?: string };
    expect(body).toMatchObject({
      ok: false,
      error: "spawn codex ENOENT",
    });
    expect(body.childSessionId).toBeUndefined();
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.asyncItems).toHaveLength(0);
  });

  test("normalizes and forwards verification_predicate on inline closure", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:predicate-inline",
        closure: { kind: "message", target: { type: "inline" } },
        verification_predicate: validSpawnPredicate("comm_spawn2_inline_predicate_1"),
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    const spawned = deps.captured.spawnInputs[0]!;
    expect(spawned.verificationPredicate).toBeDefined();
    expect(spawned.verificationPredicate?.predicate).toMatchObject({
      type: "inbox-message",
      session_name: "target",
      contains_all: ["comm_spawn2_inline_predicate_1"],
    });
  });

  test("forwards verification_predicate on todo_pool closure", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:predicate-todo-pool",
        closure: { kind: "message", target: { type: "todo_pool" } },
        verification_predicate: validSpawnPredicate("comm_spawn2_todo_predicate_1"),
      }),
    });

    expect(res.status).toBe(202);
    expect(deps.captured.spawnInputs).toHaveLength(1);
    const spawned = deps.captured.spawnInputs[0]!;
    expect(spawned.verificationPredicate).toBeDefined();
    expect(spawned.verificationPredicate?.predicate).toMatchObject({
      type: "inbox-message",
      contains_all: ["comm_spawn2_todo_predicate_1"],
    });
  });

  test("rejects invalid verification_predicate before spawning", async () => {
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:predicate-bad",
        closure: { kind: "message", target: { type: "inline" } },
        verification_predicate: { type: "no-such-predicate" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("invalid verification_predicate");
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });

  test("does not open a second child when the first inline result has no output", async () => {
    deps.childSession.spawnChild = async (input: SpawnChildInput) => {
      deps.captured.spawnInputs.push(input);
      return {
        session: mkSession({
          id: asSessionId("sess_child_empty_v2"),
          name: "child_empty_v2",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        finalMessage: "",
        backendSessionId: null,
        messageRunId: asMessageRunId("mr_child_empty_v2"),
        spawnCommId: "comm_spawn2_empty_1",
      };
    };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-05-26:caller:target:empty",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status?: string; spawnCommId?: string };
    expect(body).toMatchObject({
      ok: false,
      status: "switched_async",
      spawnCommId: "comm_spawn2_empty_1",
    });
    expect(deps.captured.spawnInputs).toHaveLength(1);
    expect(deps.captured.asyncItems).toHaveLength(1);
    expect(deps.captured.asyncItems[0]).toMatchObject({
      commId: "comm_spawn2_empty_1",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "execution",
      failureKind: "empty_output",
      status: "pending",
    });
  });
});

describe("apiServer GET /api/spawn_async_items/:ref", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;

  beforeEach(async () => {
    deps = makeDeps();
    Object.assign(deps.store, {
      async getSpawnAsyncItem(ref: string) {
        if (ref !== "async_test_ref") return null;
        return {
          ref: "async_test_ref",
          commId: "comm_async_1",
          callerSession: "scheduler",
          targetSession: "socail-king",
          failedPhase: "execution",
          failureKind: "run_timeout",
          attemptCount: 0,
          status: "closed",
          verdict: "false_alarm",
          verdictReason: "child completed after sync timeout",
          createdAt: asTimestamp(100),
          updatedAt: asTimestamp(200),
          lastAttemptAt: null,
          childSessionId: "sess_child_done",
          messageRunId: "mr_done",
          commStatus: "completed",
          finalMessage: "REPORT: done",
          errorMessage: null,
        };
      },
    });
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("resolves an async ref to the spawned child session", async () => {
    const res = await fetch(`${baseUrl}/api/spawn_async_items/async_test_ref`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ref?: string;
      commId?: string;
      childSessionId?: string;
      finalMessage?: string;
      resultUrl?: string;
    };
    expect(body).toMatchObject({
      ok: true,
      ref: "async_test_ref",
      commId: "comm_async_1",
      childSessionId: "sess_child_done",
      finalMessage: "REPORT: done",
      resultUrl: "/api/spawn_async_items/async_test_ref/take",
    });
  });
});

describe("apiServer spawn async take / by-comm (caller-consumption ledger)", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;
  let itemState: Record<string, unknown> | null;
  let consumeCalls: Array<{ ref: string; reason: string }>;
  let consumeResult: boolean;

  function mkAsyncItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ref: "async_take_1",
      commId: "comm_take_1",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "execution",
      failureKind: "run_timeout",
      attemptCount: 0,
      status: "waiting_child",
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(200),
      lastAttemptAt: null,
      childSessionId: "sess_child_done",
      messageRunId: "mr_done",
      commStatus: "completed",
      finalMessage: "REPORT: done",
      errorMessage: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    deps = makeDeps();
    itemState = null;
    consumeCalls = [];
    consumeResult = true;
    Object.assign(deps.store, {
      async getSpawnAsyncItem(ref: string) {
        return itemState && (itemState as { ref: string }).ref === ref ? itemState : null;
      },
      async getSpawnAsyncItemByComm(commId: string) {
        return itemState && (itemState as { commId: string }).commId === commId ? itemState : null;
      },
      async closeSpawnAsyncItemConsumed(ref: string, reason: string) {
        consumeCalls.push({ ref, reason });
        if (consumeResult && itemState) {
          itemState = { ...itemState, status: "closed", verdict: "caller_consumed", verdictReason: reason };
        }
        return consumeResult;
      },
    });
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("take returns the completed result and records caller_consumed after a confirmed write", async () => {
    itemState = mkAsyncItem();
    const res = await fetch(`${baseUrl}/api/spawn_async_items/async_take_1/take`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-sm-spawn-comm-id")).toBe("comm_take_1");
    expect(res.headers.get("x-sm-spawn-async-ref")).toBe("async_take_1");
    const body = (await res.json()) as { ok: boolean; finalMessage?: string; alreadyConsumed?: boolean };
    expect(body).toMatchObject({ ok: true, finalMessage: "REPORT: done" });
    expect(body.alreadyConsumed).toBeUndefined();

    expect(consumeCalls).toEqual([
      { ref: "async_take_1", reason: "result taken via POST /api/spawn_async_items/:ref/take" },
    ]);
    expect(deps.captured.resultSinkAttempts).toHaveLength(1);
    expect(deps.captured.resultSinkAttempts[0]).toMatchObject({
      spawnCommId: "comm_take_1",
      sinkKind: "pollable_endpoint",
      status: "delivered",
      note: "caller consumed via take endpoint",
    });
  });

  test("take consumes a delivering item as caller_consumed", async () => {
    itemState = mkAsyncItem({ status: "delivering" });
    const res = await fetch(`${baseUrl}/api/spawn_async_items/async_take_1/take`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; finalMessage?: string; alreadyConsumed?: boolean };
    expect(body).toMatchObject({ ok: true, finalMessage: "REPORT: done" });
    expect(body.alreadyConsumed).toBeUndefined();
    expect(consumeCalls).toEqual([
      { ref: "async_take_1", reason: "result taken via POST /api/spawn_async_items/:ref/take" },
    ]);
    expect(itemState).toMatchObject({
      status: "closed",
      verdict: "caller_consumed",
      verdictReason: "result taken via POST /api/spawn_async_items/:ref/take",
    });
  });

  test("take does not consume while the result is not ready", async () => {
    itemState = mkAsyncItem({ commStatus: "pending", finalMessage: null });
    const res = await fetch(`${baseUrl}/api/spawn_async_items/async_take_1/take`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(consumeCalls).toHaveLength(0);
    expect(deps.captured.resultSinkAttempts).toHaveLength(0);
  });

  test("take consumes a terminal boot-reconcile failure receipt with no child output", async () => {
    itemState = mkAsyncItem({
      status: "parked",
      commStatus: "failed",
      finalMessage: "Spawn failed during console restart before a result was produced",
      errorMessage: "boot reconcile: backend orphaned by console restart",
      clientRequestId: "2026-08-13:caller:target:restart",
    });

    const res = await fetch(`${baseUrl}/api/spawn_async_items/async_take_1/take`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; finalMessage?: string; alreadyConsumed?: boolean };
    expect(body).toMatchObject({
      ok: true,
      commStatus: "failed",
      finalMessage: "Spawn failed during console restart before a result was produced",
    });
    expect(body.alreadyConsumed).toBeUndefined();
    expect(itemState).toMatchObject({
      status: "closed",
      verdict: "caller_consumed",
    });
  });

  test("take is idempotent on an already-consumed item", async () => {
    itemState = mkAsyncItem({ status: "closed", verdict: "caller_consumed", verdictReason: "earlier take" });
    consumeResult = false; // CAS would miss on a closed item
    const res = await fetch(`${baseUrl}/api/spawn_async_items/async_take_1/take`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; alreadyConsumed?: boolean };
    expect(body.alreadyConsumed).toBe(true);
    expect(consumeCalls).toHaveLength(0);
  });

  test("take returns 404 for an unknown ref", async () => {
    const res = await fetch(`${baseUrl}/api/spawn_async_items/async_unknown/take`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("by-comm returns the async item read-only; 404 for unknown comm", async () => {
    itemState = mkAsyncItem();
    const res = await fetch(`${baseUrl}/api/spawn_async_items/by-comm/comm_take_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ref?: string; status?: string };
    expect(body).toMatchObject({
      ok: true,
      ref: "async_take_1",
      status: "waiting_child",
      resultUrl: "/api/spawn_async_items/async_take_1/take",
    });
    // Read-only: must not consume.
    expect(consumeCalls).toHaveLength(0);

    const missing = await fetch(`${baseUrl}/api/spawn_async_items/by-comm/comm_unknown`);
    expect(missing.status).toBe(404);
  });

  test("terminal child failure during sync wait returns a bounded async receipt and closes HTTP", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    deps = makeDeps();
    deps.syncSpawnResponseTimeoutMs = 500;
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    deps.childSession.spawnChild = async (input: SpawnChildInput) => {
      deps.captured.spawnInputs.push(input);
      await input.onSessionReady?.({
        session: mkSession({
          id: asSessionId("sess_child_restart_wait"),
          name: "child_restart_wait",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        messageRunId: asMessageRunId("mr_restart_wait"),
        spawnCommId: "comm_restart_wait_1",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("boot reconcile: backend orphaned by console restart");
    };

    const startedAt = Date.now();
    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "restart while waiting",
        client_request_id: "2026-08-13:caller:target:restart-wait",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });
    const bodyResponse = res.clone();
    const body = (await res.json()) as {
      ok: boolean;
      status?: string;
      spawnCommId?: string;
      resultUrl?: string;
    };

    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "switched_async",
      spawnCommId: "comm_restart_wait_1",
      resultUrl: expect.stringMatching(/^\/api\/spawn_async_items\/async_/u),
    });
    expect(bodyResponse.body).not.toBeNull();
    const reader = bodyResponse.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  test("switched_async response carries a self-describing resultUrl", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    deps = makeDeps();
    deps.syncSpawnResponseTimeoutMs = 20;
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    let resolveSpawn!: () => void;
    deps.childSession.spawnChild = async (input: SpawnChildInput) => {
      deps.captured.spawnInputs.push(input);
      await input.onSessionReady?.({
        session: mkSession({
          id: asSessionId("sess_child_resulturl"),
          name: "child_resulturl",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        messageRunId: asMessageRunId("mr_resulturl"),
        spawnCommId: "comm_resulturl_1",
      });
      await new Promise<void>((resolve) => {
        resolveSpawn = resolve;
      });
      return {
        session: mkSession({
          id: asSessionId("sess_child_resulturl"),
          name: "child_resulturl",
          scope: "child",
          parentId: asSessionId("sess_target"),
          depth: 1,
        }),
        finalMessage: "late done",
        backendSessionId: null,
        messageRunId: asMessageRunId("mr_resulturl"),
        spawnCommId: "comm_resulturl_1",
      };
    };

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "long child",
        client_request_id: "2026-07-20:caller:target:resulturl",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status?: string; ref?: string; resultUrl?: string };
    expect(body).toMatchObject({ ok: false, status: "switched_async" });
    expect(body.ref).toMatch(/^async_/);
    expect(body.resultUrl).toBe(`/api/spawn_async_items/${body.ref}/take`);
    resolveSpawn();
  });

  test("409 duplicate response carries resultUrl when the prior comm has an async item", async () => {
    deps.state.existingComms.push({
      id: "comm_dup_item",
      status: "pending",
      childSessionId: "sess_child_prev",
      createdAt: 1000,
      clientRequestId: "2026-07-20:caller:target:dup-item",
    });
    itemState = mkAsyncItem({ ref: "async_dup_1", commId: "comm_dup_item" });

    const res = await fetch(`${baseUrl}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "caller",
        target: "target",
        prompt: "hello",
        client_request_id: "2026-07-20:caller:target:dup-item",
        closure: { kind: "message", target: { type: "inline" } },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      duplicate?: boolean;
      existing?: { commId: string; ref?: string; resultUrl?: string };
    };
    expect(body).toMatchObject({ ok: false, duplicate: true });
    expect(body.existing).toMatchObject({
      commId: "comm_dup_item",
      ref: "async_dup_1",
      resultUrl: "/api/spawn_async_items/async_dup_1/take",
    });
    expect(deps.captured.spawnInputs).toHaveLength(0);
  });
});

describe("apiServer POST /api/notify", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;

  beforeEach(async () => {
    deps = makeDeps();
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("records spawn exception fallback and sends it to the yolo group", async () => {
    const res = await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "spawn_exception_transaction_fallback",
        tx_id: "tx-spawn-20260515-001",
        dedupe_key: "comm_abc:child_unhealthy",
        spawn_comm_id: "comm_abc",
        trigger_signal: "child_unhealthy",
        summary: "SK unavailable while handling child_unhealthy",
        payload: {
          reason: "SK spawn failed: HTTP 503",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      exception_id: string;
      lark_message_id?: string;
    };
    expect(body).toMatchObject({
      ok: true,
      lark_message_id: "om_notify_123",
    });
    expect(body.exception_id).toMatch(/^watcher_exception_/);

    expect(deps.captured.watcherExceptions).toHaveLength(1);
    expect(deps.captured.watcherExceptions[0]).toMatchObject({
      id: body.exception_id,
      txId: "tx-spawn-20260515-001",
      dedupeKey: "comm_abc:child_unhealthy",
      spawnCommId: "comm_abc",
      triggerSignal: "child_unhealthy",
      summary: "SK unavailable while handling child_unhealthy",
      larkMessageId: "om_notify_123",
      payload: JSON.stringify({ reason: "SK spawn failed: HTTP 503" }),
      resolvedAt: null,
    });
    expect(deps.captured.larkTexts).toHaveLength(1);
    expect(deps.captured.larkTexts[0]).toMatchObject({
      chatId: "oc_REDACTEDCHATID",
    });
    expect(deps.captured.larkTexts[0]!.text).toContain("SK unavailable while handling child_unhealthy");
    expect(deps.captured.larkTexts[0]!.text).toContain("comm_abc");
  });

  test("delivers a caller-targeted boot watcher exception through the canonical endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/watcher-exception-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "spawn_exception_transaction_fallback",
        tx_id: "tx-boot-orphan-comm_restart_orphan",
        dedupe_key: "comm_restart_orphan:boot_orphaned_child",
        spawn_comm_id: "comm_restart_orphan",
        trigger_signal: "boot_orphaned_child",
        summary: "boot reconcile orphaned child spawn caller -> target (comm_restart_orphan)",
        payload: { child_session: "child_target_restart" },
        target_chat_id: "oc_caller",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; exception_id: string; lark_message_id: string };
    expect(body).toMatchObject({ ok: true, lark_message_id: "om_notify_123" });
    expect(deps.captured.watcherExceptions).toContainEqual(expect.objectContaining({
      id: body.exception_id,
      spawnCommId: "comm_restart_orphan",
      triggerSignal: "boot_orphaned_child",
      larkMessageId: "om_notify_123",
    }));
    expect(deps.captured.larkTexts).toContainEqual(expect.objectContaining({
      chatId: "oc_caller",
    }));
  });

  test("accepts targetChatId and forwards it to the notifier", async () => {
    const notifyInputs: unknown[] = [];
    deps.notifier = {
      async notify(input) {
        notifyInputs.push(input);
        return { messageId: "om_notify_456", degraded: false };
      },
    };

    const res = await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "watchdog",
        title: "done",
        body: "ok",
        targetChatId: "oc_target_chat",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: "om_notify_456" });
    expect(notifyInputs).toEqual([
      {
        source: "watchdog",
        title: "done",
        body: "ok",
        targetChatId: "oc_target_chat",
      },
    ]);
  });

  test("accepts success level and forwards it to the notifier", async () => {
    const notifyInputs: unknown[] = [];
    deps.notifier = {
      async notify(input) {
        notifyInputs.push(input);
        return { messageId: "om_notify_success", degraded: false };
      },
    };

    const res = await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "autobitable",
        title: "lifecycle complete",
        body: "ok",
        level: "success",
      }),
    });

    expect(res.status).toBe(200);
    expect(notifyInputs).toEqual([
      {
        source: "autobitable",
        title: "lifecycle complete",
        body: "ok",
        level: "success",
      },
    ]);
  });

  test("accepts notify actions and forwards their frozen contract shape", async () => {
    const notifyInputs: unknown[] = [];
    deps.notifier = {
      async notify(input) {
        notifyInputs.push(input);
        return { messageId: "om_notify_actions", degraded: false };
      },
    };

    const actions = {
      card_type: "gongying_replenish_confirm",
      options: [
        { label: "确认补货", value: "confirm" },
        { label: "跳过", value: "skip", description: "本批次不补货" },
      ],
      context: { batch_id: "B123" },
    };
    const res = await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "gongying",
        title: "补货确认",
        body: "请确认本批次。",
        actions,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: "om_notify_actions" });
    expect(notifyInputs).toEqual([
      {
        source: "gongying",
        title: "补货确认",
        body: "请确认本批次。",
        actions,
      },
    ]);
  });

  test("accepts target_chat_id alias and forwards normalized targetChatId", async () => {
    const notifyInputs: unknown[] = [];
    deps.notifier = {
      async notify(input) {
        notifyInputs.push(input);
        return { messageId: "om_notify_789", degraded: false };
      },
    };

    const res = await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "watchdog",
        title: "done",
        body: "ok",
        target_chat_id: "oc_snake_chat",
      }),
    });

    expect(res.status).toBe(200);
    expect(notifyInputs).toEqual([
      {
        source: "watchdog",
        title: "done",
        body: "ok",
        targetChatId: "oc_snake_chat",
      },
    ]);
  });

  test("rejects invalid targetChatId before notifying", async () => {
    const notifyInputs: unknown[] = [];
    deps.notifier = {
      async notify(input) {
        notifyInputs.push(input);
        return { messageId: "om_notify_bad", degraded: false };
      },
    };

    const res = await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "watchdog",
        title: "done",
        body: "ok",
        targetChatId: "not-a-chat",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("targetChatId");
    expect(notifyInputs).toEqual([]);
  });

  test("keeps the notify input strict when actions are present", async () => {
    const notifyInputs: unknown[] = [];
    deps.notifier = {
      async notify(input) {
        notifyInputs.push(input);
        return { messageId: "om_notify_bad", degraded: false };
      },
    };

    const res = await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "gongying",
        title: "补货确认",
        body: "请确认本批次。",
        actions: {
          card_type: "gongying_replenish_confirm",
          options: [{ label: "确认补货", value: "confirm" }, { label: "跳过", value: "skip" }],
        },
        unexpected: true,
      }),
    });

    expect(res.status).toBe(400);
    expect(notifyInputs).toEqual([]);
  });
});

describe("apiServer POST /api/run", () => {
  type RunDeps = ApiDeps & {
    captured: {
      runInputs: Array<{
        sessionId: string;
        prompt: string;
        groupId: string;
        requesterSessionId?: string;
      }>;
    };
    state: {
      target?: Session;
      runResult: import("../../src/app/runOnSession.ts").RunOnSessionResult;
      bindingGroupId: string | null;
    };
  };

  function makeRunDeps(): RunDeps {
    const captured: RunDeps["captured"] = { runInputs: [] };
    const state: RunDeps["state"] = {
      target: mkSession({
        id: asSessionId("sess_target"),
        name: "target",
        backendSessionId: "bks_existing",
        status: "idle",
      }),
      runResult: {
        kind: "ok",
        runId: "mr_run_1" as never,
        finalMessage: "follow-up reply",
        backendSessionId: "bks_existing",
        runStatus: "completed",
      },
      bindingGroupId: "oc_target_group",
    };
    return {
      captured,
      state,
      store: {
        async findSessionByName(name: string) {
          if (name === "target") return state.target ?? null;
          if (name === "caller") {
            return mkSession({
              id: asSessionId("sess_caller"),
              name: "caller",
            });
          }
          if (name === "child_alice") {
            return mkSession({
              id: asSessionId("sess_child_alice"),
              name: "child_alice",
              scope: "child",
            });
          }
          return null;
        },
        async findSessionById() {
          return null;
        },
        async findLatestMessageRunBySession() {
          return null;
        },
        async findRunningMessageRunBySession() {
          return null;
        },
        async listActiveSessions() {
          return [];
        },
        async countBusySessions() {
          return 0;
        },
        async getSchedulerTokenUsage() {
          return [];
        },
        async countBusySessionsByBackend() {
          return 0;
        },
        async clearBackendSessionIdsForBackend() {
          throw new Error("clearBackendSessionIdsForBackend should not be called from /api/run tests");
        },
        async findBackendAccountSwitch() {
          return null;
        },
        async recordBackendAccountSwitch() {
          throw new Error("recordBackendAccountSwitch should not be called from /api/run tests");
        },
        async acquireBackendMaintenanceLease() {
          throw new Error("acquireBackendMaintenanceLease should not be called from /api/run tests");
        },
        async releaseBackendMaintenanceLease() {
          throw new Error("releaseBackendMaintenanceLease should not be called from /api/run tests");
        },
        async getBackendMaintenanceLease() {
          throw new Error("getBackendMaintenanceLease should not be called from /api/run tests");
        },
        async getChildSessionDefaults() {
          return {
            backend: { configured: false, value: null },
            model: { configured: false, value: null },
            effort: { configured: false, value: null },
            updatedAt: null,
          };
        },
        async findBySession() {
          return state.bindingGroupId
            ? { groupId: state.bindingGroupId as never }
            : null;
        },
        async getSpawnPredicate() {
          return null;
        },
        async getWatcherState() {
          return null;
        },
        async patchSpawnPredicate() {
          throw new Error("patchSpawnPredicate should not be called from /api/run tests");
        },
        async getSpawnAsyncItem() {
          return null;
        },
        async getSpawnAsyncItemByComm() {
          return null;
        },
        async closeSpawnAsyncItemConsumed() {
          return false;
        },
        async closeSpawnAsyncItemSyncDelivered() {
          return 0;
        },
        async findCrossSessionCommForDedup() {
          return null;
        },
        async registerSpawnAsyncItem() {
          throw new Error("registerSpawnAsyncItem should not be called from /api/run tests");
        },
        async recordResultSinkAttempt() {
          throw new Error("recordResultSinkAttempt should not be called from /api/run tests");
        },
        async recordWatcherException() {
          throw new Error("recordWatcherException should not be called from /api/run tests");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("childSession.spawnChild should not be called from /api/run tests");
        },
      },
      runOnSession: async (input) => {
        captured.runInputs.push({
          sessionId: input.session.id,
          prompt: input.prompt,
          groupId: input.groupId,
          ...(input.requesterSessionId
            ? { requesterSessionId: input.requesterSessionId }
            : {}),
        });
        return state.runResult;
      },
      notifier: {
        async notify() {
          throw new Error("notifier should not be called");
        },
      },
      logger: noopLogger as unknown as ApiDeps["logger"],
    };
  }

  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: RunDeps;

  beforeEach(async () => {
    deps = makeRunDeps();
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("happy path returns 200 with finalMessage and forwards prompt to runOnSession", async () => {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "target",
        prompt: "follow up please",
        from: "caller",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      target: string;
      runId: string;
      finalMessage: string;
      backendSessionId: string | null;
      runStatus: string;
    };
    expect(body.ok).toBe(true);
    expect(body.target).toBe("target");
    expect(body.runId).toBe("mr_run_1");
    expect(body.finalMessage).toBe("follow-up reply");
    expect(body.backendSessionId).toBe("bks_existing");
    expect(deps.captured.runInputs).toHaveLength(1);
    expect(deps.captured.runInputs[0]!.prompt).toBe("follow up please");
    expect(deps.captured.runInputs[0]!.groupId).toBe("oc_target_group");
    expect(deps.captured.runInputs[0]!.requesterSessionId).toBe("sess_caller");
  });

  test("returns 409 when runOnSession reports busy", async () => {
    deps.state.runResult = { kind: "busy", currentRunId: "mr_running" as never };
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target", prompt: "x", from: "caller" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      currentRunId: string;
    };
    expect(body.ok).toBe(false);
    expect(body.currentRunId).toBe("mr_running");
  });

  test("returns 423 when the unified admission fence reports backend maintenance", async () => {
    deps.state.runResult = { kind: "maintenance", backend: "claude", leaseOwner: "sm-switch" };
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target", prompt: "x", from: "caller" }),
    });
    expect(res.status).toBe(423);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "backend_maintenance",
      backend: "claude",
      leaseOwner: "sm-switch",
    });
  });

  test("returns 200+ok=false on run-time error", async () => {
    deps.state.runResult = {
      kind: "error",
      runId: "mr_fail" as never,
      finalMessage: "",
      error: "[TIMEOUT] backend stalled",
      runStatus: "timeout",
    };
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target", prompt: "x", from: "caller" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      runStatus: string;
      error: string;
    };
    expect(body.ok).toBe(false);
    expect(body.runStatus).toBe("timeout");
    expect(body.error).toContain("[TIMEOUT]");
  });

  test("rejects target=child with 400", async () => {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "child_alice", prompt: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/scope must be 'user'/);
  });

  test("returns 404 when target session not found", async () => {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "ghost", prompt: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 404 when from session not found", async () => {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target", prompt: "x", from: "ghost_caller" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 when prompt missing", async () => {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 500 when target has no binding (data inconsistency)", async () => {
    deps.state.bindingGroupId = null;
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target", prompt: "x" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no binding/);
  });

  test("rejects target in 'error' status", async () => {
    deps.state.target = mkSession({
      id: asSessionId("sess_target"),
      name: "target",
      status: "error",
    });
    const res = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target", prompt: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/error state/);
  });
});
