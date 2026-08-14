import { describe, expect, test } from "vitest";
import { buildCommandRegistry } from "../../../src/app/commandRegistry.ts";
import { createHelpHandler } from "../../../src/app/commands/help.ts";

describe("rank help", () => {
  test("documents the root-only personal detail form", async () => {
    const handler = createHelpHandler(buildCommandRegistry());
    const result = await handler({
      msg: {
        groupId: "oc_root" as any,
        messageId: "m",
        userId: "u",
        text: "/help rank",
        attachments: [],
        receivedAtMs: 0,
      },
      scope: "root",
      args: { name: "rank" },
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/rank <完整姓名>");
    expect(result.replyText).toContain("仅 Console 群");
    expect(result.replyText).toContain("全局名次");
    expect(result.replyText).toContain("全部 session 分布");
    expect(result.replyText).toContain("open_id");
  });
});
