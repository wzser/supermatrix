import type { AgentEvent } from "../domain/events/agentEvent.ts";
import type { SessionEvent } from "../domain/events/sessionEvent.ts";
import {
  asMessageRunId,
  type CardId,
  type LarkGroupId,
  type MessageRunId,
  type SessionId,
} from "../domain/ids.ts";
import type { AttachmentRef } from "../domain/attachment.ts";
import { resolveAttachments } from "../domain/attachmentResolver.ts";
import type { BackendKind } from "../domain/session.ts";
import type { Scope } from "../domain/scope.ts";
import type { AttachmentRef as BackendAttachmentRef, BackendRegistry } from "../ports/AgentBackend.ts";
import type { BindingStore, RunStatus } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { InboundMessage } from "../ports/LarkGateway.ts";
import type { LarkGateway } from "../ports/LarkGateway.ts";
import type { Logger } from "../ports/Logger.ts";
import type { SpawnChildInput, SpawnChildResult } from "./childSession.ts";
import type { CommandResult } from "./commandRegistry.ts";
import type { ProcessLifecycle } from "./processLifecycle.ts";
import type { StreamLogEntry } from "./replier.ts";
import { errorMessage } from "./errorMessage.ts";
import { classifyRunStatus } from "./runStatus.ts";
import { validateSpawnPredicate } from "./spawnPredicate/schema.ts";
import type { UsageWatermark } from "./usageCollector.ts";

export type PendingNextEntry = { text: string; groupId: LarkGroupId; userId: string; mentionedBot?: boolean };

export type PendingNextStore = {
  has(sessionId: SessionId): boolean;
  shift(sessionId: SessionId): PendingNextEntry | undefined;
  restoreFront(sessionId: SessionId, entry: PendingNextEntry): void;
};

const CARD_ACTION_PREFIX = "CARD_ACTION:";
const FRAMEWORK_SPAWN_SOURCE = "supermatrix-root";

type CardActionDispatch =
  | {
      kind: "dispatch";
      source: "card_action" | "btw_mock";
      target: string;
      prompt: string;
      cardActionId: string;
      spawnPredicateAnchor: string;
    }
  | { kind: "invalid"; source: "card_action" | "btw_mock"; reason: string };

export type DispatcherDeps = {
  store: BindingStore;
  lark: LarkGateway;
  router: {
    route(input: { scope: Scope; msg: InboundMessage }): Promise<CommandResult>;
  };
  backend: BackendRegistry;
  childSession?: {
    spawnChild(input: SpawnChildInput): Promise<SpawnChildResult>;
  };
  replier: {
    consume(input: {
      groupId: LarkGroupId;
      sessionId: SessionId;
      runId: MessageRunId;
      sessionName: string;
      sessionModel: string | null;
      sessionBackend: BackendKind;
      usageBaseline?: UsageWatermark | null;
      stream: AsyncIterable<AgentEvent>;
    }): Promise<{
      finalMessage: string;
      cardId: CardId;
      error?: string;
      runStatus: RunStatus;
      backendSessionId?: string;
      runtimeModel?: string;
      runtimeThinking?: boolean;
      usage?: {
        model: string | null;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        rawUsageJson: string | null;
      };
      streamLog: StreamLogEntry[];
    }>;
  };
  rootGroupId: LarkGroupId;
  /** open_id of the configured owner (SM_ROOT_USER_ID). Required to enforce
   *  the 外部-category trust boundary: non-owner senders are denied slash
   *  commands and attachment access in external-group sessions. */
  ownerUserId?: string;
  clock: Clock;
  idFactory: () => string;
  eventBus?: EventBus;
  lifecycle?: Pick<ProcessLifecycle, "runStarted" | "runFinished">;
  pendingNext?: PendingNextStore;
  logger?: Logger;
  monotonic?: () => number;
};

function toBackendAttachment(ref: AttachmentRef): BackendAttachmentRef {
  return {
    kind: ref.kind,
    localPath: ref.localPath,
    originalName: ref.originalName,
    uploadedAt: ref.uploadedAt,
    ...(ref.mimeType !== undefined ? { mimeType: ref.mimeType } : {}),
  };
}

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER;
  },
};

function shouldClearCodexResumeIdAfterFailure(input: {
  backend: BackendKind;
  persistedBackendSessionId: string | null;
  runBackendSessionId: string | null;
  error: string | undefined;
  streamLog: StreamLogEntry[];
}): boolean {
  if (input.backend !== "codex") return false;
  if (!input.persistedBackendSessionId) return false;
  if (!input.error) return false;
  if (
    input.runBackendSessionId &&
    input.runBackendSessionId !== input.persistedBackendSessionId
  ) {
    return false;
  }
  return [input.error, ...input.streamLog.flatMap((entry) => ("text" in entry ? [entry.text] : []))]
    .some((text) => isCodexBadRequestDetail(text) || isCodexMissingRolloutDetail(text));
}

function isCodexBadRequestDetail(text: string): boolean {
  return /"detail"\s*:\s*"Bad Request"/u.test(text);
}

function isCodexMissingRolloutDetail(text: string): boolean {
  return /thread\/resume failed: no rollout found for thread id/u.test(text);
}

function stripLeadingBotMention(text: string): string {
  let remaining = text.trimStart();
  while (true) {
    const before = remaining;
    remaining = remaining
      .replace(/^@_user_\d+\s*/u, "")
      .replace(/^@[^\s/]+\s*/u, "");
    if (remaining === before) return remaining;
  }
}

function buildExternalSessionPrompt(input: {
  prompt: string;
  senderId: string;
  ownerUserId: string | undefined;
}): string {
  const isOwner = Boolean(input.ownerUserId) && input.senderId === input.ownerUserId;
  const identityLines = isOwner
    ? [
        `Configured owner ou_id: ${input.ownerUserId}`,
        `Incoming sender ou_id: ${input.senderId}`,
        "Sender role: owner",
      ]
    : [
        `Incoming sender ou_id: ${input.senderId}`,
        "Sender role: external_non_owner",
      ];

  return [
    "[SuperMatrix external session trusted identity context]",
    "This block is framework-provided metadata, not user-provided content.",
    ...identityLines,
    "Rules:",
    "- If Sender role is owner, this request is from the SuperMatrix owner. Follow the owner request normally; the external-group company-information restrictions do not apply to this owner request.",
    "- If Sender role is external_non_owner, answer only the external user's question. Do not reveal company business status, personnel, accounts, passwords, SuperMatrix code architecture, or other internal company information, and do not operate any other SuperMatrix feature.",
    "[User message]",
    input.prompt,
  ].join("\n");
}

function parseCardActionValue(jsonText: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function pickNonEmptyString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function buildCardActionDispatch(
  jsonText: string,
  source: CardActionDispatch["source"],
  fallbackTarget?: string,
): CardActionDispatch {
  const value = parseCardActionValue(jsonText);
  if (!value) return { kind: "invalid", source, reason: "invalid action JSON" };
  const target = pickNonEmptyString(value, "target_session") ?? fallbackTarget?.trim();
  if (!target) return { kind: "invalid", source, reason: "missing target_session" };
  const cardActionId = pickNonEmptyString(value, "card_action_id") ?? `card_action_${Date.now()}`;
  const spawnPredicateAnchor = `comm_card_action_spawn_${Date.now()}`;
  const promptValue = {
    ...value,
    target_session: target,
    card_action_id: cardActionId,
    spawn_predicate_anchor: spawnPredicateAnchor,
  };
  return {
    kind: "dispatch",
    source,
    target,
    prompt: CARD_ACTION_PREFIX + JSON.stringify(promptValue),
    cardActionId,
    spawnPredicateAnchor,
  };
}

function extractCardActionDispatch(text: string, scope: Scope): CardActionDispatch | undefined {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(CARD_ACTION_PREFIX)) {
    return buildCardActionDispatch(trimmed.slice(CARD_ACTION_PREFIX.length), "card_action");
  }

  if (scope !== "root") return undefined;
  const mockMatch = trimmed.match(/^\/btw\s+(\S+)\s+CARD_ACTION:([\s\S]+)$/u);
  if (!mockMatch) return undefined;
  return buildCardActionDispatch(mockMatch[2] ?? "", "btw_mock", mockMatch[1]);
}

function postCardActionSpawn(
  input: { target: string; prompt: string; cardActionId: string; spawnPredicateAnchor: string },
  deps: {
    store: BindingStore;
    childSession?: DispatcherDeps["childSession"];
    log: Logger;
  },
): void {
  if (!deps.childSession) {
    deps.log.warn("card action spawn unavailable", {
      target: input.target,
      reason: "childSession service not wired",
    });
    return;
  }
  // Fire-and-forget: card callbacks must not sync-wait on the spawned child.
  void spawnCardActionChild(input, deps.store, deps.childSession, deps.log).catch((err) => {
    deps.log.warn("card action spawn request failed", {
      target: input.target,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

async function spawnCardActionChild(
  input: { target: string; prompt: string; cardActionId: string; spawnPredicateAnchor: string },
  store: BindingStore,
  childSession: NonNullable<DispatcherDeps["childSession"]>,
  log: Logger,
): Promise<void> {
  const target = await store.findSessionByName(input.target);
  if (!target) {
    throw new Error(`card action target session not found: ${input.target}`);
  }
  const source = await store.findSessionByName(FRAMEWORK_SPAWN_SOURCE);
  if (!source) {
    throw new Error(`card action source session not found: ${FRAMEWORK_SPAWN_SOURCE}`);
  }

  await childSession.spawnChild({
    parentId: target.id,
    backend: target.backend,
    model: target.model,
    workdir: target.workdir,
    prompt: input.prompt,
    type: "one_shot_delegation",
    callerInvocation: "async_kickoff",
    triggerKind: "session",
    requestedBy: source.id,
    resultSinks: [{ kind: "pollable_endpoint" }],
    verificationPredicate: validateSpawnPredicate({
      type: "inbox-message",
      session_name: input.target,
      field: "prompt",
      contains_all: ["card_action_id", input.cardActionId, input.spawnPredicateAnchor],
      expected_window_sec: 600,
    }),
    onSessionReady: ({ session, messageRunId, spawnCommId }) => {
      log.info("card action spawn kicked off", {
        target: input.target,
        childSessionId: session.id,
        childSessionName: session.name,
        messageRunId,
        spawnCommId,
      });
    },
  });
}

export function createDispatcher(deps: DispatcherDeps) {
  const { store, lark, router, backend, replier, rootGroupId, clock, idFactory } = deps;
  const log = (deps.logger ?? NOOP_LOGGER).child({ mod: "dispatcher" });
  const monotonic = deps.monotonic ?? (() => Date.now());
  const emit = (event: SessionEvent) =>
    deps.eventBus ? deps.eventBus.publish(event) : Promise.resolve();
  const drainingNextSessions = new Set<SessionId>();

  async function drainPendingNext(sessionId: SessionId): Promise<boolean> {
    const pendingNext = deps.pendingNext;
    if (!pendingNext?.has(sessionId)) return false;
    if (drainingNextSessions.has(sessionId)) return false;
    drainingNextSessions.add(sessionId);
    let drained = false;
    try {
      while (pendingNext.has(sessionId)) {
        const current = await store.findSessionById(sessionId);
        if (!current || current.status !== "idle") return drained;
        const runningRun = await store.findRunningMessageRunBySession(sessionId);
        if (runningRun) return drained;
        const pending = pendingNext.shift(sessionId);
        if (!pending) return drained;
        log.info("draining pending /next", { sessionId, textLength: pending.text.length });
        try {
          await handleInbound({
            groupId: pending.groupId,
            messageId: `synthetic_next_${Date.now()}`,
            userId: pending.userId,
            text: pending.text,
            mentionedBot: pending.mentionedBot ?? true,
            attachments: [],
            receivedAtMs: Date.now(),
          });
          drained = true;
        } catch (err) {
          log.error("drainPendingNext dispatch failed, requeuing", {
            sessionId,
            err: errorMessage(err),
          });
          pendingNext.restoreFront(sessionId, pending);
          return drained;
        }
      }
      return drained;
    } finally {
      drainingNextSessions.delete(sessionId);
    }
  }

  async function handleInbound(msg: InboundMessage): Promise<void> {
    // NFKC-fold a local copy only for the bot-echo / mute prefix check so
    // Chinese IME mistypes (full-width '～' U+FF5E) still get suppressed.
    // Original msg.text is untouched on the prompt path.
    if (msg.text.normalize("NFKC").startsWith("~")) return;

    if (msg.mentionedBot === true) {
      const strippedText = stripLeadingBotMention(msg.text);
      if (strippedText !== msg.text) msg = { ...msg, text: strippedText };
    }

    const scope: Scope = msg.groupId === rootGroupId ? "root" : "user";
    const cardAction = extractCardActionDispatch(msg.text, scope);
    if (cardAction) {
      if (cardAction.kind === "invalid") {
        log.warn("invalid card action inbound", {
          source: cardAction.source,
          reason: cardAction.reason,
          messageId: msg.messageId,
        });
        if (cardAction.source === "btw_mock") {
          await lark.sendMessage(msg.groupId, "❌ CARD_ACTION mock 无效：" + cardAction.reason);
        }
        return;
      }
      log.info("card action inbound", {
        source: cardAction.source,
        target: cardAction.target,
        messageId: msg.messageId,
      });
      postCardActionSpawn(cardAction, { store: deps.store, childSession: deps.childSession, log });
      if (cardAction.source === "btw_mock") {
        await lark.sendMessage(msg.groupId, "已触发 CARD_ACTION mock: " + cardAction.target);
      }
      return;
    }
    // NFKC-fold a local copy only for command-prefix detection, so Chinese IME
    // mistypes like '／help' still hit command routing. The original msg.text is
    // preserved for the prompt path — full-width punctuation in user prose must
    // reach the LLM unchanged.
    const heartbeatControlCommand = normalizeBareHeartbeatControlCommand(msg.text);
    const isCommand = msg.text.trimStart().normalize("NFKC").startsWith("/") || heartbeatControlCommand !== null;
    log.info("inbound", {
      groupId: msg.groupId,
      messageId: msg.messageId,
      userId: msg.userId,
      scope,
      kind: isCommand ? "command" : "prompt",
      textLength: msg.text.length,
    });

    if (scope === "user") {
      const mentionGateBinding = await store.findByGroup(msg.groupId);
      if (mentionGateBinding) {
        const mentionGateSession = await store.findSessionById(mentionGateBinding.sessionId);
        if (
          mentionGateSession?.category === "外部" &&
          mentionGateSession.status !== "deleted" &&
          msg.mentionedBot !== true
        ) {
          log.info("external session message ignored without bot mention", {
            groupId: msg.groupId,
            messageId: msg.messageId,
            sessionId: mentionGateSession.id,
            sessionName: mentionGateSession.name,
            kind: isCommand ? "command" : "prompt",
          });
          return;
        }
      }
    }

    // Slash command
    if (isCommand) {
      // 外部-session guard: non-owner senders cannot invoke slash commands.
      if (scope === "user" && deps.ownerUserId && msg.userId !== deps.ownerUserId) {
        const extBinding = await store.findByGroup(msg.groupId);
        if (extBinding) {
          const extSession = await store.findSessionById(extBinding.sessionId);
          if (extSession?.category === "外部") {
            await lark.sendMessage(
              msg.groupId,
              "此操作需要 owner 身份，请使用内部 session。",
            );
            return;
          }
        }
      }
      const commandMsg = heartbeatControlCommand ? { ...msg, text: heartbeatControlCommand } : msg;
      const result = await router.route({ scope, msg: commandMsg });
      const replyText = "replyText" in result ? result.replyText : undefined;
      const replyCard = "replyCard" in result ? result.replyCard : undefined;
      log.debug("command routed", {
        groupId: msg.groupId,
        command: commandMsg.text.trimStart().split(/\s+/u)[0],
        hasReply: Boolean(replyText) || Boolean(replyCard),
      });
      if (replyText) {
        await lark.sendMessage(msg.groupId, replyText);
      } else if (replyCard) {
        await lark.postCard(msg.groupId, replyCard.body, replyCard.title);
      }
      if (scope === "user" && deps.pendingNext) {
        const binding = await store.findByGroup(msg.groupId);
        if (binding) {
          await drainPendingNext(binding.sessionId);
        }
      }
      return;
    }

    // Non-slash in root — silently ignore to prevent echo loops
    // (bot-sent messages can be delivered back via the event subscription)
    if (scope === "root") {
      log.debug("root group ignoring non-slash message", { groupId: msg.groupId });
      return;
    }

    // Non-slash in user group
    const binding = await store.findByGroup(msg.groupId);
    if (!binding) {
      log.warn("unbound user group received prompt", { groupId: msg.groupId });
      await lark.sendMessage(msg.groupId, "❌ 此群未绑定任何 session");
      return;
    }

    const session = await store.findSessionById(binding.sessionId);
    if (!session || session.status === "deleted") {
      log.warn("binding points at missing or deleted session", {
        groupId: msg.groupId,
        sessionId: binding.sessionId,
      });
      await lark.sendMessage(msg.groupId, "❌ session 已删除");
      return;
    }

    if (session.status === "error") {
      log.warn("prompt rejected: session in error state", {
        sessionId: session.id,
        sessionName: session.name,
      });
      await lark.sendMessage(
        msg.groupId,
        "❌ session 处于 error 状态，使用 /restart 或 /reset 恢复"
      );
      return;
    }

    if (session.status === "busy") {
      log.info("prompt rejected: session busy", {
        sessionId: session.id,
        sessionName: session.name,
      });
      await lark.sendMessage(msg.groupId, "⏳ 当前 session 正忙，请等待上一条消息完成");
      return;
    }

    const runningRun = await store.findRunningMessageRunBySession(session.id);
    if (runningRun) {
      log.info("prompt rejected: prior run still marked running", {
        sessionId: session.id,
        runId: runningRun.id,
      });
      await lark.sendMessage(msg.groupId, "⏳ 当前 session 正忙，请等待上一条消息完成");
      return;
    }

    // 外部-session guard: non-owner senders cannot access attachments.
    const isExternalNonOwner =
      session.category === "外部" &&
      msg.userId !== (deps.ownerUserId ?? "");

    // Fetch and record inbound attachments
    const fetched: AttachmentRef[] = [];
    if (!isExternalNonOwner) {
      for (const att of msg.attachments) {
        try {
          const { localPath } = await att.fetch();
          const ref = await store.recordAttachment({
            sessionId: session.id,
            kind: att.kind,
            localPath,
            originalName: att.originalName,
            mimeType: att.mimeType,
            uploadedAt: clock.now(),
          });
          fetched.push(ref);
        } catch (err) {
          log.warn("attachment fetch failed", {
            sessionId: session.id,
            originalName: att.originalName,
            err: errorMessage(err),
          });
        }
      }
    }

    // Resolve attachments (current message + history)
    const history = isExternalNonOwner ? [] : await store.listSessionAttachments(session.id);
    const selected = resolveAttachments({ prompt: msg.text, current: fetched, history });
    const backendAttachments = selected.map(toBackendAttachment);
    const backendPrompt =
      session.category === "外部"
        ? buildExternalSessionPrompt({
            prompt: msg.text,
            senderId: msg.userId,
            ownerUserId: deps.ownerUserId,
          })
        : msg.text;

    // Start message run + mark session busy so concurrent prompts are
    // rejected and /restart / /reset can see the running state.
    const runId = asMessageRunId(idFactory());
    deps.lifecycle?.runStarted();
    await store.startMessageRun({
      id: runId,
      sessionId: session.id,
      groupId: msg.groupId,
      prompt: msg.text,
      startedAt: clock.now(),
      senderId: msg.userId,
    });
    await store.updateSessionStatus(session.id, "busy", clock.now());
    await emit({
      kind: "session_status_changed",
      sessionId: session.id,
      from: "idle",
      to: "busy",
    });
    log.info("run started", {
      runId,
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
      resume: session.backendSessionId ?? null,
      attachments: backendAttachments.length,
    });
    const runStartedAtMs = monotonic();

    try {
      try {
        const usageBaseline =
          session.backend === "codex"
            ? await store.getLatestTokenUsageRawTotals(session.id)
            : null;
        const iterable = backend.get(session.backend).run({
          session,
          prompt: backendPrompt,
          attachments: backendAttachments,
          answerOnly: isExternalNonOwner,
        });
        const result = await replier.consume({
          groupId: msg.groupId,
          sessionId: session.id,
          runId,
          sessionName: session.name,
          sessionModel: session.model,
          sessionBackend: session.backend,
          usageBaseline,
          stream: iterable,
        });
        // Re-read the session to avoid clobbering a /restart or /reset that
        // landed while we were running. If status has already been reset to
        // idle with a null backend_session_id, don't resurrect it.
        const afterRun = await store.findSessionById(session.id);
        const wasCleared = afterRun?.backendSessionId === null && afterRun?.status === "idle";
        const clearBadCodexResume = shouldClearCodexResumeIdAfterFailure({
          backend: session.backend,
          persistedBackendSessionId: session.backendSessionId,
          runBackendSessionId: result.backendSessionId ?? null,
          error: result.error,
          streamLog: result.streamLog,
        });
        if (clearBadCodexResume && !wasCleared) {
          await store.updateSessionBackendSessionId(session.id, null);
          log.warn("cleared codex backend session after invalid resume failure", {
            runId,
            sessionId: session.id,
            backendSessionId: session.backendSessionId,
          });
        } else if (result.backendSessionId && !wasCleared && !isExternalNonOwner) {
          // Answer-only runs (外部 non-owner) execute with --ephemeral / no --resume, so the
          // backendSessionId reported by the backend has no rollout file on disk. Persisting it
          // would poison the next owner @ run with a "no rollout found" failure.
          await store.updateSessionBackendSessionId(session.id, result.backendSessionId);
        }
        // Persist runtime model & thinking extracted from the Claude system event.
        if (!wasCleared) {
          if (result.runtimeModel && !session.model) {
            await store.updateSessionModel(session.id, result.runtimeModel);
          }
          if (result.runtimeThinking !== undefined) {
            await store.updateSessionThinking(session.id, result.runtimeThinking);
          }
        }
        if (result.usage) {
          await store.recordTokenUsage({
            sessionId: session.id,
            messageRunId: runId,
            backend: session.backend,
            model: result.usage.model ?? session.model ?? null,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cacheReadTokens: result.usage.cacheReadTokens,
            cacheWriteTokens: result.usage.cacheWriteTokens,
            reasoningTokens: result.usage.reasoningTokens,
            rawUsageJson: result.usage.rawUsageJson,
            createdAt: clock.now(),
          });
        }
        const streamLogJson =
          result.streamLog && result.streamLog.length > 0
            ? JSON.stringify(result.streamLog)
            : undefined;
        if (result.error) {
          await store.finishMessageRun(
            runId,
            result.runStatus,
            result.finalMessage,
            result.error,
            streamLogJson,
          );
          if (!wasCleared) {
            await store.updateSessionStatus(session.id, "idle", clock.now());
            await emit({ kind: "session_status_changed", sessionId: session.id, from: "busy", to: "idle" });
            await drainPendingNext(session.id);
          }
          log.warn("run finished with error", {
            runId,
            sessionId: session.id,
            durationMs: monotonic() - runStartedAtMs,
            error: result.error,
            cleared: wasCleared,
          });
        } else {
          await store.finishMessageRun(
            runId,
            "completed",
            result.finalMessage,
            undefined,
            streamLogJson,
          );
          if (!wasCleared) {
            await store.updateSessionStatus(session.id, "idle", clock.now());
            await emit({ kind: "session_status_changed", sessionId: session.id, from: "busy", to: "idle" });
            await drainPendingNext(session.id);
          }
          log.info("run completed", {
            runId,
            sessionId: session.id,
            durationMs: monotonic() - runStartedAtMs,
            backendSessionId: result.backendSessionId ?? null,
            finalLength: result.finalMessage.length,
            cleared: wasCleared,
          });
        }
      } catch (err) {
        const text = errorMessage(err, "unknown");
        await store.finishMessageRun(runId, classifyRunStatus(text), undefined, text);
        const afterRun = await store.findSessionById(session.id);
        const wasCleared = afterRun?.backendSessionId === null && afterRun?.status === "idle";
        if (!wasCleared) {
          await store.updateSessionStatus(session.id, "idle", clock.now());
          await emit({ kind: "session_status_changed", sessionId: session.id, from: "busy", to: "idle" });
          await drainPendingNext(session.id);
        }
        log.error("run threw", {
          runId,
          sessionId: session.id,
          durationMs: monotonic() - runStartedAtMs,
          error: text,
        });
        await lark.sendMessage(msg.groupId, "❌ 执行失败：" + text);
      }
    } finally {
      deps.lifecycle?.runFinished();
    }
  }

  return { handleInbound };
}

function normalizeBareHeartbeatControlCommand(input: string): string | null {
  const normalized = input.trim().normalize("NFKC");
  const stop = normalized.match(/^stop\s+heartbeat(?:\s+(\S+))?$/iu);
  if (stop) {
    return stop[1] ? `/heartbeat stop ${stop[1]}` : "/heartbeat stop";
  }
  if (/^resume\s+heartbeat$/iu.test(normalized)) {
    return "/heartbeat resume";
  }
  return null;
}
