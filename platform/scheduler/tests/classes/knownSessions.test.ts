import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createKnownSessionsLoader } from "../../src/classes/knownSessions";

describe("createKnownSessionsLoader", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `known-sessions-test-${Date.now()}-${Math.random()}.db`);
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE sessions (id TEXT, name TEXT)`);
    db.prepare(`INSERT INTO sessions (id, name) VALUES (?, ?)`).run("s1", "alpha");
    db.prepare(`INSERT INTO sessions (id, name) VALUES (?, ?)`).run("s2", "beta");
    db.prepare(`INSERT INTO sessions (id, name) VALUES (?, ?)`).run("s3", "child_codexroot_abc");
    db.prepare(`INSERT INTO sessions (id, name) VALUES (?, ?)`).run("s4", "sess_123");
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("loads non-child non-sess sessions + framework pseudo-owners", () => {
    const load = createKnownSessionsLoader(dbPath);
    const set = load();
    expect(set.has("alpha")).toBe(true);
    expect(set.has("beta")).toBe(true);
    expect(set.has("child_codexroot_abc")).toBe(false);
    expect(set.has("sess_123")).toBe(false);
    expect(set.has("supermatrix-root")).toBe(true);
    expect(set.has("codexroot")).toBe(true);
  });

  it("caches within TTL — second call sees stale data", () => {
    const load = createKnownSessionsLoader(dbPath, { ttlMs: 60_000 });
    const first = load();
    const db2 = new Database(dbPath);
    db2.prepare(`INSERT INTO sessions (id, name) VALUES (?, ?)`).run("s5", "gamma");
    db2.close();
    const second = load();
    expect(second.has("gamma")).toBe(false);
    expect(second).toBe(first);
  });

  it("refreshes after TTL (ttlMs=0)", () => {
    const load = createKnownSessionsLoader(dbPath, { ttlMs: 0 });
    load();
    const db2 = new Database(dbPath);
    db2.prepare(`INSERT INTO sessions (id, name) VALUES (?, ?)`).run("s5", "gamma");
    db2.close();
    expect(load().has("gamma")).toBe(true);
  });

  it("returns pseudo-owners only when db missing", () => {
    const load = createKnownSessionsLoader("/nonexistent/path.db");
    const set = load();
    expect(set.has("supermatrix-root")).toBe(true);
    expect(set.has("codexroot")).toBe(true);
  });

  it("loader is callable repeatedly (different invocations within TTL share identity)", () => {
    const load = createKnownSessionsLoader(dbPath, { ttlMs: 60_000 });
    expect(load()).toBe(load());
  });
});
