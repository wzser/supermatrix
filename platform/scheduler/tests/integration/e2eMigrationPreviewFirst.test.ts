import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

describe("E2E: migration preview before first proposal", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("first tick sends only preview, second tick sends proposal", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    ts.createTask({
      name: "a", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-z",
    });
    ts.createTask({
      name: "b", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-z",
    });

    const prompts: string[] = [];
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async (p) => {
        prompts.push(p.prompt);
        return { ok: true, childSessionId: `c${prompts.length}` };
      },
      sendUserDm: async () => {},
      clock: () => 1000,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("预告");
    expect(prompts[0]).toContain("a");
    expect(prompts[0]).toContain("b");

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async (p) => {
        prompts.push(p.prompt);
        return { ok: true, childSessionId: `c${prompts.length}` };
      },
      sendUserDm: async () => {},
      clock: () => 2000,
    });
    const proposalPrompts = prompts.slice(1);
    expect(proposalPrompts).toHaveLength(1);
    expect(proposalPrompts[0]).toContain("migration proposal");
  });
});
