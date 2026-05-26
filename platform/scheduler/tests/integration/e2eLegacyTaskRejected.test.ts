import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createCronEngine } from "../../src/cron/engine.js";
import { createApp } from "../../src/api/routes.js";
import { createTestKnownSessionsLoader } from "../helpers/testKnownSessions.js";

describe("E2E: POST /tasks rejects legacy-shape input", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("plain shell task without class/expectedDuration/owner → 400", async () => {
    const store = createTaskStore(db);
    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, undefined, undefined,
      createTestKnownSessionsLoader(),
    );
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "legacy-only",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      }),
    });
    expect(res.status).toBe(400);
    // task not persisted
    expect(store.listTasks()).toHaveLength(0);
  });
});
