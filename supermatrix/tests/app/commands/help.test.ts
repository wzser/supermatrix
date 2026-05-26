import { describe, expect, test } from "vitest";
import { createHelpHandler } from "../../../src/app/commands/help.ts";
import { buildCommandRegistry } from "../../../src/app/commandRegistry.ts";
import { resetCodexModelCatalogForTests } from "../../../src/ports/CodexModelCatalog.ts";

describe("help handler", () => {
  test("root scope lists root-allowed commands in Chinese", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: {},
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/new");
    expect(result.replyText).toContain("/delete");
    expect(result.replyText).toContain("新建");
  });

  test("user scope hides root-only commands and name params", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_user" as any, messageId: "m", userId: "u", text: "/help", attachments: [], receivedAtMs: 0 },
      scope: "user",
      args: {},
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).not.toContain("/new");
    expect(result.replyText).toContain("/reset");
    expect(result.replyText).toContain("/restart");
    expect(result.replyText).toContain("/log");
    expect(result.replyText).toContain("/cancel [target...]");
    expect(result.replyText).toMatch(/\/reset\s{2,}/);
    expect(result.replyText).toMatch(/\/restart\s{2,}/);
    expect(result.replyText).toMatch(/\/status\s{2,}/);
  });

  test("summary view does not include notes", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: {},
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).not.toContain("操作顺序");
    expect(result.replyText).not.toContain("影响的资源");
    expect(result.replyText).toContain("/help <command>");
  });

  test("/help <cmd> shows detail with notes and params", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help delete", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: "delete" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/delete");
    expect(result.replyText).toContain("操作顺序");
    expect(result.replyText).toContain("影响的资源");
    expect(result.replyText).toContain("可逆性");
    expect(result.replyText).toContain("参数：");
    expect(result.replyText).toContain("name (必填)");
  });

  test("/help model documents current Codex model IDs", async () => {
    resetCodexModelCatalogForTests([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help model", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: "model" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("gpt-5.5");
    expect(result.replyText).toContain("gpt-5.4-mini");
    expect(result.replyText).toContain("gpt-5.2");
    expect(result.replyText).not.toContain("gpt-5.3-codex-spark");
  });

  test("/help next documents FIFO multi-message queue semantics", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_user" as any, messageId: "m", userId: "u", text: "/help next", attachments: [], receivedAtMs: 0 },
      scope: "user",
      args: { name: "next" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("FIFO");
    expect(result.replyText).toContain("多条");
    expect(result.replyText).toContain("/cancel next");
    expect(result.replyText).not.toContain("最多 1 条");
    expect(result.replyText).not.toContain("已有排队消息时：拒绝");
    expect(result.replyText).not.toContain("队列已满");
  });

  test("/help log documents recent injection log semantics", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_user" as any, messageId: "m", userId: "u", text: "/help log", attachments: [], receivedAtMs: 0 },
      scope: "user",
      args: { name: "log" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/log");
    expect(result.replyText).toContain("最近 10 条");
    expect(result.replyText).toContain("150 个字符");
    expect(result.replyText).toContain("只读");
  });

  test("/help <cmd> returns error for unknown command", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help foo", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: "foo" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("未知命令");
  });

  test("/help <cmd> rejects out-of-scope command", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_user" as any, messageId: "m", userId: "u", text: "/help new", attachments: [], receivedAtMs: 0 },
      scope: "user",
      args: { name: "new" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("不可用");
  });
});
