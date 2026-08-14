// Probe: what does kimi send in session/request_permission when the model calls
// the built-in AskUserQuestion tool? Run: node /tmp/probe-kimi-askuser.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@zed-industries/agent-client-protocol";

const KIMI = "/Users/LOCAL_USER/.kimi-code/bin/kimi";
const child = spawn(KIMI, ["--skills-dir", "/tmp/probe-empty-skills", "acp"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
);

const permissionLog = [];
const conn = new acp.ClientSideConnection(
  () => ({
    sessionUpdate: async () => {},
    requestPermission: async (params) => {
      permissionLog.push(params);
      console.log("=== REQUEST_PERMISSION PARAMS ===");
      console.log(JSON.stringify(params, null, 2));
      // Answer with the first option so the turn can finish.
      const opt = params.options?.[0];
      return { outcome: { outcome: "selected", optionId: opt?.optionId ?? "approve" } };
    },
    readTextFile: async () => { throw new Error("no fs"); },
    writeTextFile: async () => { throw new Error("no fs"); },
    createTerminal: async () => { throw new Error("no terminal"); },
  }),
  stream,
);

await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
const cwd = mkdtempSync(join(tmpdir(), "kimi-probe-"));
const { sessionId } = await conn.newSession({ cwd, mcpServers: [] });
console.log("session:", sessionId);

const promptText = [
  "Call the AskUserQuestion tool exactly once with TWO questions in one call:",
  "Q1: question '测试：选哪个方案？' header '测试一' options: '方案A'(desc '选A意味着全部重建'), '方案B'(desc '选B意味着只改配置').",
  "Q2: question '测试：通知哪些群？' header '测试二' multi_select=true options: '群一'(desc '通知运维群'), '群二'(desc '通知业务群'), '群三'(desc '通知老板').",
  "After the tool returns, reply with the answers you got in one line.",
  "Do not ask in plain text; use the tool.",
].join(" ");

const resp = await conn.prompt({
  sessionId,
  prompt: [{ type: "text", text: promptText }],
});
console.log("=== PROMPT DONE ===", JSON.stringify(resp));
console.log("permission calls:", permissionLog.length);
child.kill();
process.exit(0);
