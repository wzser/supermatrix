import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import {
  createCodexModelAvailabilityProbe,
  createProbeProcessRunner,
} from "../../../src/adapters/backend-codex/modelAvailabilityProbe.ts";

type RunCall = { command: string; args: string[]; cwd: string; timeoutMs: number };

const completed = (text = "MODEL_AVAILABILITY_OK") => JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text },
});

function harness(outcomes: Array<{ exitCode: number; stdout?: string; stderr?: string }>) {
  let now = 1_000;
  let cliVersion = "codex-cli 1";
  let catalogFingerprint = "catalog-1";
  let authStat = { path: "/home/test/.codex/auth.json", size: 10, mtimeMs: 100, mode: 0o600 };
  const calls: RunCall[] = [];
  const removed: string[] = [];
  let tempCounter = 0;
  const probe = createCodexModelAvailabilityProbe({
    runProcess: async (input) => {
      calls.push(input);
      return outcomes.shift() ?? { exitCode: 0, stdout: completed() };
    },
    now: () => now,
    getCliVersion: async () => cliVersion,
    getCatalogFingerprint: () => catalogFingerprint,
    getAuthStat: async () => authStat,
    fs: {
      makeTempDir: async () => `/tmp/model-probe-${++tempCounter}`,
      readDir: async () => [],
      removeDir: async (path) => { removed.push(path); },
    },
  });
  return {
    probe, calls, removed,
    advance: (ms: number) => { now += ms; },
    setCliVersion: (value: string) => { cliVersion = value; },
    setCatalogFingerprint: (value: string) => { catalogFingerprint = value; },
    setAuthMtime: (value: number) => { authStat = { ...authStat, mtimeMs: value }; },
  };
}

describe("Codex model availability probe", () => {
  test("uses the verified ephemeral read-only command in an empty temporary cwd", async () => {
    const h = harness([{ exitCode: 0, stdout: completed() }]);
    await h.probe.probe("gpt-5.5");
    expect(h.calls[0]).toEqual({
      command: "codex",
      args: [
        "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-rules",
        "--sandbox", "read-only", "--model", "gpt-5.5", "--cd", "/tmp/model-probe-1",
        "Reply with exactly MODEL_AVAILABILITY_OK.",
      ],
      cwd: "/tmp/model-probe-1",
      timeoutMs: 45_000,
    });
    expect(h.removed).toEqual(["/tmp/model-probe-1"]);
  });

  test("caches available and confirmed unavailable results for fifteen minutes", async () => {
    const available = harness([{ exitCode: 0, stdout: completed() }]);
    expect((await available.probe.probe("gpt-5.5")).kind).toBe("available");
    available.advance(899_999);
    expect((await available.probe.probe("gpt-5.5")).kind).toBe("available");
    expect(available.calls).toHaveLength(1);

    const unavailable = harness([{ exitCode: 1, stdout: JSON.stringify({
      type: "error", error: { code: "model_not_found", status: 404 },
    }) }]);
    expect((await unavailable.probe.probe("gpt-5.2")).kind).toBe("unavailable");
    expect((await unavailable.probe.probe("gpt-5.2")).kind).toBe("unavailable");
    expect(unavailable.calls).toHaveLength(1);
  });

  test("expires cached results at fifteen minutes", async () => {
    const h = harness([
      { exitCode: 0, stdout: completed() },
      { exitCode: 0, stdout: completed() },
    ]);
    await h.probe.probe("gpt-5.5");
    h.advance(900_000);
    await h.probe.probe("gpt-5.5");
    expect(h.calls).toHaveLength(2);
  });

  test("keys cache by model, CLI version, catalog fingerprint, and auth stat fingerprint", async () => {
    const h = harness(Array.from({ length: 5 }, () => ({ exitCode: 0, stdout: completed() })));
    await h.probe.probe("gpt-5.5");
    await h.probe.probe("gpt-5.4");
    h.setCliVersion("codex-cli 2");
    await h.probe.probe("gpt-5.5");
    h.setCatalogFingerprint("catalog-2");
    await h.probe.probe("gpt-5.5");
    h.setAuthMtime(200);
    await h.probe.probe("gpt-5.5");
    expect(h.calls).toHaveLength(5);
  });

  test("does not cache transient failures", async () => {
    const h = harness([
      { exitCode: 1, stderr: "request timed out" },
      { exitCode: 0, stdout: completed() },
    ]);
    expect((await h.probe.probe("gpt-5.5")).kind).toBe("transient_failure");
    expect((await h.probe.probe("gpt-5.5")).kind).toBe("available");
    expect(h.calls).toHaveLength(2);
  });

  test("coalesces concurrent probes for the same cache key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const probe = createCodexModelAvailabilityProbe({
      runProcess: async () => {
        calls += 1;
        await gate;
        return { exitCode: 0, stdout: completed() };
      },
      now: () => 1,
      getCliVersion: async () => "codex-cli 1",
      getCatalogFingerprint: () => "catalog-1",
      getAuthStat: async () => null,
      fs: {
        makeTempDir: async () => `/tmp/concurrent-${calls}`,
        readDir: async () => [],
        removeDir: async () => undefined,
      },
    });
    const first = probe.probe("gpt-5.5");
    const second = probe.probe("gpt-5.5");
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test("always cleans the temporary directory when the runner throws", async () => {
    const h = harness([]);
    const throwing = createCodexModelAvailabilityProbe({
      runProcess: async () => { throw new Error("DNS failure"); },
      now: () => 1,
      getCliVersion: async () => "codex-cli 1",
      getCatalogFingerprint: () => "catalog-1",
      getAuthStat: async () => null,
      fs: {
        makeTempDir: async () => "/tmp/thrown-probe",
        readDir: async () => [],
        removeDir: async (path) => { h.removed.push(path); },
      },
    });
    expect((await throwing.probe("gpt-5.5")).kind).toBe("transient_failure");
    expect(h.removed).toEqual(["/tmp/thrown-probe"]);
  });

  test.each([
    ["empty", ""],
    ["unrelated", completed("NOT_THE_SENTINEL")],
    ["malformed", "not json"],
    ["error event", JSON.stringify({ type: "error", message: "provider failed" })],
  ])("treats exit zero with %s stdout as transient", async (_name, stdout) => {
    const h = harness([{ exitCode: 0, stdout }]);
    expect((await h.probe.probe("gpt-5.5")).kind).toBe("transient_failure");
  });

  test("rejects a valid sentinel when the stream also contains a top-level error", async () => {
    const stdout = [
      JSON.stringify({ type: "error", message: "provider failed" }),
      completed("MODEL_AVAILABILITY_OK."),
    ].join("\n");
    const h = harness([{ exitCode: 0, stdout }]);

    expect((await h.probe.probe("gpt-5.6-sol")).kind).toBe("transient_failure");
  });

  // gpt-5.6-sol deterministically echoes the probe instruction's own trailing
  // period ("MODEL_AVAILABILITY_OK."), and other models may wrap the sentinel in
  // quotes/backticks or whitespace. These are available models, so trivial edge
  // formatting must not be misclassified as a probe failure (regression: Codex
  // sessions pinned to gpt-5.6-sol returned spurious "校验失败" at spawn admission).
  test.each([
    ["trailing period", completed("MODEL_AVAILABILITY_OK.")],
    ["wrapping backticks", completed("`MODEL_AVAILABILITY_OK`")],
    ["trailing exclamation and space", completed("MODEL_AVAILABILITY_OK! ")],
  ])("treats exit zero with the sentinel plus %s as available", async (_name, stdout) => {
    const h = harness([{ exitCode: 0, stdout }]);
    expect((await h.probe.probe("gpt-5.6-sol")).kind).toBe("available");
  });

  test("accepts the real gpt-5.6-sol JSONL response with a trailing period", async () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019f57f3" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "error",
          message: "Skill descriptions were shortened to fit the context budget.",
        },
      }),
      completed("MODEL_AVAILABILITY_OK."),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 23_183, output_tokens: 10 },
      }),
    ].join("\n");
    const h = harness([{ exitCode: 0, stdout }]);

    await expect(h.probe.probe("gpt-5.6-sol")).resolves.toMatchObject({
      kind: "available",
    });
  });

  test("accepts the real gpt-5.6-terra lifecycle JSONL response", async () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019fa734" }),
      JSON.stringify({ type: "turn.started" }),
      completed("MODEL_AVAILABILITY_OK"),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 21_068, output_tokens: 9 },
      }),
    ].join("\n");
    const h = harness([{ exitCode: 0, stdout }]);

    await expect(h.probe.probe("gpt-5.6-terra")).resolves.toMatchObject({
      kind: "available",
    });
  });

  test("reports stderr probe timeout instead of lifecycle JSON", async () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019fa734" }),
      JSON.stringify({ type: "turn.started" }),
    ].join("\n");
    const h = harness([{
      exitCode: 1,
      stdout,
      stderr: "codex probe timed out after 45000ms",
    }]);

    await expect(h.probe.probe("gpt-5.6-terra")).resolves.toEqual({
      kind: "transient_failure",
      checkedAt: 1_000,
      reason: "codex probe timed out after 45000ms",
    });
  });

  test("reports actionable stderr instead of lifecycle JSON", async () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019fa734" }),
      JSON.stringify({ type: "turn.started" }),
    ].join("\n");
    const h = harness([{
      exitCode: 1,
      stdout,
      stderr: "provider connection failed",
    }]);

    await expect(h.probe.probe("gpt-5.6-terra")).resolves.toMatchObject({
      kind: "transient_failure",
      reason: "provider connection failed",
    });
  });

  test("returns transient failure when temporary-directory cleanup fails", async () => {
    const probe = createCodexModelAvailabilityProbe({
      runProcess: async () => ({ exitCode: 0, stdout: completed() }),
      now: () => 1,
      getCliVersion: async () => "codex-cli 1",
      getCatalogFingerprint: () => "catalog-1",
      getAuthStat: async () => null,
      fs: {
        makeTempDir: async () => "/tmp/cleanup-failure",
        readDir: async () => [],
        removeDir: async () => { throw new Error("cleanup denied"); },
      },
    });

    await expect(probe.probe("gpt-5.5")).resolves.toMatchObject({
      kind: "transient_failure",
      reason: "cleanup failed: cleanup denied",
    });
  });

  test("force-settles a hung process and permits cleanup after the timeout grace", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      const signals: NodeJS.Signals[] = [];
      let spawnOptions: unknown;
      const runner = createProbeProcessRunner({
        spawn: (_command, _args, options) => {
          spawnOptions = options;
          return child;
        },
        killProcessGroup: (_pid, signal) => { signals.push(signal); },
      });
      const removed: string[] = [];
      const probe = createCodexModelAvailabilityProbe({
        runProcess: runner,
        now: () => 1,
        getCliVersion: async () => "codex-cli 1",
        getCatalogFingerprint: () => "catalog-1",
        getAuthStat: async () => null,
        timeoutMs: 20_000,
        fs: {
          makeTempDir: async () => "/tmp/hung-probe",
          readDir: async () => [],
          removeDir: async (path) => { removed.push(path); },
        },
      });

      const result = probe.probe("gpt-5.5");
      await vi.advanceTimersByTimeAsync(20_500);

      await expect(result).resolves.toMatchObject({ kind: "transient_failure" });
      expect(spawnOptions).toMatchObject({ detached: true, stdio: ["ignore", "pipe", "pipe"] });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(removed).toEqual(["/tmp/hung-probe"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
