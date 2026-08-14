import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexBackend } from "../../../src/adapters/backend-codex/index.ts";
import type { CodexAppServerRunPlan } from "../../../src/adapters/backend-codex/commandBuilder.ts";
import { createCallerAttestationRegistry } from "../../../src/domain/callerAttestation.ts";
import { asMessageRunId, asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import type { Session } from "../../../src/domain/session.ts";
import type { RunInput } from "../../../src/ports/AgentBackend.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

// The fake app-server speaks the real codex-cli 0.146.0 JSON-RPC shapes and
// doubles as the codex command itself (it answers `--version`).
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeCodexAppServer.mjs");

function mkSession(): Session {
  return {
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "codex",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp"),
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
  };
}

function fakePlan(
  scenario: string,
  overrides: Partial<CodexAppServerRunPlan> = {},
): CodexAppServerRunPlan {
  return {
    appServerArgs: [scenario],
    resumeThreadId: null,
    routeChangeNotice: null,
    threadParams: { cwd: "/tmp", model: "gpt-fake" },
    turnInput: [{ type: "text", text: "hi" }],
    turnEffort: null,
    model: "gpt-fake",
    ...overrides,
  };
}

function fakeBackend(scenario: string, opts: {
  planOverrides?: Partial<CodexAppServerRunPlan>;
  capturePlanInputs?: RunInput[];
  callerAttestations?: ReturnType<typeof createCallerAttestationRegistry>;
  codexStateDbPath?: string | null;
  cardAskHealthCheck?: () => Promise<boolean>;
} = {}): CodexBackend {
  return new CodexBackend({
    command: FAKE,
    codexStateDbPath: opts.codexStateDbPath === undefined ? null : opts.codexStateDbPath,
    buildRunPlan: (input) => {
      opts.capturePlanInputs?.push(input);
      return fakePlan(scenario, opts.planOverrides);
    },
    ...(opts.callerAttestations ? { callerAttestations: opts.callerAttestations } : {}),
    ...(opts.cardAskHealthCheck ? { cardAskHealthCheck: opts.cardAskHealthCheck } : {}),
  });
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of iterable) events.push(e);
  return events;
}

describe("CodexBackend (app-server transport)", () => {
  afterEach(() => {
    delete process.env["SM_CODEX_CLI_PATH"];
  });

  test("happy run yields started + final + completed via AsyncIterable", async () => {
    const backend = fakeBackend("happy");
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );
    expect(events.map((e) => e.kind)).toEqual([
      "started",
      "assistant_message",
      "completed",
    ]);
    expect(events[0]).toEqual({ kind: "started", backendSessionId: "fake-thread-1" });
    const completed = events.find((e) => e.kind === "completed");
    expect(completed?.finalMessage).toBe("echo:hi");
  });

  test("rich turn maps commentary, tool call/result, usage, and final message", async () => {
    const backend = fakeBackend("rich-turn");
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );
    expect(events.map((e) => e.kind)).toEqual([
      "started",
      "thinking",
      "tool_call",
      "tool_result",
      "usage",
      "assistant_message",
      "completed",
    ]);
    expect(events[1]).toEqual({ kind: "thinking", text: "planning the work" });
    expect(events[2]).toMatchObject({ kind: "tool_call", name: "ls /tmp" });
    expect(events[3]).toMatchObject({
      kind: "tool_result",
      name: "ls /tmp",
      result: { output: "a.txt\n", exitCode: 0 },
    });
    expect(events[4]).toMatchObject({
      kind: "usage",
      model: "gpt-fake",
      inputTokens: 1200,
      outputTokens: 50,
      cacheReadTokens: 200,
      reasoningTokens: 30,
      contextWindowTokens: 272000,
    });
    expect(events[5]).toEqual({ kind: "assistant_message", text: "final answer", final: true });
    expect(events[6]).toEqual({ kind: "completed", finalMessage: "final answer" });
  });

  test("resume run goes through thread/resume with the persisted thread id", async () => {
    const backend = fakeBackend("resume-echo", {
      planOverrides: {
        resumeThreadId: "persisted-77",
        threadParams: { threadId: "persisted-77", model: "gpt-fake" },
      },
    });
    const session = mkSession();
    session.backendSessionId = "persisted-77";
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" }),
    );
    expect(events[0]).toEqual({ kind: "started", backendSessionId: "persisted-77" });
    const completed = events.find((e) => e.kind === "completed");
    expect(completed?.finalMessage).toBe("resumed:persisted-77");
  });

  test("announces a route-triggered fresh thread after thread/start succeeds", async () => {
    const notice = "检测到 Codex 路由切换；已自动开启新会话。";
    const backend = fakeBackend("happy", {
      planOverrides: { routeChangeNotice: notice },
    });

    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );

    expect(events[0]).toEqual({ kind: "started", backendSessionId: "fake-thread-1" });
    expect(events[1]).toEqual({ kind: "thinking", text: notice });
  });

  test("failed turn surfaces the raw API error exactly once", async () => {
    const backend = fakeBackend("turn-error");
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toEqual([
      {
        kind: "error",
        message: "The model `gpt-fake` is currently at capacity",
        recoverable: false,
      },
    ]);
  });

  test("willRetry errors are suppressed; the terminal turn failure is surfaced", async () => {
    const backend = fakeBackend("turn-error-quiet");
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toEqual([
      { kind: "error", message: "stream disconnected before completion", recoverable: false },
    ]);
  });

  test("turn completing with no assistant message yields a stable error", async () => {
    const backend = fakeBackend("empty-completion");
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );
    expect(events.filter((e) => e.kind === "completed")).toEqual([]);
    expect(events.filter((e) => e.kind === "error")).toEqual([
      {
        kind: "error",
        message: "codex returned empty completion (no agentMessage item)",
        recoverable: false,
      },
    ]);
  });

  test("injects SM_SESSION_NAME env var from session.name", async () => {
    const backend = fakeBackend("env");
    const session = mkSession();
    let finalMessage = "";
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      if (e.kind === "completed") finalMessage = e.finalMessage;
    }
    expect(finalMessage).toBe(`SM_SESSION_NAME=${session.name}`);
  });

  test("injects a caller attestation the runtime can resolve back to this session", async () => {
    const registry = createCallerAttestationRegistry();
    const backend = fakeBackend("attest", { callerAttestations: registry });
    const session = mkSession();
    let token = "";
    let resolvedDuringRun: unknown = null;

    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      if (e.kind === "completed") {
        token = e.finalMessage.replace("SM_CALLER_ATTESTATION=", "");
        // Resolve while the run is still live: this is the window in which a
        // tool the agent shells out to would present the attestation.
        resolvedDuringRun = registry.resolve(token);
      }
    }

    expect(token).not.toBe("");
    expect(token).not.toContain(session.name);
    expect(resolvedDuringRun).toEqual({
      sessionId: session.id,
      sessionName: session.name,
      backend: "codex",
      issuedAt: expect.any(Number),
    });
  });

  test("revokes the attestation when the run ends, bounding the leak window", async () => {
    const registry = createCallerAttestationRegistry();
    const backend = fakeBackend("attest", { callerAttestations: registry });
    let token = "";
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      if (e.kind === "completed") token = e.finalMessage.replace("SM_CALLER_ATTESTATION=", "");
    }
    expect(registry.resolve(token)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  test("uses SM_CODEX_CLI_PATH as the default command", async () => {
    process.env["SM_CODEX_CLI_PATH"] = FAKE;
    const backend = new CodexBackend({
      codexStateDbPath: null,
      buildRunPlan: () => fakePlan("happy"),
    });
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );
    expect(events.map((e) => e.kind)).toContain("started");
    expect(events.map((e) => e.kind)).toContain("completed");
  });

  test("default builder reports normalized effort through the production observer", async () => {
    const observed: unknown[] = [];
    const session = mkSession();
    session.model = "gpt-5.4";
    session.effort = "ultra";
    const backend = new CodexBackend({
      command: FAKE,
      codexStateDbPath: null,
      onEffortNormalized: (evidence) => observed.push(evidence),
    });

    for await (const _event of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "secret prompt" })) {
      // drain: the fake ignores the production app-server argv
    }

    expect(observed).toEqual([{
      kind: "codex_effort_normalized",
      model: "gpt-5.4",
      persistedEffort: "ultra",
      cliEffort: "xhigh",
    }]);
  });

  test.each([
    { model: "gpt-5.6-sol", effort: "ultra" as const },
    { model: "gpt-5.6-terra", effort: "max" as const },
    { model: "gpt-5.4", effort: null },
  ])("default builder does not report unchanged or null effort: $model/$effort", async ({ model, effort }) => {
    const observed: unknown[] = [];
    const session = mkSession();
    session.model = model;
    session.effort = effort;
    const backend = new CodexBackend({
      command: FAKE,
      codexStateDbPath: null,
      onEffortNormalized: (evidence) => observed.push(evidence),
    });

    for await (const _event of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "secret prompt" })) {
      // drain
    }

    expect(observed).toEqual([]);
  });

  test("fails cleanly before spawn when codex command is missing", async () => {
    const buildRunPlan = vi.fn(() => fakePlan("happy"));
    const backend = new CodexBackend({
      command: "missing-codex-for-test",
      buildRunPlan,
      commandHealthCheck: async () => ({
        kind: "fail",
        reason: "missing",
        error: "spawn missing-codex-for-test ENOENT",
      }),
    });

    const events: AgentEvent[] = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e);
    }

    expect(buildRunPlan).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        kind: "error",
        message: expect.stringContaining("command \"missing-codex-for-test\" was not found"),
        recoverable: false,
      },
    ]);
    const error = events.find((event) => event.kind === "error");
    expect(error?.message).toContain("SM_CODEX_CLI_PATH");
    expect(error?.message).toContain("reinstall @openai/codex");
  });

  test("fails cleanly before spawn when codex command is unusable", async () => {
    const buildRunPlan = vi.fn(() => fakePlan("happy"));
    const backend = new CodexBackend({
      command: FAKE,
      buildRunPlan,
      commandHealthCheck: async () => ({
        kind: "fail",
        reason: "unusable",
        error: "Command failed: codex --version",
      }),
    });

    const events: AgentEvent[] = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e);
    }

    expect(buildRunPlan).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        kind: "error",
        message: expect.stringContaining("failed the pre-run --version probe"),
        recoverable: false,
      },
    ]);
  });

  test("disables card ask before spawn when broker health check fails", async () => {
    const captured: RunInput[] = [];
    const backend = fakeBackend("happy", {
      capturePlanInputs: captured,
      cardAskHealthCheck: async () => false,
    });

    for await (const _e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "hi",
      cardAskEnabled: true,
      cardAskChatId: "oc_card_ask",
    })) {
      // drain
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBeUndefined();
    expect(captured[0].cardAskChatId).toBeUndefined();
  });

  test("archives missing latest cwd rollout before owner run starts", async () => {
    const dir = mkTempDir();
    const dbPath = join(dir, "state_5.sqlite");
    const existingRollout = join(dir, "rollout-existing.jsonl");
    writeFileSync(existingRollout, "{}\n");
    const db = createCodexStateDb(dbPath);
    insertThread(db, {
      id: "fresh-thread",
      cwd: "/tmp",
      rolloutPath: existingRollout,
      recencyAtMs: 100,
    });
    insertThread(db, {
      id: "stale-thread-older",
      cwd: "/tmp",
      rolloutPath: join(dir, "missing-rollout-older.jsonl"),
      recencyAtMs: 150,
    });
    insertThread(db, {
      id: "stale-thread",
      cwd: "/tmp",
      rolloutPath: join(dir, "missing-rollout.jsonl"),
      recencyAtMs: 200,
    });
    const captured: RunInput[] = [];
    const backend = fakeBackend("happy", {
      capturePlanInputs: captured,
      codexStateDbPath: dbPath,
    });

    for await (const _e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      // drain
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].session.backendSessionId).toBeNull();
    expect(getArchived(db, "stale-thread")).toBe(1);
    expect(getArchived(db, "stale-thread-older")).toBe(1);
    expect(getArchived(db, "fresh-thread")).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips stale resume id when its rollout file is missing", async () => {
    const dir = mkTempDir();
    const dbPath = join(dir, "state_5.sqlite");
    const db = createCodexStateDb(dbPath);
    insertThread(db, {
      id: "stale-resume",
      cwd: "/tmp",
      rolloutPath: join(dir, "missing-resume-rollout.jsonl"),
      recencyAtMs: 100,
    });
    const captured: RunInput[] = [];
    const backend = fakeBackend("happy", {
      capturePlanInputs: captured,
      codexStateDbPath: dbPath,
    });
    const session = mkSession();
    session.backendSessionId = "stale-resume";

    for await (const _e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      // drain
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].session.backendSessionId).toBeNull();
    expect(getArchived(db, "stale-resume")).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("steer injects into the active turn and confirms the exact expectedTurnId", async () => {
    const backend = fakeBackend("steer-hold");
    const session = mkSession();
    const events: AgentEvent[] = [];
    let steerResult: unknown = null;
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      events.push(e);
      if (e.kind === "thinking" && e.text === "turn-open") {
        steerResult = await backend.steer({
          sessionId: session.id,
          expectedMessageRunId: TEST_MESSAGE_RUN_ID,
          text: "nudge please",
        });
      }
    }
    expect(steerResult).toEqual({ accepted: true, backendTurnId: "fake-turn-1" });
    const completed = events.find((e) => e.kind === "completed");
    expect(completed?.finalMessage).toBe("steered:nudge please");
  });

  test("steer rejects when the response confirms a different turn id", async () => {
    const backend = fakeBackend("steer-mismatch");
    const session = mkSession();
    let steerError: unknown = null;
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      if (e.kind === "thinking" && e.text === "turn-open") {
        steerError = await backend.steer({
          sessionId: session.id,
          expectedMessageRunId: TEST_MESSAGE_RUN_ID,
          text: "nudge",
        }).catch((err: unknown) => err);
        await backend.cancel(session.id);
      }
    }
    expect(steerError).toBeInstanceOf(Error);
    expect((steerError as Error).message).toContain(
      "codex turn/steer confirmed a different turn (expected fake-turn-1, got some-other-turn)",
    );
  }, 15_000);

  test("steer rejects when the server refuses the expectedTurnId precondition", async () => {
    const backend = fakeBackend("steer-error");
    const session = mkSession();
    let steerError: unknown = null;
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      if (e.kind === "thinking" && e.text === "turn-open") {
        steerError = await backend.steer({
          sessionId: session.id,
          expectedMessageRunId: TEST_MESSAGE_RUN_ID,
          text: "nudge",
        }).catch((err: unknown) => err);
        await backend.cancel(session.id);
      }
    }
    expect(steerError).toBeInstanceOf(Error);
    expect((steerError as Error).message).toContain("expectedTurnId does not match the active turn");
  }, 15_000);

  test("steer rejects on a completion race instead of pretending acceptance", async () => {
    const backend = fakeBackend("steer-race");
    const session = mkSession();
    let steerError: unknown = null;
    const events: AgentEvent[] = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      events.push(e);
      if (e.kind === "thinking" && e.text === "turn-open") {
        steerError = await backend.steer({
          sessionId: session.id,
          expectedMessageRunId: TEST_MESSAGE_RUN_ID,
          text: "too late",
        }).catch((err: unknown) => err);
      }
    }
    expect(steerError).toBeInstanceOf(Error);
    // The turn completed while the steer was in flight; the pending request
    // is rejected when the per-run app-server shuts down, never accepted.
    expect((steerError as Error).message).toMatch(/failed before response|already completed/u);
    const completed = events.find((e) => e.kind === "completed");
    expect(completed?.finalMessage).toBe("raced to completion");
  });

  test("steer rejects a stale messageRunId without touching the active turn", async () => {
    const backend = fakeBackend("slow");
    const session = mkSession();
    let steerError: unknown = null;
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      if (e.kind === "thinking" && e.text === "turn-open") {
        steerError = await backend.steer({
          sessionId: session.id,
          expectedMessageRunId: asMessageRunId("mr_someone_else"),
          text: "nudge",
        }).catch((err: unknown) => err);
        await backend.cancel(session.id);
      }
    }
    expect(steerError).toBeInstanceOf(Error);
    expect((steerError as Error).message).toContain("stale messageRunId");
  }, 15_000);

  test("steer rejects when no run is active for the session", async () => {
    const backend = fakeBackend("happy");
    await expect(
      backend.steer({
        sessionId: asSessionId("s1"),
        expectedMessageRunId: TEST_MESSAGE_RUN_ID,
        text: "nudge",
      }),
    ).rejects.toThrow("no active codex run for this session");
  });

  test("steer rejects after the run has completed and been cleaned up", async () => {
    const backend = fakeBackend("happy");
    const session = mkSession();
    await collect(backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" }));
    await expect(
      backend.steer({
        sessionId: session.id,
        expectedMessageRunId: TEST_MESSAGE_RUN_ID,
        text: "nudge",
      }),
    ).rejects.toThrow("no active codex run for this session");
  });

  test("cancel prefers turn/interrupt and surfaces cancelled-by-user", async () => {
    const backend = fakeBackend("slow");
    const session = mkSession();
    const events: AgentEvent[] = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      events.push(e);
      if (e.kind === "thinking" && e.text === "turn-open") {
        await backend.cancel(session.id);
      }
    }
    expect(events.filter((e) => e.kind === "error")).toEqual([
      { kind: "error", message: "cancelled by user", recoverable: false },
    ]);
  }, 15_000);

  test("cancel falls back to killing the process group when interrupt is ignored", async () => {
    const backend = fakeBackend("slow-ignore-interrupt");
    const session = mkSession();
    const events: AgentEvent[] = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      events.push(e);
      if (e.kind === "thinking" && e.text === "turn-open") {
        await backend.cancel(session.id);
      }
    }
    expect(events.filter((e) => e.kind === "error")).toEqual([
      { kind: "error", message: "cancelled by user", recoverable: false },
    ]);
  }, 20_000);

  test("inactivity timeout kills the run with the existing [TIMEOUT] error", async () => {
    const backend = fakeBackend("slow");
    const session = mkSession();
    session.inactivityTimeoutS = 1;
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" }),
    );
    const error = events.find((e) => e.kind === "error");
    expect(error?.message).toContain("[TIMEOUT] inactivity: no output for 1s");
  }, 15_000);

  test("a killed run still commits the last observed token usage", async () => {
    // exec-era parity: token_count lines were committed incrementally, so a
    // timed-out run kept its partial usage rows. The app-server path must not
    // lose the run's tokens just because turn/completed never arrived.
    const backend = fakeBackend("usage-then-hang");
    const session = mkSession();
    session.inactivityTimeoutS = 1;
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" }),
    );
    expect(events.some((e) => e.kind === "error" && e.message.includes("[TIMEOUT]"))).toBe(true);
    expect(events.find((e) => e.kind === "usage")).toMatchObject({
      kind: "usage",
      model: "gpt-fake",
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 300,
      reasoningTokens: 20,
      contextWindowTokens: 272000,
    });
  }, 15_000);

  test("process death before turn completion surfaces stderr as the run error", async () => {
    const backend = new CodexBackend({
      command: FAKE,
      codexStateDbPath: null,
      buildRunPlan: () => fakePlan("close-mid-request"),
    });
    const events = await collect(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" }),
    );
    const error = events.find((e) => e.kind === "error");
    expect(error?.message).toContain("fake app-server exploding");
  });
});

function mkTempDir(): string {
  const dir = join(tmpdir(), `sm-codex-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createCodexStateDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      recency_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER,
      created_at_ms INTEGER
    );
  `);
  return db;
}

function insertThread(
  db: Database.Database,
  input: { id: string; cwd: string; rolloutPath: string; recencyAtMs: number },
): void {
  db.prepare(`
    INSERT INTO threads (id, rollout_path, cwd, archived, recency_at_ms, updated_at_ms, created_at_ms)
    VALUES (@id, @rolloutPath, @cwd, 0, @recencyAtMs, @recencyAtMs, @recencyAtMs)
  `).run(input);
}

function getArchived(db: Database.Database, id: string): number {
  return db.prepare("SELECT archived FROM threads WHERE id = ?").pluck().get(id) as number;
}
