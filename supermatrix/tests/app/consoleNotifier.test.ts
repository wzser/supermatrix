import { describe, it, expect, vi } from "vitest";
import {
  buildCardContent,
  buildPlainText,
  classifyNotifyError,
  createConsoleNotifier,
  type NotifyEvent,
} from "../../src/app/consoleNotifier.ts";
import type { Clock } from "../../src/ports/Clock.ts";
import { asTimestamp } from "../../src/domain/ids.ts";

const FIXED_MS = 1713600000000; // 2024-04-20 08:00:00 UTC → 16:00:00 Asia/Shanghai
const fixedClock: Clock = { now: () => asTimestamp(FIXED_MS) };

describe("buildCardContent", () => {
  it("uses yellow template and notification-card prefix for info (default level)", () => {
    const card = JSON.parse(buildCardContent(
      { source: "watchdog", title: "t", body: "b" },
      FIXED_MS,
    ));
    expect(card.header.template).toBe("yellow");
    expect(card.header.title.content).toBe("【通知卡片】t");
  });

  it("does not duplicate the notification-card title prefix", () => {
    const card = JSON.parse(buildCardContent(
      { source: "watchdog", title: "【通知卡片】done", body: "b" },
      FIXED_MS,
    ));
    expect(card.header.title.content).toBe("【通知卡片】done");
  });

  it("maps warn→orange, error→red", () => {
    const warnCard = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", level: "warn" },
      FIXED_MS,
    ));
    expect(warnCard.header.template).toBe("orange");
    const errCard = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", level: "error" },
      FIXED_MS,
    ));
    expect(errCard.header.template).toBe("red");
  });

  it("maps success→purple", () => {
    const card = JSON.parse(buildCardContent(
      { source: "autobitable", title: "lifecycle complete", body: "ok", level: "success" },
      FIXED_MS,
    ));
    expect(card.header.template).toBe("purple");
  });

  it("renders a V2 card with markdown body and no config", () => {
    const card = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "**hello**" },
      FIXED_MS,
    ));
    expect(card.schema).toBe("2.0");
    expect(card).not.toHaveProperty("config");
    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "**hello**" });
  });

  it("renders notify actions as a V2 button row with the frozen callback value", () => {
    const card = JSON.parse(buildCardContent(
      {
        source: "gongying",
        title: "补货确认",
        body: "请确认本批次。",
        actions: {
          card_type: "gongying_replenish_confirm",
          options: [
            { label: "确认补货", value: "confirm" },
            { label: "跳过", value: "skip", description: "本批次不补货" },
          ],
          context: { batch_id: "B123" },
        },
      },
      FIXED_MS,
    ));
    const actionRow = card.body.elements[1];
    expect(actionRow).toMatchObject({
      tag: "column_set",
      columns: [
        {
          tag: "column",
          elements: [
            {
              tag: "button",
              element_id: expect.stringMatching(/^na_[0-9a-f]{8}_0$/u),
              text: { tag: "plain_text", content: "确认补货" },
              type: "primary",
              value: {
                __notify_action: true,
                card_type: "gongying_replenish_confirm",
                value: "confirm",
                context: { batch_id: "B123" },
              },
            },
          ],
        },
        {
          tag: "column",
          elements: [
            {
              tag: "button",
              element_id: expect.stringMatching(/^na_[0-9a-f]{8}_1$/u),
              text: { tag: "plain_text", content: "跳过" },
              type: "primary",
              value: {
                __notify_action: true,
                card_type: "gongying_replenish_confirm",
                value: "skip",
              },
            },
          ],
        },
      ],
    });
    const buttons = actionRow.columns.flatMap((column: { elements: unknown[] }) => column.elements);
    const tokens = buttons.map((button: { value: { token: string } }) => button.value.token);
    expect(tokens[0]).toMatch(/^na_[0-9a-f]{8}$/u);
    expect(tokens[1]).toBe(tokens[0]);
    expect(card.body.elements[2].tag).toBe("markdown");
  });

  it("renders metadata as hr + collapsed V2 panel with one markdown widget", () => {
    const card = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", metadata: { run_id: "abc", n: 42, ok: true } },
      FIXED_MS,
    ));
    expect(card.body.elements).toHaveLength(4);
    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "b" });
    expect(card.body.elements[1]).toEqual({ tag: "hr" });
    const panel = card.body.elements[2];
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toBe("**详情 metadata (3 项)**");
    expect(panel.elements).toEqual([
      {
        tag: "markdown",
        content: "**run_id**: abc\n\n**n**: 42\n\n**ok**: true",
      },
    ]);
  });

  it("omits metadata section when absent or empty", () => {
    const absent = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b" },
      FIXED_MS,
    )) as { body: { elements: Array<{ tag: string }> } };
    expect(absent.body.elements).toHaveLength(2);
    expect(absent.body.elements.some((e) => e.tag === "hr")).toBe(false);
    expect(absent.body.elements.some((e) => e.tag === "collapsible_panel")).toBe(false);

    const empty = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", metadata: {} },
      FIXED_MS,
    )) as { body: { elements: Array<{ tag: string }> } };
    expect(empty.body.elements).toHaveLength(2);
    expect(empty.body.elements.some((e) => e.tag === "hr")).toBe(false);
    expect(empty.body.elements.some((e) => e.tag === "collapsible_panel")).toBe(false);
  });

  it("footer signature is grey V2 markdown with source · Asia/Shanghai timestamp", () => {
    const card = JSON.parse(buildCardContent(
      { source: "watchdog", title: "t", body: "b" },
      FIXED_MS,
    ));
    const note = card.body.elements[card.body.elements.length - 1];
    expect(note.tag).toBe("markdown");
    const text = note.content as string;
    expect(text).toMatch(/^<font color='grey'>/u);
    expect(text).toContain("watchdog · ");
    expect(text).toContain("2024-04-20 16:00:00");
    expect(text).toMatch(/<\/font>$/u);
  });

  it("serializes non-primitive metadata as JSON", () => {
    const card = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", metadata: { nested: { k: 1 } } },
      FIXED_MS,
    ));
    const panel = card.body.elements[2];
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.elements[0]).toEqual({
      tag: "markdown",
      content: '**nested**: {"k":1}',
    });
  });

  it("produces valid JSON even with markdown special chars in body", () => {
    const content = buildCardContent(
      { source: "s", title: "t", body: "```js\nconst x = 1;\n```\n**bold**\n\"quoted\"" },
      FIXED_MS,
    );
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

describe("buildPlainText", () => {
  it("starts with [level] source: prefixed title", () => {
    const text = buildPlainText(
      { source: "watchdog", title: "done", body: "ok", level: "warn" },
      FIXED_MS,
    );
    expect(text.split("\n")[0]).toBe("[warn] watchdog: 【通知卡片】done");
  });

  it("defaults level to info", () => {
    const text = buildPlainText(
      { source: "s", title: "t", body: "b" },
      FIXED_MS,
    );
    expect(text).toContain("[info]");
  });

  it("expands metadata to key: value per line with unchanged serialization", () => {
    const text = buildPlainText(
      { source: "s", title: "t", body: "b", metadata: { run_id: "abc", n: 42, ok: true, nested: { k: 1 } } },
      FIXED_MS,
    );
    expect(text).toContain("run_id: abc");
    expect(text).toContain("n: 42");
    expect(text).toContain("ok: true");
    expect(text).toContain('nested: {"k":1}');
  });

  it("includes CST-formatted timestamp footer", () => {
    const text = buildPlainText(
      { source: "s", title: "t", body: "b" },
      FIXED_MS,
    );
    expect(text).toContain("2024-04-20 16:00:00");
  });

  it("lists notify action labels in the text fallback", () => {
    const text = buildPlainText(
      {
        source: "gongying",
        title: "补货确认",
        body: "请确认本批次。",
        actions: {
          card_type: "gongying_replenish_confirm",
          options: [
            { label: "确认补货", value: "confirm" },
            { label: "跳过", value: "skip" },
          ],
        },
      },
      FIXED_MS,
    );
    expect(text).toContain("选项（按钮仅在卡片形态可用）：[确认补货] [跳过]");
  });
});

describe("createConsoleNotifier", () => {
  const mkLogger = () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child() { return this; },
  });

  it("happy path: sends card, returns messageId, degraded=false", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_card123" });
    const sendText = vi.fn();
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
    });
    const res = await notifier.notify({
      source: "watchdog",
      title: "hi",
      body: "world",
    });
    expect(res).toEqual({ messageId: "om_card123", degraded: false });
    expect(sendCard).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();

    const cardJson = sendCard.mock.calls[0]![0] as string;
    const parsed = JSON.parse(cardJson);
    expect(parsed.header.template).toBe("yellow");
    expect(parsed.header.title.content).toBe("【通知卡片】hi");
  });

  it("passes targetChatId to card sends", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_card123" });
    const sendText = vi.fn();
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
    });
    await notifier.notify({
      source: "watchdog",
      title: "hi",
      body: "world",
      targetChatId: "oc_target_chat",
    });
    expect(sendCard).toHaveBeenCalledWith(expect.any(String), "oc_target_chat");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("card failure falls back to plain text and marks degraded=true", async () => {
    const sendCard = vi.fn().mockRejectedValue(new Error("card rejected: invalid content"));
    const sendText = vi.fn().mockResolvedValue({ messageId: "om_text456" });
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
    });
    const res = await notifier.notify({
      source: "watchdog",
      title: "hi",
      body: "world",
      level: "error",
      metadata: { trace: "abc" },
    });
    expect(res.messageId).toBe("om_text456");
    expect(res.degraded).toBe(true);
    expect(res.error).toContain("card rejected");
    expect(sendCard).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledOnce();

    const textArg = sendText.mock.calls[0]![0] as string;
    expect(sendText).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(textArg).toContain("[error] watchdog: 【通知卡片】hi");
    expect(textArg).toContain("trace: abc");
  });

  it("passes targetChatId to fallback text sends", async () => {
    const sendCard = vi.fn().mockRejectedValue(new Error("card rejected"));
    const sendText = vi.fn().mockResolvedValue({ messageId: "om_text456" });
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
    });
    await notifier.notify({
      source: "watchdog",
      title: "hi",
      body: "world",
      targetChatId: "oc_target_chat",
    });
    expect(sendCard).toHaveBeenCalledWith(expect.any(String), "oc_target_chat");
    expect(sendText).toHaveBeenCalledWith(expect.any(String), "oc_target_chat");
  });

  it("throws when card AND text both fail (no silent drop)", async () => {
    const sendCard = vi.fn().mockRejectedValue(new Error("card fail"));
    const sendText = vi.fn().mockRejectedValue(new Error("text fail"));
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
    });
    await expect(
      notifier.notify({ source: "s", title: "t", body: "b" }),
    ).rejects.toThrow(/text fail/u);
  });

  it("routes to the source's bound group when targetChatId is omitted", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_creator" });
    const sendText = vi.fn();
    const resolveDefaultChat = vi.fn().mockResolvedValue("oc_creator_group");
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
      resolveDefaultChat,
    });
    await notifier.notify({ source: "autobitable", title: "t", body: "b" });
    expect(resolveDefaultChat).toHaveBeenCalledWith("autobitable");
    expect(sendCard).toHaveBeenCalledWith(expect.any(String), "oc_creator_group");
  });

  it("explicit targetChatId wins over the source's bound group", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_explicit" });
    const sendText = vi.fn();
    const resolveDefaultChat = vi.fn().mockResolvedValue("oc_creator_group");
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
      resolveDefaultChat,
    });
    await notifier.notify({ source: "autobitable", title: "t", body: "b", targetChatId: "oc_explicit" });
    expect(resolveDefaultChat).not.toHaveBeenCalled();
    expect(sendCard).toHaveBeenCalledWith(expect.any(String), "oc_explicit");
  });

  it("falls back to Console group (undefined to sender) when source has no bound group", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_console" });
    const sendText = vi.fn();
    const resolveDefaultChat = vi.fn().mockResolvedValue(null); // e.g. child session / unregistered
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
      resolveDefaultChat,
    });
    await notifier.notify({ source: "child_autobitable_b5ae8a", title: "t", body: "b" });
    expect(sendCard).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it("resolveDefaultChat throwing never breaks the notify (falls back to Console)", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_console" });
    const sendText = vi.fn();
    const resolveDefaultChat = vi.fn().mockRejectedValue(new Error("db down"));
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
      resolveDefaultChat,
    });
    const res = await notifier.notify({ source: "autobitable", title: "t", body: "b" });
    expect(res.messageId).toBe("om_console");
    expect(sendCard).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});

describe("classifyNotifyError", () => {
  it("maps timeout messages to network_timeout", () => {
    expect(classifyNotifyError(new Error("lark-cli im timed out after 30000ms"))).toBe("network_timeout");
    expect(classifyNotifyError(new Error("ETIMEDOUT"))).toBe("network_timeout");
  });
  it("maps Feishu auth codes to lark_auth_failed", () => {
    expect(classifyNotifyError(new Error("lark-cli notify error [99991663]: token expired"))).toBe("lark_auth_failed");
  });
  it("maps card rejection to lark_card_rejected", () => {
    expect(classifyNotifyError(new Error("lark-cli notify error [231003]: invalid card content"))).toBe("lark_card_rejected");
  });
  it("falls back to lark_other for generic lark-cli errors", () => {
    expect(classifyNotifyError(new Error("lark-cli notify error [99999]: chaos"))).toBe("lark_other");
  });
  it("falls back to unknown for unrecognized errors", () => {
    expect(classifyNotifyError(new Error("something else entirely"))).toBe("unknown");
  });
});

describe("createConsoleNotifier — events sink (B1)", () => {
  const mkLogger = () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child() { return this; },
  });

  it("emits a single 'notified' event per notify call with structural flags only (no raw body/title)", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_e1" });
    const events: NotifyEvent[] = [];
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
      onEvent: (e) => events.push(e),
    });
    await notifier.notify({
      source: "scheduler",
      title: "巡检完成",
      body: "12 个任务，11 成功，1 重试中",
      level: "warn",
      metadata: { run_id: "r-1", ok: 11 },
      targetChatId: "oc_abc",
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("notified");
    expect(ev.source).toBe("scheduler");
    expect(ev.level).toBe("warn");
    expect(ev.chat_id).toBe("oc_abc");
    expect(ev.title_len).toBe("巡检完成".length);
    expect(ev.body_len).toBe("12 个任务，11 成功，1 重试中".length);
    expect(ev.has_metadata).toBe(true);
    expect(ev.metadata_keys).toBe(2);
    expect(ev.outcome).toBe("sent");
    expect(ev.message_id).toBe("om_e1");
    // CRITICAL: no raw business text in events. Grep the event object for the body string.
    expect(JSON.stringify(ev)).not.toContain("12 个任务");
    expect(JSON.stringify(ev)).not.toContain("巡检完成");
    expect(JSON.stringify(ev)).not.toContain("run_id");
  });

  it("emits outcome=degraded with code when card fails and text succeeds", async () => {
    const sendCard = vi.fn().mockRejectedValue(new Error("lark-cli notify error [231003]: invalid card"));
    const sendText = vi.fn().mockResolvedValue({ messageId: "om_text" });
    const events: NotifyEvent[] = [];
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
      onEvent: (e) => events.push(e),
    });
    const result = await notifier.notify({ source: "s", title: "t", body: "b" });
    expect(result.degraded).toBe(true);
    expect(result.code).toBe("lark_card_rejected");
    const ev = events[0]!;
    expect(ev.outcome).toBe("degraded");
    expect(ev.code).toBe("lark_card_rejected");
    expect(ev.message_id).toBe("om_text");
  });

  it("emits outcome=failed when both card and text fail", async () => {
    const sendCard = vi.fn().mockRejectedValue(new Error("lark-cli card fail"));
    const sendText = vi.fn().mockRejectedValue(new Error("lark-cli text timed out"));
    const events: NotifyEvent[] = [];
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
      onEvent: (e) => events.push(e),
    });
    await expect(notifier.notify({ source: "s", title: "t", body: "b" })).rejects.toThrow();
    const ev = events[0]!;
    expect(ev.outcome).toBe("failed");
    expect(ev.code).toBe("network_timeout");
    expect(ev.message_id).toBeNull();
  });

  it("a thrown onEvent sink does not break a real notify", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_safe" });
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
      onEvent: () => { throw new Error("disk full"); },
    });
    const result = await notifier.notify({ source: "s", title: "t", body: "b" });
    expect(result.messageId).toBe("om_safe");
  });
});

describe("createConsoleNotifier — dedup (A3)", () => {
  const mkLogger = () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child() { return this; },
  });

  it("second identical notify within window returns prior messageId without re-sending", async () => {
    const sendCard = vi.fn().mockResolvedValue({ messageId: "om_first" });
    const sendText = vi.fn();
    const events: NotifyEvent[] = [];
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText },
      clock: fixedClock,
      logger: mkLogger(),
      onEvent: (e) => events.push(e),
      dedupWindowMs: 60_000,
    });
    const a = await notifier.notify({ source: "s", title: "t", body: "b" });
    const b = await notifier.notify({ source: "s", title: "t", body: "b" });
    expect(a.messageId).toBe("om_first");
    expect(b.messageId).toBe("om_first");
    expect(b.deduped).toBe(true);
    expect(sendCard).toHaveBeenCalledOnce(); // not called again on dedup
    expect(events.map((e) => e.outcome)).toEqual(["sent", "deduped"]);
  });

  it("different body produces a different dedup key and re-sends", async () => {
    const sendCard = vi.fn()
      .mockResolvedValueOnce({ messageId: "om_a" })
      .mockResolvedValueOnce({ messageId: "om_b" });
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
    });
    const a = await notifier.notify({ source: "s", title: "t", body: "body-1" });
    const b = await notifier.notify({ source: "s", title: "t", body: "body-2" });
    expect(a.messageId).toBe("om_a");
    expect(b.messageId).toBe("om_b");
    expect(b.deduped).toBeUndefined();
    expect(sendCard).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe different notify actions with the same source, title, and body", async () => {
    const sendCard = vi.fn()
      .mockResolvedValueOnce({ messageId: "om_confirm" })
      .mockResolvedValueOnce({ messageId: "om_skip" });
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
    });
    await notifier.notify({
      source: "gongying",
      title: "补货确认",
      body: "请确认本批次。",
      actions: {
        card_type: "gongying_replenish_confirm",
        options: [{ label: "确认补货", value: "confirm" }, { label: "跳过", value: "skip" }],
        context: { batch_id: "B123" },
      },
    });
    const result = await notifier.notify({
      source: "gongying",
      title: "补货确认",
      body: "请确认本批次。",
      actions: {
        card_type: "gongying_replenish_confirm",
        options: [{ label: "确认补货", value: "confirm" }, { label: "暂不补货", value: "skip" }],
        context: { batch_id: "B124" },
      },
    });
    expect(result.messageId).toBe("om_skip");
    expect(result.deduped).toBeUndefined();
    expect(sendCard).toHaveBeenCalledTimes(2);
  });

  it("dedup can be disabled with dedupWindowMs=0", async () => {
    const sendCard = vi.fn()
      .mockResolvedValueOnce({ messageId: "om_a" })
      .mockResolvedValueOnce({ messageId: "om_b" });
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
      dedupWindowMs: 0,
    });
    await notifier.notify({ source: "s", title: "t", body: "b" });
    await notifier.notify({ source: "s", title: "t", body: "b" });
    expect(sendCard).toHaveBeenCalledTimes(2);
  });
});

describe("createConsoleNotifier — rate limit (A3)", () => {
  const mkLogger = () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child() { return this; },
  });

  it("blocks the Nth+1 notify from the same source within 60s with a rate_limited error", async () => {
    let i = 0;
    const sendCard = vi.fn().mockImplementation(async () => ({ messageId: `om_${++i}` }));
    const events: NotifyEvent[] = [];
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
      onEvent: (e) => events.push(e),
      rateLimitPerMinute: 3,
      // Disable dedup so each call counts toward the limit.
      dedupWindowMs: 0,
    });
    await notifier.notify({ source: "s", title: "t", body: "b1" });
    await notifier.notify({ source: "s", title: "t", body: "b2" });
    await notifier.notify({ source: "s", title: "t", body: "b3" });
    await expect(
      notifier.notify({ source: "s", title: "t", body: "b4" }),
    ).rejects.toThrow(/rate limit:.*'s'.*3\/min/);
    expect(sendCard).toHaveBeenCalledTimes(3);
    const rateLimited = events.find((e) => e.outcome === "rate_limited");
    expect(rateLimited?.code).toBe("rate_limited");
  });

  it("limit is per-source — a different source has its own bucket", async () => {
    let i = 0;
    const sendCard = vi.fn().mockImplementation(async () => ({ messageId: `om_${++i}` }));
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
      rateLimitPerMinute: 1,
      dedupWindowMs: 0,
    });
    await notifier.notify({ source: "a", title: "t", body: "x" });
    await notifier.notify({ source: "b", title: "t", body: "x" });
    expect(sendCard).toHaveBeenCalledTimes(2);
  });

  it("rate limit can be disabled with rateLimitPerMinute=0", async () => {
    let i = 0;
    const sendCard = vi.fn().mockImplementation(async () => ({ messageId: `om_${++i}` }));
    const notifier = createConsoleNotifier({
      sender: { sendCard, sendText: vi.fn() },
      clock: fixedClock,
      logger: mkLogger(),
      rateLimitPerMinute: 0,
      dedupWindowMs: 0,
    });
    for (let n = 0; n < 200; n++) {
      await notifier.notify({ source: "s", title: "t", body: `b${n}` });
    }
    expect(sendCard).toHaveBeenCalledTimes(200);
  });
});
