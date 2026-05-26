import { describe, it, expect, vi } from "vitest";
import {
  buildCardContent,
  buildPlainText,
  createConsoleNotifier,
} from "../../src/app/consoleNotifier.ts";
import type { Clock } from "../../src/ports/Clock.ts";
import { asTimestamp } from "../../src/domain/ids.ts";

const FIXED_MS = 1713600000000; // 2024-04-20 08:00:00 UTC → 16:00:00 Asia/Shanghai
const fixedClock: Clock = { now: () => asTimestamp(FIXED_MS) };

describe("buildCardContent", () => {
  it("uses blue template for info (default level)", () => {
    const card = JSON.parse(buildCardContent(
      { source: "watchdog", title: "t", body: "b" },
      FIXED_MS,
    ));
    expect(card.header.template).toBe("blue");
    expect(card.header.title.content).toBe("t");
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

  it("renders body as lark_md div", () => {
    const card = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "**hello**" },
      FIXED_MS,
    ));
    expect(card.elements[0]).toEqual({
      tag: "div",
      text: { tag: "lark_md", content: "**hello**" },
    });
  });

  it("renders metadata as hr + div with bold keys", () => {
    const card = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", metadata: { run_id: "abc", n: 42 } },
      FIXED_MS,
    ));
    expect(card.elements[1]).toEqual({ tag: "hr" });
    expect(card.elements[2].tag).toBe("div");
    const md = card.elements[2].text.content as string;
    expect(md).toContain("**run_id**: abc");
    expect(md).toContain("**n**: 42");
  });

  it("omits metadata section when absent or empty", () => {
    const absent = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b" },
      FIXED_MS,
    )) as { elements: Array<{ tag: string }> };
    expect(absent.elements.some((e) => e.tag === "hr")).toBe(false);

    const empty = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", metadata: {} },
      FIXED_MS,
    )) as { elements: Array<{ tag: string }> };
    expect(empty.elements.some((e) => e.tag === "hr")).toBe(false);
  });

  it("footer note shows source · Asia/Shanghai timestamp", () => {
    const card = JSON.parse(buildCardContent(
      { source: "watchdog", title: "t", body: "b" },
      FIXED_MS,
    ));
    const note = card.elements[card.elements.length - 1];
    expect(note.tag).toBe("note");
    const text = note.elements[0].content as string;
    expect(text).toMatch(/^watchdog · /u);
    expect(text).toContain("2024-04-20 16:00:00");
  });

  it("serializes non-primitive metadata as JSON", () => {
    const card = JSON.parse(buildCardContent(
      { source: "s", title: "t", body: "b", metadata: { nested: { k: 1 } } },
      FIXED_MS,
    ));
    expect(card.elements[2].text.content).toContain('**nested**: {"k":1}');
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
  it("starts with [level] source: title", () => {
    const text = buildPlainText(
      { source: "watchdog", title: "done", body: "ok", level: "warn" },
      FIXED_MS,
    );
    expect(text.split("\n")[0]).toBe("[warn] watchdog: done");
  });

  it("defaults level to info", () => {
    const text = buildPlainText(
      { source: "s", title: "t", body: "b" },
      FIXED_MS,
    );
    expect(text).toContain("[info]");
  });

  it("expands metadata to key: value per line", () => {
    const text = buildPlainText(
      { source: "s", title: "t", body: "b", metadata: { run_id: "abc", n: 42 } },
      FIXED_MS,
    );
    expect(text).toContain("run_id: abc");
    expect(text).toContain("n: 42");
  });

  it("includes CST-formatted timestamp footer", () => {
    const text = buildPlainText(
      { source: "s", title: "t", body: "b" },
      FIXED_MS,
    );
    expect(text).toContain("2024-04-20 16:00:00");
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
    expect(parsed.header.template).toBe("blue");
    expect(parsed.header.title.content).toBe("hi");
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
    expect(textArg).toContain("[error] watchdog: hi");
    expect(textArg).toContain("trace: abc");
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
});
