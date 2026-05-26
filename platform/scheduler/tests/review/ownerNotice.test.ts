import { describe, it, expect, vi } from "vitest";
import { createOwnerNoticeSender } from "../../src/review/ownerNotice.js";

describe("createOwnerNoticeSender", () => {
  const url = "http://localhost:3501/api/spawn";

  it("success path: returns {ok: true} on 2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const send = createOwnerNoticeSender({ spawnApiUrl: url, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await send("some-session", "hello");
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends correct body shape (target/from/prompt)", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (u: string, init: RequestInit) => {
      captured = { url: u, init };
      return new Response("ok", { status: 200 });
    });
    const send = createOwnerNoticeSender({ spawnApiUrl: url, fetchImpl: fetchImpl as unknown as typeof fetch });
    await send("owner-x", "the-prompt-text");
    expect(captured.url).toBe(url);
    expect(captured.init?.method).toBe("POST");
    const body = JSON.parse(captured.init!.body as string);
    expect(body.target).toBe("owner-x");
    expect(body.from).toBe("scheduler");
    expect(body.prompt).toBe("the-prompt-text");
    expect(body.verification_predicate).toEqual({
      type: "inbox-message",
      session_name: "owner-x",
      field: "final_message",
      contains_any: ["[scheduler"],
      expected_window_sec: 3600,
    });
  });

  it("HTTP error: returns {ok: false, error: 'HTTP ...'}", async () => {
    const fetchImpl = vi.fn(async () => new Response("server boom", { status: 500 }));
    const send = createOwnerNoticeSender({ spawnApiUrl: url, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await send("owner", "p");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 500");
    expect(result.error).toContain("server boom");
  });

  it("thrown fetch error: returns {ok: false, error: <message>}", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const send = createOwnerNoticeSender({ spawnApiUrl: url, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await send("owner", "p");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });
});
