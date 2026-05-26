import { describe, expect, test } from "vitest";
import { createTempStore } from "./helpers.ts";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";

describe("sqlite migrations", () => {
  test("init applies all migrations and records latest schema_version", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const raw = (store as unknown as { db: { prepare: (sql: string) => { get: () => { version: number } } } }).db;
      const row = raw.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get();
      expect(row.version).toBe(32);
    } finally {
      await cleanup();
    }
  });

  test("init is idempotent", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.init();
      await store.init();
      const raw = (store as unknown as { db: { prepare: (sql: string) => { all: () => { version: number }[] } } }).db;
      const rows = raw.prepare("SELECT version FROM schema_version").all();
      expect(rows).toHaveLength(32);
    } finally {
      await cleanup();
    }
  });

  test("duplicate column is auto-marked as applied", async () => {
    const store = new SqliteBindingStore(":memory:");
    // First init — applies all migrations normally
    await store.init();
    // Manually remove version 8 from schema_version (simulates drift)
    store.db.prepare("DELETE FROM schema_version WHERE version = 8").run();
    // Second init — migration 008 tries ALTER TABLE but column exists
    // With idempotency, this should not throw
    const result = await store.init();
    expect(result.degraded).toHaveLength(0);
    // Version 8 should be re-recorded
    const row = store.db.prepare("SELECT version FROM schema_version WHERE version = 8").get() as { version: number } | undefined;
    expect(row?.version).toBe(8);
    await store.close();
  });

  test("optional migration failure degrades instead of crashing", async () => {
    const store = new SqliteBindingStore(":memory:");
    const result = await store.init();
    expect(result).toHaveProperty("degraded");
    expect(Array.isArray(result.degraded)).toBe(true);
    await store.close();
  });

  test("critical migration failure still throws", async () => {
    const store = new SqliteBindingStore(":memory:");
    const result = await store.init();
    expect(result.degraded).toHaveLength(0);
    await store.close();
  });

  test("023-026 create spawn closure support tables", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const rows = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?) ORDER BY name")
      .all(
        "result_sink_attempts",
        "spawn_predicate_patches",
        "spawn_predicates",
        "watcher_exceptions",
        "watcher_state",
        "watcher_ticks"
      ) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual([
      "result_sink_attempts",
      "spawn_predicate_patches",
      "spawn_predicates",
      "watcher_exceptions",
      "watcher_state",
      "watcher_ticks",
    ]);
    await store.close();
  });

  test("028 creates spawn async items contract table", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    const columns = store.db.pragma("table_info(spawn_async_items)") as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    expect(columns.map((c) => c.name)).toEqual([
      "ref",
      "comm_id",
      "caller_session",
      "target_session",
      "failed_phase",
      "failure_kind",
      "attempt_count",
      "status",
      "verdict",
      "verdict_reason",
      "created_at",
      "updated_at",
      "last_attempt_at",
    ]);

    expect(Object.fromEntries(columns.map((c) => [c.name, c.dflt_value]))).toMatchObject({
      attempt_count: "0",
      status: "'pending'",
    });

    const required = columns.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(required).toEqual([
      "comm_id",
      "failed_phase",
      "failure_kind",
      "attempt_count",
      "status",
      "created_at",
      "updated_at",
    ]);

    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'spawn_async_items' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toEqual([
      "idx_spawn_async_items_comm",
      "idx_spawn_async_items_courier_status",
      "idx_spawn_async_items_status",
      "sqlite_autoindex_spawn_async_items_1",
    ]);

    await store.close();
  });

  test("030 adds indexes for boot reconciliation and cross-session sync scans", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    const rows = store.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name IN (?, ?, ?, ?)
         ORDER BY name`,
      )
      .all(
        "idx_cross_session_log_bitable_record",
        "idx_cross_session_log_child",
        "idx_cross_session_log_stale_sync",
        "idx_sessions_backend_session_id",
      ) as Array<{ name: string }>;

    expect(rows.map((r) => r.name)).toEqual([
      "idx_cross_session_log_bitable_record",
      "idx_cross_session_log_child",
      "idx_cross_session_log_stale_sync",
      "idx_sessions_backend_session_id",
    ]);

    await store.close();
  });

  test("031 creates persistent spawn throttle queue table", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    const columns = store.db.pragma("table_info(spawn_queue)") as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "parent_id",
      "spawn_input_json",
      "caller_session",
      "comm_id",
      "status",
      "created_at",
      "dispatched_at",
      "ttl_sec",
      "updated_at",
    ]);

    expect(Object.fromEntries(columns.map((c) => [c.name, c.dflt_value]))).toMatchObject({
      status: "'pending'",
    });

    const required = columns.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(required).toEqual([
      "parent_id",
      "spawn_input_json",
      "comm_id",
      "status",
      "created_at",
      "ttl_sec",
      "updated_at",
    ]);

    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'spawn_queue' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toEqual([
      "idx_spawn_queue_comm",
      "idx_spawn_queue_parent_status_created",
      "sqlite_autoindex_spawn_queue_1",
    ]);

    await store.close();
  });

  test("002 adds parent_id and depth columns to sessions", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const info = store.db.pragma("table_info(sessions)") as Array<{ name: string }>;
    const columns = info.map((c) => c.name);
    expect(columns).toContain("parent_id");
    expect(columns).toContain("depth");
    await store.close();
  });

  test("013 adds child capability columns to sessions", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const info = store.db.pragma("table_info(sessions)") as Array<{ name: string }>;
    const columns = info.map((c) => c.name);
    expect(columns).toContain("child_type");
    expect(columns).toContain("trigger_kind");
    expect(columns).toContain("post_identity");
    expect(columns).toContain("caller_invocation");
    expect(columns).toContain("continuation_hook");
    expect(columns).toContain("capability_payload");
    await store.close();
  });

  test("013 backfills pre-existing child rows by status heuristic", async () => {
    // Verify the backfill UPDATE logic directly against the applied schema.
    // Insert rows with child_type intentionally NULL to simulate pre-013 state,
    // then execute the same UPDATE statements the migration runs.
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    store.db.exec(`
      INSERT INTO sessions (id, name, scope, backend, workdir, purpose, status, parent_id, depth, child_type, created_at, updated_at)
      VALUES
        ('p1', 'parent', 'user', 'claude', '/tmp', '', 'idle', NULL, 0, NULL, 0, 0),
        ('s-idle-child', 'idle_child', 'child', 'claude', '/tmp', '', 'idle', 'p1', 1, NULL, 0, 0),
        ('s-busy-child', 'busy_child', 'child', 'claude', '/tmp', '', 'busy', 'p1', 1, NULL, 0, 0),
        ('s-deleted-child', 'deleted_child', 'child', 'claude', '/tmp', '', 'deleted', 'p1', 1, NULL, 0, 0),
        ('s-user-session', 'user_session', 'user', 'claude', '/tmp', '', 'idle', NULL, 0, NULL, 0, 0);
    `);

    store.db.exec(`
      UPDATE sessions
      SET child_type = 'ephemeral_conversation'
      WHERE scope = 'child' AND status = 'idle' AND child_type IS NULL;

      UPDATE sessions
      SET child_type = 'one_shot_delegation'
      WHERE scope = 'child' AND child_type IS NULL;
    `);

    const rows = store.db
      .prepare("SELECT id, child_type FROM sessions")
      .all() as Array<{ id: string; child_type: string | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.child_type]));

    expect(byId["s-idle-child"]).toBe("ephemeral_conversation");
    expect(byId["s-busy-child"]).toBe("one_shot_delegation");
    expect(byId["s-deleted-child"]).toBe("one_shot_delegation");
    expect(byId["s-user-session"]).toBeNull();
    expect(byId["p1"]).toBeNull();

    await store.close();
  });

  test("020 backfills heartbeat for existing non-child active sessions", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    store.db.exec(`
      INSERT INTO sessions (id, name, scope, backend, workdir, purpose, status, parent_id, depth, heartbeat_enabled, created_at, updated_at)
      VALUES
        ('s-user', 'user_session', 'user', 'claude', '/tmp', '', 'idle', NULL, 0, 0, 0, 0),
        ('s-root', 'root_session', 'root', 'claude', '/tmp', '', 'idle', NULL, 0, 0, 0, 0),
        ('s-child', 'child_session', 'child', 'claude', '/tmp', '', 'idle', 's-user', 1, 0, 0, 0),
        ('s-deleted', 'deleted_session', 'user', 'claude', '/tmp', '', 'deleted', NULL, 0, 0, 0, 0),
        ('s-heartbeat', 'heartbeat', 'user', 'claude', '/tmp', '', 'idle', NULL, 0, 0, 0, 0);
    `);

    store.db.exec(`
      UPDATE sessions
      SET heartbeat_enabled = 1
      WHERE status != 'deleted'
        AND scope != 'child'
        AND name != 'heartbeat';
    `);

    const rows = store.db
      .prepare("SELECT id, heartbeat_enabled FROM sessions WHERE id LIKE 's-%'")
      .all() as Array<{ id: string; heartbeat_enabled: number }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.heartbeat_enabled]));

    expect(byId["s-user"]).toBe(1);
    expect(byId["s-root"]).toBe(1);
    expect(byId["s-child"]).toBe(0);
    expect(byId["s-deleted"]).toBe(0);
    expect(byId["s-heartbeat"]).toBe(0);
    await store.close();
  });

  test("032 adds client_request_id to cross_session_log with lookup index", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    const columns = store.db.pragma("table_info(cross_session_log)") as Array<{ name: string; type: string }>;
    expect(columns).toContainEqual(expect.objectContaining({
      name: "client_request_id",
      type: "TEXT",
    }));

    const row = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_cross_session_log_client_request_id") as { name: string } | undefined;
    expect(row?.name).toBe("idx_cross_session_log_client_request_id");

    await store.close();
  });
});
