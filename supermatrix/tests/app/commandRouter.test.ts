import { describe, expect, test } from "vitest";
import { createCommandRouter } from "../../src/app/commandRouter.ts";
import { buildCommandRegistry } from "../../src/app/commandRegistry.ts";
import type { CommandHandler } from "../../src/app/commandRegistry.ts";
import { asLarkGroupId } from "../../src/domain/ids.ts";
import { UserError } from "../../src/domain/errors.ts";

function bindAll(handler: CommandHandler) {
  const reg = buildCommandRegistry();
  for (const entry of Object.values(reg)) {
    entry.handler = handler;
  }
  return reg;
}

describe("commandRouter", () => {
  test("dispatches to the right handler", async () => {
    let called: string | undefined;
    const reg = bindAll(async ({}) => {
      called = "yes";
      return { replyText: "ok" };
    });
    const router = createCommandRouter(reg);
    const result = await router.route({
      scope: "root",
      msg: {
        groupId: asLarkGroupId("oc_1"),
        messageId: "m",
        userId: "u",
        text: "/help",
        attachments: [],
        receivedAtMs: 0,
      },
    });
    expect(called).toBe("yes");
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toBe("ok");
  });

  test("routes /log in user scope", async () => {
    let called = false;
    const reg = bindAll(async () => ({ replyText: "" }));
    reg.log.handler = async () => {
      called = true;
      return { replyText: "log ok" };
    };
    const router = createCommandRouter(reg);
    const result = await router.route({
      scope: "user",
      msg: {
        groupId: asLarkGroupId("oc_1"),
        messageId: "m",
        userId: "u",
        text: "/log",
        attachments: [],
        receivedAtMs: 0,
      },
    });
    expect(called).toBe(true);
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toBe("log ok");
  });

  test("rejects unknown command with Chinese error", async () => {
    const reg = bindAll(async () => ({ replyText: "" }));
    const router = createCommandRouter(reg);
    const result = await router.route({
      scope: "root",
      msg: {
        groupId: asLarkGroupId("oc_1"),
        messageId: "m",
        userId: "u",
        text: "/nope",
        attachments: [],
        receivedAtMs: 0,
      },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("未知命令");
  });

  test("rejects wrong-scope command with clear message", async () => {
    const reg = bindAll(async () => ({ replyText: "" }));
    const router = createCommandRouter(reg);
    const result = await router.route({
      scope: "user",
      msg: {
        groupId: asLarkGroupId("oc_1"),
        messageId: "m",
        userId: "u",
        text: "/new claude foo",
        attachments: [],
        receivedAtMs: 0,
      },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("不可在");
  });

  test("UserError in handler becomes ❌ prefixed reply", async () => {
    const reg = bindAll(async () => {
      throw new UserError("名称已存在");
    });
    const router = createCommandRouter(reg);
    const result = await router.route({
      scope: "root",
      msg: {
        groupId: asLarkGroupId("oc_1"),
        messageId: "m",
        userId: "u",
        text: "/help",
        attachments: [],
        receivedAtMs: 0,
      },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("❌");
    expect(result.replyText).toContain("名称已存在");
  });
});
