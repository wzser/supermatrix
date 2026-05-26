import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { startApiServer, type ApiDeps } from "../../src/cli/apiServer.ts";
import type { SpawnChildInput, SpawnChildResult } from "../../src/app/childSession.ts";
import { asAbsolutePath, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
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
  predicatePatches: unknown[];
};

type TestDeps = ApiDeps & {
  captured: {
    spawnInputs: SpawnChildInput[];
    watcherExceptions: unknown[];
    asyncItems: unknown[];
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
    predicatePatches: [] as unknown[],
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
        return null;
      },
      async findSessionById() {
        return null;
      },
      async findLatestMessageRunBySession() {
        return null;
      },
      async listActiveSessions() {
        return [];
      },
      async countBusySessions() {
        return 0;
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
      async recordWatcherException(input: unknown) {
        captured.watcherExceptions.push(input);
      },
      async registerSpawnAsyncItem(input: unknown) {
        captured.asyncItems.push(input);
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

describe("apiServer POST /api/spawn", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let deps: TestDeps;
  let previousPatchToken: string | undefined;

  beforeEach(async () => {
    previousPatchToken = process.env.SM_PREDICATE_PATCH_TOKEN;
    process.env.SM_PREDICATE_PATCH_TOKEN = "fixture-token";
    resetCodexModelCatalogForTests([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
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
        message: expect.stringContaining("已转后台跟进"),
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
      const body = (await res.json()) as { ok: boolean; status?: string; spawnCommId?: string };
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
      expect(deps.captured.spawnInputs[0]!.model).toBe("claude-sonnet-4-6");
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
      expect(body.error).toContain("gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.2");
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
          Authorization: "Bearer fixture-token",
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
          Authorization: "Bearer fixture-token",
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

    test("root path patches with manual override reason", async () => {
      const res = await fetch(`${baseUrl}/api/spawn/comm_patch_1712345678/predicate`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer fixture-token",
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
          Authorization: "Bearer fixture-token",
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
    expect(deps.captured.larkTexts[0]!.chatId).toBeTruthy();
    expect(deps.captured.larkTexts[0]!.text).toContain("SK unavailable while handling child_unhealthy");
    expect(deps.captured.larkTexts[0]!.text).toContain("comm_abc");
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
        async listActiveSessions() {
          return [];
        },
        async countBusySessions() {
          return 0;
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
        async registerSpawnAsyncItem() {
          throw new Error("registerSpawnAsyncItem should not be called from /api/run tests");
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
