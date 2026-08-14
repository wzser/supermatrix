// tests/adapters/backend-kimi/acpClient.test.ts
//
// TDD tests for AcpClient. All tests use in-process cross-wired streams —
// no real kimi binary is spawned.
//
// Stream wiring:
//   clientToServer: client writes → server reads  (PassThrough)
//   serverToClient: server writes → client reads  (PassThrough)

import { homedir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  AcpClient,
  buildDefaultKimiArgs,
  buildKimiChildEnv,
  resolveKimiSkillsDir,
} from "../../../src/adapters/backend-kimi/acpClient.ts";
import { runFakeAcpServer } from "./fakeAcpServer.ts";

function pairWithFake(scenario: "happy" | "tool" | "tool-schema-drift" | "cancel" | "error") {
  // Two PassThrough streams cross-wired:
  //   clientToServer: client writes here → server reads from here
  //   serverToClient: server writes here → client reads from here
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  runFakeAcpServer({
    scenario,
    clientToServer,
    serverToClient,
  });

  // AcpClient receives:
  //   stdin = where it writes outgoing messages → clientToServer
  //   stdout = where it reads incoming messages ← serverToClient
  return new AcpClient({
    streams: {
      stdin: clientToServer, // client writes here (→ server reads)
      stdout: serverToClient, // client reads here (← server writes)
    },
  });
}

function fakeManagedChild(): {
  child: ChildProcess;
  signals: string[];
} {
  const events = new EventEmitter();
  const signals: string[] = [];
  const child = Object.assign(events, {
    pid: 424242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: string) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        queueMicrotask(() => events.emit("exit", null, "SIGKILL"));
      }
      return true;
    }),
  }) as unknown as ChildProcess;
  return { child, signals };
}

describe("AcpClient", () => {
  test("initialize + newSession returns sessionId", async () => {
    const client = pairWithFake("happy");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    expect(sid).toBe("fake-acp-sid-001");
    await client.dispose();
  });

  test("prompt collects session updates via onUpdate callback", async () => {
    const client = pairWithFake("happy");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    const updates: any[] = [];
    const result = await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: (u) => updates.push(u),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0].sessionUpdate).toBe("agent_message_chunk");
    await client.dispose();
  });

  test("routes kimi tool_call_update when rawOutput is a string", async () => {
    const client = pairWithFake("tool-schema-drift");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    const updates: any[] = [];

    const result = await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "use a tool" }],
      onUpdate: (update) => updates.push(update),
    });

    expect(result.stopReason).toBe("end_turn");
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "tool_call_update",
      toolCallId: "0:tool_schema_drift",
      status: "completed",
    }));
    await client.dispose();
  });

  test("cancel sends session/cancel and stopReason becomes cancelled", async () => {
    const client = pairWithFake("cancel");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    const promptP = client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "long task" }],
      onUpdate: () => {},
    });
    setTimeout(() => {
      client.cancel(sid).catch(() => {});
    }, 100);
    const result = await promptP;
    expect(result.stopReason).toBe("cancelled");
    await client.dispose();
  });

  test("dispose closes idempotently — second call does not throw", async () => {
    const client = pairWithFake("happy");
    await client.ensureReady();
    await client.dispose();
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  test("dispose resumes a stopped managed ACP before bounded TERM/KILL reaping", async () => {
    const client = new AcpClient({
      disposeTermTimeoutMs: 5,
      disposeKillTimeoutMs: 5,
    } as any);
    const { child, signals } = fakeManagedChild();
    const mutable = client as unknown as {
      child: ChildProcess | null;
      state: "init" | "ready" | "dead";
    };
    mutable.child = child;
    mutable.state = "ready";

    await client.dispose();

    expect(signals).toEqual(["SIGCONT", "SIGTERM", "SIGKILL"]);
    expect(mutable.state).toBe("dead");
  });

  test("stopped managed ACP is rejected before session/new can wait on its retained pipes", async () => {
    const client = new AcpClient({
      childLivenessProbe: async () => "stopped",
      disposeTermTimeoutMs: 5,
      disposeKillTimeoutMs: 5,
    } as any);
    const { child } = fakeManagedChild();
    const newSession = vi.fn().mockResolvedValue({ sessionId: "should-not-run" });
    const mutable = client as unknown as {
      child: ChildProcess | null;
      conn: { newSession: typeof newSession } | null;
      state: "init" | "ready" | "dead";
    };
    mutable.child = child;
    mutable.conn = { newSession };
    mutable.state = "ready";

    await expect(client.newSession({ cwd: "/tmp" })).rejects.toThrow(
      "managed ACP child is stopped",
    );
    expect(newSession).not.toHaveBeenCalled();
  });

  test("bounds a stalled session/new RPC and invalidates the client", async () => {
    const client = new AcpClient({ sessionRpcTimeoutMs: 10 } as any);
    const mutable = client as unknown as {
      conn: { newSession: () => Promise<never> } | null;
      state: "init" | "ready" | "dead";
    };
    mutable.conn = { newSession: () => new Promise<never>(() => {}) };
    mutable.state = "ready";

    await expect(client.newSession({ cwd: "/tmp" })).rejects.toThrow(
      "session/new timed out after 10ms",
    );
    expect(mutable.state).toBe("dead");
  });

  test("bounds a stalled session/load RPC and invalidates the client", async () => {
    const client = new AcpClient({ sessionRpcTimeoutMs: 10 } as any);
    const mutable = client as unknown as {
      conn: { loadSession: () => Promise<never> } | null;
      state: "init" | "ready" | "dead";
    };
    mutable.conn = { loadSession: () => new Promise<never>(() => {}) };
    mutable.state = "ready";

    await expect(client.loadSession({ sessionId: "acp-sid", cwd: "/tmp" })).rejects.toThrow(
      "session/load timed out after 10ms",
    );
    expect(mutable.state).toBe("dead");
  });

  test("health probe round-trips session/list without creating a business session", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    let buffered = "";
    let listCalls = 0;
    clientToServer.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id: string | number; method: string };
        if (request.method === "initialize") {
          serverToClient.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [],
            },
          }) + "\n");
        }
        if (request.method === "session/list") {
          listCalls++;
          serverToClient.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {},
          }) + "\n");
        }
      }
    });

    const client = new AcpClient({
      streams: { stdin: clientToServer, stdout: serverToClient },
    });

    await expect(client.probeHealth(100)).resolves.toEqual({
      rttMs: expect.any(Number),
    });
    expect(listCalls).toBe(1);
    await client.dispose();
  });
});

describe("resolveKimiSkillsDir", () => {
  test("defaults to ~/.kimi/skills when SM_KIMI_SKILLS_DIR unset", () => {
    expect(resolveKimiSkillsDir({})).toBe(join(homedir(), ".kimi", "skills"));
  });

  test("honors SM_KIMI_SKILLS_DIR override", () => {
    expect(resolveKimiSkillsDir({ SM_KIMI_SKILLS_DIR: "/opt/skills" })).toBe(
      "/opt/skills",
    );
  });

  test("treats empty SM_KIMI_SKILLS_DIR as unset", () => {
    expect(resolveKimiSkillsDir({ SM_KIMI_SKILLS_DIR: "" })).toBe(
      join(homedir(), ".kimi", "skills"),
    );
  });
});

describe("buildDefaultKimiArgs", () => {
  test("places --skills-dir as a top-level global flag before acp", () => {
    const args = buildDefaultKimiArgs({ SM_KIMI_SKILLS_DIR: "/opt/skills" });
    expect(args).toEqual(["--skills-dir", "/opt/skills", "acp"]);
    // Order matters: Kimi CLI rejects --skills-dir when it appears after `acp`.
    const flagIdx = args.indexOf("--skills-dir");
    const acpIdx = args.indexOf("acp");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(acpIdx).toBeGreaterThan(flagIdx + 1);
  });

  test("falls back to ~/.kimi/skills when env unset", () => {
    expect(buildDefaultKimiArgs({})).toEqual([
      "--skills-dir",
      join(homedir(), ".kimi", "skills"),
      "acp",
    ]);
  });
});

describe("AcpClient.setSessionModel (raw side channel)", () => {
  test("sends session/set_model with modelId and resolves on server ack", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
    runFakeAcpServer({ scenario: "happy", clientToServer, serverToClient, setModelCalls });
    const client = new AcpClient({ streams: { stdin: clientToServer, stdout: serverToClient } });

    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    await client.setSessionModel({ sessionId: sid, modelId: "kimi-code/k3" });

    expect(setModelCalls).toEqual([{ sessionId: "fake-acp-sid-001", modelId: "kimi-code/k3" }]);

    // Lib connection stays usable after a raw round-trip (response filtering
    // must not corrupt the shared stdout stream).
    const updates: unknown[] = [];
    const result = await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: (u) => updates.push(u),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    await client.dispose();
  });

  test("dispose rejects in-flight raw requests", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    // No fake server on purpose: the request can never be answered.
    const client = new AcpClient({ streams: { stdin: clientToServer, stdout: serverToClient } });
    // Bypass ensureReady (it would hang without a server): wire rawStdin directly.
    (client as unknown as { rawStdin: unknown; conn: unknown }).rawStdin = clientToServer;
    (client as unknown as { conn: unknown }).conn = {}; // satisfy the ready guard
    const p = client.setSessionModel({ sessionId: "s", modelId: "m" });
    await client.dispose();
    await expect(p).rejects.toThrow("AcpClient disposed");
  });
});

describe("AcpClient.setSessionConfigOption (raw side channel)", () => {
  test("sends session/set_config_option and records configOptions from the response", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const setConfigOptionCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    runFakeAcpServer({ scenario: "happy", clientToServer, serverToClient, setConfigOptionCalls });
    const client = new AcpClient({ streams: { stdin: clientToServer, stdout: serverToClient } });

    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    await client.setSessionConfigOption({ sessionId: sid, configId: "thinking", value: "max" });

    expect(setConfigOptionCalls).toEqual([
      { sessionId: "fake-acp-sid-001", configId: "thinking", value: "max" },
    ]);
    // The response configOptions are recorded for later read-backs.
    expect(client.getSessionThinking(sid)).toBe("max");
    expect(client.getSessionModel(sid)).toBe("kimi-code/k3");

    // Lib connection stays usable after the raw round-trip.
    const result = await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: () => {},
    });
    expect(result.stopReason).toBe("end_turn");
    await client.dispose();
  });

  test("a config_option_update notification also refreshes the recorded thinking level", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    runFakeAcpServer({ scenario: "happy", clientToServer, serverToClient });
    const client = new AcpClient({ streams: { stdin: clientToServer, stdout: serverToClient } });
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });

    serverToClient.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { type: "select", id: "model", name: "Model", currentValue: "kimi-code/k3" },
            { type: "select", id: "thinking", name: "Thinking", currentValue: "low" },
          ],
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    expect(client.getSessionThinking(sid)).toBe("low");
    await client.dispose();
  });

  test("server-side ACP error rejects with the precise error", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    runFakeAcpServer({
      scenario: "happy",
      clientToServer,
      serverToClient,
      failSetConfigOption: true,
    });
    const client = new AcpClient({ streams: { stdin: clientToServer, stdout: serverToClient } });

    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    await expect(
      client.setSessionConfigOption({ sessionId: sid, configId: "thinking", value: "low" }),
    ).rejects.toThrow(/-32602/);
    await client.dispose();
  });
});

describe("AcpClient session model tracking", () => {
  test("newSession records the model from configOptions", async () => {
    const client = pairWithFake("happy");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    expect(client.getSessionModel(sid)).toBe("kimi-code/kimi-for-coding");
    await client.dispose();
  });

  test("loadSession records the resumed session's configOptions (model + thinking snapshot)", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    runFakeAcpServer({
      scenario: "happy",
      clientToServer,
      serverToClient,
      loadSessionConfigOptions: [
        { type: "select", id: "model", name: "Model", currentValue: "kimi-code/k3" },
        { type: "select", id: "thinking", name: "Thinking", currentValue: "max" },
      ],
    });
    const client = new AcpClient({ streams: { stdin: clientToServer, stdout: serverToClient } });
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    // Fresh session observed the default model; the resume must overwrite the
    // snapshot with the resumed session's actual config (a model-null run
    // resolves its level against this).
    expect(client.getSessionModel(sid)).toBe("kimi-code/kimi-for-coding");
    await client.loadSession({ sessionId: sid, cwd: "/tmp" });
    expect(client.getSessionModel(sid)).toBe("kimi-code/k3");
    expect(client.getSessionThinking(sid)).toBe("max");
    await client.dispose();
  });

  test("config_option_update notification updates the model and is dropped before the lib", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    runFakeAcpServer({ scenario: "happy", clientToServer, serverToClient });
    const client = new AcpClient({ streams: { stdin: clientToServer, stdout: serverToClient } });
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });

    // Inject the raw notification exactly as kimi-code 0.26.0 emits it — the
    // 0.4.5 lib schema rejects this update kind, so it must be consumed by the
    // client-side filter (recording the model) and never reach the lib.
    serverToClient.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ type: "select", id: "model", name: "Model", currentValue: "kimi-code/k3" }],
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    expect(client.getSessionModel(sid)).toBe("kimi-code/k3");

    // Connection still healthy after the filtered notification.
    const result = await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: () => {},
    });
    expect(result.stopReason).toBe("end_turn");
    await client.dispose();
  });
});

describe("AcpClient AskUserQuestion routing", () => {
  function pairForPermission(
    scenario: "ask" | "approve",
    opts: {
      askBroker?: (
        req: import("../../../src/adapters/card-ask/askViaBroker.ts").CardAskBrokerRequest,
      ) => Promise<import("../../../src/adapters/card-ask/askViaBroker.ts").CardAskBrokerResult>;
      permissionOutcomes: unknown[];
    },
  ) {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    runFakeAcpServer({
      scenario,
      clientToServer,
      serverToClient,
      permissionOutcomes: opts.permissionOutcomes,
    });
    return new AcpClient({
      streams: { stdin: clientToServer, stdout: serverToClient },
      ...(opts.askBroker ? { askBroker: opts.askBroker } : {}),
    });
  }

  async function runOnePrompt(client: AcpClient): Promise<string> {
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: () => {},
    });
    return sid;
  }

  test("without a registered route, AskUserQuestion is cancelled and the broker is untouched", async () => {
    const permissionOutcomes: unknown[] = [];
    const asked: unknown[] = [];
    const client = pairForPermission("ask", {
      permissionOutcomes,
      askBroker: async (req) => {
        asked.push(req);
        return { status: "answered", value: "q0_opt_1", label: "方案B" };
      },
    });
    const sid = await runOnePrompt(client);

    expect(asked).toHaveLength(0);
    expect(permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    await client.dispose();
    void sid;
  });

  test("with a registered route, the user's click maps back to the optionId", async () => {
    const permissionOutcomes: unknown[] = [];
    const asked: Array<{ question: string; options: unknown[]; chatId: string }> = [];
    const client = pairForPermission("ask", {
      permissionOutcomes,
      askBroker: async (req) => {
        asked.push(req);
        return { status: "answered", value: "q0_opt_1", label: "方案B" };
      },
    });
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    client.setCardAskRoute(sid, { brokerUrl: "http://127.0.0.1:8787", chatId: "oc_test" });
    await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: () => {},
    });

    expect(asked).toEqual([
      {
        brokerUrl: "http://127.0.0.1:8787",
        chatId: "oc_test",
        question: "测试：选哪个方案？",
        options: [
          { label: "方案A", value: "q0_opt_0", description: "方案A" },
          { label: "方案B", value: "q0_opt_1", description: "方案B" },
        ],
      },
    ]);
    expect(permissionOutcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "q0_opt_1" } },
    ]);
    await client.dispose();
  });

  test("escape/timeout from the broker resolves to cancelled, never a fabricated answer", async () => {
    const permissionOutcomes: unknown[] = [];
    const client = pairForPermission("ask", {
      permissionOutcomes,
      askBroker: async () => ({ status: "escaped", reason: "timeout" }),
    });
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    client.setCardAskRoute(sid, { brokerUrl: "http://127.0.0.1:8787", chatId: "oc_test" });
    await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: () => {},
    });
    expect(permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    await client.dispose();
  });

  test("broker failure resolves to cancelled, never a fabricated answer", async () => {
    const permissionOutcomes: unknown[] = [];
    const client = pairForPermission("ask", {
      permissionOutcomes,
      askBroker: async () => {
        throw new Error("broker down");
      },
    });
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    client.setCardAskRoute(sid, { brokerUrl: "http://127.0.0.1:8787", chatId: "oc_test" });
    await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: () => {},
    });
    expect(permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    await client.dispose();
  });

  test("clearing the route stops card routing again", async () => {
    const permissionOutcomes: unknown[] = [];
    const asked: unknown[] = [];
    const client = pairForPermission("ask", {
      permissionOutcomes,
      askBroker: async (req) => {
        asked.push(req);
        return { status: "answered", value: "q0_opt_0", label: "方案A" };
      },
    });
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    client.setCardAskRoute(sid, { brokerUrl: "http://127.0.0.1:8787", chatId: "oc_test" });
    client.setCardAskRoute(sid, null);
    await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: () => {},
    });
    expect(asked).toHaveLength(0);
    expect(permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    await client.dispose();
  });

  test("ordinary tool consent is still auto-approved (approve_for_session preferred)", async () => {
    const permissionOutcomes: unknown[] = [];
    const client = pairForPermission("approve", { permissionOutcomes });
    await runOnePrompt(client);
    expect(permissionOutcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "approve_for_session" } },
    ]);
    await client.dispose();
  });
});

describe("buildKimiChildEnv", () => {
  // Structural limit, asserted so it cannot regress silently: kimi runs as ONE
  // shared ACP process for every kimi-backed session (lazy-spawned on first
  // use), so there is no per-session process to inject a per-session identity
  // into. The correct behaviour is therefore to fail *honestly unattested*
  // rather than leak whatever identity the SuperMatrix parent process happens
  // to carry — a kimi session inheriting the parent's SM_SESSION_NAME would be
  // silently MISattributed, which is the exact failure this work exists to stop.
  test("strips per-session identity vars inherited from the SuperMatrix process", () => {
    const env = buildKimiChildEnv({
      PATH: "/usr/bin",
      SM_SESSION_NAME: "supermatrix-root",
      SM_CALLER_ATTESTATION: "smca_leaked",
      SM_RUNTIME_ROOT: "/runtime",
    });

    expect(env["SM_SESSION_NAME"]).toBeUndefined();
    expect(env["SM_CALLER_ATTESTATION"]).toBeUndefined();
    // Everything else is passed through untouched.
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["SM_RUNTIME_ROOT"]).toBe("/runtime");
  });

  test("does not mutate the source env", () => {
    const source = { SM_SESSION_NAME: "supermatrix-root" };
    buildKimiChildEnv(source);
    expect(source.SM_SESSION_NAME).toBe("supermatrix-root");
  });

  // The card-ask askserver is ACP-injected and cannot carry a per-server
  // toolTimeoutMs, so MCP tool calls fall back to kimi's built-in default
  // (≈60s) — human clicks arriving later were lost with MCP error -32001
  // (2026-08-07). The child env must push the process-wide default past the
  // broker's 300s click window, while respecting an explicit operator value.
  test("defaults KIMI_MCP_TOOL_TIMEOUT_MS past the card-ask broker window; operator setting wins", () => {
    expect(buildKimiChildEnv({ PATH: "/usr/bin" })["KIMI_MCP_TOOL_TIMEOUT_MS"]).toBe("330000");
    expect(
      buildKimiChildEnv({ KIMI_MCP_TOOL_TIMEOUT_MS: "120000" })["KIMI_MCP_TOOL_TIMEOUT_MS"],
    ).toBe("120000");
  });
});
