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

import { AgentSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";
import { Readable, Writable } from "node:stream";

export type FakeScenario = "happy" | "tool" | "cancel" | "error";

export function runFakeAcpServer(opts: {
  scenario: FakeScenario;
  // These are from the CLIENT's perspective:
  // - clientToServer: client writes here, server reads from here
  // - serverToClient: server writes here, client reads from here
  clientToServer: Readable; // server reads from this (server's stdin)
  serverToClient: Writable; // server writes to this (server's stdout)
}): { close: () => void } {
  // ndJsonStream(output, input):
  //   output = where to write outgoing messages (server's stdout → serverToClient)
  //   input  = where to read incoming messages  (server's stdin  ← clientToServer)
  const webOutput = Writable.toWeb(opts.serverToClient);
  const webInput = Readable.toWeb(opts.clientToServer);
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
        return { sessionId: "fake-acp-sid-001" };
      },

      async loadSession(_params) {
        return {};
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

        return { stopReason: "end_turn" };
      },

      async cancel(_params) {
        cancelled = true;
      },

      async setSessionMode(_params) {
        return {};
      },

      async setSessionModel(_params) {
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
