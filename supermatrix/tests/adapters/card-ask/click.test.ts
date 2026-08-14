import { afterEach, describe, expect, test, vi } from "vitest";
import {
  extractCardAskClick,
  postCardAskClick,
  resolveCardAskClickBrokerUrl,
} from "../../../src/adapters/card-ask/click.ts";

describe("card ask click forwarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("extracts the canonical larkc ask_user click shape", () => {
    expect(extractCardAskClick({
      action: {
        value: {
          __ask_user: true,
          token: "top-level-token",
          value: "prod",
        },
      },
    })).toEqual({ token: "top-level-token", value: "prod" });

    expect(extractCardAskClick({
      event: {
        action: {
          value: {
            __ask_user: true,
            token: "abc123",
            value: "方案 A",
          },
        },
      },
    })).toEqual({ token: "abc123", value: "方案 A" });

    expect(extractCardAskClick({
      event: {
        action: {
          value: {
            target_session: "carddemo",
            action: "approve",
          },
        },
      },
    })).toBeNull();
  });

  test("does not intercept a generic CARD_ACTION value that happens to include token", () => {
    expect(extractCardAskClick({
      event: {
        action: {
          value: {
            token: "ordinary-card-token",
            value: "not-ask-user",
          },
        },
      },
    })).toBeNull();
  });

  test("posts clicks to broker /click using BROKER_PORT by default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postCardAskClick(
      { token: "abc123", value: "方案 A" },
      { BROKER_PORT: "8788" },
    )).resolves.toBe(true);

    const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0]?.[0])).toBe("http://127.0.0.1:8788/click");
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "abc123", value: "方案 A" }),
    });
  });

  test("click forwarding uses BROKER_URL before BROKER_PORT", () => {
    expect(resolveCardAskClickBrokerUrl({
      BROKER_URL: "http://example.invalid:9999",
      BROKER_PORT: "8790",
    })).toBe("http://example.invalid:9999");
  });

  test("fails closed when broker /click is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(postCardAskClick(
      { token: "abc123", value: "方案 A" },
      {},
    )).resolves.toBe(false);
  });
});
