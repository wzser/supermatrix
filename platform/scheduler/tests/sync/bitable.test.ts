import { describe, it, expect, vi } from "vitest";
import { enqueueDailyTaskMirror, taskToFields, DEFAULT_ASSET } from "../../src/sync/bitable.js";
import type { Task } from "../../src/types.js";

const task: Task = {
  id: "t1", name: "daily-x", description: "做啥", owner: "ads-master", createdBy: "x",
  type: "script", config: { command: "c", cwd: "/tmp" }, cron: "0 9 * * *",
  enabled: true, oneshot: false, category: "巡检", retryEnabled: false, retryMax: 0,
  retryDelayMs: 0, alertThreshold: 3, alertChannel: "owner_dm",
  lastSuccessAt: 1748649600000, createdAt: 0, updatedAt: 1782134200000,
};

const noopFs = {
  writeRows: vi.fn(async () => undefined),
  deleteRows: vi.fn(async () => undefined),
};

describe("bitable mirror — taskToFields (unchanged shape)", () => {
  it("maps the new field set", () => {
    const f = taskToFields(task, "success");
    expect(f.task_id).toBe("t1");
    expect(f.name).toBe("daily-x");
    expect(f.type).toBe("script");
    expect(f.enabled).toBe(true);
    expect(f.latest_outcome).toBe("success");
    expect(f.owner).toBe("ads-master");
    expect(f.config).toBe(JSON.stringify(task.config));
    expect(f.alert_threshold).toBe(3);
    expect(f.alert_channel).toBe("owner_dm");
    expect(f.retry_enabled).toBe(false);
  });

  it("prompt column is empty for script tasks (no spawn prompt)", () => {
    expect(taskToFields(task, "success").prompt).toBe("");
  });

  it("prompt column surfaces config.body.prompt for session tasks", () => {
    const sessionTask: Task = {
      ...task,
      id: "t2",
      type: "session",
      config: {
        url: "http://localhost:3501/api/spawn2.0",
        method: "POST",
        body: { target: "ziniao", from: "ziniao", prompt: "跑 health 巡检" },
        timeout: 120000,
      },
    };
    expect(taskToFields(sessionTask, "success").prompt).toBe("跑 health 巡检");
  });
});

describe("bitable mirror — daily full-roster batch", () => {
  it("submits all task rows as one accepted daily upsert job", async () => {
    const runEnqueue = vi.fn(() => Promise.resolve({
      stdout: JSON.stringify({ accepted: true, job_id: 42, status: "pending" }),
      stderr: "",
    }));
    const writeRows = vi.fn(async () => undefined);
    const deleteRows = vi.fn(async () => undefined);

    const result = await enqueueDailyTaskMirror({
      snapshots: [
        { task, latestOutcome: "success" },
        { task: { ...task, id: "t2", name: "daily-y" }, latestOutcome: "failed" },
      ],
      date: new Date("2026-07-18T00:00:00.000Z"),
      runEnqueue,
      writeRows,
      deleteRows,
    });

    expect(runEnqueue).toHaveBeenCalledOnce();
    const args = runEnqueue.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining([
      "--op", "bitable_rows_upsert",
      "--asset", DEFAULT_ASSET,
      "--from", "scheduler",
      "--drain-scope", "none",
    ]));
    const rows = JSON.parse(writeRows.mock.calls[0][1] as string);
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { task_id: string }) => row.task_id)).toEqual(["t1", "t2"]);
    expect(result).toEqual({
      accepted: true,
      duplicate: false,
      jobId: 42,
      dedupeKey: "2026-07-18:scheduler:scheduler.mirror.v2-tasks:scheduler-mirror-daily-20260718",
    });
    expect(deleteRows).toHaveBeenCalledOnce();
  });

  it("uses the Shanghai calendar date for the 07:10 cron key", async () => {
    const runEnqueue = vi.fn(() => Promise.resolve({
      stdout: JSON.stringify({ accepted: true, job_id: 43 }),
      stderr: "",
    }));

    const result = await enqueueDailyTaskMirror({
      snapshots: [{ task, latestOutcome: "success" }],
      // 07:10 in Shanghai is still the previous UTC day.
      date: new Date("2026-07-17T23:10:00.000Z"),
      runEnqueue,
      ...noopFs,
    });

    expect(result.dedupeKey).toBe(
      "2026-07-18:scheduler:scheduler.mirror.v2-tasks:scheduler-mirror-daily-20260718",
    );
  });

  it("accepts an existing same-day job returned as duplicate", async () => {
    const result = await enqueueDailyTaskMirror({
      snapshots: [{ task, latestOutcome: "success" }],
      date: new Date("2026-07-18T00:00:00.000Z"),
      runEnqueue: () => Promise.resolve({
        stdout: JSON.stringify({ duplicate: true, job_id: 44 }),
        stderr: "",
      }),
      ...noopFs,
    });

    expect(result).toMatchObject({ accepted: true, duplicate: true, jobId: 44 });
  });

  it("rejects a daily enqueue response that lacks acceptance", async () => {
    await expect(enqueueDailyTaskMirror({
      snapshots: [{ task, latestOutcome: "success" }],
      date: new Date("2026-07-18T00:00:00.000Z"),
      runEnqueue: () => Promise.resolve({ stdout: JSON.stringify({ accepted: false }), stderr: "" }),
      ...noopFs,
    })).rejects.toThrow("daily mirror enqueue was not accepted");
  });
});
