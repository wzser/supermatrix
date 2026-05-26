import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createCreationReviewStore } from "../../src/review/creationReviewStore.js";
import { runDecisionPollTick } from "../../src/review/decisionPoll.js";

describe("runDecisionPollTick", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createCreationReviewStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.exec(`INSERT INTO tasks (id, name, cron, executor, config, created_at, updated_at) VALUES ('t1', 'n', '* * * * *', 'shell', '{}', 0, 0)`);
    store = createCreationReviewStore(db);
  });
  afterEach(() => db.close());

  it("returns 0 expired when no dispatched reviews", async () => {
    const result = await runDecisionPollTick({ store, staleAfterMs: 86_400_000 });
    expect(result).toEqual({ expired: 0, expiredReviewIds: [] });
  });

  it("does not expire dispatched reviews younger than threshold", async () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    store.markDispatched(r.id);
    const result = await runDecisionPollTick({ store, staleAfterMs: 86_400_000 });
    expect(result.expired).toBe(0);
    expect(store.get(r.id)!.status).toBe("dispatched");
  });

  it("expires dispatched reviews older than threshold", async () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    store.markDispatched(r.id);
    // Force dispatched_at to 1000ms
    db.prepare(`UPDATE creation_reviews SET dispatched_at = ? WHERE id = ?`).run(1000, r.id);
    const result = await runDecisionPollTick({
      store, staleAfterMs: 60_000, nowMs: 100_000,
    });
    expect(result.expired).toBe(1);
    expect(result.expiredReviewIds).toEqual([r.id]);
    const got = store.get(r.id)!;
    expect(got.status).toBe("expired");
    expect(got.decisionReason).toContain("did not reply");
  });

  it("invokes notifyOwnerFn with the expired list when provided", async () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    store.markDispatched(r.id);
    db.prepare(`UPDATE creation_reviews SET dispatched_at = ? WHERE id = ?`).run(1000, r.id);
    const notify = vi.fn(async () => {});
    await runDecisionPollTick({
      store, staleAfterMs: 60_000, nowMs: 100_000, notifyOwnerFn: notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toHaveLength(1);
    expect(notify.mock.calls[0][0][0].id).toBe(r.id);
  });

  it("does NOT call notifyOwnerFn when nothing expired", async () => {
    const notify = vi.fn(async () => {});
    await runDecisionPollTick({ store, staleAfterMs: 60_000, notifyOwnerFn: notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it("swallows notifyOwnerFn errors (best-effort)", async () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    store.markDispatched(r.id);
    db.prepare(`UPDATE creation_reviews SET dispatched_at = ? WHERE id = ?`).run(1000, r.id);
    const notify = vi.fn(async () => { throw new Error("boom"); });
    // Should not throw — return result still includes the expired count
    const result = await runDecisionPollTick({
      store, staleAfterMs: 60_000, nowMs: 100_000, notifyOwnerFn: notify,
    });
    expect(result.expired).toBe(1);
    expect(store.get(r.id)!.status).toBe("expired");
  });
});
