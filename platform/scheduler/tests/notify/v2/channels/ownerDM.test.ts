import { describe, it, expect, vi } from "vitest";
import { createOwnerDM } from "../../../../src/notify/v2/channels/ownerDM.js";

describe("ownerDM channel", () => {
  it("POSTs /api/spawn targeting ownerSession with no mode field", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, childSessionId: "child-abc" }),
    });
    const send = createOwnerDM({
      spawnApiUrl: "http://localhost:3501/api/spawn",
      fetchImpl: fetchFn,
    });
    await send({
      event: "receipt_missing",
      taskId: "t-1",
      runId: "r-1",
      taskName: "my-task",
      ownerSession: "my-owner",
      message: "task X failed",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:3501/api/spawn");
    const body = JSON.parse(init.body);
    expect(body.target).toBe("my-owner");
    expect(body.mode).toBeUndefined();
    expect(body.from).toBe("scheduler");
    expect(body.prompt).toContain("my-task");
  });

  it("throws on non-2xx", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "session not found",
    });
    const send = createOwnerDM({ spawnApiUrl: "http://x", fetchImpl: fetchFn });
    await expect(
      send({
        event: "receipt_missing",
        taskId: "t",
        runId: "r",
        taskName: "n",
        ownerSession: "missing",
        message: "",
      })
    ).rejects.toThrow(/404/);
  });
});
