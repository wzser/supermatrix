// src/app/kimiAutonomousTurnWatch.ts
//
// Framework-level visibility for kimi CLI *autonomous turns*: turns the
// CLI starts on its own when background-task completion notifications
// arrive (wire `turn.steer`; since kimi-code 0.33.0 an idle-launched turn
// is recorded as `turn.prompt` with a `<notification>` input instead —
// see isWireNotificationPrompt), while no SM run is active. These turns are
// invisible on the ACP stream (verified 2026-07-22 via
// scripts/probe-kimi-acp.mjs `bgturn` on kimi-code 0.27.0), so without
// this watcher a session can be working while SM considers it idle — new
// prompts then race the autonomous turn at the ACP layer and are rejected
// with "Cannot launch a new turn while another turn is active".
//
// While an autonomous turn is active this watcher:
//   - marks the SM session busy, so the dispatcher rejects new prompts
//     with the ⏳ busy notice instead of an ACP-level error (framework
//     perception), and
//   - renders the turn through the standard replier as the same streaming
//     card shape humans see for ordinary conversations — only the title's
//     run slot (`auto-turn-<cliTurnId>` instead of an mr_ id) and the
//     completed header color (violet instead of green) differ (human
//     perception; see kimiAutonomousTurnStream.ts).
// When the turn goes quiet (no writes to any of the session's wire logs
// for `quietMs`) the stream finalizes the card and the session is flipped
// back to idle. A watcher-owned busy is always released conservatively:
// if an SM run appears meanwhile (e.g. via the runOnSession API path,
// which takes busy unconditionally) the watcher yields ownership without
// touching the status.
//
// Data source: the CLI's own session wire logs (same source as
// usageWire.ts). Turn-trigger events (`turn.prompt` / `turn.steer` /
// `turn.cancel`) are read from agents/main/wire.jsonl with an incremental
// offset; the activity check uses the newest mtime across ALL
// agents/*/wire.jsonl so subagent-heavy turns (main wire quiet while a
// delegated subagent works) still count as active. Stale busy flags left
// by a crash are reset by the existing resetBusySessionsOnBoot recovery.
//
// Known bounded false positive: a background notification steered INTO an
// SM turn's final moments leaves `turn.steer` as the last turn event, so
// after that run ends the session looks autonomous-active for up to
// quietMs (+ one spurious card). It self-heals on the next quiet tick.
//
// Background-task execution coverage: the same main-wire scan also picks
// up `Agent` tool results of the shape `task_id: X / status: running /
// agent_id: agent-N` (a run_in_background subagent launch) and renders
// the task's OWN agent wire as a `bg-task-<taskId>` card while it runs.
// The card ends on the task's completion notification (`task:X:completed`
// with source_kind=background_task), with a long quiet floor as safety
// net — background tasks can sit silent in approval waits far longer
// than the ordinary quietMs. The session status is deliberately NOT
// touched: the main agent is genuinely free to chat while a background
// task runs. Task tracking lives at process level (not in WatchState) so
// an SM-run state reseed neither loses the completion signal for a live
// card nor relaunches a card for the same task.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { asMessageRunId, type SessionId } from "../domain/ids.ts";
import type { Session } from "../domain/session.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Logger } from "../ports/Logger.ts";
import type { createReplier } from "./replier.ts";
import { defaultKimiHome, resolveSessionDir } from "../domain/kimiSessionIndex.ts";
import { errorMessage } from "./errorMessage.ts";
import {
  isWireNotificationPrompt,
  newestWireMtimeMs,
  peekTurnId,
  readCompleteLines,
  streamAutonomousTurn,
} from "./kimiAutonomousTurnStream.ts";

export type KimiAutonomousTurnWatchDeps = {
  store: BindingStore;
  replier: Pick<ReturnType<typeof createReplier>, "consume">;
  clock: Clock;
  logger: Logger;
  eventBus?: EventBus | undefined;
  kimiHome?: string | undefined;
  pollMs?: number | undefined;
  quietMs?: number | undefined;
  /** Wire poll interval of the card stream; for tests. */
  streamPollMs?: number | undefined;
};

type TurnTrigger = "prompt" | "steer" | "cancel";

type WatchState = {
  /** Consumed bytes of agents/main/wire.jsonl. */
  offset: number;
  lastTrigger: TurnTrigger | null;
  /** Byte offset of the last turn.steer line (stream start point). */
  lastSteerOffset: number | null;
  /** True while THIS watcher holds the session's busy flag. */
  ownedBusy: boolean;
  /** True while a replier stream task is running for this session. */
  streaming: boolean;
  /** Start offset of the episode currently rendered by that stream. */
  streamingStartOffset: number | null;
  /** A newer episode noticed while the previous stream is still draining. */
  pendingStreamStartOffset: number | null;
};

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_QUIET_MS = 120_000;
// Background tasks can sit silent in approval waits far longer than the
// autonomous-turn quiet window; their cards end primarily on the
// completion notification, with this floor as the quiet safety net.
const BG_QUIET_FLOOR_MS = 15 * 60_000;
// Reseeding reads at most this much of the wire tail — enough to always
// contain the last turn-trigger event, bounded for pathological files.
const SEED_READ_CAP_BYTES = 2 * 1024 * 1024;

type BgTask = {
  agentId: string;
  /** Completion notification for this task has been seen in the main wire. */
  done: boolean;
  /** True while THIS watcher holds a live card stream for the task. */
  streaming: boolean;
};

/** Parses a background-Agent tool.result line into its task identity. */
function parseBgSpawn(line: string): { taskId: string; agentId: string } | null {
  if (!line.includes('"tool.result"') || !line.includes("status: running")) return null;
  let rec: { event?: { type?: unknown; result?: unknown } };
  try {
    rec = JSON.parse(line) as typeof rec;
  } catch {
    return null;
  }
  if (rec.event?.type !== "tool.result") return null;
  const result = rec.event.result;
  const output =
    typeof result === "string"
      ? result
      : result && typeof result === "object" && "output" in result
        ? (result as { output?: unknown }).output
        : undefined;
  if (typeof output !== "string" || !/^status: running$/m.test(output)) return null;
  const taskId = /^task_id: (\S+)$/m.exec(output)?.[1];
  const agentId = /^agent_id: (\S+)$/m.exec(output)?.[1];
  if (!taskId || !agentId) return null;
  return { taskId, agentId };
}

/** Matches a background-task completion notification and returns its task id. */
function parseBgCompletion(line: string): string | null {
  if (!line.includes("background_task")) return null;
  return /task:(agent-[A-Za-z0-9]+):completed/u.exec(line)?.[1] ?? null;
}

/** Last turn-trigger event (and the offset of its line) in complete lines. */
function scanLastTrigger(
  lines: string[],
  baseOffset: number,
): { trigger: TurnTrigger | null; steerOffset: number | null } {
  let trigger: TurnTrigger | null = null;
  let steerOffset: number | null = null;
  let cursor = baseOffset;
  for (const line of lines) {
    const lineStart = cursor;
    cursor += Buffer.byteLength(line + "\n", "utf-8");
    if (!line.includes('"turn.')) continue;
    // kimi-code 0.33.0 records an idle-launched autonomous turn as
    // turn.prompt with a <notification> input instead of turn.steer; treat
    // it as the autonomous trigger (2026-08-07 aftersale-web turns 15/16
    // ran invisible and busy-rejected 5 SM runs).
    if (isWireNotificationPrompt(line)) {
      trigger = "steer";
      steerOffset = lineStart;
    } else if (line.includes('"turn.prompt"')) trigger = "prompt";
    else if (line.includes('"turn.steer"')) {
      trigger = "steer";
      steerOffset = lineStart;
    } else if (line.includes('"turn.cancel"')) trigger = "cancel";
  }
  return { trigger, steerOffset };
}

export function startKimiAutonomousTurnWatch(deps: KimiAutonomousTurnWatchDeps): () => void {
  const kimiHome = deps.kimiHome ?? defaultKimiHome(process.env);
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
  const log = deps.logger.child({ mod: "kimiAutonomousTurnWatch" });
  const states = new Map<string, WatchState>();
  // Background-task tracking lives at process level: WatchState is deleted
  // on every SM-run tick, but a live bg card must keep receiving its
  // completion signal, and a reseed must not relaunch the same task.
  const bgTasksBySession = new Map<string, Map<string, BgTask>>();
  let stopped = false;
  let ticking = false;

  const emit = (sessionId: SessionId, from: "idle" | "busy", to: "idle" | "busy") =>
    deps.eventBus
      ? deps.eventBus.publish({ kind: "session_status_changed", sessionId, from, to })
      : Promise.resolve();

  async function catchUp(
    session: Session,
    sessionDir: string,
    state: WatchState,
    wirePath: string,
    size: number,
  ): Promise<void> {
    if (size < state.offset) {
      // Truncated/rotated — reseed from the tail.
      state.offset = Math.max(0, size - SEED_READ_CAP_BYTES);
      state.lastTrigger = null;
      state.lastSteerOffset = null;
    }
    if (size === state.offset) return;
    const { lines, nextOffset } = await readCompleteLines(wirePath, state.offset, size);
    const { trigger, steerOffset } = scanLastTrigger(lines, state.offset);
    if (trigger) state.lastTrigger = trigger;
    if (trigger && trigger !== "steer") state.pendingStreamStartOffset = null;
    if (steerOffset !== null) state.lastSteerOffset = steerOffset;
    state.offset = nextOffset;
    trackBackgroundTasks(session, sessionDir, lines);
  }

  /** Detects bg-task spawns/completions in freshly read main-wire lines. */
  function trackBackgroundTasks(session: Session, sessionDir: string, lines: string[]): void {
    const spawns: Array<{ taskId: string; agentId: string }> = [];
    const completions: string[] = [];
    for (const line of lines) {
      const spawn = parseBgSpawn(line);
      if (spawn) spawns.push(spawn);
      const completed = parseBgCompletion(line);
      if (completed) completions.push(completed);
    }
    if (spawns.length === 0 && completions.length === 0) return;
    const sessionId = session.id as string;
    let tasks = bgTasksBySession.get(sessionId);
    if (!tasks) {
      tasks = new Map();
      bgTasksBySession.set(sessionId, tasks);
    }
    for (const taskId of completions) {
      const existing = tasks.get(taskId);
      if (existing) {
        if (!existing.done) {
          existing.done = true;
          log.info("background task completion noticed", { sessionId, sessionName: session.name, taskId });
        }
      } else {
        // Completion without a known spawn (process started later) — record
        // it so a future reseed never launches a card for this task.
        tasks.set(taskId, { agentId: "", done: true, streaming: false });
      }
    }
    for (const spawn of spawns) {
      if (tasks.has(spawn.taskId)) continue; // already launched or known done
      const entry: BgTask = {
        agentId: spawn.agentId,
        done: completions.includes(spawn.taskId),
        streaming: false,
      };
      tasks.set(spawn.taskId, entry);
      if (entry.done) continue; // spawn+completion inside one reseed batch
      log.info("background task detected; launching card", {
        sessionId,
        sessionName: session.name,
        taskId: spawn.taskId,
        agentId: spawn.agentId,
      });
      launchBgCard(session, sessionDir, spawn.taskId, entry);
    }
  }

  /**
   * Fire-and-forget: render a background task's own agent wire as a
   * streaming card. Session status is untouched — the main agent stays
   * genuinely free while the task runs.
   */
  function launchBgCard(session: Session, sessionDir: string, taskId: string, entry: BgTask): void {
    if (entry.streaming) return;
    entry.streaming = true;
    void (async () => {
      try {
        const binding = await deps.store.findBySession(session.id);
        if (!binding) {
          log.warn("background task active but session has no bound group; card skipped", {
            sessionId: session.id,
            sessionName: session.name,
            taskId,
          });
          return;
        }
        const branch = await deps.store.getActiveBranch(session.id);
        const wirePath = join(sessionDir, "agents", entry.agentId, "wire.jsonl");
        // Agent wires are resumed across tasks — start at the current end
        // so the card never replays the previous task's history.
        const startOffset = await stat(wirePath).then((st) => st.size).catch(() => 0);
        await deps.replier.consume({
          groupId: binding.groupId,
          sessionId: session.id,
          runId: asMessageRunId(`bg-task-${taskId}`),
          sessionName: session.name,
          branchName: branch.name,
          sessionModel: session.model,
          sessionEffort: session.effort,
          sessionBackend: "kimi",
          // Same non-conversation violet as autonomous-turn cards.
          completedTemplate: "violet",
          stream: streamAutonomousTurn({
            sessionDir,
            backendSessionId: session.backendSessionId!,
            startOffset,
            wirePath,
            quietScope: "wire",
            endOnTurnPrompt: false,
            isComplete: () => entry.done,
            quietMs: Math.max(quietMs, BG_QUIET_FLOOR_MS),
            ...(deps.streamPollMs !== undefined ? { pollMs: deps.streamPollMs } : {}),
          }),
        });
      } catch (err) {
        log.warn("background task stream card failed", {
          sessionId: session.id,
          sessionName: session.name,
          taskId,
          err: errorMessage(err),
        });
      } finally {
        entry.streaming = false;
      }
    })();
  }

  /** Fire-and-forget: render the episode as a standard streaming card. */
  function launchStreamCard(session: Session, sessionDir: string, state: WatchState): void {
    const startOffset = state.lastSteerOffset ?? state.offset;
    if (state.streaming) {
      if (state.streamingStartOffset !== startOffset) {
        state.pendingStreamStartOffset = startOffset;
      }
      return; // one card per continuous episode
    }
    state.pendingStreamStartOffset = null;
    state.streaming = true;
    state.streamingStartOffset = startOffset;
    void (async () => {
      try {
        const binding = await deps.store.findBySession(session.id);
        if (!binding) {
          log.warn("autonomous turn active but session has no bound group; card skipped", {
            sessionId: session.id,
            sessionName: session.name,
          });
          return;
        }
        const branch = await deps.store.getActiveBranch(session.id);
        const turnId = await peekTurnId(sessionDir, startOffset);
        await deps.replier.consume({
          groupId: binding.groupId,
          sessionId: session.id,
          runId: asMessageRunId(`auto-turn-${turnId ?? "?"}`),
          sessionName: session.name,
          branchName: branch.name,
          sessionModel: session.model,
          sessionEffort: session.effort,
          sessionBackend: "kimi",
          // Autonomous turns recolor their completed card violet so they are
          // distinguishable at a glance from ordinary conversation runs.
          completedTemplate: "violet",
          stream: streamAutonomousTurn({
            sessionDir,
            backendSessionId: session.backendSessionId!,
            startOffset,
            quietMs,
            ...(deps.streamPollMs !== undefined ? { pollMs: deps.streamPollMs } : {}),
          }),
        });
      } catch (err) {
        log.warn("autonomous turn stream card failed", {
          sessionId: session.id,
          sessionName: session.name,
          err: errorMessage(err),
        });
      } finally {
        state.streaming = false;
        state.streamingStartOffset = null;
      }
    })();
  }

  async function watchSession(session: Session): Promise<void> {
    const id = session.id as string;
    // An SM run owns the session. Yield any watcher-owned busy WITHOUT
    // touching the status (the run's own lifecycle manages it), and force
    // a reseed once the session is free again.
    if (await deps.store.findRunningMessageRunBySession(session.id)) {
      states.delete(id);
      return;
    }
    if (!session.backendSessionId) return;
    const sessionDir = await resolveSessionDir(kimiHome, session.backendSessionId);
    if (!sessionDir) return;
    const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
    let size: number;
    try {
      size = (await stat(wirePath)).size;
    } catch {
      return;
    }

    let state = states.get(id);
    if (!state) {
      state = {
        offset: 0,
        lastTrigger: null,
        lastSteerOffset: null,
        ownedBusy: false,
        streaming: false,
        streamingStartOffset: null,
        pendingStreamStartOffset: null,
      };
      states.set(id, state);
    }
    await catchUp(session, sessionDir, state, wirePath, size);

    const mtimeMs = await newestWireMtimeMs(sessionDir);
    const nowMs = deps.clock.now() as number;
    const active =
      state.lastTrigger === "steer" && mtimeMs !== null && nowMs - mtimeMs < quietMs;

    if (active) {
      if (!state.ownedBusy) {
        // Only take busy from a clean idle; any other status belongs to
        // someone else (dispatcher run, error state, stuck flag).
        if (session.status !== "idle") return;
        await deps.store.updateSessionStatus(session.id, "busy", deps.clock.now());
        await emit(session.id, "idle", "busy");
        state.ownedBusy = true;
        log.info("autonomous turn detected; session marked busy", {
          sessionId: id,
          sessionName: session.name,
        });
      }
      // Busy ownership can outlive the previous card stream. Retry the
      // launch on a later tick once that stream has fully drained.
      launchStreamCard(session, sessionDir, state);
      return;
    }

    if (!active && state.ownedBusy) {
      await deps.store.updateSessionStatus(session.id, "idle", deps.clock.now());
      await emit(session.id, "busy", "idle");
      state.ownedBusy = false;
      log.info("autonomous turn quiet; session back to idle", {
        sessionId: id,
        sessionName: session.name,
      });
    }

    // The previous stream may have drained after the episode's quiet tick.
    // If a newer steer was recorded while it was still running, render that
    // episode now instead of losing it with the busy ownership transition.
    if (
      !state.streaming &&
      state.pendingStreamStartOffset !== null &&
      state.lastTrigger === "steer" &&
      state.lastSteerOffset === state.pendingStreamStartOffset
    ) {
      launchStreamCard(session, sessionDir, state);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return; // a slow tick must never overlap the next one
    ticking = true;
    try {
      const sessions = await deps.store.listActiveSessionsByBackend("kimi");
      for (const session of sessions) {
        try {
          await watchSession(session);
        } catch (err) {
          log.warn("watch tick failed for session", {
            sessionId: session.id,
            sessionName: session.name,
            err: errorMessage(err),
          });
        }
      }
    } catch (err) {
      log.error("watch tick failed", { err: errorMessage(err) });
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, pollMs);
  void tick();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
