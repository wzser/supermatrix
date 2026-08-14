// src/adapters/backend-kimi/index.ts
//
// KimiBackend implements AgentBackend, orchestrating AcpClient + eventTranslator.
// One KimiBackend instance holds one AcpClient singleton (shared process).
// All kimi sessions are multiplexed over a single ACP child process via sessionId.

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import type { SessionId } from "../../domain/ids.ts";
import type { AgentBackend, AttachmentRef, RunInput } from "../../ports/AgentBackend.ts";
import { resolveRunExecutionConfig } from "../../ports/RunExecutionConfig.ts";
import { errorMessage } from "../../domain/errorMessage.ts";
import { AcpClient, type AcpClientState } from "./acpClient.ts";
import { KIMI_DEFAULT_MODEL, resolveKimiThinkingLevel } from "../../ports/KimiModelCatalog.ts";
import { isProcessTreeActive, type ProcessActivityProbeResult } from "./processActivity.ts";
import { createKimiUsageTracker, type KimiUsageTracker } from "./usageWire.ts";
import {
  createTranslatorState,
  flushPendingContent,
  flushTranslator,
  translateUpdate,
  type TranslatorState,
} from "./eventTranslator.ts";
import {
  buildCardAskRuntimeConfig,
  buildKimiCardAskMcpServers,
  disableCardAskWhenBrokerUnhealthy,
  probeCardAskBrokerHealth,
  type CardAskHealthCheck,
} from "../card-ask/config.ts";

// Mirrors backend-claude/backend-codex: same default inactivity window so a
// silent-but-stuck turn is killed identically across backends.
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

// When an inactivity window elapses, the watchdog samples the backend
// process tree's CPU and network bytes over this window before declaring
// the turn wedged — silence with ongoing work (subagent, long tool call,
// in-flight LLM streaming) is not a hang. The window must outlast typical
// server-side LLM thinking gaps (~20s observed for k3) so a mid-request
// subagent still shows net byte growth.
const INACTIVITY_PROBE_WINDOW_MS = 30_000;

// The kimi CLI autonomously starts turns when background-task completion
// notifications arrive (turn.steer; turn.prompt with a <notification> input
// since 0.33.0), even between SM runs. A prompt that lands during such a
// turn is rejected with "Cannot launch a new turn while another turn (ID N)
// is active" (2026-07-13 sess_ac7a8e08 twice, 2026-07-22 product-info
// mr_81c81fd7); kimi-code 0.33.0 added a second rejection path with a
// different message, "another turn is already in progress"
// (RequestError.invalidRequest TURN_AGENT_BUSY_CODE, driver not settled —
// 2026-08-07 aftersale-web mr_4d11d4d3 et al. failed in 2s because the
// regex below missed the new text). That foreign turn is usually doing
// real work (finishing background deliverables), so don't cancel it — wait
// for it to settle and retry the prompt. Bounded: a permanently busy
// session still surfaces the original error after ≈5 minutes.
const TURN_ACTIVE_RETRY_DELAY_MS = 10_000;
const TURN_ACTIVE_MAX_RETRIES = 30;

const isTurnActiveError = (err: unknown): boolean => {
  const message = errorMessage(err);
  return (
    /Cannot launch a new turn while another turn/.test(message) ||
    /another turn is already in progress/.test(message)
  );
};

const isDisposedAcpClientError = (err: unknown): boolean =>
  /AcpClient (has been )?disposed/.test(errorMessage(err));

export type KimiBackendOptions = {
  acpClient?: AcpClient; // for tests
  acpClientFactory?: () => AcpClient; // for tests / recovery
  cardAskHealthCheck?: CardAskHealthCheck;
  usageTracker?: KimiUsageTracker; // for tests
  activityProbe?: (pid: number) => Promise<ProcessActivityProbeResult>; // for tests
  turnActiveRetryDelayMs?: number; // for tests
};

export type KimiAcpHealth = {
  pid: number | null;
  state: AcpClientState;
  roundtrip:
    | { ok: true; rttMs: number }
    | { ok: false; error: string };
};

export type KimiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

// Mirrors backend-claude's native-image gate: same size cap and mime set so a
// picture that renders on one backend doesn't silently degrade on another.
const MAX_NATIVE_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function inferImageMediaType(attachment: AttachmentRef): string | undefined {
  const mimeType = attachment.mimeType?.toLowerCase();
  if (mimeType && SUPPORTED_IMAGE_MEDIA_TYPES.has(mimeType)) return mimeType;

  const ext = extname(attachment.originalName || attachment.localPath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

function buildNativeImageBlock(attachment: AttachmentRef): KimiContentBlock | undefined {
  const mediaType = inferImageMediaType(attachment);
  if (!mediaType) return undefined;

  try {
    const stat = statSync(attachment.localPath);
    if (!stat.isFile() || stat.size > MAX_NATIVE_IMAGE_BYTES) return undefined;
    return {
      type: "image",
      mimeType: mediaType,
      data: readFileSync(attachment.localPath).toString("base64"),
    };
  } catch {
    return undefined;
  }
}

export class KimiBackend implements AgentBackend {
  readonly kind = "kimi" as const;
  private acp: AcpClient;
  private readonly acpClientFactory: (() => AcpClient) | null;
  private acpReadyLock: Promise<void> | null = null;
  private appliedMcpConfigFingerprints = new Map<string, string>();
  private inflight = new Map<SessionId, { acpSessionId: string; cancel: () => boolean }>();

  /** H2: per-session mutex so concurrent run() for the same session serializes newSession/loadSession. */
  private sessionLocks = new Map<SessionId, Promise<void>>();

  private readonly cardAskHealthCheck: CardAskHealthCheck;
  private readonly usageTracker: KimiUsageTracker;
  private readonly activityProbe: (pid: number) => Promise<ProcessActivityProbeResult>;
  private readonly turnActiveRetryDelayMs: number;

  constructor(opts: KimiBackendOptions = {}) {
    this.acpClientFactory =
      opts.acpClientFactory ?? (opts.acpClient ? null : () => new AcpClient());
    this.acp = opts.acpClient ?? this.acpClientFactory!();
    this.cardAskHealthCheck = opts.cardAskHealthCheck ?? probeCardAskBrokerHealth;
    this.usageTracker = opts.usageTracker ?? createKimiUsageTracker();
    this.activityProbe =
      opts.activityProbe ?? ((pid) => isProcessTreeActive(pid, INACTIVITY_PROBE_WINDOW_MS));
    this.turnActiveRetryDelayMs = opts.turnActiveRetryDelayMs ?? TURN_ACTIVE_RETRY_DELAY_MS;
  }

  private async ensureAcpReady(): Promise<void> {
    if (this.acpReadyLock) return this.acpReadyLock;
    this.acpReadyLock = this.ensureAcpReadyOnce().finally(() => {
      this.acpReadyLock = null;
    });
    return this.acpReadyLock;
  }

  private async ensureAcpReadyOnce(): Promise<void> {
    try {
      await this.acp.ensureReady();
      return;
    } catch (err) {
      if (!isDisposedAcpClientError(err) || !this.acpClientFactory) throw err;

      const oldAcp = this.acp;
      this.acp = this.acpClientFactory();
      this.appliedMcpConfigFingerprints.clear();
      await oldAcp.dispose().catch(() => {});

      // eslint-disable-next-line no-console
      console.warn("[kimi-acp disposed client recovered; recreated AcpClient]");
      await this.acp.ensureReady();
    }
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        await self.ensureAcpReady();

        const sessionId = input.session.id;

        // H2: acquire per-session lock for newSession / loadSession.
        while (self.sessionLocks.has(sessionId)) {
          try { await self.sessionLocks.get(sessionId)!; } catch { /* ignore prior failure */ }
        }
        let lockResolve: (() => void) | undefined;
        const lockP = new Promise<void>((r) => { lockResolve = r; });
        self.sessionLocks.set(sessionId, lockP);

        // Probe broker health and disable cardAsk if it's down.
        const safeInput = await disableCardAskWhenBrokerUnhealthy(
          input,
          self.cardAskHealthCheck,
        );
        const cardAskConfig = buildCardAskRuntimeConfig(safeInput);
        const mcpServers = cardAskConfig
          ? buildKimiCardAskMcpServers(cardAskConfig)
          : [];
        const mcpConfigFingerprint = JSON.stringify(mcpServers);

        let acpSessionId: string;
        try {
          acpSessionId = safeInput.session.backendSessionId ?? "";
          if (!acpSessionId) {
            acpSessionId = await self.acp.newSession({
              cwd: safeInput.session.workdir,
              mcpServers,
            });
            self.appliedMcpConfigFingerprints.set(acpSessionId, mcpConfigFingerprint);
          } else if (
            self.appliedMcpConfigFingerprints.get(acpSessionId) !== mcpConfigFingerprint
          ) {
            await self.acp.loadSession({
              sessionId: acpSessionId,
              cwd: safeInput.session.workdir,
              mcpServers,
            });
            self.appliedMcpConfigFingerprints.set(acpSessionId, mcpConfigFingerprint);
          }
        } finally {
          self.sessionLocks.delete(sessionId);
          lockResolve?.();
        }

        // Point built-in AskUserQuestion permission requests for this ACP
        // session at the card-ask broker (or clear the route when the gate is
        // off / broker unhealthy), so they become real Feishu cards instead of
        // auto-approved phantom answers. Registered every run because a resumed
        // session must not carry a stale route from a previous gate decision.
        self.acp.setCardAskRoute(
          acpSessionId,
          cardAskConfig
            ? { brokerUrl: cardAskConfig.brokerUrl, chatId: cardAskConfig.chatId }
            : null,
        );

        // Token usage bookkeeping (best-effort): snapshot the kimi session wire
        // log so this turn only counts its own usage.record events. ACP carries
        // no usage notifications — see usageWire.ts.
        await self.usageTracker.beginTurn(acpSessionId).catch(() => {});

        // Emit `started` every turn like claude/codex (each of their CLI
        // invocations re-announces the session), carrying the model that will
        // execute so the Lark card title shows the real model instead of a
        // generic "Kimi". model=null is an explicit "follow the default":
        // actively reset a reused ACP session to Kimi's default K2.7 model
        // instead of skipping set_model — otherwise a prior K3 selection (and
        // its thinking level) silently leaks into this run.
        const execution = safeInput.execution ?? resolveRunExecutionConfig(safeInput.session);
        const effectiveModel = execution.model ?? KIMI_DEFAULT_MODEL;
        yield {
          kind: "started",
          backendSessionId: acpSessionId,
          model: effectiveModel,
        } satisfies AgentEvent;

        // Per-run model selection. Idempotent re-send each turn: set_model is a
        // cheap local RPC and re-applying guards against the shared ACP process
        // having been restarted with different defaults — and against a reused
        // ACP session retaining an earlier explicit model.
        try {
          await self.acp.setSessionModel({
            sessionId: acpSessionId,
            modelId: effectiveModel,
          });
        } catch (err) {
          yield {
            kind: "error",
            message: `kimi session/set_model 失败（model=${effectiveModel}）：${errorMessage(err)}`,
            recoverable: false,
          } satisfies AgentEvent;
          return;
        }

        // Per-run thinking level (kimi-code 0.30.0), applied AFTER set_model
        // and BEFORE the prompt: K3 models hold a native low/high/max level
        // via session/set_config_option, and a null execution effort already
        // resolved to the native default "high" upstream so a reused ACP
        // session cannot retain an earlier override. The level is derived
        // from the ACTUAL effective model just applied — never from a stale
        // ACP configOptions observation — so a K2.7 session (fixed-on) is
        // left untouched instead of being sent a level it would reject. A
        // failed RPC fails the run closed: prompting anyway would execute
        // with the wrong level.
        const thinkingLevel = resolveKimiThinkingLevel(effectiveModel, execution.effort);
        if (thinkingLevel !== null) {
          try {
            await self.acp.setSessionConfigOption({
              sessionId: acpSessionId,
              configId: "thinking",
              value: thinkingLevel,
            });
          } catch (err) {
            yield {
              kind: "error",
              message: `kimi session/set_config_option 失败（thinking=${thinkingLevel}）：${errorMessage(err)}`,
              recoverable: false,
            } satisfies AgentEvent;
            return;
          }
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

        // M4: timeout handling, aligned with backend-claude/backend-codex semantics:
        //   inactivityTimeoutS — 0 disables; null falls back to the 15-minute
        //   default; N fires the watchdog after N seconds without any ACP
        //   update. The watchdog only kills when the backend process tree
        //   shows no work at all — neither CPU advance nor net byte growth
        //   (processActivity.ts) — so silent but busy subagents / tool calls /
        //   in-flight LLM streaming get a fresh window instead of a kill.
        //   maxRuntimeS — null/0 means unlimited; N is an absolute wall-clock cap.
        // Terminal cause is first-wins: a user cancel and the two timeout kills
        // are mutually exclusive. Whichever fires first records terminalCause,
        // clears all timers, and owns the final label ("cancelled by user" vs
        // "[TIMEOUT] …" in flushAndFinish). Mirrors the cancelled/timedOut
        // mutual exclusion in backend-claude/backend-codex process wrappers.
        const inactivityTimeoutMs =
          safeInput.session.inactivityTimeoutS === 0
            ? undefined
            : safeInput.session.inactivityTimeoutS !== null
              ? safeInput.session.inactivityTimeoutS * 1000
              : DEFAULT_INACTIVITY_TIMEOUT_MS;
        const maxRuntimeMs =
          safeInput.session.maxRuntimeS && safeInput.session.maxRuntimeS > 0
            ? safeInput.session.maxRuntimeS * 1000
            : undefined;

        let terminalCause: "user" | "timeout" | null = null;
        let timeoutMessage: string | null = null;
        let maxRuntimeHandle: ReturnType<typeof setTimeout> | undefined;
        let inactivityHandle: ReturnType<typeof setTimeout> | undefined;
        const clearTimers = () => {
          if (maxRuntimeHandle) clearTimeout(maxRuntimeHandle);
          if (inactivityHandle) clearTimeout(inactivityHandle);
        };
        const fireTimeout = (message: string) => {
          if (terminalCause) return; // first-wins: a cause is already recorded
          terminalCause = "timeout";
          timeoutMessage = message;
          clearTimers();
          self.acp.cancel(acpSessionId).catch(() => {});
        };

        self.inflight.set(safeInput.session.id, {
          acpSessionId,
          // Returns true when this cancel claimed the terminal cause (the
          // caller must then cancel the ACP turn); false when a timeout kill
          // already owns it — so the user-cancel path never double-cancels.
          cancel: () => {
            if (terminalCause) return false;
            terminalCause = "user";
            clearTimers();
            return true;
          },
        });

        // M1: build content blocks from prompt + attachments + systemHint.
        const blocks = self.buildContentBlocks(safeInput);

        if (maxRuntimeMs !== undefined) {
          maxRuntimeHandle = setTimeout(() => {
            fireTimeout(`[TIMEOUT] max runtime: exceeded ${Math.round(maxRuntimeMs / 1000)}s`);
          }, maxRuntimeMs);
        }
        const armInactivity = () => {
          if (inactivityTimeoutMs === undefined || terminalCause) return;
          if (inactivityHandle) clearTimeout(inactivityHandle);
          inactivityHandle = setTimeout(() => {
            const firedHandle = inactivityHandle;
            if (terminalCause) return;
            void (async () => {
              // Output silence alone is not proof of a wedged turn: kimi runs
              // subagents and long tool calls in-process, which legitimately
              // produce no ACP updates for many minutes. Only kill when the
              // backend process tree shows no work at all (no CPU advance,
              // no net byte growth).
              const pid = self.acp.getPid();
              if (pid !== null) {
                const activity = await self.activityProbe(pid).catch((err): ProcessActivityProbeResult => ({
                  kind: "unknown",
                  reason: errorMessage(err),
                }));
                if (terminalCause) return;
                if (activity === true) {
                  // Still working silently — start a fresh window. If an ACP
                  // update re-armed during the probe the timer was already
                  // replaced, so nothing more to do.
                  if (inactivityHandle === firedHandle) armInactivity();
                  return;
                }
                if (activity !== false) {
                  // A rejected/timed-out probe is not evidence that the ACP
                  // process tree is idle. Keep the turn alive, record why,
                  // and retry on a fresh inactivity window.
                  // eslint-disable-next-line no-console
                  console.warn("[kimi-acp inactivity probe unknown; re-arming]", {
                    sessionId: safeInput.session.id,
                    acpSessionId,
                    pid,
                    reason: activity.reason,
                  });
                  if (inactivityHandle === firedHandle) armInactivity();
                  return;
                }
                // Probe says idle, but an update arrived during the probe and
                // re-armed the timer — the turn is alive; stay out of its way.
                if (inactivityHandle !== firedHandle) return;
              }
              fireTimeout(`[TIMEOUT] inactivity: no output for ${Math.round(inactivityTimeoutMs / 1000)}s`);
            })();
          }, inactivityTimeoutMs);
        };
        armInactivity();

        const promptDone = (async (): Promise<Awaited<ReturnType<typeof self.acp.prompt>>> => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await self.acp.prompt({
                sessionId: acpSessionId,
                blocks,
                onUpdate: (u) => {
                  armInactivity();
                  for (const e of translateUpdate(u, state)) push(e);
                },
              });
            } catch (err) {
              if (terminalCause || !isTurnActiveError(err) || attempt >= TURN_ACTIVE_MAX_RETRIES) {
                throw err;
              }
              // eslint-disable-next-line no-console
              console.warn("[kimi-acp session busy with an autonomous turn; retrying prompt]", {
                sessionId: safeInput.session.id,
                acpSessionId,
                attempt: attempt + 1,
              });
              await new Promise<void>((r) => setTimeout(r, self.turnActiveRetryDelayMs));
            }
          }
        })();

        // The terminal cause owns the final label regardless of how the ACP
        // turn actually settled: a timeout kill may still resolve as end_turn
        // (or reject), and a user cancel may resolve as end_turn — neither may
        // be reported as a success. Pending thinking / tool calls are flushed
        // first so the terminal paths don't lose the turn's trailing activity.
        const pushByTerminalCause = (): boolean => {
          if (terminalCause === "timeout" && timeoutMessage) {
            for (const e of flushPendingContent(state)) push(e);
            push({ kind: "error", message: timeoutMessage, recoverable: false });
            push({ kind: "completed", finalMessage: "" });
            return true;
          }
          if (terminalCause === "user") {
            for (const e of flushPendingContent(state)) push(e);
            push({ kind: "error", message: "cancelled by user", recoverable: false });
            push({ kind: "completed", finalMessage: "" });
            return true;
          }
          return false;
        };

        // Drain via async generator pattern.
        const flushAndFinish = async () => {
          try {
            const r = await promptDone;
            const stopReason = r.stopReason ?? "end_turn";
            if (!pushByTerminalCause()) {
              for (const e of flushTranslator(state, stopReason)) push(e);
            }
          } catch (err) {
            if (!pushByTerminalCause()) {
              const message = errorMessage(err);
              push({ kind: "error", message, recoverable: false });
            }
          } finally {
            clearTimers();
            // Per-turn token usage from the kimi session wire log (best-effort —
            // ACP carries no usage notifications). Pushed before the sentinel so
            // replier/collector can fold it into the run's token_usage row.
            const turnUsage = await self.usageTracker
              .collectTurnUsage(acpSessionId)
              .catch(() => null);
            if (turnUsage) {
              push({
                kind: "usage",
                model: turnUsage.model,
                inputTokens: turnUsage.inputTokens,
                outputTokens: turnUsage.outputTokens,
                cacheReadTokens: turnUsage.cacheReadTokens,
                cacheWriteTokens: turnUsage.cacheWriteTokens,
                reasoningTokens: 0,
                rawUsage: { source: "kimi-wire", recordCount: turnUsage.recordCount },
              });
            }
            self.inflight.delete(safeInput.session.id);
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
  private buildContentBlocks(input: RunInput): KimiContentBlock[] {
    const blocks: KimiContentBlock[] = [];

    // systemHint is not yet mapped to an ACP system-message block because
    // the ACP schema for system blocks is not confirmed.  We prepend it as
    // a text block for now so the hint is not silently lost.
    if (input.systemHint) {
      blocks.push({ type: "text", text: `[System] ${input.systemHint}\n\n` });
    }

    // Image attachments become native ACP image blocks (promptCapabilities
    // .image verified true on kimi-code 0.26.0). Oversized/unreadable images
    // and non-image files fall back to an inline text description.
    const hintAttachments: AttachmentRef[] = [];
    const imageBlocks: KimiContentBlock[] = [];
    for (const att of input.attachments ?? []) {
      const block = att.kind === "image" ? buildNativeImageBlock(att) : undefined;
      if (block) imageBlocks.push(block);
      else hintAttachments.push(att);
    }
    blocks.push(...imageBlocks);

    const promptParts: string[] = [input.prompt];
    if (hintAttachments.length > 0) {
      promptParts.push("\n\n[Attachments]");
      for (const att of hintAttachments) {
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
    // Only the winner that claims the terminal cause cancels the ACP turn;
    // when a timeout kill already fired, a later user cancel must not
    // double-cancel (and must not overwrite the [TIMEOUT] label).
    const claimed = inflight.cancel();
    if (claimed) await this.acp.cancel(inflight.acpSessionId);
  }

  getAcpPid(): number | null {
    return this.acp.getPid();
  }

  /**
   * Probe this backend's actual shared ACP client without opening a Kimi
   * business session or prompting the model. Used by the loopback health API.
   */
  async probeAcpHealth(): Promise<KimiAcpHealth> {
    try {
      await this.ensureAcpReady();
      const { rttMs } = await this.acp.probeHealth();
      return {
        pid: this.acp.getPid(),
        state: this.acp.getState(),
        roundtrip: { ok: true, rttMs },
      };
    } catch (err) {
      return {
        pid: this.acp.getPid(),
        state: this.acp.getState(),
        roundtrip: { ok: false, error: errorMessage(err) },
      };
    }
  }

  async dispose(): Promise<void> {
    await this.acp.dispose();
    this.appliedMcpConfigFingerprints.clear();
    this.sessionLocks.clear();
  }
}
