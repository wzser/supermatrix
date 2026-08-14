// tests/adapters/backend-kimi/fakeAcpServer.ts
//
// In-process ACP server mock using AgentSideConnection.
// Used by acpClient.test.ts — no real kimi binary is spawned.
//
// Stream wiring for tests:
//   Client writes  → clientToServer (PassThrough) → server reads  (server stdin)
//   Server writes  → serverToClient (PassThrough) → client reads  (client stdout)
//
// ndJsonStream(output, input):
//   - output = WritableStream (where to send encoded messages)
//   - input  = ReadableStream (where to receive encoded messages)
//
// For the SERVER side:
//   output = Writable.toWeb(serverToClient)  — server sends → client reads
//   input  = Readable.toWeb(clientToServer)  — client sends → server receives

import { AgentSideConnection, ndJsonStream, type LoadSessionResponse } from "@zed-industries/agent-client-protocol";
import { PassThrough, Readable, Writable } from "node:stream";

export type FakeScenario =
  | "happy"
  | "tool"
  | "tool-schema-drift"
  | "cancel"
  | "error"
  | "ask"
  | "approve";

export function runFakeAcpServer(opts: {
  scenario: FakeScenario;
  // These are from the CLIENT's perspective:
  // - clientToServer: client writes here, server reads from here
  // - serverToClient: server writes here, client reads from here
  clientToServer: Readable; // server reads from this (server's stdin)
  serverToClient: Writable; // server writes to this (server's stdout)
  // Records every session/set_model request the server receives.
  setModelCalls?: Array<{ sessionId: string; modelId: string }>;
  // Records every raw session/set_config_option request (kimi-code 0.30.0;
  // unknown to the 0.4.5 lib, so answered by the line tap below).
  setConfigOptionCalls?: Array<{ sessionId: string; configId: string; value: string }>;
  // When true, session/set_config_option answers ACP -32602 like a K2.7 model.
  failSetConfigOption?: boolean;
  // configOptions to return on the session/load response (kimi-code returns
  // the resumed session's current config; the field is beyond the 0.4.5
  // lib's typed shape).
  loadSessionConfigOptions?: Array<Record<string, unknown>>;
  // Records the outcome of each session/request_permission the server issued.
  permissionOutcomes?: unknown[];
}): { close: () => void } {
  // Line tap between the client and AgentSideConnection: raw
  // session/set_config_option requests have no handler in the 0.4.5 lib, so
  // consume and answer them here (mirroring kimi-code 0.30.0, which returns
  // the session's full configOptions); everything else passes through.
  const serverInput = new PassThrough();
  let tapBuf = "";
  const handleRawLine = (line: string): boolean => {
    if (!line.includes('"session/set_config_option"')) return false;
    let msg: {
      id?: unknown;
      method?: string;
      params?: { sessionId?: string; configId?: string; value?: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return false;
    }
    if (msg.method !== "session/set_config_option" || msg.id === undefined) return false;
    const params = msg.params ?? {};
    opts.setConfigOptionCalls?.push({
      sessionId: params.sessionId ?? "",
      configId: params.configId ?? "",
      value: params.value ?? "",
    });
    const body = opts.failSetConfigOption
      ? { error: { code: -32602, message: "Invalid params" } }
      : {
          result: {
            configOptions: [
              { type: "select", id: "model", name: "Model", currentValue: "kimi-code/k3" },
              { type: "select", id: "thinking", name: "Thinking", currentValue: params.value ?? "" },
            ],
          },
        };
    opts.serverToClient.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }) + "\n");
    return true;
  };
  opts.clientToServer.on("data", (chunk: Buffer) => {
    tapBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = tapBuf.indexOf("\n")) >= 0) {
      const line = tapBuf.slice(0, idx);
      tapBuf = tapBuf.slice(idx + 1);
      if (!handleRawLine(line)) serverInput.write(line + "\n");
    }
  });

  // ndJsonStream(output, input):
  //   output = where to write outgoing messages (server's stdout → serverToClient)
  //   input  = where to read incoming messages  (server's stdin  ← tapped clientToServer)
  const webOutput = Writable.toWeb(opts.serverToClient);
  const webInput = Readable.toWeb(serverInput);
  const stream = ndJsonStream(webOutput, webInput);

  let cancelled = false;

  const conn = new AgentSideConnection(
    (clientConn) => ({
      async initialize(_params) {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { audio: false, embeddedContext: true, image: true },
          },
          authMethods: [],
        };
      },

      async newSession(_params) {
        // kimi-code returns configOptions on session/new; the field is beyond
        // the 0.4.5 lib's typed NewSessionResponse, mirror that here.
        return {
          sessionId: "fake-acp-sid-001",
          configOptions: [
            { type: "select", id: "model", name: "Model", currentValue: "kimi-code/kimi-for-coding" },
          ],
        } as { sessionId: string };
      },

      async loadSession(_params) {
        // kimi-code returns configOptions on session/load; the field is beyond
        // the 0.4.5 lib's typed LoadSessionResponse, mirror that here (same
        // assertion idiom as newSession above).
        return {
          ...(opts.loadSessionConfigOptions
            ? { configOptions: opts.loadSessionConfigOptions }
            : {}),
        } as LoadSessionResponse;
      },

      async authenticate(_params) {
        return {};
      },

      async prompt(params) {
        if (opts.scenario === "happy") {
          await clientConn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello " },
            } as any,
          });
          await clientConn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "world" },
            } as any,
          });
          return { stopReason: "end_turn" };
        }

        if (opts.scenario === "cancel") {
          // Poll until cancel fires, then return cancelled stop reason.
          for (let i = 0; i < 100 && !cancelled; i++) {
            await new Promise<void>((r) => setTimeout(r, 50));
          }
          return { stopReason: cancelled ? "cancelled" : "end_turn" };
        }

        if (opts.scenario === "error") {
          throw new Error("synthetic error from fakeAcpServer");
        }

        if (opts.scenario === "tool") {
          await clientConn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc1",
              title: "shell",
              kind: "execute",
              status: "in_progress",
            } as any,
          });
          await clientConn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc1",
              status: "completed",
            } as any,
          });
          await clientConn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "done" },
            } as any,
          });
          return { stopReason: "end_turn" };
        }

        if (opts.scenario === "tool-schema-drift") {
          // Raw kimi-code shape captured in logs/sm-crash.log on 2026-08-04:
          // ACP SDK 0.4.5 expects rawOutput to be a record, while kimi emits a
          // string. Write the wire frame directly so the fixture preserves the
          // incompatible producer shape instead of being constrained by types.
          opts.serverToClient.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "0:tool_schema_drift",
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: "tool output" } }],
                rawOutput: "tool output",
              },
            },
          }) + "\n");
          return { stopReason: "end_turn" };
        }

        if (opts.scenario === "ask" || opts.scenario === "approve") {
          // Mirror kimi-code 0.27.0's real wire shapes (probe:
          // scripts/repair/probe-kimi-askuser.mjs). "ask" is the built-in
          // AskUserQuestion tool; "approve" is an ordinary tool consent.
          const permissionParams =
            opts.scenario === "ask"
              ? {
                  sessionId: params.sessionId,
                  toolCall: {
                    toolCallId: "0:tool_probe",
                    title: "AskUserQuestion",
                    content: [
                      {
                        type: "content",
                        content: { type: "text", text: "测试：选哪个方案？" },
                      },
                    ],
                  },
                  options: [
                    { kind: "allow_once", name: "方案A", optionId: "q0_opt_0" },
                    { kind: "allow_once", name: "方案B", optionId: "q0_opt_1" },
                    { kind: "reject_once", name: "Skip", optionId: "q0_skip" },
                  ],
                }
              : {
                  sessionId: params.sessionId,
                  toolCall: { toolCallId: "tool_bash", title: "Bash" },
                  options: [
                    { kind: "allow_always", name: "Approve for session", optionId: "approve_for_session" },
                    { kind: "allow_once", name: "Approve", optionId: "approve" },
                    { kind: "reject_once", name: "Reject", optionId: "reject" },
                  ],
                };
          const outcome = await clientConn.requestPermission(permissionParams as any);
          opts.permissionOutcomes?.push(outcome);
          return { stopReason: "end_turn" };
        }

        return { stopReason: "end_turn" };
      },

      async cancel(_params) {
        cancelled = true;
      },

      async setSessionMode(_params) {
        return {};
      },

      async setSessionModel(params) {
        opts.setModelCalls?.push({
          sessionId: params.sessionId,
          modelId: (params as { modelId: string }).modelId,
        });
        return {};
      },
    }),
    stream,
  );

  return {
    close: () => {
      // Caller closes streams; conn cleanup is GC'd.
      void conn;
    },
  };
}
