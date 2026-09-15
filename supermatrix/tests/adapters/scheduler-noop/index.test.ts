import { describe, expect, test } from "vitest";
import { NoopScheduler } from "../../../src/adapters/scheduler-noop/index.ts";

describe("NoopScheduler", () => {
  test("listTasks returns empty", async () => {
    const s = new NoopScheduler();
    expect(await s.listTasks()).toEqual([]);
  });

  test("addTask throws UserError-ish", async () => {
    const s = new NoopScheduler();
    await expect(
      s.addTask({ cronExpression: "* * * * *", sessionName: "foo", prompt: "x", enabled: true })
    ).rejects.toThrow(/scheduler/);
  });
});
