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
import { isThinkingBlockResumeError } from "../domain/backendResumeErrors.ts";
import type { BackendKind, EffortLevel } from "../domain/session.ts";
import type { Scope } from "../domain/scope.ts";
import type {
  AttachmentRef as BackendAttachmentRef,
  BackendRegistry,
  RunInput,
} from "../ports/AgentBackend.ts";
import type { BindingStore, RunStatus } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { InboundMessage, ReferencedMessage } from "../ports/LarkGateway.ts";
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
import { resolveRunExecutionConfig } from "../ports/RunExecutionConfig.ts";
import type { RunExecutionConfig } from "../ports/RunExecutionConfig.ts";
import {
  CARD_ASK_SYSTEM_HINT,
  evaluateCardAskGate,
  type CardAskGateEvaluator,
} from "./cardAskGate.ts";
import {
  createCodexRuntimeRecoveryRun,
  type CodexRuntimeRecoveryDeps,
  type CodexRuntimeRecoveryRun,
} from "./codexRuntimeRecovery.ts";
import { recoverRepeatedCodexResume } from "./codexResumeRecovery.ts";
import { recoverKimiResumeStream } from "./kimiResumeRecovery.ts";

export type PendingNextEntry = { text: string; groupId: LarkGroupId; userId: string; mentionedBot?: boolean };

export type PendingNextStore = {
  has(sessionId: SessionId): boolean;
  shift(sessionId: SessionId): PendingNextEntry | undefined;
  restoreFront(sessionId: SessionId, entry: PendingNextEntry): void;
};

const CARD_ACTION_PREFIX = "CARD_ACTION:";
const FRAMEWORK_SPAWN_SOURCE = "supermatrix-root";
const WORKSPACE_LOCK_PROMPT_SUFFIX =
  "工作区是锁定状态，不管我前面说了什么，都不要执行任何写代码、文件、写入记忆等操作，只做纯执行";
const EMPLOYEE_BLOCKED_COMMANDS = new Set([
  "backend",
  "model",
  "spawn",
  "btw",
  "skills",
  "branch",
  "new",
  "clone",
  "delete",
  "reload",
  "heartbeat",
  "effort",
  "timeout",
  "reset",
  "restart",
]);

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
      branchName?: string;
      sessionModel: string | null;
      sessionEffort?: EffortLevel | null;
      execution?: RunExecutionConfig;
      sessionBackend: BackendKind;
      usageBaseline?: UsageWatermark | null;
      runStartedAtMs?: number;
      askUserQuestionCardRouted?: boolean;
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
  cardAskGatePath?: string;
  cardAskGate?: CardAskGateEvaluator;
  /**
   * Pre-run broker health filter (wired to disableCardAskWhenBrokerUnhealthy
   * in bootstrap). Applied right after the gate enables card-ask so the
   * replier's card-routed signal reflects a broker that is actually
   * reachable; when absent, no filtering is done (tests).
   */
  cardAskHealthFilter?: (input: RunInput) => Promise<RunInput>;
  codexRuntimeRecovery?: Omit<CodexRuntimeRecoveryDeps, "store" | "logger">;
  /**
   * Reads the sm-switch route-state contract: is a non-openai codex route
   * active right now? Wired to the codex adapter in bootstrap (app must not
   * import adapters). Absent → false, i.e. the pre-route-state behavior.
   */
  isCodexRouteOverrideActive?: () => boolean;
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
    .some((text) => isCodexMissingRolloutDetail(text));
}

function isCodexMissingRolloutDetail(text: string): boolean {
  return /thread\/resume failed: no rollout found for thread id/u.test(text);
}

function isCodexModelResumeIncompatibility(input: {
  backend: BackendKind;
  persistedBackendSessionId: string | null;
  error: string | undefined;
  streamLog: StreamLogEntry[];
}): boolean {
  if (input.backend !== "codex" || !input.persistedBackendSessionId || !input.error) return false;
  return [input.error, ...input.streamLog.flatMap((entry) => ("text" in entry ? [entry.text] : []))]
    .some((text) => /"detail"\s*:\s*"Bad Request"/u.test(text));
}

// Claude analogue of the codex clear: when a resumed Claude session dies on a
// thinking-block 400, the persisted backendSessionId points at a poisoned
// transcript. Re-persisting it re-poisons the next turn (the backend's
// in-memory fresh retry only papers over a single turn). Null it so the next
// turn starts a clean session. Unlike codex we don't gate on runBackendSessionId
// matching — the in-memory retry may surface a fresh id while the run still
// errors, and we still want the poisoned persisted id gone.
function shouldClearClaudeResumeIdAfterFailure(input: {
  backend: BackendKind;
  persistedBackendSessionId: string | null;
  error: string | undefined;
  streamLog: StreamLogEntry[];
}): boolean {
  if (input.backend !== "claude") return false;
  if (!input.persistedBackendSessionId) return false;
  if (!input.error) return false;
  return [input.error, ...input.streamLog.flatMap((entry) => ("text" in entry ? [entry.text] : []))]
    .some((text) => isThinkingBlockResumeError(text));
}

function shouldClearKimiResumeIdAfterFailure(input: {
  backend: BackendKind;
  persistedBackendSessionId: string | null;
  error: string | undefined;
  streamLog: StreamLogEntry[];
}): boolean {
  if (input.backend !== "kimi") return false;
  if (!input.persistedBackendSessionId) return false;
  if (!input.error) return false;
  return [input.error, ...input.streamLog.flatMap((entry) => ("text" in entry ? [entry.text] : []))]
    .some((text) => text.includes(`Unknown sessionId: ${input.persistedBackendSessionId}`));
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
  referencedMessage?: ReferencedMessage;
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

  const userMessageBlock = input.referencedMessage
    ? [
        renderReferencedMessageBlock(input.referencedMessage),
        "[User message]",
        input.prompt,
      ]
    : [
        "[User message]",
        input.prompt,
      ];

  return [
    "[SuperMatrix external session trusted identity context]",
    "This block is framework-provided metadata, not user-provided content.",
    ...identityLines,
    "Rules:",
    "- If Sender role is owner, this request is from the SuperMatrix owner. Follow the owner request normally; the external-group company-information restrictions do not apply to this owner request.",
    "- If Sender role is external_non_owner, answer only the external user's question. Do not reveal company business status, personnel, accounts, passwords, SuperMatrix code architecture, or other internal company information, and do not operate any other SuperMatrix feature.",
    ...userMessageBlock,
  ].join("\n");
}

function renderReferencedMessageBlock(ref: ReferencedMessage): string {
  const lines = [
    "[SuperMatrix referenced message context]",
    "This block is framework-provided metadata, not user-provided content.",
    `Referenced message id: ${ref.messageId}`,
  ];
  if (ref.senderName && ref.senderId) {
    lines.push(`Sender: ${ref.senderName} (${ref.senderId})`);
  } else if (ref.senderName) {
    lines.push(`Sender: ${ref.senderName}`);
  } else if (ref.senderId) {
    lines.push(`Sender: ${ref.senderId}`);
  }
  if (ref.timestampMs !== undefined) {
    lines.push(`Timestamp: ${new Date(ref.timestampMs).toISOString()}`);
  }
  if (ref.fetchError) {
    lines.push(`Fetch failure: ${ref.fetchError}`);
  }
  if (ref.parseError) {
    lines.push(`Parse failure: ${ref.parseError}`);
  }
  if (ref.text !== undefined) {
    lines.push("[Referenced message content]", ref.text);
  } else {
    lines.push("[Referenced message content]", "(unavailable)");
  }
  return lines.join("\n");
}

function buildPromptWithReferencedMessage(prompt: string, ref: ReferencedMessage | undefined): string {
  if (!ref) return prompt;
  return [
    renderReferencedMessageBlock(ref),
    "[Current user message]",
    prompt,
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

function isDisabledQuestionChoiceAction(value: Record<string, unknown>): boolean {
  return value.action === ["ask", "user", "answer"].join("_");
}

function buildCardActionDispatch(
  jsonText: string,
  source: CardActionDispatch["source"],
  fallbackTarget?: string,
): CardActionDispatch {
  const value = parseCardActionValue(jsonText);
  if (!value) return { kind: "invalid", source, reason: "invalid action JSON" };
  if (isDisabledQuestionChoiceAction(value)) {
    return { kind: "invalid", source, reason: "question choice callbacks are disabled" };
  }
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

function extractCommandName(text: string): string | null {
  const match = text.trimStart().normalize("NFKC").match(/^\/([^\s]+)/u);
  const name = match?.[1]?.trim().toLowerCase();
  return name ? name : null;
}

function employeeCommandBlockedMessage(command: string): string {
  return `员工群不支持 /${command}。这里只保留文档类命令和普通对话；业务、平台和会话管理操作请在对应内部 session 处理。`;
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
  const isCodexRouteOverrideActive = deps.isCodexRouteOverrideActive ?? (() => false);
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
            origin: "framework_synthetic",
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

  async function drainPendingRuntimeConfig(sessionId: SessionId): Promise<void> {
    const result = await store.drainPendingSessionRuntimeConfig(sessionId);
    if (result.kind === "rejected") {
      log.warn("pending runtime config rejected", { sessionId, reason: result.reason });
    }
  }

  async function handleInbound(msg: InboundMessage): Promise<void> {
    // NFKC-fold a local copy only for the bot-echo / mute prefix check so
    // Chinese IME mistypes (full-width '～' U+FF5E) still get suppressed.
    // Original msg.text is untouched on the prompt path.
    if (msg.text.normalize("NFKC").startsWith("~")) return;
    // Feishu rich-post / image messages carry content as post JSON
    // ({"title":"","content":[[...]]}); raw JSON starts with '{' and bypasses
    // the plain-text check above. Peek at the first non-empty text block.
    const firstPostBlock = extractFirstPostTextBlock(msg.text);
    if (firstPostBlock !== null && firstPostBlock.trimStart().normalize("NFKC").startsWith("~")) return;

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
    const commandTextCandidate = extractCommandTextCandidate(msg.text);
    const heartbeatControlCommand = normalizeBareHeartbeatControlCommand(msg.text);
    // Framework-synthetic messages are internal prompt delivery, never commands.
    const allowCommandRouting = msg.origin !== "framework_synthetic";
    const isCommand =
      allowCommandRouting &&
      (commandTextCandidate.trimStart().normalize("NFKC").startsWith("/") ||
        heartbeatControlCommand !== null);
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
        const ownerSlashCommand =
          isCommand &&
          deps.ownerUserId !== undefined &&
          msg.userId === deps.ownerUserId;
        if (
          mentionGateSession?.category === "外部" &&
          mentionGateSession.status !== "deleted" &&
          msg.mentionedBot !== true &&
          !ownerSlashCommand
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
      const commandMsg = heartbeatControlCommand
        ? { ...msg, text: heartbeatControlCommand }
        : commandTextCandidate !== msg.text
          ? { ...msg, text: commandTextCandidate }
          : msg;
      if (scope === "user") {
        const commandName = extractCommandName(commandMsg.text);
        if (commandName && EMPLOYEE_BLOCKED_COMMANDS.has(commandName)) {
          const binding = await store.findByGroup(msg.groupId);
          if (binding) {
            const session = await store.findSessionById(binding.sessionId);
            if (session?.category === "员工" && session.status !== "deleted") {
              await lark.sendMessage(msg.groupId, employeeCommandBlockedMessage(commandName));
              return;
            }
          }
        }
      }
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

    // If /next appears on a non-first line (after explanation text), re-dispatch
    // so it enters the command path even when the session is busy.
    if (allowCommandRouting) {
      const embeddedNext = extractEmbeddedNextLine(commandTextCandidate);
      if (embeddedNext !== null) {
        log.info("embedded /next on non-first line, re-dispatching as command", {
          groupId: msg.groupId,
          messageId: msg.messageId,
        });
        await handleInbound({ ...msg, text: embeddedNext });
        return;
      }
    }

    // Non-slash in user group
    const binding = await store.findByGroup(msg.groupId);
    if (!binding) {
      log.warn("unbound user group received prompt", { groupId: msg.groupId });
      await lark.sendMessage(msg.groupId, "❌ 此群未绑定任何 session");
      return;
    }

    let session = await store.findSessionById(binding.sessionId);
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

    // 外部 sessions must never reach the kimi backend: kimi has no answer-only
    // read-only execution mode, so the sandbox layer of the trust boundary
    // would silently be missing. Creation and /backend both reject this combo;
    // this run-time check covers rows drifted via out-of-process writes.
    if (isExternalNonOwner && session.backend === "kimi") {
      log.warn("prompt rejected: external non-owner on kimi backend", {
        sessionId: session.id,
        sessionName: session.name,
        senderId: msg.userId,
      });
      await lark.sendMessage(
        msg.groupId,
        "❌ 外部 session 不支持 kimi backend，请联系管理员切换为 claude 或 codex",
      );
      return;
    }

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
    const baseBackendPrompt =
      session.category === "外部"
        ? buildExternalSessionPrompt({
            prompt: msg.text,
            senderId: msg.userId,
            ownerUserId: deps.ownerUserId,
            ...(msg.referencedMessage !== undefined ? { referencedMessage: msg.referencedMessage } : {}),
          })
        : buildPromptWithReferencedMessage(msg.text, msg.referencedMessage);
    const workspaceLockedForSender =
      msg.origin === "lark_user" &&
      msg.userId !== deps.ownerUserId &&
      await store.getSessionWorkspaceLocked(session.id);
    const backendPrompt = workspaceLockedForSender
      ? `${baseBackendPrompt}\n\n${WORKSPACE_LOCK_PROMPT_SUFFIX}`
      : baseBackendPrompt;
    const activeBranch = await store.getActiveBranch(session.id);

    // One durable admission transaction owns both the maintenance-fence check
    // and running-row/session-busy creation. The earlier status checks are
    // only UX fast paths; they are not correctness gates.
    const runId = asMessageRunId(idFactory());
    const startedAt = clock.now();
    const admission = await store.admitMessageRun({
      id: runId,
      sessionId: session.id,
      groupId: msg.groupId,
      prompt: msg.text,
      startedAt,
      senderId: msg.userId,
      branchName: activeBranch.name,
    });
    if (admission.kind === "maintenance") {
      log.info("prompt rejected: backend maintenance lease active", {
        sessionId: session.id,
        sessionName: session.name,
        backend: admission.backend,
        leaseOwner: admission.lease.owner,
      });
      await lark.sendMessage(msg.groupId, "⛔ Claude 正在维护切换中，请稍后重试");
      return;
    }
    if (admission.kind === "busy") {
      log.info("prompt rejected: concurrent admission lost", {
        sessionId: session.id,
        runId: admission.currentRunId,
      });
      await lark.sendMessage(msg.groupId, "⏳ 当前 session 正忙，请等待上一条消息完成");
      return;
    }
    if (admission.kind === "not_admittable") {
      log.warn("prompt rejected: session became non-admittable", {
        sessionId: session.id,
        status: admission.status,
      });
      await lark.sendMessage(msg.groupId, "⏳ 当前 session 暂不可执行，请稍后重试");
      return;
    }
    const backendChangedAtAdmission = session.backend !== admission.runtimeConfig.backend;
    // Execute the exact tuple checked in the lease transaction. If the
    // backend changed since preflight, discard the old branch resume id rather
    // than resuming it through a different backend process.
    session = { ...session, ...admission.runtimeConfig, status: "busy" };
    const branchSession = {
      ...session,
      // Session.updatedAt is the main branch's last activity. A non-main
      // branch carries its own last backend activity timestamp, which the
      // Codex route-boundary guard must compare with route-state.activatedAt.
      updatedAt: activeBranch.updatedAt,
      backendSessionUpdatedAt: activeBranch.updatedAt,
      backendSessionId: backendChangedAtAdmission
        ? null
        : activeBranch.backendSessionId ?? activeBranch.sourceBackendSessionId,
    };
    if (isExternalNonOwner && session.backend === "kimi") {
      await store.finishMessageRun(
        runId,
        "failed",
        undefined,
        "external session became kimi during atomic run admission",
      );
      await store.updateSessionStatus(session.id, "idle", clock.now());
      await emit({ kind: "session_status_changed", sessionId: session.id, from: "busy", to: "idle" });
      await lark.sendMessage(
        msg.groupId,
        "❌ 外部 session 不支持 kimi backend，请联系管理员切换为 claude 或 codex",
      );
      return;
    }
    await emit({
      kind: "session_status_changed",
      sessionId: session.id,
      from: admission.previousStatus,
      to: "busy",
    });
    log.info("run started", {
      runId,
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
      branch: activeBranch.name,
      resume: branchSession.backendSessionId ?? null,
      attachments: backendAttachments.length,
    });
    const runStartedAtMs = monotonic();
    let recovery: CodexRuntimeRecoveryRun | null = null;
    let recoveryFinalized = false;
    const finalizeRecovery = async () => {
      if (!recovery || recoveryFinalized) return;
      recoveryFinalized = true;
      try {
        await recovery.repairAfterRun();
        log.info("codex runtime recovery outcome", { outcome: recovery.getOutcome().kind });
      } catch {
        log.warn("codex runtime recovery finalization failed", { outcome: recovery.getOutcome().kind });
      }
    };

    try {
      // Count this run in flight only once we are inside the try whose `finally`
      // releases it — see runFinished() below. Incrementing before startMessageRun
      // / updateSessionStatus (which can throw on a busy DB) leaked the counter
      // permanently, silently pinning the restart gate above zero.
      deps.lifecycle?.runStarted();
      try {
        const usageBaseline =
          session.backend === "codex"
            ? await store.getLatestTokenUsageRawTotals(session.id)
            : null;
        const execution = resolveRunExecutionConfig(branchSession);
        const runInput: RunInput = {
          messageRunId: runId,
          session: branchSession,
          execution,
          prompt: backendPrompt,
          attachments: backendAttachments,
          answerOnly: isExternalNonOwner,
        };
        if (
          !isExternalNonOwner &&
          activeBranch.forkPending &&
          activeBranch.sourceBackendSessionId
        ) {
          runInput.conversationFork = {
            sourceBackendSessionId: activeBranch.sourceBackendSessionId,
          };
        }
        if (
          msg.origin === "lark_user" &&
          !isExternalNonOwner
        ) {
          const cardAskGate = deps.cardAskGate ?? evaluateCardAskGate;
          const cardAskDecision = await cardAskGate({
            gatePath: deps.cardAskGatePath,
            session: branchSession,
            backend: session.backend,
            logger: log,
          });
          if (cardAskDecision.enabled) {
            runInput.cardAskEnabled = true;
            runInput.cardAskChatId = msg.groupId;
            runInput.systemHint = CARD_ASK_SYSTEM_HINT;
          }
        }
        // Drop card-ask early when the broker is unreachable, so the
        // card-routed signal below (and the backend's own probe) agree.
        const effectiveRunInput =
          runInput.cardAskEnabled && deps.cardAskHealthFilter
            ? await deps.cardAskHealthFilter(runInput)
            : runInput;
        // kimi's built-in AskUserQuestion reaches the user as a real card
        // when card-ask survived the health filter; the replier uses this to
        // suppress its legacy plain-text question mirror (else the user sees
        // every question twice — card + text).
        const askUserQuestionCardRouted =
          session.backend === "kimi" && effectiveRunInput.cardAskEnabled === true;
        const selectedBackend = backend.get(session.backend);
        const iterable = session.backend === "codex" && deps.codexRuntimeRecovery
          ? (recovery = createCodexRuntimeRecoveryRun({
              run: (retryInput) => selectedBackend.run(retryInput),
              runInput: effectiveRunInput,
              messageRunId: runId,
              sessionId: session.id,
              expected: {
                backend: session.backend,
                model: session.model,
                effort: session.effort,
                backendSessionId: session.backendSessionId,
              },
              deps: { store, logger: log, ...deps.codexRuntimeRecovery },
            })).stream
          : session.backend === "kimi" && branchSession.backendSessionId
            ? recoverKimiResumeStream({
                run: (retryInput) => selectedBackend.run(retryInput),
                runInput: effectiveRunInput,
                persistedBackendSessionId: branchSession.backendSessionId,
                clearPersisted: () =>
                  store.clearSessionBranchBackendSessionId(session.id, activeBranch.name, clock.now()),
                logger: log,
              })
            : selectedBackend.run(effectiveRunInput);
        const result = await replier.consume({
          groupId: msg.groupId,
          sessionId: session.id,
          runId,
          sessionName: session.name,
          branchName: activeBranch.name,
          sessionModel: session.model,
          sessionEffort: session.effort,
          execution,
          ...(recovery ? { getExecutionConfig: recovery.getExecutionConfig } : {}),
          sessionBackend: session.backend,
          usageBaseline,
          runStartedAtMs: startedAt,
          ...(askUserQuestionCardRouted ? { askUserQuestionCardRouted: true } : {}),
          stream: iterable,
        });
        // Re-read the session to avoid clobbering a /restart or /reset that
        // landed while we were running. If status has already been reset to
        // idle with a null backend_session_id, don't resurrect it.
        const afterRun = await store.findSessionById(session.id);
        const afterBranch = await store.findSessionBranch(session.id, activeBranch.name);
        const wasCleared =
          afterRun?.status === "idle" &&
          afterBranch?.backendSessionId === null &&
          afterBranch.sourceBackendSessionId === null &&
          !afterBranch.forkPending;
        const clearBadCodexResume = shouldClearCodexResumeIdAfterFailure({
          backend: session.backend,
          persistedBackendSessionId: branchSession.backendSessionId,
          runBackendSessionId: result.backendSessionId ?? null,
          error: result.error,
          streamLog: result.streamLog,
        });
        const clearBadClaudeResume = shouldClearClaudeResumeIdAfterFailure({
          backend: session.backend,
          persistedBackendSessionId: branchSession.backendSessionId,
          error: result.error,
          streamLog: result.streamLog,
        });
        const clearBadKimiResume = shouldClearKimiResumeIdAfterFailure({
          backend: session.backend,
          persistedBackendSessionId: branchSession.backendSessionId,
          error: result.error,
          streamLog: result.streamLog,
        });
        if ((clearBadCodexResume || clearBadClaudeResume || clearBadKimiResume) && !wasCleared) {
          await store.clearSessionBranchBackendSessionId(session.id, activeBranch.name, clock.now());
          log.warn("cleared backend session after invalid resume failure", {
            runId,
            sessionId: session.id,
            backend: session.backend,
            branch: activeBranch.name,
            backendSessionId: branchSession.backendSessionId,
          });
        } else if (result.backendSessionId && !wasCleared && !isExternalNonOwner) {
          // Answer-only runs (外部 non-owner) execute with --ephemeral / no --resume, so the
          // backendSessionId reported by the backend has no rollout file on disk. Persisting it
          // would poison the next owner @ run with a "no rollout found" failure.
          await store.updateSessionBranchBackendSessionId(
            session.id,
            activeBranch.name,
            result.backendSessionId,
            clock.now(),
          );
        }
        // Persist runtime model & thinking extracted from the Claude system event.
        if (!wasCleared) {
          // While a non-openai sm-switch route is active, a codex run's runtime
          // model is a routing fact (deepseek-v4-flash), not a model this
          // session ever asked for. Learning it into sessions.model would pin
          // the intent layer to a route-specific — and off-catalog — value that
          // outlives the route: after switching back to openai the session
          // would still carry it. Intent stays null and keeps being resolved
          // through the route on every run. Fails open (no contract → no
          // override → learn as before); claude/kimi are unaffected.
          const routeOwnsCodexModel =
            session.backend === "codex" && isCodexRouteOverrideActive();
          if (result.runtimeModel && !session.model && !routeOwnsCodexModel) {
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
          const codexResumeRecovery = await recoverRepeatedCodexResume({
            store,
            sessionId: session.id,
            branchName: activeBranch.name,
            backend: session.backend,
            persistedBackendSessionId: branchSession.backendSessionId,
            failedRunId: runId,
            error: result.error,
            now: clock.now(),
            ...(deps.codexRuntimeRecovery?.backupBeforeResumeClear
              ? { backup: deps.codexRuntimeRecovery.backupBeforeResumeClear }
              : {}),
          });
          if (codexResumeRecovery.status === "cleared") {
            log.warn("cleared repeated poisoned Codex resume after verified DB backup", {
              runId,
              sessionId: session.id,
              branch: activeBranch.name,
              snapshotPath: codexResumeRecovery.snapshotPath,
              receiptPath: codexResumeRecovery.receiptPath,
              readBackBackendSessionId: null,
            });
          } else if (codexResumeRecovery.status === "backup_failed" || codexResumeRecovery.status === "clear_failed") {
            log.error("Codex poisoned-resume recovery did not clear the pointer", {
              runId,
              sessionId: session.id,
              branch: activeBranch.name,
              status: codexResumeRecovery.status,
              error: codexResumeRecovery.error instanceof Error
                ? codexResumeRecovery.error.message
                : String(codexResumeRecovery.error),
              ...(codexResumeRecovery.status === "clear_failed"
                ? {
                    snapshotPath: codexResumeRecovery.snapshotPath,
                    receiptPath: codexResumeRecovery.receiptPath,
                  }
                : {}),
            });
          }
          if (!wasCleared) {
            await store.updateSessionStatus(session.id, "idle", clock.now());
            await emit({ kind: "session_status_changed", sessionId: session.id, from: "busy", to: "idle" });
          }
          log.warn("run finished with error", {
            runId,
            sessionId: session.id,
            durationMs: monotonic() - runStartedAtMs,
            error: result.error,
            cleared: wasCleared,
          });
          if (isCodexModelResumeIncompatibility({
            backend: session.backend,
            persistedBackendSessionId: branchSession.backendSessionId,
            error: result.error,
            streamLog: result.streamLog,
          })) {
            await lark.sendMessage(
              msg.groupId,
              "当前 Codex 模型与已有会话不兼容；已保留会话状态。请手动执行 /reset 后重试。",
            );
          }
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
        await drainPendingRuntimeConfig(session.id);
        await finalizeRecovery();
        if (!wasCleared) await drainPendingNext(session.id);
      } catch (err) {
        const text = errorMessage(err, "unknown");
        await store.finishMessageRun(runId, classifyRunStatus(text), undefined, text);
        const afterRun = await store.findSessionById(session.id);
        const wasCleared = afterRun?.backendSessionId === null && afterRun?.status === "idle";
        if (!wasCleared) {
          await store.updateSessionStatus(session.id, "idle", clock.now());
          await emit({ kind: "session_status_changed", sessionId: session.id, from: "busy", to: "idle" });
        }
        log.error("run threw", {
          runId,
          sessionId: session.id,
          durationMs: monotonic() - runStartedAtMs,
          error: text,
        });
        await drainPendingRuntimeConfig(session.id);
        await finalizeRecovery();
        if (!wasCleared) await drainPendingNext(session.id);
        await lark.sendMessage(msg.groupId, "❌ 执行失败：" + text);
      }
    } finally {
      deps.lifecycle?.runFinished();
    }
  }

  return { handleInbound };
}

function extractEmbeddedNextLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const lineTrimmed = stripLeadingNextWrapperQuote(lines[i]).trimStart();
    if (/^\/next(?:\s|$)/u.test(lineTrimmed.normalize("NFKC"))) {
      const remaining = [lineTrimmed, ...lines.slice(i + 1)];
      return remaining.join("\n");
    }
  }
  return null;
}

function extractCommandTextCandidate(text: string): string {
  const visiblePostText = extractPostVisibleText(text);
  return stripLeadingNextWrapperQuote(visiblePostText ?? text);
}

function stripLeadingNextWrapperQuote(text: string): string {
  const trimmed = text.trimStart();
  const first = trimmed[0];
  if (first !== "\"" && first !== "'" && first !== "“" && first !== "‘") return text;
  const unquoted = trimmed.slice(1).trimStart();
  return /^\/next(?:\s|$)/u.test(unquoted.normalize("NFKC")) ? unquoted : text;
}

/**
 * For Feishu post-format messages, msg.text is the raw post JSON
 * {"title":"","content":[[{tag,text,...},...],...]}.  Extract the first
 * non-empty text block so the mute-prefix check can see the visible text even
 * when images or other inline blocks appear later.
 */
function extractFirstPostTextBlock(text: string): string | null {
  const lines = parsePostContentLines(text);
  if (lines === null) return null;
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (const block of line) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.tag === "text" && typeof b.text === "string" && b.text.length > 0) {
        return b.text;
      }
    }
  }
  return null;
}

function extractPostVisibleText(text: string): string | null {
  const lines = parsePostContentLines(text);
  if (lines === null) return null;
  const visibleLines: string[] = [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    let lineText = "";
    let hasTextBlock = false;
    for (const block of line) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.tag === "text" && typeof b.text === "string") {
        lineText += b.text;
        hasTextBlock = true;
      }
    }
    if (hasTextBlock) visibleLines.push(lineText);
  }
  const visibleText = visibleLines.join("\n");
  return visibleText.length > 0 ? visibleText : null;
}

function parsePostContentLines(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const lines = record.content;
    if (!Array.isArray(lines)) return null;
    return lines;
  } catch {
    // not post JSON
  }
  return null;
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
