// tests/adapters/card-ask/askViaBroker.test.ts

import { describe, expect, test, vi } from "vitest";
import { askViaBroker } from "../../../src/adapters/card-ask/askViaBroker.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseReq = {
  brokerUrl: "http://127.0.0.1:8787",
  chatId: "oc_test",
  question: "选哪个方案？",
  options: [
    { label: "方案A", value: "q0_opt_0", description: "方案A" },
    { label: "方案B", value: "q0_opt_1", description: "方案B" },
  ],
};

describe("askViaBroker", () => {
  test("posts question/options/chat_id to {brokerUrl}/ask", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "answered", value: "q0_opt_1", label: "方案B" }),
    );
    await askViaBroker(baseReq, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8787/ask");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      question: "选哪个方案？",
      options: baseReq.options,
      chat_id: "oc_test",
    });
  });

  test("maps answered status to the selected value and label", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "answered", value: "q0_opt_0", label: "方案A" }),
    );
    const result = await askViaBroker(baseReq, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ status: "answered", value: "q0_opt_0", label: "方案A" });
  });

  test("maps escaped status with reason", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "escaped", reason: "timeout", value: "__none_fits__" }),
    );
    const result = await askViaBroker(baseReq, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ status: "escaped", reason: "timeout" });
  });

  test("throws on non-200 responses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "boom" }));
    await expect(
      askViaBroker(baseReq, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("HTTP 500");
  });

  test("throws on an unexpected 200 body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { wat: true }));
    await expect(
      askViaBroker(baseReq, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("unexpected response");
  });

  test("includes context when provided", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "escaped", reason: "user_clicked" }),
    );
    await askViaBroker({ ...baseReq, context: "背景材料" }, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(init.body as string).context).toBe("背景材料");
  });
});
