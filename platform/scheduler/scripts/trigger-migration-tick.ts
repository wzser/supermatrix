#!/usr/bin/env tsx
/**
 * One-shot manual trigger for a migration tick.
 *
 * Uses the same SQLite DB as the running scheduler (SCHEDULER_DB_PATH).
 * Fires one runMigrationTick + reports what happened.
 *
 * Safe to run while scheduler is up — better-sqlite3 serializes writes,
 * and this script only touches migration_proposals + tasks rows via the
 * same helpers the scheduler uses.
 *
 * Usage:
 *   SCHEDULER_DB_PATH=... SCHEDULER_BITABLE_BASE_TOKEN=... (rest of env) \
 *     npx tsx scripts/trigger-migration-tick.ts
 */

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTaskStore } from "../src/db/taskStore.js";
import { createMigrationStore } from "../src/migration/store.js";
import { runMigrationTick } from "../src/migration/scheduler.js";
import type { MigrationSpawnResult } from "../src/migration/runner.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const dbPath = process.env.SCHEDULER_DB_PATH;
  if (!dbPath) { console.error("SCHEDULER_DB_PATH missing"); process.exit(2); }

  const spawnApiUrl = process.env.SCHEDULER_SPAWN_API_URL ?? "http://localhost:3501/api/spawn";
  const smBaseUrl = spawnApiUrl.replace(/\/api\/spawn$/, "");
  const larkCliPath = process.env.SCHEDULER_LARK_CLI_PATH ?? "lark-cli";
  const userOpenId = process.env.SCHEDULER_USER_DM_OPEN_ID;
  if (!userOpenId) { console.error("SCHEDULER_USER_DM_OPEN_ID missing"); process.exit(2); }

  const db = new Database(dbPath);
  const taskStore = createTaskStore(db);
  const migrationStore = createMigrationStore(db);

  const spawnFn = async (params: {
    target: string; from: string; prompt: string;
  }): Promise<MigrationSpawnResult> => {
    const res = await fetch(spawnApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { childSessionId?: string };
    if (!body.childSessionId) return { ok: false, error: "no childSessionId" };
    return { ok: true, childSessionId: body.childSessionId };
  };

  const sendUserDm = async (text: string) => {
    await execFileAsync(larkCliPath, [
      "im", "+messages-send",
      "--user-id", userOpenId,
      "--as", "bot",
      "--text", text,
    ], { timeout: 15_000 });
  };

  const previewCount = () => (db.prepare("SELECT COUNT(*) as n FROM migration_preview_sent").get() as {n: number}).n;
  console.log("[manual-tick] before:");
  console.log(`  pending proposals: ${migrationStore.listAll("pending").length}`);
  console.log(`  preview-sent owners: ${previewCount()}`);
  console.log(`  legacy tasks (class IS NULL, enabled): ${taskStore.listTasks().filter(t => t.class === null && t.enabled).length}`);

  console.log("[manual-tick] firing runMigrationTick...");
  await runMigrationTick({
    taskStore,
    migrationStore,
    smBaseUrl,
    spawnFn,
    sendUserDm,
  });

  console.log("[manual-tick] after:");
  console.log(`  pending proposals: ${migrationStore.listAll("pending").length}`);
  console.log(`  replied proposals: ${migrationStore.listAll("replied").length}`);
  console.log(`  preview-sent owners: ${previewCount()}`);
  const classed = taskStore.listTasks().filter(t => t.class !== null).length;
  console.log(`  migrated tasks (class set): ${classed}`);
  const defaultsByReason = db.prepare("SELECT reply_action, COUNT(*) as n FROM migration_proposals WHERE status='default_applied' GROUP BY reply_action").all();
  if ((defaultsByReason as Array<{n:number}>).length > 0) {
    console.log(`  default_applied rows: ${JSON.stringify(defaultsByReason)}`);
  }

  db.close();
  console.log("[manual-tick] done.");
}

main().catch((err) => { console.error("[manual-tick] error:", err); process.exit(1); });
