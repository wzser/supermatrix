import { UserError } from "../../domain/errors.ts";
import {
  asSessionId,
  type LarkGroupId,
  type SessionId,
} from "../../domain/ids.ts";
import type { BackendKind } from "../../domain/session.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { Clock } from "../../ports/Clock.ts";
import type { Logger } from "../../ports/Logger.ts";
import { getCodexDefaultModel } from "../../ports/CodexModelCatalog.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { isSpawnChildQueuedResult } from "../childSession.ts";
import { resolveModelAlias } from "./setModel.ts";
import type {
  ResumeChildInput,
  SpawnChildInput,
  SpawnChildResult,
} from "../childSession.ts";
import { errorMessage } from "../errorMessage.ts";

export const BTW_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function defaultBtwModel(backend: BackendKind): string {
  if (backend === "claude") return resolveModelAlias("sonnet", "claude");
  if (backend === "codex") return getCodexDefaultModel();
  return "kimi-k2-thinking"; // Default kimi model
}

type BtwEntry = {
  childSessionId: SessionId;
  idleTimer: ReturnType<typeof setTimeout>;
};

export type BtwHandlerDeps = {
  store: BindingStore;
  childSession: {
    spawnChild(input: SpawnChildInput): Promise<SpawnChildResult>;
    resumeChild(input: ResumeChildInput): Promise<SpawnChildResult>;
  };
  backend: { cancel(sessionId: SessionId): Promise<void> };
  lark: { sendMessage(groupId: LarkGroupId, text: string): Promise<void> };
  clock: Clock;
  logger?: Logger;
  idleTimeoutMs?: number;
};

export type BtwRegistryHandle = {
  handler: CommandHandler;
  shutdown(): void;
  _mapSize(): number;
};

export function createBtwHandler(deps: BtwHandlerDeps): BtwRegistryHandle {
  const idleTimeoutMs = deps.idleTimeoutMs ?? BTW_IDLE_TIMEOUT_MS;
  const log = deps.logger?.child({ mod: "btw" });
  const entries = new Map<LarkGroupId, BtwEntry>();

  function scheduleCleanup(groupId: LarkGroupId, childSessionId: SessionId): BtwEntry {
    const timer = setTimeout(() => {
      void cleanup(groupId, "idle-timeout");
    }, idleTimeoutMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return { childSessionId, idleTimer: timer };
  }

  async function cleanup(groupId: LarkGroupId, reason: string): Promise<void> {
    const entry = entries.get(groupId);
    if (!entry) return;
    entries.delete(groupId);
    clearTimeout(entry.idleTimer);
    try {
      await deps.backend.cancel(entry.childSessionId);
    } catch (err) {
      log?.warn("btw cancel failed", {
        groupId,
        childSessionId: entry.childSessionId,
        err: errorMessage(err),
      });
    }
    try {
      await deps.store.updateSessionStatus(entry.childSessionId, "deleted", deps.clock.now());
    } catch (err) {
      log?.warn("btw mark deleted failed", {
        groupId,
        childSessionId: entry.childSessionId,
        err: errorMessage(err),
      });
    }
    log?.info("btw cleanup", { groupId, childSessionId: entry.childSessionId, reason });
  }

  const handler: CommandHandler = async ({ args, scope, msg }) => {
    if (scope !== "user") throw new UserError("/btw 只能在 session 群使用");
    const prompt = args.text?.trim();
    if (!prompt) throw new UserError("用法：/btw <prompt>");

    const binding = await deps.store.findByGroup(msg.groupId);
    if (!binding) throw new UserError("当前群未绑定 session");
    const parent = await deps.store.findSessionById(binding.sessionId);
    if (!parent) throw new UserError("session 不存在");
    if (parent.status === "deleted") throw new UserError("session 已删除");

    try {
      await deps.lark.sendMessage(msg.groupId, "已收到，正在后台处理");
    } catch (err) {
      log?.warn("btw ack send failed", {
        groupId: msg.groupId,
        err: errorMessage(err),
      });
    }

    const EMPTY_COMPLETION_REPLY =
      "（后台已完成，但模型没有产出回复内容；请换个说法或补充上下文后重试）";

    const existing = entries.get(msg.groupId);
    let result: SpawnChildResult;
    try {
      if (existing) {
        clearTimeout(existing.idleTimer);
        const child = await deps.store.findSessionById(existing.childSessionId);
        if (!child || child.status === "deleted") {
          entries.delete(msg.groupId);
          log?.info("btw stale entry, falling through to spawn", {
            groupId: msg.groupId,
            childSessionId: existing.childSessionId,
            childStatus: child?.status ?? "missing",
          });
          result = await deps.childSession.spawnChild({
            parentId: parent.id,
            backend: parent.backend,
            model: defaultBtwModel(parent.backend),
            workdir: parent.workdir,
            prompt,
            type: "ephemeral_conversation",
            triggerKind: "human",
            callerInvocation: "sync_inline",
            postIdentity: "bot",
            senderId: msg.userId,
            resultSinks: [
              {
                kind: "chat_post",
                chatRef: { kind: "parent" },
                identity: "bot",
              },
            ],
          });
        } else {
          log?.info("btw resume", {
            groupId: msg.groupId,
            childSessionId: existing.childSessionId,
          });
          result = await deps.childSession.resumeChild({
            sessionId: existing.childSessionId,
            prompt,
          });
        }
      } else {
        log?.info("btw spawn", { groupId: msg.groupId, parentId: parent.id });
        result = await deps.childSession.spawnChild({
          parentId: parent.id,
          backend: parent.backend,
          model: defaultBtwModel(parent.backend),
          workdir: parent.workdir,
          prompt,
          type: "ephemeral_conversation",
          triggerKind: "human",
          callerInvocation: "sync_inline",
          postIdentity: "bot",
          senderId: msg.userId,
          resultSinks: [
            {
              kind: "chat_post",
              chatRef: { kind: "parent" },
              identity: "bot",
            },
          ],
        });
      }
    } catch (err) {
      // codex empty-completion (and other backend stream errors) surface as
      // RunFailure. Keep the user out of the "❌ 未知错误" path and give a
      // concrete next-step prompt. Other errors keep their default handling.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("empty completion")) {
        return { replyText: EMPTY_COMPLETION_REPLY };
      }
      throw err;
    }

    if (isSpawnChildQueuedResult(result)) {
      return { replyText: `已排队，ref=${result.ref}` };
    }

    const childId = asSessionId(result.session.id);
    entries.set(msg.groupId, scheduleCleanup(msg.groupId, childId));

    // Defensive second layer: if a backend completes with empty final without
    // emitting an error event (e.g. claude returning "" or a codex path the
    // parser doesn't yet cover), still give the user a concrete prompt rather
    // than silence — dispatcher drops empty replyText.
    const replyText = result.finalMessage?.trim()
      ? result.finalMessage
      : EMPTY_COMPLETION_REPLY;
    return { replyText };
  };

  function shutdown(): void {
    for (const [, entry] of entries) clearTimeout(entry.idleTimer);
    entries.clear();
  }

  return { handler, shutdown, _mapSize: () => entries.size };
}
