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
    expect(result.replyText).toContain("/clone <claude|codex|kimi> <name>");
    expect(result.replyText).toContain("/reset");
    expect(result.replyText).toContain("/restart");
    expect(result.replyText).toMatch(/\/cancel \[next\]\s{2,}/);
    expect(result.replyText).toMatch(/\/reset\s{2,}/);
    expect(result.replyText).toMatch(/\/restart\s{2,}/);
    expect(result.replyText).toMatch(/\/status\s{2,}/);
    expect(result.replyText).toMatch(/\/lock\s{2,}/);
    expect(result.replyText).toMatch(/\/unlock\s{2,}/);
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
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
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
    expect(result.replyText).toContain("gpt-5.6-sol");
    expect(result.replyText).toContain("gpt-5.6-terra");
    expect(result.replyText).toContain("gpt-5.6-luna");
    expect(result.replyText).toContain("gpt-5.5");
    expect(result.replyText).toContain("gpt-5.4-mini");
    expect(result.replyText).not.toContain("gpt-5.2");
    expect(result.replyText).not.toContain("gpt-5.3-codex");
    expect(result.replyText).not.toContain("gpt-5.3-codex-spark");
  });

  test("/help effort documents backend-specific levels and current Codex model matrix", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help effort", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: "effort" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("Claude: low / medium / high / xhigh / max");
    expect(result.replyText).toContain("Codex: 按 model 区分");
    expect(result.replyText).toContain(
      "gpt-5.6-sol / gpt-5.6-terra: low / medium / high / xhigh / max / ultra",
    );
    expect(result.replyText).toContain("gpt-5.6-luna: low / medium / high / xhigh / max");
    expect(result.replyText).toContain(
      "gpt-5.5 / gpt-5.4 / gpt-5.4-mini: low / medium / high / xhigh",
    );
    expect(result.replyText).not.toContain("none / minimal");
    expect(result.replyText).not.toContain("Codex Ultra");
    expect(result.replyText).not.toContain("ultra 仅 Codex 支持");
    expect(result.replyText).toContain(
      "Codex 后端：写入 model_reasoning_effort；selected model 支持的 effort 原样传递，不支持的历史 max / ultra 降级为 xhigh",
    );
    expect(result.replyText).not.toContain("映射为 --reasoning-effort 参数");
    expect(result.replyText).toContain("/effort all-codex ultra  # sol/terra=ultra, luna=max, 5.5/5.4=xhigh");
    expect(result.replyText).toContain("actual effective");
  });

  test("/help model documents Kimi models, aliases, and thinking capability", async () => {
    const result = await createHelpHandler(buildCommandRegistry())({ args: { name: "model" }, scope: "root", msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help model", attachments: [], receivedAtMs: 0 } });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("Kimi:");
    expect(result.replyText).toContain("kimi-code/kimi-for-coding");
    expect(result.replyText).toContain("kimi-code/kimi-for-coding-highspeed");
    expect(result.replyText).toContain("kimi-code/k3");
    expect(result.replyText).not.toContain("kimi-code/k3-256k");
    expect(result.replyText).toContain("K2.7 thinking 固定 on");
    expect(result.replyText).toContain("low/medium/high/xhigh/max/ultra 映射 K3 原生 low/high/max");
    expect(result.replyText).toContain("highspeed / fast");
    expect(result.replyText).not.toContain("k3256k");
    expect(result.replyText).toContain("/model my-kimi-session k3");
  });

  test("/help model documents atomic clamp and manual reset semantics", async () => {
    const result = await createHelpHandler(buildCommandRegistry())({ args: { name: "model" }, scope: "root", msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help model", attachments: [], receivedAtMs: 0 } });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/model amz-sql gpt-5.5  # max/ultra becomes xhigh when necessary");
    expect(result.replyText).toContain("/model all-codex gpt-5.6-luna  # all selected sessions update atomically");
    expect(result.replyText).toContain("conversation context");
    expect(result.replyText).toContain("必须手动执行 /reset");
  });

  test("/help <cmd> lookup is case-insensitive", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    for (const typed of ["MODEL", "Model"]) {
      const result = await handler({
        msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: `/help ${typed}`, attachments: [], receivedAtMs: 0 },
        scope: "root",
        args: { name: typed },
      });
      if (!("replyText" in result)) throw new Error("expected replyText");
      expect(result.replyText).toContain("/model");
      expect(result.replyText).not.toContain("未知命令");
    }
  });

  test("/help <cmd> lookup accepts fullwidth command tokens", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const typed = "ＭＯＤＥＬ";
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: `/help ${typed}`, attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: typed },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/model");
    expect(result.replyText).not.toContain("未知命令");
  });

  test("/help <cmd> keeps typed unknown command in the error", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help ＮＯＰＥ", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: "ＮＯＰＥ" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("未知命令：/ＮＯＰＥ");
  });

  test("/help backend describes one atomic runtime tuple commit", async () => {
    const result = await createHelpHandler(buildCommandRegistry())({ args: { name: "backend" }, scope: "root", msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help backend", attachments: [], receivedAtMs: 0 } });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("backend / backendSessionId / model / effort");
    expect(result.replyText).toContain("一次原子提交");
    expect(result.replyText).not.toContain("2. 清空 backendSessionId");
    expect(result.replyText).not.toContain("3. 重置 model");
    expect(result.replyText).not.toContain("4. 更新 backend 字段");
  });

  test("/help reload does not promise force-reload busy-session nudge", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);
    const result = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help reload", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: "reload" },
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("--force");
    expect(result.replyText).not.toContain("完成了吗？没完成就继续");
    expect(result.replyText).not.toContain("催一句");
    expect(result.replyText).not.toContain("user 身份");
    expect(result.replyText).not.toContain("30 秒");
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
    expect(result.replyText).not.toContain("最多 1 条");
    expect(result.replyText).not.toContain("已有排队消息时：拒绝");
    expect(result.replyText).not.toContain("队列已满");
  });

  test("/help heartbeat distinguishes temporary pause from permanent stop and lists per-scope forms", async () => {
    const reg = buildCommandRegistry();
    const handler = createHelpHandler(reg);

    const userResult = await handler({
      msg: { groupId: "oc_user" as any, messageId: "m", userId: "u", text: "/help heartbeat", attachments: [], receivedAtMs: 0 },
      scope: "user",
      args: { name: "heartbeat" },
    });
    if (!("replyText" in userResult)) throw new Error("expected replyText");
    const userText = userResult.replyText;

    // Per-state semantics must be spelled out.
    expect(userText).toMatch(/on\s+—\s+永久开启/);
    expect(userText).toMatch(/off\s+—\s+永久停止/);
    expect(userText).toMatch(/stop\s+—\s+临时暂停\s*60\s*分钟/);
    expect(userText).toMatch(/stop <minutes>\s+—\s+临时暂停指定分钟数/);
    expect(userText).toMatch(/stop permanent\s+—\s+永久停止/);
    expect(userText).toMatch(/resume\s+—\s+取消临时暂停并重新开启/);
    expect(userText).toMatch(/status\s+—\s+只读查询/);

    // The temporary-vs-permanent distinction must be explicit on the heartbeat_enabled flag.
    expect(userText).toContain("sessions.heartbeat_enabled");
    expect(userText).toContain("stop [minutes] 只改暂停表，不动标志");

    // Per-scope forms must be documented.
    expect(userText).toContain("Session 群");
    expect(userText).toContain("Console 群");
    expect(userText).toContain("stop heartbeat");
    expect(userText).toContain("resume heartbeat");

    // Root scope should render the same per-state notes.
    const rootResult = await handler({
      msg: { groupId: "oc_root" as any, messageId: "m", userId: "u", text: "/help heartbeat", attachments: [], receivedAtMs: 0 },
      scope: "root",
      args: { name: "heartbeat" },
    });
    if (!("replyText" in rootResult)) throw new Error("expected replyText");
    expect(rootResult.replyText).toMatch(/stop\s+—\s+临时暂停\s*60\s*分钟/);
    expect(rootResult.replyText).toMatch(/off\s+—\s+永久停止/);
    expect(rootResult.replyText).toContain("/heartbeat <session-name>");
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
