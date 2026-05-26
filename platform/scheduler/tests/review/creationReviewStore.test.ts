import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createCreationReviewStore } from "../../src/review/creationReviewStore.js";

describe("creationReviewStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createCreationReviewStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    // seed a task for FK
    db.exec(
      `INSERT INTO tasks (id, name, cron, executor, config, created_at, updated_at) VALUES ('t1', 'n', '* * * * *', 'shell', '{}', 0, 0)`,
    );
    store = createCreationReviewStore(db);
  });
  afterEach(() => db.close());

  it("create returns a complete record with generated id", () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: { x: 1 } });
    expect(r.id).toMatch(/^[0-9a-f-]{8,}$/i);
    expect(r.taskId).toBe("t1");
    expect(r.trigger).toBe("post_create");
    expect(r.taskSnapshot).toEqual({ x: 1 });
    expect(r.l1Report).toBeNull();
    expect(r.status).toBe("pending");
    expect(r.dispatchedAt).toBeNull();
    expect(r.decidedAt).toBeNull();
    expect(r.createdAt).toBeGreaterThan(0);
    expect(r.updatedAt).toBe(r.createdAt);
  });

  it("get returns null for unknown id", () => {
    expect(store.get("missing")).toBeNull();
  });

  it("get round-trips a created record", () => {
    const r = store.create({
      taskId: "t1",
      trigger: "post_create",
      taskSnapshot: { x: 2 },
      l1Report: { warnings: [] },
    });
    const got = store.get(r.id);
    expect(got).not.toBeNull();
    expect(got!.taskSnapshot).toEqual({ x: 2 });
    expect(got!.l1Report).toEqual({ warnings: [] });
  });

  it("listByStatus returns pending ordered by created_at ASC", async () => {
    const r1 = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    const list = store.listByStatus("pending");
    expect(list.map((r) => r.id)).toEqual([r1.id, r2.id]);
  });

  it("listPending is equivalent to listByStatus('pending')", () => {
    store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    expect(store.listPending()).toEqual(store.listByStatus("pending"));
  });

  it("markDispatched flips status and sets dispatched_at", () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    store.markDispatched(r.id);
    const got = store.get(r.id)!;
    expect(got.status).toBe("dispatched");
    expect(got.dispatchedAt).not.toBeNull();
    expect(got.updatedAt).toBeGreaterThanOrEqual(got.createdAt);
  });

  it("decide writes status / reason / patch / decided_at", () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    store.decide(r.id, {
      status: "patched",
      reason: "cron too dense",
      patch: { cron: "*/5 * * * *" },
    });
    const got = store.get(r.id)!;
    expect(got.status).toBe("patched");
    expect(got.decisionReason).toBe("cron too dense");
    expect(got.decisionPatch).toEqual({ cron: "*/5 * * * *" });
    expect(got.decidedAt).not.toBeNull();
  });

  it("expirePending bumps old pending rows and returns count", () => {
    const r1 = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    const r2 = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    // Force r1 to be "old" by overwriting created_at directly
    db.prepare(`UPDATE creation_reviews SET created_at = ? WHERE id = ?`).run(1000, r1.id);
    const count = store.expirePending(60_000, 100_000); // older than 60s, now=100s
    expect(count).toBe(1);
    expect(store.get(r1.id)!.status).toBe("expired");
    expect(store.get(r2.id)!.status).toBe("pending");
  });
});
