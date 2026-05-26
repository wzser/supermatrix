import { describe, it, expect, vi } from "vitest";
import { createCustomChat } from "../../../../src/notify/v2/channels/customChat.js";

describe("customChat channel", () => {
  it("calls lark-cli with chat-id", async () => {
    const runCli = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const send = createCustomChat({ larkCliPath: "lark-cli", runCli });
    await send(
      {
        event: "receipt_missing",
        taskId: "t",
        runId: "r",
        taskName: "my-task",
        ownerSession: "my-owner",
        message: "msg",
      },
      "oc_abcdef"
    );
    expect(runCli).toHaveBeenCalledWith(
      "lark-cli",
      expect.arrayContaining([
        "im",
        "+messages-send",
        "--chat-id",
        "oc_abcdef",
        "--as",
        "bot",
        "--text",
        expect.stringContaining("my-task"),
      ])
    );
  });
});
