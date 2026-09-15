import { afterEach, describe, expect, test, vi } from "vitest";
import {
  extractNotifyActionClick,
  postNotifyActionClick,
  resolveNotifyActionForwardUrl,
} from "../../../src/adapters/notify-action/click.ts";

describe("notify action click forwarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("extracts only the frozen marker shape and preserves callback metadata", () => {
    expect(extractNotifyActionClick({
      header: { create_time: "1700000000000" },
      event: {
        context: { open_message_id: "om_1", open_chat_id: "oc_1" },
        operator: { open_id: "ou_1" },
        action: {
          value: {
            __notify_action: true,
            card_type: "gongying_replenish_confirm",
            value: "confirm",
            token: "na_9f2c1d8e",
            context: { batch_id: "B123" },
          },
        },
      },
    })).toEqual({
      cardType: "gongying_replenish_confirm",
      value: "confirm",
      token: "na_9f2c1d8e",
      context: { batch_id: "B123" },
      operatorOpenId: "ou_1",
      chatId: "oc_1",
      openMessageId: "om_1",
      eventTime: "1700000000000",
    });
  });

  test("does not intercept a generic card action with card_type and token but no marker", () => {
    expect(extractNotifyActionClick({
      event: {
        action: {
          value: {
            card_type: "gongying_replenish_confirm",
            token: "na_9f2c1d8e",
            value: "confirm",
          },
        },
      },
    })).toBeNull();
  });

  test("posts the exact forward payload to the default loopback endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postNotifyActionClick({
      cardType: "gongying_replenish_confirm",
      value: "confirm",
      token: "na_9f2c1d8e",
      context: { batch_id: "B123" },
      operatorOpenId: "ou_1",
      chatId: "oc_1",
      openMessageId: "om_1",
      eventTime: "1700000000000",
    })).resolves.toBe(true);

    const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(String(calls[0]?.[0])).toBe("http://127.0.0.1:3510/webhooks/notify-card");
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        card_type: "gongying_replenish_confirm",
        value: "confirm",
        token: "na_9f2c1d8e",
        context: { batch_id: "B123" },
        operator_open_id: "ou_1",
        chat_id: "oc_1",
        open_message_id: "om_1",
        event_time: "1700000000000",
      }),
    });
  });

  test("uses NOTIFY_ACTION_FORWARD_URL when configured and returns false for non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(resolveNotifyActionForwardUrl({
      NOTIFY_ACTION_FORWARD_URL: "http://example.invalid:3511/notify-card",
    })).toBe("http://example.invalid:3511/notify-card");
    await expect(postNotifyActionClick(
      { cardType: "notify_schema_probe", value: "confirm", token: "na_9f2c1d8e" },
      { NOTIFY_ACTION_FORWARD_URL: "http://example.invalid:3511/notify-card" },
    )).resolves.toBe(false);
  });
});
