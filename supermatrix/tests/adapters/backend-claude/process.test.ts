import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import { spawnAndStream } from "../../../src/adapters/backend-claude/process.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeClaude.sh");
const NODE = process.execPath;

async function collectAll(handle: Awaited<ReturnType<typeof spawnAndStream>>): Promise<{ events: AgentEvent[]; done: true }> {
  const events: AgentEvent[] = [];
  for await (const e of handle.iterable) {
    events.push(e);
  }
  return { events, done: true };
}

function userEnvelope(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n";
}

type SettleState = { resolved: number; rejected: number; error: unknown };

function trackSettle(p: Promise<unknown>): SettleState {
  const state: SettleState = { resolved: 0, rejected: 0, error: undefined };
  p.then(
    () => { state.resolved += 1; },
    (err) => { state.rejected += 1; state.error = err; },
  );
  return state;
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// Fake claude that mirrors --replay-user-messages: every stdin user envelope is
// echoed back as a {"type":"user"} line. A text containing FINISH ends the turn.
const ECHO_REPLAY_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-steer" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  process.stdout.write(JSON.stringify({ type: "user", message: msg.message, session_id: "bks-steer" }) + "\\n");
  const text = (Array.isArray(msg.message.content) ? msg.message.content : [])
    .filter((b) => b && b.type === "text").map((b) => b.text).join("");
  if (text.includes("FINISH")) {
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "done:" + text }) + "\\n", () => process.exit(0));
  }
});
`;

// Reads stdin but never replays anything; emits the result once the second
// line (the injected message) has provably been received.
const WRITE_SINK_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-sink" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
rl.on("line", () => {
  n += 1;
  if (n === 2) {
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "received:" + n }) + "\\n");
    process.exit(0);
  }
});
`;

// Replays only the FIRST stdin envelope, then ends the turn on the second.
const REPLAY_INITIAL_ONLY_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-init" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (line) => {
  n += 1;
  if (n === 1) {
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({ type: "user", message: msg.message, session_id: "bks-init" }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ended" }) + "\\n");
  process.exit(0);
});
`;

// Replays every stdin envelope EXCEPT the first — models a CLI whose
// --replay-user-messages only covers mid-turn injections, not the initial
// prompt. The head-slot placeholder must tolerate this contract too.
const REPLAY_STEER_ONLY_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-steer-only" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (line) => {
  n += 1;
  if (n === 1) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  process.stdout.write(JSON.stringify({ type: "user", message: msg.message, session_id: "bks-steer-only" }) + "\\n");
  const text = (Array.isArray(msg.message.content) ? msg.message.content : [])
    .filter((b) => b && b.type === "text").map((b) => b.text).join("");
  if (text.includes("FINISH")) {
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "done:" + text }) + "\\n", () => process.exit(0));
  }
});
`;

// Models the Claude CLI shape captured with --mcp-config on 2.1.222: an empty
// successful result can arrive before the run has stopped accepting stdin;
// the later user replay is the only valid steer acknowledgement.
const EMPTY_RESULT_THEN_REPLAY_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-empty-result" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (line) => {
  n += 1;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (n === 1) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "user", isReplay: true, message: msg.message, session_id: "bks-empty-result" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done:" + n }) + "\\n", () => process.exit(0));
});
`;

const EMPTY_RESULT_AND_EXIT_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-empty-final" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" }) + "\\n", () => process.exit(0));
`;

const END_INPUT_AFTER_RESULT_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-end-input" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const text = (Array.isArray(msg.message.content) ? msg.message.content : [])
    .filter((b) => b && b.type === "text").map((b) => b.text).join("");
  if (!text.includes("FINISH")) return;
  process.stdout.write(JSON.stringify({ type: "user", message: msg.message, session_id: "bks-end-input" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "finished" }) + "\\n");
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "stdin_closed" }) + "\\n", () => process.exit(0));
});
`;

// Does not read stdin for 400ms so the pipe fills up (backpressure), then
// behaves like ECHO_REPLAY_SCRIPT.
const SLOW_READER_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-slow" }) + "\\n");
setTimeout(() => {
  const rl = require("node:readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    process.stdout.write(JSON.stringify({ type: "user", message: msg.message, session_id: "bks-slow" }) + "\\n");
    const text = (Array.isArray(msg.message.content) ? msg.message.content : [])
      .filter((b) => b && b.type === "text").map((b) => b.text).join("");
    if (text.includes("FINISH")) {
      // exit only after the (possibly huge) queued replays have flushed
      process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "done:" + text }) + "\\n", () => process.exit(0));
    }
  });
}, 400);
`;

// Closes its stdin immediately so parent-side writes hit EPIPE; stays alive
// long enough to emit a result afterwards.
const STDIN_CLOSER_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-closer" }) + "\\n");
process.stdin.destroy();
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "closer-done" }) + "\\n");
  process.exit(0);
}, 800);
`;

const NEVER_EXIT_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-hang" }) + "\\n");
setInterval(() => {}, 1000);
`;

const EXIT_NO_RESULT_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-dead" }) + "\\n");
setTimeout(() => process.exit(1), 250);
`;

describe("spawnAndStream steer / replay acknowledgement", () => {
  test("an empty intermediate result does not close the steer window", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", EMPTY_RESULT_THEN_REPLAY_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    await expect(handle.steer("injected")).resolves.toBeUndefined();
    const { events } = await eventsP;
    expect(events).toContainEqual({ kind: "completed", finalMessage: "done:2" });
    expect(events).not.toContainEqual({ kind: "completed", finalMessage: "" });
  }, 10_000);

  test("an empty final result fails closed instead of emitting completed", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", EMPTY_RESULT_AND_EXIT_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const { events } = await collectAll(handle);
    expect(events.filter((event) => event.kind === "completed")).toEqual([]);
    expect(events.some((event) => event.kind === "error" && event.message.includes("empty completion"))).toBe(true);
  }, 10_000);

  test("a non-empty terminal result still closes stdin", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", END_INPUT_AFTER_RESULT_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    await handle.steer("FINISH");
    const { events } = await eventsP;
    expect(events).toContainEqual({ kind: "completed", finalMessage: "finished" });
  }, 10_000);

  test("steer resolves only after the matching replayed user envelope returns", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", ECHO_REPLAY_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("hello"),
    });
    const eventsP = collectAll(handle);
    await handle.steer("injected note");
    await handle.steer("FINISH");
    const { events } = await eventsP;
    expect(events.some((e) => e.kind === "completed" && e.finalMessage === "done:FINISH")).toBe(true);
    // Replayed user envelopes must not leak into the event stream.
    expect(events.filter((e) => e.kind === "tool_call" || e.kind === "tool_result")).toEqual([]);
    expect(events.filter((e) => e.kind === "started")).toHaveLength(1);
  }, 10_000);

  test("a successful stdin write alone never resolves a steer", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", WRITE_SINK_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("first"),
    });
    const eventsP = collectAll(handle);
    const state = trackSettle(handle.steer("injected"));
    const { events } = await eventsP;
    // The child proved it RECEIVED the injected line (result only fires on line 2)…
    expect(events.some((e) => e.kind === "completed" && e.finalMessage === "received:2")).toBe(true);
    await tick();
    // …yet without a replay acknowledgement the steer must reject, exactly once.
    expect(state.resolved).toBe(0);
    expect(state.rejected).toBe(1);
  }, 10_000);

  test("duplicate steer texts acknowledge FIFO", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", ECHO_REPLAY_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    const order: string[] = [];
    const p1 = handle.steer("again").then(() => order.push("first"));
    const p2 = handle.steer("again").then(() => order.push("second"));
    await Promise.all([p1, p2]);
    expect(order).toEqual(["first", "second"]);
    await handle.steer("FINISH");
    await eventsP;
  }, 10_000);

  test("the initial prompt replay does not acknowledge a steer with identical text", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", REPLAY_INITIAL_ONLY_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("same"),
    });
    const eventsP = collectAll(handle);
    const state = trackSettle(handle.steer("same"));
    const { events } = await eventsP;
    expect(events.some((e) => e.kind === "completed")).toBe(true);
    await tick();
    // The replay that came back was the FIRST envelope's echo; the steer's own
    // replay never arrived, so it must reject even though the text matches.
    expect(state.resolved).toBe(0);
    expect(state.rejected).toBe(1);
  }, 10_000);

  test("steer is acknowledged even when the CLI does not replay the initial prompt", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", REPLAY_STEER_ONLY_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    // Under this contract the initial-prompt placeholder never gets its echo;
    // steer acks must not starve behind it.
    await handle.steer("injected note");
    await handle.steer("FINISH");
    const { events } = await eventsP;
    expect(events.some((e) => e.kind === "completed" && e.finalMessage === "done:FINISH")).toBe(true);
  }, 10_000);

  test("backpressure: a large write waits for drain and preserves FIFO order", async () => {
    const big = "B".repeat(600_000);
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", SLOW_READER_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    const order: string[] = [];
    const p1 = handle.steer(big).then(() => order.push("big"));
    const p2 = handle.steer("FINISH").then(() => order.push("finish"));
    await Promise.all([p1, p2]);
    expect(order).toEqual(["big", "finish"]);
    const { events } = await eventsP;
    expect(events.some((e) => e.kind === "completed" && e.finalMessage === "done:FINISH")).toBe(true);
  }, 15_000);

  test("stdin error rejects the pending steer exactly once", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", STDIN_CLOSER_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    await tick(200);
    const state = trackSettle(handle.steer("late"));
    await eventsP;
    await tick();
    expect(state.resolved).toBe(0);
    expect(state.rejected).toBe(1);
  }, 10_000);

  test("process close without a result rejects the pending steer exactly once", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", EXIT_NO_RESULT_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    const state = trackSettle(handle.steer("pending"));
    await eventsP;
    await tick();
    expect(state.resolved).toBe(0);
    expect(state.rejected).toBe(1);
  }, 10_000);

  test("cancel rejects the pending steer exactly once", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", NEVER_EXIT_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    await tick(100);
    const state = trackSettle(handle.steer("pending"));
    await tick();
    handle.cancel();
    await eventsP;
    await tick();
    expect(state.resolved).toBe(0);
    expect(state.rejected).toBe(1);
    expect(String(state.error)).toContain("cancel");
  }, 10_000);

  test("inactivity timeout rejects the pending steer exactly once", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", NEVER_EXIT_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
      inactivityTimeoutMs: 300,
    });
    const eventsP = collectAll(handle);
    const state = trackSettle(handle.steer("pending"));
    const { events } = await eventsP;
    expect(events.some((e) => e.kind === "error" && e.message.includes("[TIMEOUT]"))).toBe(true);
    await tick();
    expect(state.resolved).toBe(0);
    expect(state.rejected).toBe(1);
    expect(String(state.error)).toContain("TIMEOUT");
  }, 10_000);

  test("spawn error rejects the pending steer exactly once", async () => {
    const handle = spawnAndStream({
      command: "/nonexistent-supermatrix-claude-binary",
      args: [],
      cwd: "/tmp",
      stdin: userEnvelope("start"),
    });
    const eventsP = collectAll(handle);
    const state = trackSettle(handle.steer("pending"));
    await eventsP;
    await tick();
    expect(state.resolved).toBe(0);
    expect(state.rejected).toBe(1);
  }, 10_000);

  test("steer after the turn completed rejects immediately", async () => {
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", ECHO_REPLAY_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("FINISH"),
    });
    await collectAll(handle);
    await expect(handle.steer("late")).rejects.toThrow();
  }, 10_000);

  test("steer without a stdin pipe rejects", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["slow"], cwd: "/tmp" });
    await expect(handle.steer("x")).rejects.toThrow(/stdin/u);
    handle.cancel();
    await collectAll(handle);
  }, 10_000);
});

describe("spawnAndStream", () => {
  test("happy path yields started + completed", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["happy"], cwd: "/tmp" });
    const { events } = await collectAll(handle);
    expect(events[0]?.kind).toBe("started");
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  });

  test("writes provided stdin to the subprocess", async () => {
    const handle = spawnAndStream({
      command: "/bin/sh",
      args: [
        "-c",
        "if IFS= read -r line && [ \"$line\" = expected ]; then printf '%s\\n' '{\"type\":\"system\",\"session_id\":\"s\"}' '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"stdin-ok\",\"session_id\":\"s\"}'; else exit 7; fi",
      ],
      cwd: "/tmp",
      stdin: "expected\n",
    });
    const { events } = await collectAll(handle);

    expect(events.some((e) => e.kind === "completed" && e.finalMessage === "stdin-ok")).toBe(true);
  });

  test("cancel terminates a slow process", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["slow"], cwd: "/tmp" });
    const events: AgentEvent[] = [];
    const collectP = (async () => {
      for await (const e of handle.iterable) {
        events.push(e);
      }
    })();
    // Cancel after 100ms
    await new Promise((r) => setTimeout(r, 100));
    handle.cancel();
    await collectP;
    // After cancel, the stream should end; should have at least started event
    expect(events.some((e) => e.kind === "error" || e.kind === "started")).toBe(true);
  }, 10_000);

  test("keeps stdin open after the initial write so the child can be steered later", async () => {
    // The child only produces its result after receiving a SECOND stdin line,
    // which is impossible if the initial write already closed stdin.
    const handle = spawnAndStream({
      command: NODE,
      args: ["-e", WRITE_SINK_SCRIPT],
      cwd: "/tmp",
      stdin: userEnvelope("first"),
    });
    const eventsP = collectAll(handle);
    handle.steer("second").catch(() => { /* rejection is asserted elsewhere */ });
    const { events } = await eventsP;
    expect(events.some((e) => e.kind === "completed" && e.finalMessage === "received:2")).toBe(true);
  }, 10_000);

  test("SIGKILL fallback if SIGTERM is ignored", async () => {
    const handle = spawnAndStream({
      command: FAKE,
      args: ["ignore-sigterm"],
      cwd: "/tmp",
      killGraceMs: 500,
    });
    // Collect events in background, cancel after 100ms
    const events: AgentEvent[] = [];
    const collectP = (async () => {
      for await (const e of handle.iterable) {
        events.push(e);
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    handle.cancel();
    await collectP;
    // Should have received an error event (cancelled by user)
    expect(events.some((e) => e.kind === "error")).toBe(true);
  }, 10_000);
});
