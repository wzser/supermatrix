import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createRateLimitStore, type RateLimitStore } from "../../src/heal/rateLimitStore.js";

describe("RateLimitStore", () => {
  let db: Database.Database;
  let store: RateLimitStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createRateLimitStore(db);
  });
  afterEach(() => db.close());

  it("returns null on empty scope", () => {
    expect(store.getQuietUntil("anthropic")).toBeNull();
    expect(store.getLatest("anthropic")).toBeNull();
  });

  it("records a hit and reads it back", () => {
    store.recordHit({
      scope: "anthropic",
      detectedAt: 1_000,
      quietUntil: 1_000 + 60 * 60_000,
      sourceTaskId: "task-1",
      sourceRunId: "run-1",
      sourceSnippet: "You've hit your limit · resets 9pm",
    });
    expect(store.getQuietUntil("anthropic")).toBe(1_000 + 60 * 60_000);
    const latest = store.getLatest("anthropic");
    expect(latest).not.toBeNull();
    expect(latest!.sourceTaskId).toBe("task-1");
    expect(latest!.sourceSnippet).toContain("hit your limit");
  });

  it("upserts: a later hit overwrites the earlier one", () => {
    store.recordHit({ scope: "anthropic", detectedAt: 1_000, quietUntil: 2_000 });
    store.recordHit({ scope: "anthropic", detectedAt: 5_000, quietUntil: 9_000 });
    expect(store.getQuietUntil("anthropic")).toBe(9_000);
    expect(store.getLatest("anthropic")!.detectedAtMs).toBe(5_000);
  });

  it("scopes are independent", () => {
    store.recordHit({ scope: "anthropic", detectedAt: 1, quietUntil: 100 });
    store.recordHit({ scope: "other", detectedAt: 1, quietUntil: 200 });
    expect(store.getQuietUntil("anthropic")).toBe(100);
    expect(store.getQuietUntil("other")).toBe(200);
  });
});
