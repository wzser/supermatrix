import { describe, it, expect, vi } from "vitest";
import type { NotifyRule } from "../../../src/classes/types.js";
import { createNotifyRouter } from "../../../src/notify/v2/router.js";

describe("notify router", () => {
  it("routes ownerDM event to ownerDM channel", async () => {
    const ownerDM = vi.fn().mockResolvedValue(undefined);
    const userDM = vi.fn();
    const customChat = vi.fn();
    const router = createNotifyRouter({ ownerDM, userDM, customChat });
    const rule: NotifyRule = { channel: "ownerDM" };
    await router.route(rule, {
      event: "receipt_missing",
      taskId: "t-1",
      runId: "r-1",
      taskName: "my-task",
      ownerSession: "my-owner",
      message: "failed",
    });
    expect(ownerDM).toHaveBeenCalledOnce();
    expect(userDM).not.toHaveBeenCalled();
    expect(customChat).not.toHaveBeenCalled();
  });

  it("channel=none does nothing", async () => {
    const ownerDM = vi.fn();
    const userDM = vi.fn();
    const customChat = vi.fn();
    const router = createNotifyRouter({ ownerDM, userDM, customChat });
    await router.route(
      { channel: "none" },
      {
        event: "succeeded",
        taskId: "t",
        runId: "r",
        taskName: "n",
        ownerSession: "o",
        message: "",
      }
    );
    expect(ownerDM).not.toHaveBeenCalled();
    expect(userDM).not.toHaveBeenCalled();
    expect(customChat).not.toHaveBeenCalled();
  });

  it("customChat requires target", async () => {
    const router = createNotifyRouter({
      ownerDM: vi.fn(),
      userDM: vi.fn(),
      customChat: vi.fn(),
    });
    await expect(
      router.route(
        { channel: "customChat" },
        {
          event: "receipt_missing",
          taskId: "t",
          runId: "r",
          taskName: "n",
          ownerSession: "o",
          message: "",
        }
      )
    ).rejects.toThrow(/target/);
  });
});
