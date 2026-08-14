import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { createTaskStore } from "../db/taskStore.js";
import { enqueueDailyTaskMirror } from "../sync/bitable.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  try {
    const store = createTaskStore(db);
    const snapshots = store.listTasks().map((task) => ({
      task,
      latestOutcome: store.recentRuns(task.id, 1)[0]?.outcome ?? null,
    }));
    const receipt = await enqueueDailyTaskMirror({ snapshots });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      accepted: receipt.accepted,
      duplicate: receipt.duplicate,
      job_id: receipt.jobId,
      dedupe_key: receipt.dedupeKey,
      row_count: snapshots.length,
      status: receipt.duplicate ? "duplicate_existing_job" : "accepted_pending",
    })}\n`);
  } finally {
    db.close();
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`scheduler daily mirror failed: ${message}\n`);
  process.exitCode = 1;
});
