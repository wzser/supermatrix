import { describe, expect, test } from "vitest";
import {
  AppServerRpcError,
  createAppServerProtocol,
  type AppServerNotification,
} from "../../../src/adapters/backend-codex/appServerProtocol.ts";

type WrittenMessage = Record<string, unknown>;

function createHarness() {
  const written: WrittenMessage[] = [];
  const notifications: AppServerNotification[] = [];
  const protocol = createAppServerProtocol({
    writeLine: (line) => written.push(JSON.parse(line) as WrittenMessage),
    onNotification: (n) => notifications.push(n),
  });
  return { protocol, written, notifications };
}

describe("createAppServerProtocol", () => {
  test("requests carry jsonrpc 2.0 envelope with incrementing ids", () => {
    const { protocol, written } = createHarness();
    void protocol.initialize({ clientInfo: { name: "supermatrix", version: "0.0.0-test" } });
    void protocol.threadStart({ cwd: "/tmp" });
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(written[1]).toMatchObject({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp" } });
  });

  test("initialized is a notification: no id on the wire", () => {
    const { protocol, written } = createHarness();
    protocol.initialized();
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({ jsonrpc: "2.0", method: "initialized" });
    expect("id" in written[0]!).toBe(false);
  });

  test("responses correlate by id, not arrival order", async () => {
    const { protocol } = createHarness();
    const threadP = protocol.threadStart({});
    const turnP = protocol.turnStart({ threadId: "t1", input: [{ type: "text", text: "hi" }] });
    // Respond to the SECOND request (id 2) first.
    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { turnId: "turn-9" } }));
    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { threadId: "thread-7" } }));
    await expect(turnP).resolves.toEqual({ turnId: "turn-9" });
    await expect(threadP).resolves.toEqual({ threadId: "thread-7" });
    expect(protocol.pendingCount()).toBe(0);
  });

  test("notifications interleaved with pending requests reach onNotification", async () => {
    const { protocol, notifications } = createHarness();
    const threadP = protocol.threadStart({});
    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { threadId: "t" } }));
    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { threadId: "t" } }));
    await threadP;
    expect(notifications).toEqual([{ method: "thread/started", params: { threadId: "t" } }]);
  });

  test("JSON-RPC error response rejects with AppServerRpcError carrying code + method", async () => {
    const { protocol } = createHarness();
    const p = protocol.turnSteer({ threadId: "t", expectedTurnId: "turn-1", input: [{ type: "text", text: "x" }] });
    protocol.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "turn already completed" } }),
    );
    await expect(p).rejects.toMatchObject({
      name: "AppServerRpcError",
      code: -32000,
      message: "turn/steer: turn already completed",
    });
    await expect(p).rejects.toBeInstanceOf(AppServerRpcError);
    expect(protocol.pendingCount()).toBe(0);
  });

  test("failAllPending rejects every pending request and poisons later ones", async () => {
    const { protocol } = createHarness();
    const threadP = protocol.threadStart({});
    const turnP = protocol.turnStart({ threadId: "t", input: [] });
    expect(protocol.pendingCount()).toBe(2);
    const boom = new Error("codex app-server closed (exit 3)");
    protocol.failAllPending(boom);
    await expect(threadP).rejects.toThrow("thread/start failed before response: codex app-server closed (exit 3)");
    await expect(turnP).rejects.toThrow("turn/start failed before response");
    expect(protocol.pendingCount()).toBe(0);
    // Later requests reject immediately with the original failure...
    await expect(protocol.turnInterrupt({ threadId: "t" })).rejects.toBe(boom);
    // ...a second failAllPending keeps the first error...
    protocol.failAllPending(new Error("later error"));
    await expect(protocol.turnInterrupt({ threadId: "t" })).rejects.toBe(boom);
    // ...and notifications throw instead of writing into a dead transport.
    expect(() => protocol.initialized()).toThrow(boom);
  });

  test("one transport serves one run: second thread establishment rejects", async () => {
    const { protocol, written } = createHarness();
    void protocol.threadStart({});
    await expect(protocol.threadResume({ threadId: "t-old" })).rejects.toThrow(
      "one app-server transport serves one run",
    );
    await expect(protocol.threadStart({})).rejects.toThrow("one app-server transport serves one run");
    // Only the first establishment reached the wire.
    expect(written.filter((m) => m.method === "thread/start" || m.method === "thread/resume")).toHaveLength(1);
  });

  test("thread/resume counts as the one establishment too", async () => {
    const { protocol } = createHarness();
    void protocol.threadResume({ threadId: "t-1" });
    await expect(protocol.threadStart({})).rejects.toThrow("one app-server transport serves one run");
  });

  test("non-JSON noise, non-object lines, and unknown response ids are ignored", async () => {
    const { protocol } = createHarness();
    const p = protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    protocol.handleLine("not json at all");
    protocol.handleLine("[1,2,3]");
    protocol.handleLine('"just a string"');
    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { stray: true } }));
    protocol.handleLine("");
    // Correlation still works afterwards.
    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "fake" } }));
    await expect(p).resolves.toEqual({ userAgent: "fake" });
  });

  test("server-initiated request gets a method-not-found error reply, not a hang", () => {
    const { protocol, written, notifications } = createHarness();
    protocol.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 41, method: "execCommandApproval", params: { command: "rm" } }),
    );
    expect(notifications).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ jsonrpc: "2.0", id: 41, error: { code: -32601 } });
  });

  test("writeLine failure rejects that request and removes it from the registry", async () => {
    let fail = false;
    const protocol = createAppServerProtocol({
      writeLine: () => {
        if (fail) throw new Error("stdin is closed");
      },
    });
    const okP = protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    fail = true;
    await expect(protocol.turnStart({ threadId: "t", input: [] })).rejects.toThrow("stdin is closed");
    expect(protocol.pendingCount()).toBe(1); // only the initialize survives
    protocol.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    await expect(okP).resolves.toEqual({});
  });
});
