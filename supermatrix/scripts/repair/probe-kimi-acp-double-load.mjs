#!/usr/bin/env node
// scripts/repair/probe-kimi-acp-double-load.mjs
//
// Repro for the 2026-07-22 doubled-chunk incident (mr_ada1a0f3):
// session/load wraps the SAME cached SDK Session in a NEW AcpSession each
// time, and the SM-PATCH v1 ctor installed one autonomous-turn forwarder per
// AcpSession — after N loads, every content chunk is emitted N times
// (N-1 stale forwarders with acpPromptTurnActive=false + the native
// runTurnBody path).
//
// Probe: newSession → prompt#1 (baseline chunk count) → loadSession(same id)
// → prompt#2 (identical text). Pre-fix: prompt#2 emits ~2x the chunks.
// Post-fix (SM-PATCH v2): prompt#2 emits ~1x.
//
// Usage: SM_KIMI_CLI_PATH=/path/to/kimi node scripts/repair/probe-kimi-acp-double-load.mjs
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";

const KIMI = process.env.SM_KIMI_CLI_PATH ?? "kimi";
const child = spawn(KIMI, ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

let counting = false;
let chunkCount = 0;
let chunkText = "";

const conn = new ClientSideConnection(
  () => ({
    async sessionUpdate(params) {
      const u = params.update;
      if (counting && u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        chunkCount += 1;
        chunkText += u.content.text;
      }
    },
    async requestPermission(params) {
      const opts = params.options ?? [];
      const chosen = opts.find((o) => o.optionId === "approve_for_session") ?? opts[0];
      return { outcome: { outcome: "selected", optionId: chosen?.optionId ?? "approve" } };
    },
    async readTextFile() { throw new Error("no fs"); },
    async writeTextFile() { throw new Error("no fs"); },
    async createTerminal() { throw new Error("no terminal"); },
  }),
  stream,
);

async function promptAndCount(sessionId) {
  chunkCount = 0;
  chunkText = "";
  counting = true;
  try {
    await conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Reply with exactly this token and nothing else: DUPMARK" }],
    });
  } finally {
    counting = false;
  }
  return { chunks: chunkCount, marks: (chunkText.match(/DUPMARK/g) ?? []).length, text: chunkText };
}

await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
console.log("session:", sessionId);

const p1 = await promptAndCount(sessionId);
console.log("prompt#1 (1 AcpSession):", JSON.stringify({ chunks: p1.chunks, marks: p1.marks }));

await conn.loadSession({ sessionId, cwd: "/tmp", mcpServers: [] });
console.log("loadSession done (now 2 AcpSessions wrapping one SDK session)");

const p2 = await promptAndCount(sessionId);
console.log("prompt#2 (2 AcpSessions):", JSON.stringify({ chunks: p2.chunks, marks: p2.marks }));

const ratio = p1.chunks > 0 ? p2.chunks / p1.chunks : 0;
console.log(`RESULT chunks ratio p2/p1 = ${ratio.toFixed(2)} | DUPMARK occurrences p1=${p1.marks} p2=${p2.marks}`);
console.log(p2.marks >= 2 * Math.max(p1.marks, 1) || ratio > 1.5
  ? "VERDICT: DOUBLED (v1 leak present)"
  : "VERDICT: CLEAN (single emission)");

child.kill("SIGTERM");
process.exit(0);
