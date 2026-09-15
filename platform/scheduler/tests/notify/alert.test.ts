import { describe, it, expect, vi } from "vitest";
import { createAlertSender, deriveTriggerMode } from "../../src/notify/alert.js";
import type { Task } from "../../src/types.js";

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1", name: "daily-x", description: "", owner: "ads-master", createdBy: "x",
    type: "script", config: { command: "c", cwd: "/tmp" }, cron: "0 9 * * *",
    enabled: true, oneshot: false, category: null, retryEnabled: false, retryMax: 0,
    retryDelayMs: 0, alertThreshold: 3, alertChannel: "owner_dm", lastSuccessAt: null,
    createdAt: 0, updatedAt: 0, ...over,
  };
}

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ messageId: "om_x" }), { status: 200 }));
}

describe("alert sender", () => {
  it("owner_dm posts to /api/notify without targetChatId (defaults to Console group)", async () => {
    const fetchImpl = mockFetch();
    const send = createAlertSender({ smApiUrl: "http://localhost:3501", fetchImpl });
    await send(mkTask({ alertChannel: "owner_dm" }), 3);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:3501/api/notify");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ source: "scheduler", level: "error" });
    expect(body.title).toContain("daily-x");
    expect(body.targetChatId).toBeUndefined();
    expect(body.metadata.taskId).toBe("t1");
    expect(body.metadata.consecutiveFailures).toBe(3);
  });

  it("oc_ channel posts with targetChatId set to that chat", async () => {
    const fetchImpl = mockFetch();
    const send = createAlertSender({ smApiUrl: "http://localhost:3501", fetchImpl });
    await send(mkTask({ alertChannel: "oc_group123" }), 3);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.targetChatId).toBe("oc_group123");
  });

  it("none channel does not fire", async () => {
    const fetchImpl = mockFetch();
    const send = createAlertSender({ smApiUrl: "http://localhost:3501", fetchImpl });
    await send(mkTask({ alertChannel: "none" }), 3);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows fetch errors (best-effort, never throws into the tick)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("notify down"); });
    const send = createAlertSender({ smApiUrl: "http://localhost:3501", fetchImpl });
    await expect(send(mkTask(), 3)).resolves.toBeUndefined();
  });

  it("derives 4 trigger modes from task type + config", () => {
    expect(deriveTriggerMode(mkTask({
      type: "script", config: { command: "c", cwd: "/tmp", timeout: 60000 },
    }))).toBe("script-wait");

    expect(deriveTriggerMode(mkTask({
      type: "script", config: { command: "c", cwd: "/tmp" },
    }))).toBe("script-fnf");

    expect(deriveTriggerMode(mkTask({
      type: "session",
      config: {
        url: "http://localhost:3501/api/spawn2.0", method: "POST",
        body: { target: "ads-master", prompt: "x",
                closure: { kind: "message", target: { type: "todo_pool" } } },
        timeout: 120000,
      },
    }))).toBe("session-async");

    expect(deriveTriggerMode(mkTask({
      type: "session",
      config: {
        url: "http://localhost:3501/api/spawn2.0", method: "POST",
        body: { target: "ads-master", prompt: "x",
                closure: { kind: "message", target: { type: "topic", topic: "x" } } },
        timeout: 120000,
      },
    }))).toBe("session-sync");

    // session with inline closure → also sync (fetch sync-waits for child)
    expect(deriveTriggerMode(mkTask({
      type: "session",
      config: {
        url: "http://localhost:3501/api/spawn2.0", method: "POST",
        body: { target: "ads-master", prompt: "x",
                closure: { kind: "message", target: { type: "inline" } } },
        timeout: 120000,
      },
    }))).toBe("session-sync");
  });

  it("alert body + metadata reflect script-wait mode (exit ≠0 wording, not 'spawn 没起来')", async () => {
    const fetchImpl = mockFetch();
    const send = createAlertSender({ smApiUrl: "http://localhost:3501", fetchImpl });
    await send(mkTask({
      type: "script",
      config: { command: "c", cwd: "/tmp", timeout: 300000 },
    }), 3);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.body).toContain("triggerMode: script-wait");
    expect(body.body).toContain("脚本退出非 0 或超时");
    expect(body.body).not.toContain("spawn 没起来");
    expect(body.metadata.triggerMode).toBe("script-wait");
    expect(body.metadata.taskType).toBe("script");
  });

  it("alert body for session-sync warns child may still run on owner side", async () => {
    const fetchImpl = mockFetch();
    const send = createAlertSender({ smApiUrl: "http://localhost:3501", fetchImpl });
    await send(mkTask({
      type: "session",
      config: {
        url: "http://localhost:3501/api/spawn2.0", method: "POST",
        body: { target: "ads-master", prompt: "x",
                closure: { kind: "message", target: { type: "topic", topic: "y" } } },
        timeout: 120000,
      },
    }), 3);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.body).toContain("triggerMode: session-sync");
    expect(body.body).toContain("子 session 仍在 owner 侧跑");
    expect(body.metadata.triggerMode).toBe("session-sync");
  });
});
