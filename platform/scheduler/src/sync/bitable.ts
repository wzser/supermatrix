import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunOutcome, SessionConfig, Task } from "../types.js";

const execFileP = promisify(execFile);

export type RunEnqueueFn = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
export type WriteRowsFn = (path: string, json: string) => Promise<void>;
export type DeleteRowsFn = (path: string) => Promise<void>;

export const DEFAULT_ENQUEUE_BIN =
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/feishu-sync-enqueue";
export const DEFAULT_ASSET = "scheduler.mirror.v2-tasks";

// The fire-time spawn2.0 prompt lives at config.body.prompt for session tasks.
// Surface it as its own column so it is readable in Feishu without parsing the
// config JSON blob. Script tasks fire a shell command, not a prompt → empty.
function promptOf(task: Task): string {
  if (task.type !== "session") return "";
  const p = (task.config as SessionConfig).body?.prompt;
  return typeof p === "string" ? p : "";
}

export function taskToFields(task: Task, latestOutcome: RunOutcome | null) {
  return {
    task_id: task.id,
    name: task.name,
    owner: task.owner,
    type: task.type,
    config: JSON.stringify(task.config),
    prompt: promptOf(task),
    enabled: task.enabled,
    cron: task.cron,
    category: task.category ?? "",
    description: task.description,
    alert_threshold: task.alertThreshold,
    alert_channel: task.alertChannel,
    retry_enabled: task.retryEnabled,
    last_success_at: task.lastSuccessAt,
    latest_outcome: latestOutcome ?? "",
  };
}

export type DailyTaskSnapshot = {
  task: Task;
  latestOutcome: RunOutcome | null;
};

export type DailyMirrorReceipt = {
  accepted: true;
  duplicate: boolean;
  jobId: number | undefined;
  dedupeKey: string;
};

type EnqueueResponse = {
  accepted?: boolean;
  duplicate?: boolean;
  job_id?: number;
  status?: string;
};

function shanghaiDateParts(date: Date): { iso: string; compact: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("unable to format Shanghai daily mirror date");
  return { iso: `${year}-${month}-${day}`, compact: `${year}${month}${day}` };
}

export async function enqueueDailyTaskMirror(opts: {
  snapshots: DailyTaskSnapshot[];
  date?: Date;
  enqueueBin?: string;
  assetName?: string;
  fromSession?: string;
  runEnqueue?: RunEnqueueFn;
  writeRows?: WriteRowsFn;
  deleteRows?: DeleteRowsFn;
}): Promise<DailyMirrorReceipt> {
  const assetName = opts.assetName ?? DEFAULT_ASSET;
  const fromSession = opts.fromSession ?? "scheduler";
  const date = shanghaiDateParts(opts.date ?? new Date());
  const dedupeKey = `${date.iso}:${fromSession}:${assetName}:scheduler-mirror-daily-${date.compact}`;
  const enqueueBin = opts.enqueueBin ?? DEFAULT_ENQUEUE_BIN;
  const runEnqueue = opts.runEnqueue ?? ((args) => execFileP(enqueueBin, args));
  const writeRows = opts.writeRows ?? ((path, json) => writeFile(path, json, "utf8"));
  const deleteRows = opts.deleteRows ?? ((path) => unlink(path));
  const rowsPath = join(tmpdir(), `scheduler-mirror-daily-${date.compact}-${randomUUID().slice(0, 8)}.json`);

  try {
    await writeRows(
      rowsPath,
      JSON.stringify(opts.snapshots.map(({ task, latestOutcome }) => taskToFields(task, latestOutcome))),
    );
    const { stdout } = await runEnqueue([
      "--op", "bitable_rows_upsert",
      "--asset", assetName,
      "--from", fromSession,
      "--key", dedupeKey,
      "--rows", rowsPath,
      "--drain-scope", "none",
    ]);
    const parsed = (() => {
      try {
        return JSON.parse(stdout) as EnqueueResponse;
      } catch {
        return null;
      }
    })();
    if (parsed?.accepted !== true && parsed?.duplicate !== true) {
      throw new Error(`daily mirror enqueue was not accepted: ${stdout.slice(0, 500)}`);
    }
    return {
      accepted: true,
      duplicate: parsed.duplicate === true,
      jobId: typeof parsed.job_id === "number" ? parsed.job_id : undefined,
      dedupeKey,
    };
  } finally {
    await deleteRows(rowsPath).catch(() => undefined);
  }
}
