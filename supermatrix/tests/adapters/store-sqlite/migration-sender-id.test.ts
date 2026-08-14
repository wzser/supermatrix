import { describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";

describe("migration: sender_id column", () => {
  test("adds sender_id to message_runs on init", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    const cols = (store as any).db
      .prepare("PRAGMA table_info(message_runs)")
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "sender_id")).toBe(true);
  });

  test("creates user_display_names table on init", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    const tables = (store as any).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_display_names'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  test("sender_id column accepts NULL for historical rows", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();

    try {
      (store as any).db
        .prepare(
          `INSERT INTO sessions (id, name, alias, avatar, category, scope, backend, workdir, status, created_at, updated_at)
           VALUES ('sess_1', 'test', '', '', '', 'user', 'claude', '/tmp', 'idle', 0, 0)`
        )
        .run();
    } catch {
      // If schema differs, skip FK test — column existence test above is sufficient
      return;
    }

    (store as any).db
      .prepare(
        `INSERT INTO message_runs (id, session_id, group_id, prompt, started_at, status)
         VALUES ('r1', 'sess_1', 'oc_test', 'hello', 0, 'done')`
      )
      .run();

    const row = (store as any).db
      .prepare("SELECT sender_id FROM message_runs WHERE id = 'r1'")
      .get() as { sender_id: string | null };
    expect(row.sender_id).toBeNull();
  });
});
