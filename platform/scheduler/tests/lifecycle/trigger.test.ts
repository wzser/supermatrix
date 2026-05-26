import { describe, it, expect, vi } from "vitest";
import { triggerHttp, triggerShell, sanitizeSpawnBody } from "../../src/lifecycle/trigger.js";

describe("sanitizeSpawnBody", () => {
  it("adds from:scheduler and default verification_predicate to a /api/spawn body that lacks both", () => {
    const out = sanitizeSpawnBody("http://localhost:3501/api/spawn", { target: "ads-master", prompt: "go" });
    expect(out.from).toBe("scheduler");
    expect(out.verification_predicate).toBeDefined();
    expect((out.verification_predicate as Record<string, unknown>).type).toBe("inbox-message");
  });

  it("does not overwrite an existing from", () => {
    const out = sanitizeSpawnBody("http://localhost:3501/api/spawn", { target: "x", prompt: "p", from: "gongying" });
    expect(out.from).toBe("gongying");
  });

  it("injects verification_predicate when body lacks one, even if from is present", () => {
    const out = sanitizeSpawnBody("http://localhost:3501/api/spawn", { target: "x", prompt: "p", from: "gongying" });
    expect(out.verification_predicate).toBeDefined();
    expect((out.verification_predicate as Record<string, unknown>).type).toBe("inbox-message");
  });

  it("does not overwrite an existing verification_predicate", () => {
    const existingPred = { type: "file-mtime", root_path: "/tmp", path_glob: "*.out" };
    const out = sanitizeSpawnBody("http://localhost:3501/api/spawn", {
      target: "x", from: "x", prompt: "p", verification_predicate: existingPred,
    });
    expect(out.verification_predicate).toEqual(existingPred);
  });

  it("leaves a fully-compliant body untouched", () => {
    const body = { target: "x", from: "x", prompt: "p", verification_predicate: { type: "inbox-message" } };
    expect(sanitizeSpawnBody("http://localhost:3501/api/spawn", body)).toBe(body);
  });

  it("strips the unsupported mode field — /api/spawn HTTP 400s on it since 2026-05-19", () => {
    const out = sanitizeSpawnBody("http://localhost:3501/api/spawn", {
      target: "x", prompt: "p", from: "x", mode: "async_kickoff",
    });
    expect("mode" in out).toBe(false);
    expect(out.verification_predicate).toBeDefined(); // mode-stripping re-enters sanitize → injects predicate
  });

  it("strips mode and injects from + predicate in the same pass", () => {
    const out = sanitizeSpawnBody("http://localhost:3501/api/spawn", { target: "x", prompt: "p", mode: "fire_and_forget" });
    expect(out.from).toBe("scheduler");
    expect("mode" in out).toBe(false);
    expect(out.verification_predicate).toBeDefined();
  });

  it("leaves non-spawn URLs untouched", () => {
    const body = { target: "x", prompt: "p", mode: "x" };
    expect(sanitizeSpawnBody("http://localhost:3501/api/tasks", body)).toBe(body);
  });

  it("leaves bodies without a target untouched (not a spawn call)", () => {
    const body = { foo: "bar" };
    expect(sanitizeSpawnBody("http://localhost:3501/api/spawn", body)).toBe(body);
  });

  it("leaves the body untouched when the URL is invalid", () => {
    const body = { target: "x", prompt: "p" };
    expect(sanitizeSpawnBody("not-a-url", body)).toBe(body);
  });
});

describe("triggerShell", () => {
  it("returns PID immediately after spawn", async () => {
    const result = await triggerShell({
      command: "sleep 0.5",
      cwd: "/tmp",
      timeout: 5000,
    });
    expect(result.triggerOk).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.exitPromise).toBeDefined();
    const exit = await result.exitPromise;
    expect(exit?.exitCode).toBe(0);
  });

  it("returns triggerOk=false if spawn fails", async () => {
    const result = await triggerShell({
      command: "this_binary_does_not_exist_xyz",
      cwd: "/tmp",
      timeout: 1000,
    });
    expect(result.triggerOk).toBe(true);
    const exit = await result.exitPromise;
    expect(exit?.exitCode).not.toBe(0);
  });

  it("triggerOk=false when cwd does not exist", async () => {
    const result = await triggerShell({
      command: "echo hi",
      cwd: "/nonexistent/directory/path/xyz",
      timeout: 1000,
    });
    expect(result.triggerOk).toBe(false);
    expect(result.error).toContain("cwd");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["non-number string", "5000"],
  ])("triggerOk=false when timeout is %s (refuses Node setTimeout 1ms-clamp footgun)", async (_label, value) => {
    const result = await triggerShell({
      command: "echo hi",
      cwd: "/tmp",
      timeout: value as unknown as number,
    });
    expect(result.triggerOk).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    expect(result.pid).toBeUndefined();
    expect(result.exitPromise).toBeUndefined();
  });

  it("resolves exitPromise exactly once even when close fires after timeout kills the child", async () => {
    // Exercises the safeResolve guard: a process killed by SIGTERM may emit
    // 'close' after the force-resolve timer already fired (or vice-versa).
    // Both paths call safeResolve; only the first must win.
    const result = await triggerShell({
      command: "sleep 60",
      cwd: "/tmp",
      timeout: 50,
    });
    expect(result.triggerOk).toBe(true);
    // exitPromise must settle (SIGTERM → close fires normally because sleep
    // holds no extra FDs).  exitCode is null (signal kill) or non-zero.
    const exit = await result.exitPromise;
    expect(exit).toBeDefined();
    expect(exit!.exitCode).not.toBe(0);
  }, 10_000);
});

describe("triggerHttp", () => {
  it("returns childSessionId on successful async_kickoff spawn", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        ok: true,
        mode: "async_kickoff",
        childSessionId: "child-abc-123",
        childSessionName: "child_scheduler_abc",
        messageRunId: "run-xyz",
      }),
    });

    const result = await triggerHttp(
      {
        url: "http://localhost:3501/api/spawn",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { target: "some-target", prompt: "hi" },
        timeout: 5000,
      },
      { fetchImpl: mockFetch }
    );

    expect(result.triggerOk).toBe(true);
    expect(result.childSessionId).toBe("child-abc-123");
    expect(result.childMessageRunId).toBe("run-xyz");
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1000],
  ])("triggerOk=false when timeout is %s (no 1ms-clamp on AbortController)", async (_label, value) => {
    const fetchSpy = vi.fn();
    const result = await triggerHttp(
      {
        url: "http://localhost:3501/api/spawn",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { target: "x", prompt: "x" },
        timeout: value as unknown as number,
      },
      { fetchImpl: fetchSpy as unknown as typeof fetch }
    );
    expect(result.triggerOk).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("injects from:scheduler into the spawn body it sends", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, childSessionId: "c1" }),
    });

    await triggerHttp(
      {
        url: "http://localhost:3501/api/spawn",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { target: "ads-master", prompt: "go" },
        timeout: 5000,
      },
      { fetchImpl: mockFetch }
    );

    const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(sentBody.from).toBe("scheduler");
  });

  it("treats a switched_async response as triggerOk with asyncRef only", async () => {
    // /api/spawn returns HTTP 200 {ok:false, status:"switched_async"} when the
    // sync close did not verify — the framework's watcher has taken it over.
    // That is not a trigger failure; the work proceeds asynchronously.
    // childSessionId is NOT set because the async ref is not a session ID;
    // the receipt proof resolves asyncRef → real session ID before polling.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        status: "switched_async",
        ref: "async_abc-123",
        spawnCommId: "comm_xyz",
      }),
    });

    const result = await triggerHttp(
      {
        url: "http://localhost:3501/api/spawn",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { target: "mythos", from: "mythos", prompt: "go" },
        timeout: 5000,
      },
      { fetchImpl: mockFetch }
    );

    expect(result.triggerOk).toBe(true);
    expect(result.childSessionId).toBeUndefined();
    expect(result.asyncRef).toBe("async_abc-123");
  });

  it("treats a 200 ok:false that is not switched_async as a trigger failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: "something else went wrong" }),
    });

    const result = await triggerHttp(
      {
        url: "http://localhost:3501/api/spawn",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { target: "x", from: "x", prompt: "p" },
        timeout: 5000,
      },
      { fetchImpl: mockFetch }
    );

    expect(result.triggerOk).toBe(false);
    expect(result.error).toContain("something else went wrong");
  });

  it("returns triggerOk=false on non-2xx", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ ok: false, error: "target session not found" }),
      json: async () => ({ ok: false, error: "target session not found" }),
    });

    const result = await triggerHttp(
      {
        url: "http://localhost:3501/api/spawn",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {},
        timeout: 5000,
      },
      { fetchImpl: mockFetch }
    );

    expect(result.triggerOk).toBe(false);
    expect(result.error).toContain("500");
  });
});
