import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { asAbsolutePath, asMessageRunId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { SessionRuntimeConfigMutation } from "../../../src/ports/BindingStore.ts";
import { RuntimeConfigConflictError } from "../../../src/ports/BindingStore.ts";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import { createTempStore } from "./helpers.ts";

const CREATED_AT = asTimestamp(1_700_000_000_000);

function mutation(
  sessionId: string,
  overrides: Partial<SessionRuntimeConfigMutation> = {},
): SessionRuntimeConfigMutation {
  return {
    sessionId: asSessionId(sessionId),
    expected: { backend: "claude", model: null, effort: null, backendSessionId: null },
    after: { backend: "codex", model: "gpt-5", effort: "high", backendSessionId: "thread-1" },
    guard: { kind: "idle" },
    audit: {
      id: `audit-${sessionId}`,
      trigger: "command",
      requested: { backend: "codex", model: "gpt-5", effort: "high" },
      decision: "apply",
      reason: "test",
      catalogSource: "session-catalog.json",
      catalogFingerprint: "sha256:test",
      createdAt: asTimestamp(1_700_000_001_000),
    },
    ...overrides,
  };
}

async function seedSession(store: Awaited<ReturnType<typeof createTempStore>>["store"], id: string) {
  await store.createSession({
    id: asSessionId(id),
    name: id,
    scope: "user",
    backend: "claude",
    workdir: asAbsolutePath(`/tmp/${id}`),
    purpose: "test",
    createdAt: CREATED_AT,
  });
  await store.updateSessionStatus(asSessionId(id), "idle", CREATED_AT);
}

describe("SqliteBindingStore session runtime config mutations", () => {
  test("guard-only admission rejects busy or stale tuples and returns the committed snapshot", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      const expected = { backend: "claude" as const, model: null, effort: null, backendSessionId: null };
      await expect(store.guardIdleSessionRuntimeConfig(asSessionId("s1"), expected)).resolves.toEqual(expected);
      await expect(store.listSessionRuntimeConfigAudit(asSessionId("s1"))).resolves.toEqual([]);
      await expect(store.guardIdleSessionRuntimeConfig(asSessionId("s1"), { ...expected, model: "stale" }))
        .rejects.toBeInstanceOf(RuntimeConfigConflictError);
      await store.updateSessionStatus(asSessionId("s1"), "busy", asTimestamp(3));
      await expect(store.guardIdleSessionRuntimeConfig(asSessionId("s1"), expected))
        .rejects.toBeInstanceOf(RuntimeConfigConflictError);
    } finally {
      await cleanup();
    }
  });

  test.each(["deleted", "missing"] as const)("guard-only admission rejects %s sessions", async (state) => {
    const { store, cleanup } = await createTempStore();
    try {
      if (state === "deleted") {
        await seedSession(store, "s1");
        await store.updateSessionStatus(asSessionId("s1"), "deleted", CREATED_AT);
      }
      const expected = { backend: "claude" as const, model: null, effort: null, backendSessionId: null };
      await expect(store.guardIdleSessionRuntimeConfig(asSessionId("s1"), expected))
        .rejects.toBeInstanceOf(RuntimeConfigConflictError);
    } finally {
      await cleanup();
    }
  });

  test("updates config and inserts its audit row atomically", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");

      await expect(store.applySessionRuntimeConfigMutations([mutation("s1")])).resolves.toEqual({ updated: 1 });

      expect(await store.findSessionById(asSessionId("s1"))).toMatchObject({
        backend: "codex",
        model: "gpt-5",
        effort: "high",
        backendSessionId: "thread-1",
      });
      expect(await store.listSessionRuntimeConfigAudit(asSessionId("s1"))).toEqual([
        expect.objectContaining({
          id: "audit-s1",
          before: { backend: "claude", model: null, effort: null, resumeCleared: true },
          requested: { backend: "codex", model: "gpt-5", effort: "high" },
          after: { backend: "codex", model: "gpt-5", effort: "high", resumeCleared: false },
        }),
      ]);
      const raw = store.db.prepare(
        "SELECT before_json, after_json FROM session_runtime_config_audit WHERE id = ?",
      ).get("audit-s1") as { before_json: string; after_json: string };
      expect(raw.before_json).not.toContain("backendSessionId");
      expect(raw.after_json).not.toContain("thread-1");
    } finally {
      await cleanup();
    }
  });

  test("persists only allowlisted requested runtime config keys after an unsafe cast", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      const unsafeRequested = {
        backend: "codex",
        model: "gpt-5",
        effort: "high",
        prompt: "secret prompt",
        token: "secret token",
        auth: { apiKey: "secret key" },
      } as unknown as SessionRuntimeConfigMutation["audit"]["requested"];

      await store.applySessionRuntimeConfigMutations([
        mutation("s1", { audit: { ...mutation("s1").audit, requested: unsafeRequested } }),
      ]);

      expect((await store.listSessionRuntimeConfigAudit(asSessionId("s1")))[0]?.requested).toEqual({
        backend: "codex",
        model: "gpt-5",
        effort: "high",
      });
    } finally {
      await cleanup();
    }
  });

  test("idle guard rejects a busy session", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      await store.updateSessionStatus(asSessionId("s1"), "busy", CREATED_AT);
      await expect(store.applySessionRuntimeConfigMutations([mutation("s1")])).rejects.toBeInstanceOf(RuntimeConfigConflictError);
    } finally {
      await cleanup();
    }
  });

  test("idle guard rejects a deleted session", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      await store.updateSessionStatus(asSessionId("s1"), "deleted", CREATED_AT);
      await expect(store.applySessionRuntimeConfigMutations([mutation("s1")])).rejects.toBeInstanceOf(RuntimeConfigConflictError);
      expect(await store.listSessionRuntimeConfigAudit(asSessionId("s1"))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("active-run guard rejects a different running message run", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      await store.updateSessionStatus(asSessionId("s1"), "busy", CREATED_AT);
      store.db.prepare(
        "INSERT INTO message_runs (id, session_id, group_id, prompt, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')",
      ).run("run-real", "s1", "group-1", "secret prompt", CREATED_AT);

      await expect(store.applySessionRuntimeConfigMutations([
        mutation("s1", { guard: { kind: "active-run", messageRunId: asMessageRunId("run-wrong") } }),
      ])).rejects.toBeInstanceOf(RuntimeConfigConflictError);
    } finally {
      await cleanup();
    }
  });

  test("expected tuple comparison is null-safe", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      const stale = mutation("s1", {
        expected: { backend: "claude", model: "not-null", effort: null, backendSessionId: null },
      });
      await expect(store.applySessionRuntimeConfigMutations([stale])).rejects.toBeInstanceOf(RuntimeConfigConflictError);
    } finally {
      await cleanup();
    }
  });

  test("one stale mutation rolls back every row and audit in a bulk call", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      await seedSession(store, "s2");
      const stale = mutation("s2", {
        expected: { backend: "claude", model: "stale", effort: null, backendSessionId: null },
      });

      await expect(store.applySessionRuntimeConfigMutations([mutation("s1"), stale])).rejects.toBeInstanceOf(RuntimeConfigConflictError);

      expect((await store.findSessionById(asSessionId("s1")))?.backend).toBe("claude");
      expect(await store.listSessionRuntimeConfigAudit(asSessionId("s1"))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("audit insertion failure rolls back the config update", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await seedSession(store, "s1");
      store.db.exec(`
        CREATE TRIGGER reject_runtime_config_audit
        BEFORE INSERT ON session_runtime_config_audit
        BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;
      `);

      await expect(store.applySessionRuntimeConfigMutations([mutation("s1")])).rejects.toThrow("injected audit failure");
      expect((await store.findSessionById(asSessionId("s1")))?.backend).toBe("claude");
    } finally {
      await cleanup();
    }
  });

  test("persists a busy projected config across reopen and applies it after idle without overwriting resume", async () => {
    const first = await createTempStore();
    const dbPath = join(first.dir, "console.db");
    try {
      await seedSession(first.store, "s1");
      await first.store.updateSessionBackendSessionId(asSessionId("s1"), "run-started");
      await first.store.updateSessionStatus(asSessionId("s1"), "busy", asTimestamp(2));
      await first.store.queueSessionRuntimeConfigMutation({
        ...mutation("s1", {
          expected: { backend: "claude", model: null, effort: null, backendSessionId: "run-started" },
          after: { backend: "claude", model: "claude-opus-5", effort: "high", backendSessionId: "run-started" },
          audit: { ...mutation("s1").audit, id: "audit-pending", trigger: "model", requested: { model: "claude-opus-5" }, decision: "accept" },
        }),
      });
      expect(await first.store.getPendingSessionRuntimeConfig(asSessionId("s1"))).toMatchObject({
        projected: { backend: "claude", model: "claude-opus-5", effort: "high" },
      });
      await first.store.close();

      const reopened = new SqliteBindingStore(dbPath);
      try {
        await reopened.init();
        expect(await reopened.getPendingSessionRuntimeConfig(asSessionId("s1"))).toMatchObject({
          projected: { backend: "claude", model: "claude-opus-5", effort: "high", backendSessionId: "run-started" },
        });
        await reopened.updateSessionStatus(asSessionId("s1"), "idle", asTimestamp(3));
        await expect(reopened.drainPendingSessionRuntimeConfig(asSessionId("s1"))).resolves.toEqual({ kind: "applied" });
        expect(await reopened.findSessionById(asSessionId("s1"))).toMatchObject({
          status: "idle",
          model: "claude-opus-5",
          effort: "high",
          backendSessionId: "run-started",
        });
        expect((await reopened.listSessionRuntimeConfigAudit(asSessionId("s1"))).map((audit) => audit.decision))
          .toEqual(expect.arrayContaining(["accept", "apply"]));
      } finally {
        await reopened.close();
      }
    } finally {
      await first.cleanup();
    }
  });

  test("repairs a correct audit table missing migration version and named index", async () => {
    const first = await createTempStore();
    const dbPath = join(first.dir, "console.db");
    first.store.db.exec(`
      DROP INDEX idx_session_runtime_config_audit_session_created;
      DELETE FROM schema_version WHERE version = 37;
    `);
    await first.store.close();

    const reopened = new SqliteBindingStore(dbPath);
    try {
      await expect(reopened.init()).resolves.toEqual({ degraded: [] });
      expect(reopened.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get("idx_session_runtime_config_audit_session_created")).toEqual({
        name: "idx_session_runtime_config_audit_session_created",
      });
      expect(reopened.db.prepare("SELECT version FROM schema_version WHERE version = 37").get()).toEqual({ version: 37 });
    } finally {
      await reopened.close();
      await first.cleanup();
    }
  });

  test("fails init explicitly for an incompatible pre-existing audit table", async () => {
    const first = await createTempStore();
    const dbPath = join(first.dir, "console.db");
    first.store.db.exec(`
      DROP TABLE session_runtime_config_audit;
      DELETE FROM schema_version WHERE version = 37;
      CREATE TABLE session_runtime_config_audit (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        before_json TEXT NOT NULL,
        requested_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        catalog_source TEXT NOT NULL,
        catalog_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    await first.store.close();

    const reopened = new SqliteBindingStore(dbPath);
    try {
      await expect(reopened.init()).rejects.toThrow("session_runtime_config_audit schema incompatible");
    } finally {
      await reopened.close();
      await first.cleanup();
    }
  });
});

describe("fake binding store session runtime config contract", () => {
  async function seedFake(id: string, status: "idle" | "busy" = "idle") {
    const store = createFakeBindingStore();
    await store.createSession({
      id: asSessionId(id),
      name: id,
      scope: "user",
      backend: "claude",
      workdir: asAbsolutePath(`/tmp/${id}`),
      purpose: "test",
      createdAt: CREATED_AT,
    });
    await store.updateSessionStatus(asSessionId(id), status, CREATED_AT);
    return store;
  }

  test.each(["deleted", "missing"] as const)("guard-only admission rejects %s sessions", async (state) => {
    const store = state === "deleted" ? await seedFake("s1") : createFakeBindingStore();
    if (state === "deleted") {
      await store.updateSessionStatus(asSessionId("s1"), "deleted", CREATED_AT);
    }
    const expected = { backend: "claude" as const, model: null, effort: null, backendSessionId: null };
    await expect(store.guardIdleSessionRuntimeConfig(asSessionId("s1"), expected))
      .rejects.toBeInstanceOf(RuntimeConfigConflictError);
  });

  test("rolls back every config and audit when one bulk mutation conflicts", async () => {
    const store = await seedFake("s1");
    await store.createSession({
      id: asSessionId("s2"), name: "s2", scope: "user", backend: "claude",
      workdir: asAbsolutePath("/tmp/s2"), purpose: "test", createdAt: CREATED_AT,
    });
    const stale = mutation("s2", {
      expected: { backend: "claude", model: "stale", effort: null, backendSessionId: null },
    });

    await expect(store.applySessionRuntimeConfigMutations([mutation("s1"), stale]))
      .rejects.toBeInstanceOf(RuntimeConfigConflictError);
    expect((await store.findSessionById(asSessionId("s1")))?.backend).toBe("claude");
    expect(store._listSessionRuntimeConfigAudit()).toEqual([]);
  });

  test("active-run guard requires the exact running run for the session", async () => {
    const store = await seedFake("s1", "busy");
    await store.startMessageRun({
      id: asMessageRunId("run-real"), sessionId: asSessionId("s1"), groupId: "group-1" as never,
      prompt: "secret", startedAt: CREATED_AT,
    });

    await expect(store.applySessionRuntimeConfigMutations([
      mutation("s1", { guard: { kind: "active-run", messageRunId: asMessageRunId("run-wrong") } }),
    ])).rejects.toBeInstanceOf(RuntimeConfigConflictError);
    await expect(store.applySessionRuntimeConfigMutations([
      mutation("s1", { guard: { kind: "active-run", messageRunId: asMessageRunId("run-real") } }),
    ])).resolves.toEqual({ updated: 1 });
  });

  test("allowlists requested runtime config keys even after an unsafe cast", async () => {
    const store = await seedFake("s1");
    const requested = {
      backend: "codex", model: "gpt-5", effort: "high",
      prompt: "secret", token: "secret", auth: { apiKey: "secret" },
    } as unknown as SessionRuntimeConfigMutation["audit"]["requested"];

    await store.applySessionRuntimeConfigMutations([
      mutation("s1", { audit: { ...mutation("s1").audit, requested } }),
    ]);
    expect(store._listSessionRuntimeConfigAudit()[0]?.requested).toEqual({
      backend: "codex", model: "gpt-5", effort: "high",
    });
  });

  test("returns cloned audit rows", async () => {
    const store = await seedFake("s1");
    await store.applySessionRuntimeConfigMutations([mutation("s1")]);
    const first = store._listSessionRuntimeConfigAudit();
    first[0]!.requested.model = "mutated";
    first[0]!.after.resumeCleared = true;

    expect(store._listSessionRuntimeConfigAudit()[0]).toMatchObject({
      requested: { model: "gpt-5" },
      after: { resumeCleared: false },
    });
  });
});
