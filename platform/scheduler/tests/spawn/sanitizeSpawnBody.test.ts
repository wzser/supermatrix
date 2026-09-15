import { describe, it, expect } from "vitest";
import { sanitizeSpawnBody } from "../../src/spawn/sanitizeSpawnBody.js";

const ctx = { taskId: "task-1", runId: "run-1", triggeredAt: 1748649600000, owner: "ads-master" };

describe("sanitizeSpawnBody", () => {
  it("injects from/closure/origin and client_request_id for spawn2.0", () => {
    const out = sanitizeSpawnBody({
      pathname: "/api/spawn2.0",
      body: { target: "ads-master", prompt: "hi" },
      schedulerContext: ctx,
    });
    expect(out.from).toBe("scheduler");
    expect(out.closure).toEqual({ kind: "message", target: { type: "inline" } });
    expect((out.origin as { kind: string }).kind).toBe("scheduler");
    expect((out.origin as { task_id: string }).task_id).toBe("task-1");
    expect(out.client_request_id).toContain(":scheduler:task-1:run-1:ads-master");
    expect("mode" in out).toBe(false);
  });

  it("preserves an existing legal non-scheduler origin (e.g. message_run gets overwritten, other kept)", () => {
    const kept = sanitizeSpawnBody({
      pathname: "/api/spawn2.0",
      body: { target: "x", prompt: "p", origin: { kind: "other", note: "keep" } },
      schedulerContext: ctx,
    });
    expect((kept.origin as { kind: string }).kind).toBe("other");

    const overwritten = sanitizeSpawnBody({
      pathname: "/api/spawn2.0",
      body: { target: "x", prompt: "p", origin: { kind: "message_run" } },
      schedulerContext: ctx,
    });
    expect((overwritten.origin as { kind: string }).kind).toBe("scheduler");
  });

  it("passes non-spawn2.0 bodies through untouched", () => {
    const body = { foo: "bar" };
    expect(sanitizeSpawnBody({ pathname: "/other", body })).toBe(body);
  });
});
