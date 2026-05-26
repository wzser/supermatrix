import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { startVerifyScheduler } from "../../src/verify/scheduler.js";

describe("E2E: external_evidence sqlite lifecycle", () => {
  let db: Database.Database;
  let tmpDir: string;
  let evidenceDbPath: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    tmpDir = mkdtempSync(join(tmpdir(), "scheduler-e2e-ext-"));
    evidenceDbPath = join(tmpDir, "evidence.db");
    const ev = new Database(evidenceDbPath);
    ev.exec("CREATE TABLE daily_rows (ts INTEGER); INSERT INTO daily_rows (ts) VALUES (1), (2), (3);");
    ev.close();
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sync_job with external_evidence/sqlite reaches success", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "sync-job-proof-test",
      cron: "0 2 * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "sqlite",
          target: { db: evidenceDbPath, sql: "SELECT COUNT(*) FROM daily_rows" },
          expectation: ">= 1",
        },
      },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    verifyStore.scheduleVerification(run.id, Date.now() - 1000);

    const stop = startVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: () => ({}),
      tickIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();

    const reloaded = taskStore.getRun(run.id)!;
    expect(reloaded.finalStatus).toBe("success");
    expect(reloaded.receiptEvidence).toMatchObject({ value: 3 });
  });
});
