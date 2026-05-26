import { describe, it, expect, vi } from "vitest";
import { createUserDM } from "../../../../src/notify/v2/channels/userDM.js";

describe("userDM channel", () => {
  it("calls lark-cli with user-id", async () => {
    const runCli = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const send = createUserDM({
      larkCliPath: "lark-cli",
      userOpenId: "ou_xxx",
      runCli,
    });
    await send({
      event: "receipt_missing",
      taskId: "t-1",
      runId: "r-1",
      taskName: "my-task",
      ownerSession: "my-owner",
      message: "hello",
    });
    expect(runCli).toHaveBeenCalledWith(
      "lark-cli",
      expect.arrayContaining([
        "im",
        "+messages-send",
        "--user-id",
        "ou_xxx",
        "--as",
        "bot",
        "--text",
        expect.stringContaining("my-task"),
      ])
    );
  });
});
