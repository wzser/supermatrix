import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { triggerShell } from "../../src/executors/trigger.js";

const ctx = { taskId: "t1", runId: "r1", triggeredAt: Date.now(), owner: "adhand" };

describe("triggerShell (fire-and-forget)", () => {
  it("returns ok with a pid for a spawnable command", async () => {
    const res = await triggerShell({
      config: { command: "true", cwd: "/tmp" },
      schedulerContext: ctx,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(typeof res.pid).toBe("number");
  });

  it("fails when cwd is not a directory", async () => {
    const res = await triggerShell({
      config: { command: "true", cwd: "/no/such/dir/xyz" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cwd/);
  });

  it("reports a nonzero shell exit code in wait-for-exit mode", async () => {
    const res = await triggerShell({
      config: { command: "exit 75", cwd: "/tmp", timeout: 1000 },
      schedulerContext: ctx,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.exitCode).toBe(75);
  });

  it("resolves immediately without waiting for the child to exit", async () => {
    const start = Date.now();
    const res = await triggerShell({
      config: { command: "sleep 5", cwd: "/tmp" },
      schedulerContext: ctx,
    });
    expect(res.ok).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000); // did not wait 5s
  });

  it("injects SM_SESSION_NAME=owner so scripts attribute identity to the task owner, not scheduler", async () => {
    const out = `/tmp/sched-v2-env-${process.pid}-${ctx.runId}.txt`;
    if (existsSync(out)) rmSync(out);
    const res = await triggerShell({
      config: { command: `printf '%s' "$SM_SESSION_NAME" > ${out}`, cwd: "/tmp" },
      schedulerContext: ctx,
    });
    expect(res.ok).toBe(true);
    // detached child; poll briefly for the file
    for (let i = 0; i < 40 && !existsSync(out); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(readFileSync(out, "utf8")).toBe("adhand");
    rmSync(out);
  });

  it("injects SM_SCHEDULER_* context vars alongside SM_SESSION_NAME", async () => {
    const out = `/tmp/sched-v2-schedenv-${process.pid}-${ctx.runId}.txt`;
    if (existsSync(out)) rmSync(out);
    const res = await triggerShell({
      config: { command: `printf '%s' "$SM_SCHEDULER_TASK_ID" > ${out}`, cwd: "/tmp" },
      schedulerContext: ctx,
    });
    expect(res.ok).toBe(true);
    for (let i = 0; i < 40 && !existsSync(out); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(readFileSync(out, "utf8")).toBe("t1");
    rmSync(out);
  });
});
