import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";
import { createChildSessionService } from "../../src/app/childSession.ts";
import { startApiServer, type ApiDeps } from "../../src/cli/apiServer.ts";
import type { AgentBackend, RunInput } from "../../src/ports/AgentBackend.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Logger } from "../../src/ports/Logger.ts";

function makeControlledBackend(): AgentBackend & {
  prompts: string[];
  releaseNext(finalMessage?: string): void;
  waitForRunCount(count: number): Promise<void>;
} {
  const prompts: string[] = [];
  const releases: Array<(finalMessage: string) => void> = [];
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  return {
    kind: "claude",
    prompts,
    releaseNext(finalMessage = "done") {
      const release = releases.shift();
      if (!release) throw new Error("no backend run waiting");
      release(finalMessage);
    },
    async waitForRunCount(count: number) {
      while (prompts.length < count) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async *run(input: RunInput): AsyncIterable<AgentEvent> {
      const finalMessagePromise = new Promise<string>((resolve) => releases.push(resolve));
      prompts.push(input.prompt);
      notify();
      yield { kind: "started", backendSessionId: `bks-e2e-${prompts.length}` };
      const finalMessage = await finalMessagePromise;
      yield { kind: "assistant_message", text: finalMessage, final: true };
      yield { kind: "completed", finalMessage };
    },
    async cancel() {},
  };
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

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

describe("e2e spawn throttle queue", () => {
  let dir: string;
  let store: SqliteBindingStore;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sm-spawn-throttle-queue-e2e-"));
    store = new SqliteBindingStore(join(dir, "supermatrix.db"));
    await store.init();
    await store.createSession({
      id: asSessionId("sess_caller"),
      name: "caller",
      scope: "user",
      backend: "claude",
      workdir: asAbsolutePath("/ws/caller"),
      purpose: "",
      createdAt: asTimestamp(Date.now()),
    });
    await store.createSession({
      id: asSessionId("sess_target"),
      name: "target",
      scope: "user",
      backend: "claude",
      workdir: asAbsolutePath("/ws/target"),
      purpose: "",
      createdAt: asTimestamp(Date.now()),
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("queues throttled API spawns and runs them without caller retry", async () => {
    const backend = makeControlledBackend();
    const delivered: Array<{ childName: string; finalMessage: string; sinkKinds: string[] }> = [];
    const childSession = createChildSessionService({
      store,
      backendRegistry: {
        get: () => backend,
        cancel: async () => {},
      },
      clock: { now: () => asTimestamp(Date.now()) },
      idFactory: (() => {
        let i = 0;
        return () => `sess_child_e2e_${++i}`;
      })(),
      maxConcurrent: 1,
      logger: noopLogger,
      deliverSinks: async (session, finalMessage) => {
        delivered.push({
          childName: session.name,
          finalMessage,
          sinkKinds: (session.capabilityPayload?.resultSinks ?? []).map((sink) => sink.kind),
        });
        return { delivered: [] };
      },
    });
    const deps: ApiDeps = {
      store,
      closureDb: store.db,
      childSession,
      runOnSession: async () => {
        throw new Error("runOnSession should not be called");
      },
      notifier: {
        async notify() {
          throw new Error("notify should not be called");
        },
      },
      logger: noopLogger,
    };
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const first = fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "target", from: "caller", prompt: "first" }),
    });
    await backend.waitForRunCount(1);

    const queuedResponses = await Promise.all([
      fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "target", from: "caller", prompt: "second" }),
      }),
      fetch(`${baseUrl}/api/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "target", from: "caller", prompt: "third" }),
      }),
    ]);
    const queuedBodies = await Promise.all(
      queuedResponses.map((res) => res.json() as Promise<{ ok: boolean; status: string; ref: string; comm_id: string }>),
    );
    expect(queuedResponses.map((res) => res.status)).toEqual([200, 200]);
    expect(queuedBodies).toEqual([
      expect.objectContaining({ ok: true, status: "queued", ref: expect.stringMatching(/^spawnq_/), comm_id: expect.stringMatching(/^comm_/) }),
      expect.objectContaining({ ok: true, status: "queued", ref: expect.stringMatching(/^spawnq_/), comm_id: expect.stringMatching(/^comm_/) }),
    ]);

    backend.releaseNext("first done");
    const firstBody = (await (await first).json()) as { ok: boolean; finalMessage: string };
    expect(firstBody).toMatchObject({ ok: true, finalMessage: "first done" });

    await backend.waitForRunCount(2);
    backend.releaseNext("second done");
    await backend.waitForRunCount(3);
    backend.releaseNext("third done");

    await eventually(() => {
      expect(backend.prompts).toEqual(["first", "second", "third"]);
      const queueRows = store.db
        .prepare("SELECT status FROM spawn_queue ORDER BY created_at ASC")
        .all() as Array<{ status: string }>;
      expect(queueRows.map((row) => row.status)).toEqual(["dispatched", "dispatched"]);
      const completed = store.db
        .prepare("SELECT COUNT(*) AS c FROM cross_session_log WHERE status = 'completed'")
        .get() as { c: number };
      expect(completed.c).toBe(3);
      expect(delivered.map((row) => row.finalMessage)).toEqual(["first done", "second done", "third done"]);
      const queuedDeliveries = delivered.filter((row) => row.finalMessage !== "first done");
      expect(queuedDeliveries.every((row) => row.sinkKinds.includes("pollable_endpoint"))).toBe(true);
      expect(queuedDeliveries.every((row) => row.sinkKinds.includes("parent_continuation_inject"))).toBe(false);
    });
  });
});
