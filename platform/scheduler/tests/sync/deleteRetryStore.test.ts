import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import {
  createBitableDeleteRetryStore,
  drainBitableDeleteQueue,
  type BitableDeleteRetryStore,
} from "../../src/sync/deleteRetryStore.js";

const silentLogger = {
  info: () => {},
  error: () => {},
};

describe("BitableDeleteRetryStore", () => {
  let db: Database.Database;
  let store: BitableDeleteRetryStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createBitableDeleteRetryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("enqueue persists task with attempts=1 and last_error", () => {
    store.enqueue("task-a", new Error("lark-cli timeout"));
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].taskId).toBe("task-a");
    expect(entries[0].attempts).toBe(1);
    expect(entries[0].lastError).toBe("lark-cli timeout");
    expect(entries[0].queuedAt).toBeGreaterThan(0);
  });

  it("re-enqueue same taskId bumps attempts and updates last_error/queued_at", () => {
    store.enqueue("task-a", new Error("first failure"));
    const firstQueuedAt = store.list()[0].queuedAt;

    store.enqueue("task-a", new Error("second failure"));
    const entries = store.list();

    expect(entries).toHaveLength(1);
    expect(entries[0].attempts).toBe(2);
    expect(entries[0].lastError).toBe("second failure");
    expect(entries[0].queuedAt).toBeGreaterThanOrEqual(firstQueuedAt);
  });

  it("list returns entries sorted by queued_at ascending", () => {
    store.enqueue("a", new Error("e1"));
    store.enqueue("b", new Error("e2"));
    store.enqueue("c", new Error("e3"));
    const ids = store.list().map((e) => e.taskId);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("dequeue removes only the named task", () => {
    store.enqueue("a", new Error("x"));
    store.enqueue("b", new Error("y"));
    store.dequeue("a");
    const ids = store.list().map((e) => e.taskId);
    expect(ids).toEqual(["b"]);
  });

  it("enqueue truncates very long error messages", () => {
    const long = "x".repeat(5000);
    store.enqueue("a", new Error(long));
    const entry = store.list()[0];
    expect(entry.lastError!.length).toBeLessThanOrEqual(1000);
  });

  it("enqueue handles non-Error values (string, undefined)", () => {
    store.enqueue("a", "boom");
    store.enqueue("b", undefined);
    const entries = store.list();
    expect(entries.find((e) => e.taskId === "a")?.lastError).toBe("boom");
    expect(entries.find((e) => e.taskId === "b")?.lastError).toBe("");
  });
});

describe("drainBitableDeleteQueue", () => {
  let db: Database.Database;
  let store: BitableDeleteRetryStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createBitableDeleteRetryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0/0 when queue is empty (no-op)", async () => {
    const calls: string[] = [];
    const result = await drainBitableDeleteQueue(
      store,
      async (id) => { calls.push(id); },
      silentLogger,
    );
    expect(result).toEqual({ drained: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it("drains all entries when doDelete succeeds and clears the queue", async () => {
    store.enqueue("a", new Error("e1"));
    store.enqueue("b", new Error("e2"));

    const calls: string[] = [];
    const result = await drainBitableDeleteQueue(
      store,
      async (id) => { calls.push(id); },
      silentLogger,
    );

    expect(result).toEqual({ drained: 2, failed: 0 });
    expect(calls.sort()).toEqual(["a", "b"]);
    expect(store.list()).toHaveLength(0);
  });

  it("re-queues entries that fail again, bumping attempts", async () => {
    store.enqueue("a", new Error("first"));
    const before = store.list()[0];
    expect(before.attempts).toBe(1);

    const result = await drainBitableDeleteQueue(
      store,
      async () => { throw new Error("still failing"); },
      silentLogger,
    );

    expect(result).toEqual({ drained: 0, failed: 1 });
    const after = store.list();
    expect(after).toHaveLength(1);
    expect(after[0].taskId).toBe("a");
    expect(after[0].attempts).toBe(2);
    expect(after[0].lastError).toBe("still failing");
  });

  it("partial drain: succeeds dequeue success, re-queues failures", async () => {
    store.enqueue("ok", new Error("e1"));
    store.enqueue("bad", new Error("e2"));

    const result = await drainBitableDeleteQueue(
      store,
      async (id) => {
        if (id === "bad") throw new Error("nope");
      },
      silentLogger,
    );

    expect(result).toEqual({ drained: 1, failed: 1 });
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].taskId).toBe("bad");
    expect(remaining[0].attempts).toBe(2);
  });
});
