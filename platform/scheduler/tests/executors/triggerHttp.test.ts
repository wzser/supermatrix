import { describe, it, expect } from "vitest";
import { triggerHttp } from "../../src/executors/trigger.js";

function fakeFetch(payload: { status?: number; json?: unknown; ok?: boolean }) {
  return async () =>
    ({
      ok: payload.ok ?? true,
      status: payload.status ?? 200,
      json: async () => payload.json ?? {},
      text: async () => JSON.stringify(payload.json ?? {}),
    }) as Response;
}

const base = {
  url: "http://localhost:3501/api/spawn2.0",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { target: "ads-master", prompt: "hi" },
  timeout: 5000,
  schedulerContext: { taskId: "t1", runId: "r1", triggeredAt: Date.now(), owner: "ads-master" },
};

describe("triggerHttp (session success = real child_session_id)", () => {
  it("success on a real childSessionId", async () => {
    const res = await triggerHttp(base, {
      fetchImpl: fakeFetch({ json: { ok: true, childSessionId: "sess-123" } }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.childSessionId).toBe("sess-123");
  });

  it("SUCCESS on switched_async (ref is the accepted child reference)", async () => {
    // The framework took the spawn and routed the child to the async watcher,
    // returning a ref instead of a sync childSessionId. The child did start →
    // fire-and-forget trigger success; whether the work lands is the owner's job.
    const res = await triggerHttp(base, {
      fetchImpl: fakeFetch({ json: { ok: false, status: "switched_async", ref: "async_9" } }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.childSessionId).toBe("async_9");
  });

  it("FAILED on async_ prefixed childSessionId", async () => {
    const res = await triggerHttp(base, {
      fetchImpl: fakeFetch({ json: { ok: true, childSessionId: "async_42" } }),
    });
    expect(res.ok).toBe(false);
  });

  it("FAILED on non-2xx", async () => {
    const res = await triggerHttp(base, {
      fetchImpl: fakeFetch({ ok: false, status: 500, json: {} }),
    });
    expect(res.ok).toBe(false);
  });

  it("FAILED on ok:false rejection", async () => {
    const res = await triggerHttp(base, {
      fetchImpl: fakeFetch({ json: { ok: false, error: "bad" } }),
    });
    expect(res.ok).toBe(false);
  });

  it("FAILED when childSessionId is absent", async () => {
    const res = await triggerHttp(base, { fetchImpl: fakeFetch({ json: { ok: true } }) });
    expect(res.ok).toBe(false);
  });
});
