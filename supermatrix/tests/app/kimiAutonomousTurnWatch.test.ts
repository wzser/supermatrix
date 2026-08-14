// tests/app/kimiAutonomousTurnWatch.test.ts
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  startKimiAutonomousTurnWatch,
  type KimiAutonomousTurnWatchDeps,
} from "../../src/app/kimiAutonomousTurnWatch.ts";
import type { ConsumeInput } from "../../src/app/replier.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("s1"), name: "foo", alias: "", avatar: "", category: "", fpManaged: null,
    scope: "user", backend: "kimi", model: null, effort: null, thinking: false, modelLocked: false,
    workdir: asAbsolutePath("/tmp"), backendSessionId: "acp-sid-1", chatName: null,
    purpose: "", status: "idle", parentId: null, depth: 0,
    inactivityTimeoutS: null, maxRuntimeS: null, childType: null,
    triggerKind: null, postIdentity: null, callerInvocation: null,
    continuationHook: null, capabilityPayload: null,
    createdAt: asTimestamp(1), updatedAt: asTimestamp(1), ...overrides,
  };
}

const TURN_PROMPT = JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "hi" }] }) + "\n";
const TURN_STEER = JSON.stringify({ type: "turn.steer", input: [{ type: "text", text: "<notification/>" }] }) + "\n";
// kimi-code 0.33.0 shape: an idle-launched autonomous turn is recorded as
// turn.prompt carrying the <notification> envelope instead of turn.steer
// (2026-08-07 aftersale-web turns 15/16 — invisible to the old steer-only
// scan, busy-rejecting 5 SM runs).
const TURN_NOTIFICATION_PROMPT = JSON.stringify({
  type: "turn.prompt",
  input: [{ type: "text", text: "<notification id=\"task:bash-x:completed\" category=\"task\" type=\"task.completed\" source_kind=\"background_task\" source_id=\"bash-x\">\n轮询 completed." }],
}) + "\n";
const STEP = JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin", turnId: "2", step: 1 } }) + "\n";
const TEXT_PART = JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", turnId: "2", part: { type: "text", text: "后台做完了" } } }) + "\n";
// Background Agent tool.result as recorded in the main wire when the CLI
// launches a run_in_background subagent (shape verified on a live session).
const BG_SPAWN = JSON.stringify({
  type: "context.append_loop_event",
  event: {
    type: "tool.result", turnId: "18", toolCallId: "tc1",
    result: { output: "task_id: agent-t1\nstatus: running\nagent_id: agent-1\nactual_subagent_type: coder" },
  },
}) + "\n";
// Completion notification arriving mid-turn as a context message (the
// turn.steer envelope for the same notification is the auto-turn path).
const BG_COMPLETE = JSON.stringify({
  type: "context.append_message",
  message: {
    role: "user",
    content: [{ type: "text", text: "<notification id=\"task:agent-t1:completed\" category=\"task\" type=\"task.completed\" source_kind=\"background_task\" source_id=\"agent-t1\" agent_id=\"agent-1\">\n片4 completed." }],
  },
}) + "\n";

type Harness = {
  wirePath: string;
  agentWirePath: string;
  session: Session;
  store: {
    findRunningMessageRunBySession: ReturnType<typeof vi.fn>;
    updateSessionStatus: ReturnType<typeof vi.fn>;
    listActiveSessionsByBackend: ReturnType<typeof vi.fn>;
    findBySession: ReturnType<typeof vi.fn>;
    getActiveBranch: ReturnType<typeof vi.fn>;
  };
  consumeInputs: ConsumeInput[];
  consumeDone: string[];
  events: Array<{ kind: string; to?: string }>;
  start: (overrides?: Partial<KimiAutonomousTurnWatchDeps>) => () => void;
};

function mkHarness(): Harness {
  const kimiHome = mkdtempSync(join(tmpdir(), "kimi-watch-"));
  const sessionDir = join(kimiHome, "sessions", "wd_x", "session_abc");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  mkdirSync(join(sessionDir, "agents", "agent-1"), { recursive: true });
  writeFileSync(
    join(kimiHome, "session_index.jsonl"),
    JSON.stringify({ sessionId: "acp-sid-1", sessionDir }) + "\n",
  );
  const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
  const agentWirePath = join(sessionDir, "agents", "agent-1", "wire.jsonl");

  const session = mkSession();
  const store = {
    findRunningMessageRunBySession: vi.fn(async () => null),
    updateSessionStatus: vi.fn(async () => {}),
    listActiveSessionsByBackend: vi.fn(async () => [session]),
    findBySession: vi.fn(async () => ({ groupId: "oc_group1", sessionId: session.id })),
    getActiveBranch: vi.fn(async () => ({ name: "main" })),
  };
  const consumeInputs: ConsumeInput[] = [];
  const consumeDone: string[] = [];
  const events: Array<{ kind: string; to?: string }> = [];
  // Live clock: quiet detection compares file mtimes against real time.
  const clock = { now: () => asTimestamp(Date.now()) };

  const start = (overrides: Partial<KimiAutonomousTurnWatchDeps> = {}) =>
    startKimiAutonomousTurnWatch({
      store: store as any,
      replier: {
        consume: async (input: ConsumeInput) => {
          consumeInputs.push(input);
          for await (const _ of input.stream) { /* drain */ }
          consumeDone.push(String(input.runId));
          return { finalMessage: "", cardId: "c1", runStatus: "done", streamLog: [] } as any;
        },
      },
      clock: clock as any,
      logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) } as any,
      eventBus: { publish: async (e: { kind: string; to?: string }) => { events.push(e); } } as any,
      kimiHome,
      pollMs: 50,
      quietMs: 300,
      streamPollMs: 40,
      ...overrides,
    });

  return { wirePath, agentWirePath, session, store, consumeInputs, consumeDone, events, start };
}

async function waitFor(cond: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor: condition not met within timeout");
}

describe("kimiAutonomousTurnWatch", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  test("steer-latest wire with fresh activity → busy + event + replier card titled auto-turn-<id>", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + STEP + TURN_STEER + STEP + TEXT_PART);
    stop = h.start();
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "busy"));
    expect(h.events.some((e) => e.kind === "session_status_changed" && e.to === "busy")).toBe(true);
    await waitFor(() => h.consumeInputs.length === 1);
    const input = h.consumeInputs[0]!;
    expect(input.runId).toBe("auto-turn-2");
    expect(input.groupId).toBe("oc_group1");
    expect(input.sessionBackend).toBe("kimi");
    expect(input.branchName).toBe("main");
    expect(input.completedTemplate).toBe("violet");
  });

  test("autonomous turn gone quiet → watcher-owned busy released", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + TURN_STEER + STEP);
    stop = h.start();
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "busy"));
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "idle"));
    expect(h.events.some((e) => e.kind === "session_status_changed" && e.to === "idle")).toBe(true);
  });

  test("prompt-latest wire (SM-owned turn) → stays idle, no card", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_STEER + STEP + TURN_PROMPT + STEP);
    stop = h.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.store.updateSessionStatus.mock.calls.length).toBe(0);
    expect(h.consumeInputs.length).toBe(0);
  });

  test("0.33 notification-prompt latest → busy + auto-turn card (idle-launched autonomous turn)", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + STEP + TURN_NOTIFICATION_PROMPT + STEP + TEXT_PART);
    stop = h.start();
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "busy"));
    expect(h.events.some((e) => e.kind === "session_status_changed" && e.to === "busy")).toBe(true);
    await waitFor(() => h.consumeInputs.length === 1);
    const input = h.consumeInputs[0]!;
    expect(input.runId).toBe("auto-turn-2");
    expect(input.completedTemplate).toBe("violet");
  });

  test("running SM run → watcher does not mark busy", async () => {
    const h = mkHarness();
    h.store.findRunningMessageRunBySession = vi.fn(async () => ({ id: "mr_x" }));
    writeFileSync(h.wirePath, TURN_STEER + STEP);
    stop = h.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.store.updateSessionStatus.mock.calls.length).toBe(0);
    expect(h.consumeInputs.length).toBe(0);
  });

  test("incremental catch-up: steer appended after seeding flips session busy", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + STEP);
    stop = h.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.store.updateSessionStatus.mock.calls.length).toBe(0);
    appendFileSync(h.wirePath, TURN_STEER + STEP);
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "busy"));
  });

  test("subagent wire activity keeps the episode alive while main wire is quiet", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + TURN_STEER + STEP);
    writeFileSync(h.agentWirePath, STEP);
    stop = h.start({ quietMs: 400 });
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "busy"));
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 150));
      appendFileSync(h.agentWirePath, STEP);
    }
    expect(h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "idle")).toBe(false);
  });

  test("session already busy (dispatcher-owned) → watcher does not take it or stream a card", async () => {
    const h = mkHarness();
    h.session = mkSession({ status: "busy" });
    h.store.listActiveSessionsByBackend = vi.fn(async () => [h.session]);
    writeFileSync(h.wirePath, TURN_STEER + STEP);
    stop = h.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(h.store.updateSessionStatus.mock.calls.length).toBe(0);
    expect(h.consumeInputs.length).toBe(0);
  });

  test("a second episode after release gets a fresh card", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + TURN_STEER + STEP);
    stop = h.start();
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "busy"));
    await waitFor(() => h.store.updateSessionStatus.mock.calls.some((c) => c[1] === "idle"));
    await waitFor(() => h.consumeInputs.length === 1);
    appendFileSync(h.wirePath, TURN_STEER + STEP + TEXT_PART);
    await waitFor(() => h.consumeInputs.length === 2);
    expect(h.store.updateSessionStatus.mock.calls.filter((c) => c[1] === "busy").length).toBe(2);
  });

  test("background task spawn → bg-task card, session stays idle; completion finalizes the card", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + BG_SPAWN);
    writeFileSync(h.agentWirePath, STEP);
    stop = h.start();
    await waitFor(() => h.consumeInputs.length === 1);
    const input = h.consumeInputs[0]!;
    expect(input.runId).toBe("bg-task-agent-t1");
    expect(input.groupId).toBe("oc_group1");
    expect(input.sessionBackend).toBe("kimi");
    expect(input.completedTemplate).toBe("violet");
    // A running background task must NOT mark the session busy — the main
    // agent is genuinely free to chat.
    expect(h.store.updateSessionStatus.mock.calls.length).toBe(0);
    // The stream outlives the ordinary quiet window while the task runs.
    appendFileSync(h.agentWirePath, TEXT_PART);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.consumeDone.length).toBe(0);
    // Completion notification in the main wire finalizes the bg card.
    appendFileSync(h.wirePath, BG_COMPLETE);
    await waitFor(() => h.consumeDone.includes("bg-task-agent-t1"));
  });

  test("reseed with spawn+completion already in history → no bg card", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + BG_SPAWN + BG_COMPLETE);
    writeFileSync(h.agentWirePath, STEP);
    stop = h.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(h.consumeInputs.length).toBe(0);
  });

  test("in-flight bg task is not relaunched after an SM-run state reseed", async () => {
    const h = mkHarness();
    writeFileSync(h.wirePath, TURN_PROMPT + BG_SPAWN);
    writeFileSync(h.agentWirePath, STEP);
    stop = h.start();
    await waitFor(() => h.consumeInputs.length === 1);
    // An SM run owns the session for a while (states are deleted per tick).
    h.store.findRunningMessageRunBySession = vi.fn(async () => ({ id: "mr_x" }));
    await new Promise((r) => setTimeout(r, 200));
    h.store.findRunningMessageRunBySession = vi.fn(async () => null);
    // Post-run reseed re-reads the whole wire, including the old spawn.
    appendFileSync(h.wirePath, STEP);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.consumeInputs.length).toBe(1);
  });
});
