import { describe, expect, it, vi } from "vitest";
import { resolveNotifyDryRun, withNotifyDryRun } from "../../src/app/notifyDryRun.ts";
import type { NotifySender } from "../../src/app/consoleNotifier.ts";
import type { Logger } from "../../src/ports/Logger.ts";

function fakeLogger(): Logger & { warns: Array<{ msg: string; fields?: unknown }> } {
  const warns: Array<{ msg: string; fields?: unknown }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => { warns.push({ msg, fields }); },
    error: () => {},
    child: () => logger,
  };
  return Object.assign(logger, { warns });
}

function liveSender(): NotifySender & { cards: string[]; texts: string[] } {
  const cards: string[] = [];
  const texts: string[] = [];
  return {
    cards,
    texts,
    sendCard: async (content) => { cards.push(content); return { messageId: "om_real" }; },
    sendText: async (text) => { texts.push(text); return { messageId: "om_real" }; },
  };
}

describe("resolveNotifyDryRun", () => {
  it("is live when neither VITEST nor SM_NOTIFY_DRY_RUN is set (production default)", () => {
    expect(resolveNotifyDryRun({})).toEqual({ dryRun: false });
  });

  it("dry-runs under vitest so a test process can never put a card on the wire", () => {
    expect(resolveNotifyDryRun({ VITEST: "true" })).toEqual({ dryRun: true, reason: "VITEST" });
  });

  it("cannot be forced live from inside a test process", () => {
    // The hard part of the guard: SM_NOTIFY_DRY_RUN=0 must NOT re-arm sending
    // while VITEST is set, or a fixture could opt itself back into real sends.
    expect(resolveNotifyDryRun({ VITEST: "true", SM_NOTIFY_DRY_RUN: "0" }))
      .toEqual({ dryRun: true, reason: "VITEST" });
  });

  it("dry-runs when a dev instance opts in via SM_NOTIFY_DRY_RUN=1", () => {
    expect(resolveNotifyDryRun({ SM_NOTIFY_DRY_RUN: "1" }))
      .toEqual({ dryRun: true, reason: "SM_NOTIFY_DRY_RUN=1" });
  });

  it("stays live for any other SM_NOTIFY_DRY_RUN value (only '1' arms the flag)", () => {
    expect(resolveNotifyDryRun({ SM_NOTIFY_DRY_RUN: "0" })).toEqual({ dryRun: false });
    expect(resolveNotifyDryRun({ SM_NOTIFY_DRY_RUN: "" })).toEqual({ dryRun: false });
    expect(resolveNotifyDryRun({ SM_NOTIFY_DRY_RUN: "true" })).toEqual({ dryRun: false });
  });
});

describe("withNotifyDryRun", () => {
  it("returns the live sender untouched when not dry-running", async () => {
    const sender = liveSender();
    const wrapped = withNotifyDryRun(sender, { dryRun: false }, fakeLogger());

    expect(wrapped).toBe(sender);
    await wrapped.sendCard("{}");
    expect(sender.cards).toEqual(["{}"]);
  });

  it("swallows the send and returns a marked synthetic id when dry-running", async () => {
    const sender = liveSender();
    const logger = fakeLogger();
    const wrapped = withNotifyDryRun(sender, { dryRun: true, reason: "VITEST" }, logger);

    const card = await wrapped.sendCard("{\"schema\":\"2.0\"}", "oc_real_group");
    const text = await wrapped.sendText("hello", "oc_real_group");

    expect(sender.cards).toEqual([]);
    expect(sender.texts).toEqual([]);
    // Synthetic ids are prefixed so nobody mistakes a dry-run result for a
    // delivered message, and are unique so dedup/event logs stay meaningful.
    expect(card.messageId).toBe("om_dryrun_1");
    expect(text.messageId).toBe("om_dryrun_2");
    expect(logger.warns[0]?.msg).toContain("DRY-RUN");
    expect(logger.warns[0]?.fields).toMatchObject({ reason: "VITEST", chatId: "oc_real_group" });
  });

  it("keeps notify succeeding so callers exercise their real success path", async () => {
    const wrapped = withNotifyDryRun(liveSender(), { dryRun: true, reason: "SM_NOTIFY_DRY_RUN=1" }, fakeLogger());
    await expect(wrapped.sendCard("{}")).resolves.toMatchObject({ messageId: expect.any(String) });
  });

  it("reports the console-group fallback target when the caller omits a chat id", async () => {
    const logger = fakeLogger();
    const wrapped = withNotifyDryRun(liveSender(), { dryRun: true, reason: "VITEST" }, logger, "oc_console");

    await wrapped.sendCard("{}");
    expect(logger.warns[0]?.fields).toMatchObject({ chatId: "oc_console" });
  });
});

describe("notify dry-run guard under the real process env", () => {
  it("is armed for this very test run", () => {
    // Regression anchor for the root cause: any test in this repo that reaches
    // the bootstrap notify sender must be dry-run by construction.
    expect(resolveNotifyDryRun(process.env)).toEqual({ dryRun: true, reason: "VITEST" });
  });

  it("does not shell out to lark-cli from a test process", async () => {
    const send = vi.fn();
    const wrapped = withNotifyDryRun(
      { sendCard: async () => { send(); return { messageId: "om_real" }; },
        sendText: async () => { send(); return { messageId: "om_real" }; } },
      resolveNotifyDryRun(process.env),
      fakeLogger(),
    );

    await wrapped.sendCard("{}");
    await wrapped.sendText("x");
    expect(send).not.toHaveBeenCalled();
  });
});
