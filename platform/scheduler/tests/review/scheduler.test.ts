import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createCreationReviewStore } from "../../src/review/creationReviewStore.js";
import { buildProposalText } from "../../src/review/proposalText.js";
import { runCreationReviewTick, type SpawnFn } from "../../src/review/scheduler.js";

describe("runCreationReviewTick", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createCreationReviewStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.exec(`INSERT INTO tasks (id, name, cron, executor, config, created_at, updated_at) VALUES ('t1', 'n', '* * * * *', 'shell', '{}', 0, 0)`);
    store = createCreationReviewStore(db);
  });
  afterEach(() => db.close());

  function ok(): SpawnFn { return vi.fn(async () => ({ ok: true })); }
  function fail(): SpawnFn { return vi.fn(async () => ({ ok: false, error: "no session" })); }

  it("returns empty when no pending", async () => {
    const spawn = ok();
    const result = await runCreationReviewTick({
      store, spawnFn: spawn, proposalTextBuilder: buildProposalText,
      batchThreshold: 5, maxAgeMs: 3600_000,
    });
    expect(result).toEqual({ dispatched: 0, reviewIds: [], skipReason: "empty" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("skips when pending < threshold and oldest is recent", async () => {
    for (let i = 0; i < 3; i++) store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    const spawn = ok();
    const result = await runCreationReviewTick({
      store, spawnFn: spawn, proposalTextBuilder: buildProposalText,
      batchThreshold: 5, maxAgeMs: 3600_000,
      nowMs: Date.now(),
    });
    expect(result.dispatched).toBe(0);
    expect(result.skipReason).toBe("below_threshold");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dispatches when pending >= threshold", async () => {
    for (let i = 0; i < 5; i++) store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    const spawn = ok();
    const result = await runCreationReviewTick({
      store, spawnFn: spawn, proposalTextBuilder: buildProposalText,
      batchThreshold: 5, maxAgeMs: 3600_000,
    });
    expect(result.dispatched).toBe(5);
    expect(result.reviewIds).toHaveLength(5);
    expect(spawn).toHaveBeenCalledTimes(1);
    const call = spawn.mock.calls[0][0];
    expect(call.target).toBe("scheduler");
    expect("mode" in call).toBe(false);
    expect(call.prompt).toContain("5 条 task creation");
  });

  it("dispatches when oldest pending exceeds maxAgeMs even if below threshold", async () => {
    const r = store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    // Force old creation time
    db.prepare(`UPDATE creation_reviews SET created_at = ? WHERE id = ?`).run(1000, r.id);
    const spawn = ok();
    const result = await runCreationReviewTick({
      store, spawnFn: spawn, proposalTextBuilder: buildProposalText,
      batchThreshold: 5, maxAgeMs: 60_000,
      nowMs: 100_000,
    });
    expect(result.dispatched).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("marks dispatched reviews after successful spawn", async () => {
    for (let i = 0; i < 5; i++) store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    await runCreationReviewTick({
      store, spawnFn: ok(), proposalTextBuilder: buildProposalText,
      batchThreshold: 5, maxAgeMs: 3600_000,
    });
    expect(store.listPending()).toHaveLength(0);
    expect(store.listByStatus("dispatched")).toHaveLength(5);
  });

  it("does NOT mark dispatched on spawn failure (so next tick retries)", async () => {
    for (let i = 0; i < 5; i++) store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    const result = await runCreationReviewTick({
      store, spawnFn: fail(), proposalTextBuilder: buildProposalText,
      batchThreshold: 5, maxAgeMs: 3600_000,
    });
    expect(result.dispatched).toBe(0);
    expect(result.skipReason).toBe("spawn_failed");
    expect(store.listPending()).toHaveLength(5);
  });

  it("respects selfTarget and fromSession options", async () => {
    for (let i = 0; i < 5; i++) store.create({ taskId: "t1", trigger: "post_create", taskSnapshot: {} });
    const spawn = ok();
    await runCreationReviewTick({
      store, spawnFn: spawn, proposalTextBuilder: buildProposalText,
      batchThreshold: 5, maxAgeMs: 3600_000,
      selfTarget: "scheduler-test",
      fromSession: "scheduler-from",
    });
    const call = spawn.mock.calls[0][0];
    expect(call.target).toBe("scheduler-test");
    expect(call.from).toBe("scheduler-from");
  });
});
