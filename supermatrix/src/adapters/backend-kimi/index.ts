// src/adapters/backend-kimi/index.ts
//
// KimiBackend implements AgentBackend, orchestrating AcpClient + eventTranslator.
// One KimiBackend instance holds one AcpClient singleton (shared process).
// All kimi sessions are multiplexed over a single ACP child process via sessionId.

import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import type { SessionId } from "../../domain/ids.ts";
import type { AgentBackend, RunInput } from "../../ports/AgentBackend.ts";
import { AcpClient } from "./acpClient.ts";
import {
  createTranslatorState,
  flushTranslator,
  translateUpdate,
  type TranslatorState,
} from "./eventTranslator.ts";

export type KimiBackendOptions = {
  acpClient?: AcpClient; // for tests
};

export class KimiBackend implements AgentBackend {
  readonly kind = "kimi" as const;
  private acp: AcpClient;
  private loadedAcpSessions = new Set<string>();
  private inflight = new Map<SessionId, { acpSessionId: string; cancel: () => void }>();

  /** H2: per-session mutex so concurrent run() for the same session serializes newSession/loadSession. */
  private sessionLocks = new Map<SessionId, Promise<void>>();

  constructor(opts: KimiBackendOptions = {}) {
    this.acp = opts.acpClient ?? new AcpClient();
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        await self.acp.ensureReady();

        const sessionId = input.session.id;

        // H2: acquire per-session lock for newSession / loadSession.
        while (self.sessionLocks.has(sessionId)) {
          try { await self.sessionLocks.get(sessionId)!; } catch { /* ignore prior failure */ }
        }
        let lockResolve: (() => void) | undefined;
        const lockP = new Promise<void>((r) => { lockResolve = r; });
        self.sessionLocks.set(sessionId, lockP);

        let acpSessionId: string;
        let isNewSession = false;
        try {
          acpSessionId = input.session.backendSessionId ?? "";
          if (!acpSessionId) {
            acpSessionId = await self.acp.newSession({ cwd: input.session.workdir });
            self.loadedAcpSessions.add(acpSessionId);
            isNewSession = true;
          } else if (!self.loadedAcpSessions.has(acpSessionId)) {
            await self.acp.loadSession({
              sessionId: acpSessionId,
              cwd: input.session.workdir,
            });
            self.loadedAcpSessions.add(acpSessionId);
          }
        } finally {
          self.sessionLocks.delete(sessionId);
          lockResolve?.();
        }

        if (isNewSession) {
          yield { kind: "started", backendSessionId: acpSessionId } satisfies AgentEvent;
        }

        const state: TranslatorState = createTranslatorState();
        state.sessionAnnounced = true;

        // Channel updates from acpClient → translator → buffered queue.
        const MAX_QUEUE_SIZE = 2000; // M2: backpressure guard.
        const queue: (AgentEvent | null)[] = [];
        let waiter: ((v: IteratorResult<AgentEvent>) => void) | null = null;
        const push = (e: AgentEvent) => {
          if (waiter) { const w = waiter; waiter = null; w({ value: e, done: false }); }
          else {
            if (queue.length >= MAX_QUEUE_SIZE) {
              // Drop oldest thinking chunk first; otherwise drop oldest event.
              const dropIdx = queue.findIndex((ev) => ev !== null && ev.kind === "thinking");
              if (dropIdx >= 0) queue.splice(dropIdx, 1);
              else queue.shift();
            }
            queue.push(e);
          }
        };

        self.inflight.set(input.session.id, {
          acpSessionId,
          cancel: () => { /* signal handled via acp.cancel */ },
        });

        // M1: build content blocks from prompt + attachments + systemHint.
        const blocks = self.buildContentBlocks(input);

        const promptDone = self.acp.prompt({
          sessionId: acpSessionId,
          blocks,
          onUpdate: (u) => {
            for (const e of translateUpdate(u, state)) push(e);
          },
        });

        // M4: respect maxRuntimeS (default 10 minutes if unset).
        const maxRuntimeMs = input.session.maxRuntimeS ? input.session.maxRuntimeS * 1000 : 600_000;
        const timeoutHandle = setTimeout(() => {
          self.acp.cancel(acpSessionId).catch(() => {});
        }, maxRuntimeMs);

        // Drain via async generator pattern.
        const flushAndFinish = async () => {
          try {
            const r = await promptDone;
            for (const e of flushTranslator(state, r.stopReason ?? "end_turn")) push(e);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            push({ kind: "error", message, recoverable: false });
          } finally {
            clearTimeout(timeoutHandle);
            self.inflight.delete(input.session.id);
            if (waiter) {
              const w = waiter;
              waiter = null;
              w({ value: undefined as unknown as AgentEvent, done: true });
            } else {
              queue.push(null); // sentinel
            }
          }
        };
        void flushAndFinish();

        while (true) {
          const e = queue.shift();
          if (e === null) break;             // sentinel: stream done
          if (e !== undefined) { yield e; continue; }
          // queue was empty — suspend until push() or sentinel arrives
          const next = await new Promise<IteratorResult<AgentEvent>>((r) => { waiter = r; });
          if (next.done) break;
          yield next.value;
        }
      },
    };
  }

  /** M1: construct ACP content blocks from RunInput fields. */
  private buildContentBlocks(input: RunInput): Array<{ type: "text"; text: string }> {
    const blocks: Array<{ type: "text"; text: string }> = [];

    // systemHint is not yet mapped to an ACP system-message block because
    // the ACP schema for system blocks is not confirmed.  We prepend it as
    // a text block for now so the hint is not silently lost.
    if (input.systemHint) {
      blocks.push({ type: "text", text: `[System] ${input.systemHint}\n\n` });
    }

    // Attachments: ACP block types for image/file are not yet confirmed,
    // so we describe them inline.  When ACP schema is verified, switch to
    // native { type: "image", ... } blocks.
    const promptParts: string[] = [input.prompt];
    if (input.attachments && input.attachments.length > 0) {
      promptParts.push("\n\n[Attachments]");
      for (const att of input.attachments) {
        promptParts.push(`- ${att.kind}: ${att.originalName} (${att.localPath})`);
      }
    }
    blocks.push({ type: "text", text: promptParts.join("\n") });

    // answerOnly is recorded as a no-op for now.  ACP does not expose a
    // read-only execution flag, so we rely on the dispatcher-level guard
    // (answerOnly skips attachments and wraps the prompt for external sessions).
    if (input.answerOnly) {
      // Intentional no-op: the restriction is enforced upstream in dispatcher.
    }

    return blocks;
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const inflight = this.inflight.get(sessionId);
    if (!inflight) return;
    inflight.cancel();
    await this.acp.cancel(inflight.acpSessionId);
  }

  getAcpPid(): number | null {
    return this.acp.getPid();
  }

  async dispose(): Promise<void> {
    await this.acp.dispose();
    this.loadedAcpSessions.clear();
    this.sessionLocks.clear();
  }
}
