import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createImmutableIngressBridge,
  type ImmutableIngressDeclaration,
} from "../../src/app/immutableIngress.ts";

const cleanup: string[] = [];

async function waitForFile(path: string, timeoutMs = 1_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

const declaration: ImmutableIngressDeclaration = {
  protocol: "supermatrix-immutable-ingress/v1",
  startMarker: "WECHAT_HDQ_INGRESS_V1:",
  endMarker: "WECHAT_HDQ_INGRESS_END_V1",
  command: "receiver",
  args: ["--ingress-prompt-file", "{prompt_file}"],
  receipt: {
    terminalPointer: "/terminal",
    acceptedPointer: "/transport/target_accepted",
    identity: {
      eventId: {
        receiptPointer: "/correlation/event_id",
        carrierPointer: "/binding/event_id",
      },
      payloadDigest: {
        receiptPointer: "/transport/received_envelope_sha256",
        carrierPointer: "/raw_object_sha256",
      },
    },
  },
};

describe("immutable ingress bridge", () => {
  test("captures exact prompt bytes, admits a verified receipt, and redacts the carrier from model input", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-"));
    cleanup.push(runtimeRoot);
    const prompt = [
      "before-secret=do-not-forward WECHAT_SUB_ENVELOPE_V1 legacy business JSON",
      "WECHAT_HDQ_INGRESS_V1:",
      JSON.stringify({
        binding: { event_id: "event-1" },
        raw_object_sha256: "digest-1",
      }),
      "WECHAT_HDQ_INGRESS_END_V1",
      "after-secret=do-not-forward another legacy payload",
    ].join("\n");
    let receiverInput: { args: string[]; promptBytes: Buffer } | undefined;
    const bridge = createImmutableIngressBridge({
      runtimeRoot,
      runReceiver: async ({ args }) => {
        const promptPath = args[args.indexOf("--ingress-prompt-file") + 1]!;
        receiverInput = { args, promptBytes: await readFile(promptPath) };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            terminal: true,
            transport: {
              target_accepted: true,
              received_envelope_sha256: "digest-1",
            },
            correlation: { event_id: "event-1" },
          }),
          stderr: "",
        };
      },
    });

    const result = await bridge.admit({
      targetSessionName: "target",
      clientRequestId: "2026-08-28:caller:target:ingress-1",
      prompt,
      declaration,
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    expect(receiverInput?.promptBytes).toEqual(Buffer.from(prompt, "utf8"));
    expect(result.admittedPrompt).toContain('"eventId":"event-1"');
    expect(result.admittedPrompt).toContain('"payloadDigest":"digest-1"');
    expect(result.admittedPrompt).not.toContain("before-secret=do-not-forward");
    expect(result.admittedPrompt).not.toContain("after-secret=do-not-forward");
    expect(result.admittedPrompt).not.toContain("WECHAT_SUB_ENVELOPE_V1");
    expect(result.admittedPrompt).not.toContain("WECHAT_HDQ_INGRESS_V1:");
    expect(result.admittedPrompt).not.toContain("WECHAT_HDQ_INGRESS_END_V1");
    expect(result.eventIdentity).toEqual({ eventId: "event-1", payloadDigest: "digest-1" });
  });

  test("rejects a declared identity that resolves to a composite value", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-composite-"));
    cleanup.push(runtimeRoot);
    const compositeDeclaration: ImmutableIngressDeclaration = {
      ...declaration,
      receipt: {
        ...declaration.receipt,
        identity: {
          composite: {
            receiptPointer: "/details",
            carrierPointer: "/binding",
          },
        },
      },
    };
    const bridge = createImmutableIngressBridge({
      runtimeRoot,
      runReceiver: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          terminal: true,
          transport: { target_accepted: true },
          details: { nested: "must-not-enter-ticket" },
        }),
        stderr: "",
      }),
    });
    const result = await bridge.admit({
      targetSessionName: "target",
      clientRequestId: "2026-08-28:caller:target:ingress-composite",
      prompt: [
        "WECHAT_HDQ_INGRESS_V1:",
        JSON.stringify({ binding: { nested: "must-not-enter-ticket" } }),
        "WECHAT_HDQ_INGRESS_END_V1",
      ].join("\n"),
      declaration: compositeDeclaration,
    });
    expect(result).toEqual({
      accepted: false,
      reason: "immutable ingress receipt identity must be scalar: composite",
    });
  });

  test("rejects a terminal receipt whose durable identity does not match the carrier", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-mismatch-"));
    cleanup.push(runtimeRoot);
    const bridge = createImmutableIngressBridge({
      runtimeRoot,
      runReceiver: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          terminal: true,
          transport: { target_accepted: true, received_envelope_sha256: "different-digest" },
          correlation: { event_id: "event-1" },
        }),
        stderr: "",
      }),
    });
    const result = await bridge.admit({
      targetSessionName: "target",
      clientRequestId: "2026-08-28:caller:target:ingress-mismatch",
      prompt: [
        "WECHAT_HDQ_INGRESS_V1:",
        JSON.stringify({ binding: { event_id: "event-1" }, raw_object_sha256: "digest-1" }),
        "WECHAT_HDQ_INGRESS_END_V1",
      ].join("\n"),
      declaration,
    });
    expect(result).toEqual({ accepted: false, reason: "immutable ingress receipt identity mismatch: payloadDigest" });
  });

  test("rejects when the declared receiver emits no structured receipt", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-no-receipt-"));
    cleanup.push(runtimeRoot);
    const bridge = createImmutableIngressBridge({
      runtimeRoot,
      runReceiver: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const result = await bridge.admit({
      targetSessionName: "target",
      clientRequestId: "2026-08-28:caller:target:ingress-no-receipt",
      prompt: [
        "WECHAT_HDQ_INGRESS_V1:",
        JSON.stringify({ binding: { event_id: "event-1" }, raw_object_sha256: "digest-1" }),
        "WECHAT_HDQ_INGRESS_END_V1",
      ].join("\n"),
      declaration,
    });
    expect(result).toEqual({
      accepted: false,
      reason: "immutable ingress receipt missing or invalid: Unexpected end of JSON input",
    });
  });

  test("reports a nonzero receiver exit before parsing its empty receipt", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-rejected-"));
    cleanup.push(runtimeRoot);
    const bridge = createImmutableIngressBridge({
      runtimeRoot,
      runReceiver: async () => ({ exitCode: 7, stdout: "", stderr: "controlled rejection" }),
    });
    const result = await bridge.admit({
      targetSessionName: "target",
      clientRequestId: "2026-08-28:caller:target:ingress-rejected",
      prompt: [
        "WECHAT_HDQ_INGRESS_V1:",
        JSON.stringify({ binding: { event_id: "event-1" }, raw_object_sha256: "digest-1" }),
        "WECHAT_HDQ_INGRESS_END_V1",
      ].join("\n"),
      declaration,
    });
    expect(result).toEqual({
      accepted: false,
      reason: "immutable ingress receiver rejected: controlled rejection",
    });
  });

  test("waits for the entire killed receiver process group to be reaped", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-reap-"));
    cleanup.push(runtimeRoot);
    const leaderPidPath = join(runtimeRoot, "leader.pid");
    const workerPidPath = join(runtimeRoot, "worker.pid");
    const slowDeclaration: ImmutableIngressDeclaration = {
      ...declaration,
      command: "sh",
      args: [
        "-c",
        `trap "" TERM; echo $$ > ${leaderPidPath}; sleep 100 & echo $! > ${workerPidPath}; wait`,
        "{prompt_file}",
      ],
    };
    const bridge = createImmutableIngressBridge({ runtimeRoot });
    const result = await bridge.admit({
      targetSessionName: "target",
      clientRequestId: "2026-08-28:caller:target:ingress-reap",
      prompt: [
        "WECHAT_HDQ_INGRESS_V1:",
        JSON.stringify({ binding: { event_id: "event-1" }, raw_object_sha256: "digest-1" }),
        "WECHAT_HDQ_INGRESS_END_V1",
      ].join("\n"),
      declaration: slowDeclaration,
      receiverTimeoutMs: 1_000,
    });

    expect(result).toMatchObject({ accepted: false });
    const leaderPid = Number(await waitForFile(leaderPidPath));
    const workerPid = Number(await waitForFile(workerPidPath));
    expect(() => process.kill(leaderPid, 0)).toThrow();
    expect(() => process.kill(workerPid, 0)).toThrow();
  });

  test("keeps cleanup active when the receiver leader exits after TERM but a descendant survives", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-descendant-reap-"));
    cleanup.push(runtimeRoot);
    const leaderPidPath = join(runtimeRoot, "leader.pid");
    const workerPidPath = join(runtimeRoot, "worker.pid");
    const slowDeclaration: ImmutableIngressDeclaration = {
      ...declaration,
      command: "sh",
      args: [
        "-c",
        `trap 'exit 0' TERM; echo $$ > ${leaderPidPath}; sh -c 'trap "" TERM HUP INT; echo $$ > "$1"; while :; do sleep 1; done' sh ${workerPidPath} </dev/null >/dev/null 2>&1 & wait`,
        "{prompt_file}",
      ],
    };
    const bridge = createImmutableIngressBridge({ runtimeRoot });
    let leaderPid: number | undefined;
    let workerPid: number | undefined;
    let resolved = false;
    try {
      const resultPromise = bridge.admit({
        targetSessionName: "target",
        clientRequestId: "2026-08-28:caller:target:ingress-descendant-reap",
        prompt: [
          "WECHAT_HDQ_INGRESS_V1:",
          JSON.stringify({ binding: { event_id: "event-1" }, raw_object_sha256: "digest-1" }),
          "WECHAT_HDQ_INGRESS_END_V1",
        ].join("\n"),
        declaration: slowDeclaration,
        receiverTimeoutMs: 300,
      });
      void resultPromise.then(() => { resolved = true; });
      leaderPid = Number(await waitForFile(leaderPidPath));
      workerPid = Number(await waitForFile(workerPidPath));

      await waitForProcessExit(leaderPid);
      expect(() => process.kill(workerPid!, 0)).not.toThrow();
      expect(resolved).toBe(false);

      await expect(resultPromise).resolves.toMatchObject({ accepted: false });
      expect(() => process.kill(workerPid!, 0)).toThrow();
    } finally {
      if (leaderPid !== undefined) {
        try { process.kill(-leaderPid, "SIGKILL"); } catch { /* already reaped */ }
      }
      if (workerPid !== undefined) {
        try { process.kill(workerPid, "SIGKILL"); } catch { /* already reaped */ }
      }
    }
  });

  test("keeps admission unsettled after negative-PGID SIGKILL fails until the descendant group is gone", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-kill-failure-"));
    cleanup.push(runtimeRoot);
    const leaderPidPath = join(runtimeRoot, "leader.pid");
    const workerPidPath = join(runtimeRoot, "worker.pid");
    const slowDeclaration: ImmutableIngressDeclaration = {
      ...declaration,
      command: "sh",
      args: [
        "-c",
        `trap 'exit 0' TERM; echo $$ > ${leaderPidPath}; sh -c 'trap "" TERM HUP INT; echo $$ > "$1"; while :; do sleep 1; done' sh ${workerPidPath} </dev/null >/dev/null 2>&1 & wait`,
        "{prompt_file}",
      ],
    };
    const realProcessKill = process.kill.bind(process);
    let leaderPid: number | undefined;
    let workerPid: number | undefined;
    let killFailureInjected = false;
    let resolved = false;
    let resultPromise: ReturnType<ReturnType<typeof createImmutableIngressBridge>["admit"]> | undefined;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (leaderPid !== undefined && pid === -leaderPid && signal === "SIGKILL") {
        killFailureInjected = true;
        throw Object.assign(new Error("injected negative-PGID SIGKILL failure"), { code: "EPERM" });
      }
      return realProcessKill(pid, signal);
    });
    try {
      const bridge = createImmutableIngressBridge({ runtimeRoot });
      resultPromise = bridge.admit({
        targetSessionName: "target",
        clientRequestId: "2026-08-28:caller:target:ingress-kill-failure",
        prompt: [
          "WECHAT_HDQ_INGRESS_V1:",
          JSON.stringify({ binding: { event_id: "event-1" }, raw_object_sha256: "digest-1" }),
          "WECHAT_HDQ_INGRESS_END_V1",
        ].join("\n"),
        declaration: slowDeclaration,
        receiverTimeoutMs: 300,
      });
      void resultPromise.then(() => { resolved = true; });
      leaderPid = Number(await waitForFile(leaderPidPath));
      workerPid = Number(await waitForFile(workerPidPath));

      const injectionDeadline = Date.now() + 1_000;
      while (!killFailureInjected && Date.now() < injectionDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(killFailureInjected).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => realProcessKill(workerPid!, 0)).not.toThrow();
      expect(() => realProcessKill(-leaderPid!, 0)).not.toThrow();
      expect(resolved).toBe(false);

      realProcessKill(-leaderPid, "SIGKILL");
      await expect(resultPromise).resolves.toEqual({
        accepted: false,
        reason: "immutable ingress receiver process group cleanup failed: signal SIGKILL failed with EPERM",
        failure: {
          code: "receiver_process_group_cleanup_failed",
          operation: "signal",
          signal: "SIGKILL",
          errorCode: "EPERM",
        },
      });
      await waitForProcessExit(workerPid);
    } finally {
      killSpy.mockRestore();
      if (leaderPid !== undefined) {
        try { realProcessKill(-leaderPid, "SIGKILL"); } catch { /* already reaped */ }
      }
      if (workerPid !== undefined) {
        try { realProcessKill(workerPid, "SIGKILL"); } catch { /* already reaped */ }
      }
      if (resultPromise) {
        await Promise.race([
          resultPromise.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    }
  });

  test("rejects a valid receiver receipt that arrives after the deadline", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "sm-immutable-ingress-deadline-"));
    cleanup.push(runtimeRoot);
    const bridge = createImmutableIngressBridge({
      runtimeRoot,
      runReceiver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 350));
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            terminal: true,
            transport: { target_accepted: true, received_envelope_sha256: "digest-1" },
            correlation: { event_id: "event-1" },
          }),
          stderr: "",
        };
      },
    });
    const result = await bridge.admit({
      targetSessionName: "target",
      clientRequestId: "2026-08-28:caller:target:ingress-late-receipt",
      prompt: [
        "WECHAT_HDQ_INGRESS_V1:",
        JSON.stringify({ binding: { event_id: "event-1" }, raw_object_sha256: "digest-1" }),
        "WECHAT_HDQ_INGRESS_END_V1",
      ].join("\n"),
      declaration,
      receiverDeadlineAt: Date.now() + 320,
    });

    expect(result).toEqual({
      accepted: false,
      reason: "immutable ingress receiver-terminal deadline expired before receiver completion",
    });
  });
});
