import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { routeTaskExecution } from "../../src/main.js";

describe("dual-path routing", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("legacy task (class=null) routes to 'legacy'", () => {
    const store = createTaskStore(db);
    const task = store.createTask({
      name: "legacy",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    });
    expect(routeTaskExecution(task)).toBe("legacy");
  });

  it("new-class task routes to 'new'", () => {
    const store = createTaskStore(db);
    const task = store.createTask({
      name: "new",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "me",
    });
    expect(routeTaskExecution(task)).toBe("new");
  });
});
