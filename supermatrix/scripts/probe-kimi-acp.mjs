#!/usr/bin/env node
// One-shot ACP roundtrip prober.
// Usage:
//   node scripts/probe-kimi-acp.mjs <scenario>
// Scenarios:
//   init       - initialize + close (smallest possible roundtrip)
//   prompt     - initialize + new session + prompt "say hi" + read updates until end-of-turn
//   resume     - same as prompt, then second prompt with same session id (verify resume)
//   cancel     - initialize + new session + prompt long task + cancel mid-flight
//   tool       - initialize + new session + prompt that triggers a tool use
//
// Logs ALL JSON-RPC traffic (incoming + outgoing) and ALL session/update notifications
// as one-JSON-per-line on stdout. Stderr is left to kimi.
//
// Each line is wrapped:
//   {"_dir":"out","_type":"req","method":"...","params":{...}}
//   {"_dir":"in","_type":"resp","id":1,"result":{...}}
//   {"_dir":"in","_type":"notif","method":"session/update","params":{...}}
//
// This wrapper makes fixtures parseable WITHOUT pulling in the ACP package:
// the eventTranslator test reads only the `params` of session/update lines.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";

const scenario = process.argv[2] ?? "prompt";
const KIMI = process.env.SM_KIMI_CLI_PATH ?? "kimi";

const child = spawn(KIMI, ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (err) => { console.error("spawn error", err); process.exit(2); });
child.on("exit", (code) => { console.error(`kimi acp exited code=${code}`); });

// Convert Node.js streams to Web Streams API (required by ndJsonStream)
// ndJsonStream(output, input) where output=writable (to child stdin), input=readable (from child stdout)
const webWritable = Writable.toWeb(child.stdin);
const webReadable = Readable.toWeb(child.stdout);
const rawStream = ndJsonStream(webWritable, webReadable);

const conn = new ClientSideConnection(
  (agent) => ({
    async sessionUpdate(params) {
      process.stdout.write(JSON.stringify({ _dir: "in", _type: "notif", method: "session/update", params }) + "\n");
    },
    async requestPermission(params) {
      // Auto-allow whatever kimi asks for in probe mode.
      // ACP RequestPermissionResponse.outcome is { outcome: "selected"|"cancelled", optionId }.
      // (Yes, .outcome.outcome — the spec nests it.)
      process.stdout.write(JSON.stringify({ _dir: "in", _type: "req", method: "session/request_permission", params }) + "\n");
      const opts = params.options ?? [];
      const sessionApprove = opts.find((o) => o.optionId === "approve_for_session");
      const chosen = sessionApprove ?? opts[0];
      return { outcome: { outcome: "selected", optionId: chosen?.optionId ?? "approve_for_session" } };
    },
    async readTextFile() { throw new Error("client does not advertise fs capability in probe"); },
    async writeTextFile() { throw new Error("client does not advertise fs capability in probe"); },
    async createTerminal() { throw new Error("client does not advertise terminal capability in probe"); },
  }),
  rawStream,
);

async function run() {
  const initResp = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
  process.stdout.write(JSON.stringify({ _dir: "in", _type: "init-resp", result: initResp }) + "\n");

  if (scenario === "init") return;

  const newSess = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
  process.stdout.write(JSON.stringify({ _dir: "in", _type: "new-session-resp", result: newSess }) + "\n");

  const prompts = {
    prompt:  [{ type: "text", text: "Reply with: hello world" }],
    resume:  [{ type: "text", text: "Reply with: hello world" }],
    cancel:  [{ type: "text", text: "Write a 200-word essay about the history of unix" }],
    tool:    [{ type: "text", text: "Run 'echo hi' using a shell tool and tell me the output" }],
    // bgturn: start a background task, end the turn immediately, then watch
    // whether the notification-driven autonomous turn emits session/update
    // notifications on the ACP stream (2026-07-22 feasibility probe for
    // surfacing autonomous turns as streaming cards in SuperMatrix).
    bgturn:  [{ type: "text", text: "Use the Bash tool with run_in_background=true to run: sleep 15 && echo BG_MARKER_DONE. Then IMMEDIATELY reply 'started' without waiting for it. Do not poll or wait for the background task." }],
  };
  const blocks = prompts[scenario] ?? prompts.prompt;

  if (scenario === "cancel") {
    const promptP = conn.prompt({ sessionId: newSess.sessionId, prompt: blocks });
    setTimeout(() => {
      conn.cancel({ sessionId: newSess.sessionId }).catch(() => {});
    }, 800);
    try { await promptP; } catch (e) { process.stdout.write(JSON.stringify({ _dir: "in", _type: "prompt-err", err: String(e) }) + "\n"); }
  } else {
    const r1 = await conn.prompt({ sessionId: newSess.sessionId, prompt: blocks });
    process.stdout.write(JSON.stringify({ _dir: "in", _type: "prompt-resp", result: r1 }) + "\n");
  }

  if (scenario === "bgturn") {
    // Turn ended. Keep the connection open past the background task's
    // completion and log everything the CLI sends on its own initiative.
    const WAIT_MS = 45_000;
    process.stdout.write(JSON.stringify({ _dir: "in", _type: "bgturn-wait", waitMs: WAIT_MS }) + "\n");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    process.stdout.write(JSON.stringify({ _dir: "in", _type: "bgturn-wait-end" }) + "\n");
  }

  if (scenario === "resume") {
    const r2 = await conn.prompt({
      sessionId: newSess.sessionId,
      prompt: [{ type: "text", text: "What did I just ask you?" }],
    });
    process.stdout.write(JSON.stringify({ _dir: "in", _type: "prompt-resp-2", result: r2 }) + "\n");
  }
}

run().then(() => { child.kill("SIGTERM"); process.exit(0); })
     .catch((err) => { console.error("probe failed", err); child.kill("SIGTERM"); process.exit(1); });
