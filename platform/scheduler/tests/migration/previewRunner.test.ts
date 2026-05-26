import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { sendPreviewIfNeeded } from "../../src/migration/previewRunner.js";

describe("sendPreviewIfNeeded", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("sends preview and marks owner when not sent before", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    }).id;
    let sent: { target: string; prompt: string } | null = null;
    const r = await sendPreviewIfNeeded({
      taskStore: ts, migrationStore: ms, ownerSession: "owner-a", ownerTaskIds: [taskId],
      spawnFn: async (params) => {
        sent = { target: params.target, prompt: params.prompt };
        return { ok: true, childSessionId: "preview-c" };
      },
      clock: () => 1000,
    });
    expect(r).toBe(true);
    expect(sent!.target).toBe("owner-a");
    expect(sent!.prompt).toContain("t1");
    expect(ms.isPreviewSent("owner-a")).toBe(true);
  });

  it("does nothing when preview already sent", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    ms.markPreviewSent("owner-a", 1);
    const taskId = ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    }).id;
    const r = await sendPreviewIfNeeded({
      taskStore: ts, migrationStore: ms, ownerSession: "owner-a", ownerTaskIds: [taskId],
      spawnFn: async () => {
        throw new Error("must not be called");
      },
    });
    expect(r).toBe(false);
  });

  it("does NOT mark preview sent if spawn fails", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    }).id;
    const r = await sendPreviewIfNeeded({
      taskStore: ts, migrationStore: ms, ownerSession: "owner-a", ownerTaskIds: [taskId],
      spawnFn: async () => ({ ok: false, status: 404 }),
    });
    expect(r).toBe(false);
    expect(ms.isPreviewSent("owner-a")).toBe(false);
  });
});
