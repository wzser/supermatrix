import { describe, expect, it, vi } from "vitest";
import type { Task } from "../src/types.js";
import {
  findBootExpiredCandidates,
  findBootRecoveryCandidates,
  recoverMissedTasks,
} from "../src/recovery.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "account-health", name: "account-health", description: "", owner: "ziniao", createdBy: "scheduler",
    type: "script", config: { command: "true", cwd: "/tmp", catchUpOnBoot: true },
    cron: "43 0 * * *", enabled: true, oneshot: false, category: null,
    retryEnabled: false, retryMax: 0, retryDelayMs: 0, alertThreshold: 0, alertChannel: "none",
    lastSuccessAt: null, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

describe("findBootRecoveryCandidates", () => {
  it("returns the latest missed opted-in tick after a scheduler restart", () => {
    const now = Date.parse("2026-07-25T09:48:22+08:00");

    expect(findBootRecoveryCandidates([task()], now, () => false)).toEqual([
      { task: task(), scheduledAt: Date.parse("2026-07-25T00:43:00+08:00") },
    ]);
  });

  it("records the prior expired gap instead of reusing a delivered current slot as catch-up", () => {
    const now = Date.parse("2026-07-26T21:30:00+08:00");
    const deliveredToday = Date.parse("2026-07-26T00:43:00+08:00");
    const missedYesterday = Date.parse("2026-07-25T00:43:00+08:00");

    const hasDelivery = (_taskId: string, scheduledAt: number) => scheduledAt === deliveredToday;

    // The latest slot already has a delivery, so no business task may be replayed.
    expect(findBootRecoveryCandidates([task()], now, hasDelivery)).toEqual([]);
    // The older missing slot is availability evidence only, not a dispatch candidate.
    expect(findBootExpiredCandidates([task()], now, hasDelivery)).toEqual([
      { task: task(), scheduledAt: missedYesterday },
    ]);
  });

  it("delivers the missed tick using its original scheduled time", async () => {
    const now = Date.parse("2026-07-25T09:48:22+08:00");
    const deliver = async (candidate: { task: Task; scheduledAt: number }) => undefined;
    const delivered = vi.fn(deliver);

    await recoverMissedTasks([task()], now, () => false, delivered);

    expect(delivered).toHaveBeenCalledWith({
      task: task(), scheduledAt: Date.parse("2026-07-25T00:43:00+08:00"),
    });
  });
});
