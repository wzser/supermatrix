// src/app/kimiAutonomousTurnStream.ts
//
// Turns a kimi CLI autonomous turn (started by a background-task
// notification, wire `turn.steer`, ACP-invisible) into a standard
// AsyncIterable<AgentEvent> so the normal replier can render it as the
// same streaming card humans see for ordinary conversations. The event
// source is the CLI's own session wire log — the only place autonomous
// turns are observable (verified 2026-07-22, probe `bgturn`).
//
// The same generator also renders background-task execution cards: the
// watcher points `wirePath` at the spawned agent's own wire, switches the
// quiet check to that wire alone (`quietScope: "wire"`), keeps the stream
// alive across the agent wire's task-start `turn.prompt`
// (`endOnTurnPrompt: false`), and ends it when the completion
// notification lands in the main wire (`isComplete`).
//
// Translation: main-wire loop events → AgentEvent
//   content.part(think) → thinking
//   content.part(text)  → assistant_message (final:false)
//   tool.call           → tool_call (name/args/callId)
//   tool.result         → tool_result (name recovered via callId)
//   usage.record        → usage
//
// The stream ends when every wire log of the session has been quiet for
// `quietMs` (subagent wires count — a delegated subagent keeps the episode
// alive while the main wire is silent), or immediately when a new
// turn.prompt / turn.cancel appears (SM took the session back). Only the
// `completed` receipt carries the final text: the last streamed text part,
// or a fallback so the card never ends in MISSING_TERMINAL_EVIDENCE.

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "../domain/events/agentEvent.ts";

export type AutonomousTurnStreamDeps = {
  sessionDir: string;
  backendSessionId: string;
  /** Byte offset of the triggering turn.steer line in agents/main/wire.jsonl. */
  startOffset: number;
  quietMs: number;
  /** Wire poll interval; defaults to 2s (cards update in near-real-time). */
  pollMs?: number | undefined;
  /**
   * Wire file to stream; defaults to agents/main/wire.jsonl (autonomous
   * turns). Background-task cards pass their own agent wire.
   */
  wirePath?: string | undefined;
  /**
   * Quiet-check scope: "session" (default — any agent wire keeps the
   * episode alive) or "wire" (only the streamed wire itself; background
   * tasks, whose siblings may be busy on unrelated work).
   */
  quietScope?: "session" | "wire" | undefined;
  /**
   * Default true: a new turn.prompt ends the stream (SM took the session
   * back). Background-task streams pass false — their agent wire's
   * turn.prompt marks the task start, not a takeover. turn.cancel always
   * ends the stream regardless. A notification-prompt (isWireNotificationPrompt)
   * never ends the stream — since kimi-code 0.33.0 it IS the autonomous
   * turn's own start marker.
   */
  endOnTurnPrompt?: boolean | undefined;
  /**
   * External completion signal, checked every poll. Background-task
   * streams use it to end promptly when the task's completion
   * notification lands in the main wire.
   */
  isComplete?: (() => boolean) | undefined;
};

/**
 * True when a wire line is a turn.prompt whose input is a background-task
 * `<notification>` envelope — since kimi-code 0.33.0 this is how an
 * idle-launched autonomous turn is recorded (previously always turn.steer;
 * 2026-08-07 aftersale-web sess_f6644c1b turns 15/16). Such a prompt is NOT
 * SM taking the session back: the notification launched the turn itself.
 */
export function isWireNotificationPrompt(line: string): boolean {
  return line.includes('"turn.prompt"') && line.includes('"text":"<notification');
}

/** Newest mtime (epoch ms) across all agents/*\/wire.jsonl of a session dir, or null. */
export async function newestWireMtimeMs(sessionDir: string): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(join(sessionDir, "agents"));
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const entry of entries) {
    try {
      const st = await stat(join(sessionDir, "agents", entry, "wire.jsonl"));
      if (st.isFile() && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
    } catch {
      // agent dir without a wire log
    }
  }
  return newest;
}

/** Reads [offset, size) of `path`, returning only complete lines plus the new offset. */
export async function readCompleteLines(
  path: string,
  offset: number,
  size: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const fh = await open(path, "r");
  let chunk: string;
  try {
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    chunk = buf.toString("utf-8");
  } finally {
    await fh.close();
  }
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) return { lines: [], nextOffset: offset };
  const complete = chunk.slice(0, lastNewline + 1);
  return { lines: complete.split("\n"), nextOffset: offset + Buffer.byteLength(complete, "utf-8") };
}

/** First turnId seen at or after `startOffset` in the main wire, or null. */
export async function peekTurnId(sessionDir: string, startOffset: number): Promise<string | null> {
  const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
  let size: number;
  try {
    size = (await stat(wirePath)).size;
  } catch {
    return null;
  }
  if (size <= startOffset) return null;
  const { lines } = await readCompleteLines(wirePath, startOffset, size);
  for (const line of lines) {
    if (!line.includes('"turnId"')) continue;
    try {
      const rec = JSON.parse(line) as { event?: { turnId?: unknown } };
      const turnId = rec.event?.turnId;
      if (typeof turnId === "string" || typeof turnId === "number") return String(turnId);
    } catch {
      // skip malformed line
    }
  }
  return null;
}

type WireLoopEvent = {
  type?: unknown;
  event?: {
    type?: unknown;
    turnId?: unknown;
    toolCallId?: unknown;
    name?: unknown;
    args?: unknown;
    part?: { type?: unknown; think?: unknown; text?: unknown };
    result?: { output?: unknown } | unknown;
  };
  model?: unknown;
  usage?: {
    inputOther?: unknown;
    output?: unknown;
    inputCacheRead?: unknown;
    inputCacheCreation?: unknown;
  };
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Translates one complete wire line into an AgentEvent, or null when not displayable. */
export function translateWireLine(
  line: string,
  nameByCallId: Map<string, string>,
): AgentEvent | null {
  let rec: WireLoopEvent;
  try {
    rec = JSON.parse(line) as WireLoopEvent;
  } catch {
    return null;
  }
  if (rec.type === "usage.record") {
    const u = rec.usage ?? {};
    return {
      kind: "usage",
      model: typeof rec.model === "string" && rec.model ? rec.model : null,
      inputTokens: num(u.inputOther),
      outputTokens: num(u.output),
      cacheReadTokens: num(u.inputCacheRead),
      cacheWriteTokens: num(u.inputCacheCreation),
      reasoningTokens: 0,
      rawUsage: rec,
    };
  }
  if (rec.type !== "context.append_loop_event") return null;
  const ev = rec.event;
  if (!ev) return null;
  if (ev.type === "content.part" && ev.part) {
    if (ev.part.type === "think" && typeof ev.part.think === "string" && ev.part.think) {
      return { kind: "thinking", text: ev.part.think };
    }
    if (ev.part.type === "text" && typeof ev.part.text === "string" && ev.part.text) {
      return { kind: "assistant_message", text: ev.part.text, final: false };
    }
    return null;
  }
  if (ev.type === "tool.call" && typeof ev.name === "string") {
    const callId = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
    if (callId) nameByCallId.set(callId, ev.name);
    return {
      kind: "tool_call",
      name: ev.name,
      args: ev.args ?? null,
      ...(callId ? { callId } : {}),
    };
  }
  if (ev.type === "tool.result") {
    const callId = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
    const result =
      ev.result && typeof ev.result === "object" && "output" in ev.result
        ? (ev.result as { output?: unknown }).output
        : ev.result;
    return {
      kind: "tool_result",
      name: (callId && nameByCallId.get(callId)) ?? "tool",
      result: result ?? null,
      ...(callId ? { callId } : {}),
    };
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* streamAutonomousTurn(
  deps: AutonomousTurnStreamDeps,
): AsyncGenerator<AgentEvent> {
  const wirePath = deps.wirePath ?? join(deps.sessionDir, "agents", "main", "wire.jsonl");
  const pollMs = deps.pollMs ?? 2_000;
  const endOnTurnPrompt = deps.endOnTurnPrompt ?? true;
  const nameByCallId = new Map<string, string>();
  let offset = deps.startOffset;
  let lastText = "";

  yield { kind: "started", backendSessionId: deps.backendSessionId };

  for (;;) {
    if (deps.isComplete?.()) break;
    let size: number;
    try {
      size = (await stat(wirePath)).size;
    } catch {
      break; // wire log vanished — finalize with what we have
    }
    if (size < offset) break; // truncated/rotated mid-episode — stop guessing
    if (size > offset) {
      const { lines, nextOffset } = await readCompleteLines(wirePath, offset, size);
      offset = nextOffset;
      let sessionTakenBack = false;
      for (const line of lines) {
        // SM cancelled this turn, or started a new run — the episode is
        // over. In bg mode a turn.prompt is the task's own start marker.
        if (line.includes('"turn.cancel"')) {
          sessionTakenBack = true;
          break;
        }
        if (endOnTurnPrompt && line.includes('"turn.prompt"') && !isWireNotificationPrompt(line)) {
          sessionTakenBack = true;
          break;
        }
        const ev = translateWireLine(line, nameByCallId);
        if (!ev) continue;
        if (ev.kind === "assistant_message") lastText = ev.text;
        yield ev;
      }
      if (sessionTakenBack) break;
    }
    const mtime = await quietMtimeMs(deps, wirePath);
    if (mtime === null || Date.now() - mtime >= deps.quietMs) break;
    await sleep(pollMs);
  }

  yield {
    kind: "completed",
    finalMessage: lastText.trim() || "（自治工作结束，无文本输出）",
  };
}

/** Newest activity timestamp for the quiet check, per the configured scope. */
async function quietMtimeMs(
  deps: AutonomousTurnStreamDeps,
  wirePath: string,
): Promise<number | null> {
  if (deps.quietScope === "wire") {
    try {
      return (await stat(wirePath)).mtimeMs;
    } catch {
      return null;
    }
  }
  return newestWireMtimeMs(deps.sessionDir);
}
