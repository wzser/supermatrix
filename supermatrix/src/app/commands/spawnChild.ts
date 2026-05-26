import type { AbsolutePath, LarkGroupId, SessionId } from "../../domain/ids.ts";
import { asLarkGroupId } from "../../domain/ids.ts";
import type { Binding } from "../../domain/binding.ts";
import type { BackendKind } from "../../domain/session.ts";
import { UserError } from "../../domain/errors.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { isSpawnChildQueuedResult, type SpawnChildInput, type SpawnChildResult } from "../childSession.ts";
import { resolveAndValidateModel } from "./setModel.ts";

export type SpawnChildHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{
      id: SessionId;
      workdir: AbsolutePath;
      backend: BackendKind;
      model: string | null;
    } | null>;
    findBySession(sessionId: SessionId): Promise<Binding | null>;
  };
  childSession: {
    spawnChild(input: SpawnChildInput): Promise<SpawnChildResult>;
  };
  lark: {
    sendMessage(groupId: LarkGroupId, text: string): Promise<void>;
  };
};

const REPLY_TO_RE = /--reply-to\s+(\S+)/;
const BACKEND_RE = /--backend\s+(claude|codex)/;
const FROM_RE = /--from\s+(\S+)/;
const MODEL_RE = /--model\s+(\S+)/;

export function createSpawnChildHandler(deps: SpawnChildHandlerDeps): CommandHandler {
  return async ({ args, scope }) => {
    if (scope !== "root") throw new UserError("/spawn 只能在 root 群使用");
    const targetName = args.name;
    let prompt = args.prompt;
    if (!targetName || !prompt) {
      throw new UserError("用法：/spawn <session-name> [--backend claude|codex] [--model <model|default>] [--reply-to <chat_id>] <prompt...>");
    }

    // Extract optional --reply-to <chat_id> from prompt
    let replyTo: LarkGroupId | null = null;
    const replyToMatch = prompt.match(REPLY_TO_RE);
    if (replyToMatch) {
      replyTo = asLarkGroupId(replyToMatch[1]);
      prompt = prompt.replace(REPLY_TO_RE, "").trim();
    }

    // Extract optional --backend claude|codex from prompt
    let backendOverride: BackendKind | null = null;
    const backendMatch = prompt.match(BACKEND_RE);
    if (backendMatch) {
      backendOverride = backendMatch[1] as BackendKind;
      prompt = prompt.replace(BACKEND_RE, "").trim();
    }

    // Extract optional --model <model-id|alias|default> from prompt
    let modelOverride: string | null | undefined;
    const modelMatch = prompt.match(MODEL_RE);
    if (modelMatch) {
      modelOverride = modelMatch[1] === "default" ? null : modelMatch[1];
      prompt = prompt.replace(MODEL_RE, "").trim();
    }

    // Extract optional --from <session-name> for cross-session comm logging
    let fromName: string | null = null;
    const fromMatch = prompt.match(FROM_RE);
    if (fromMatch) {
      fromName = fromMatch[1];
      prompt = prompt.replace(FROM_RE, "").trim();
    }

    if (!prompt) {
      throw new UserError("用法：/spawn <session-name> [--backend claude|codex] [--model <model|default>] [--from <session>] [--reply-to <chat_id>] <prompt...>");
    }

    const target = await deps.store.findSessionByName(targetName);
    if (!target) throw new UserError(`session 不存在：${targetName}`);

    let requestedBy: SessionId | undefined;
    if (fromName) {
      const fromSession = await deps.store.findSessionByName(fromName);
      if (!fromSession) throw new UserError(`from session 不存在：${fromName}`);
      requestedBy = fromSession.id;
    }

    const backend = backendOverride ?? target.backend;
    let model =
      modelOverride !== undefined
        ? modelOverride === null
          ? null
          : resolveAndValidateModel(modelOverride, backend)
        : backend === target.backend
          ? target.model
          : null;
    if (backend === "codex" && model !== null) {
      model = resolveAndValidateModel(model, backend);
    }

    // /spawn is the one_shot_delegation entrypoint: run once, post result to
    // parent's group (or --reply-to override), with bot identity.
    const result = await deps.childSession.spawnChild({
      parentId: target.id,
      backend,
      model,
      workdir: target.workdir,
      prompt,
      type: "one_shot_delegation",
      callerInvocation: "sync_inline",
      postIdentity: "bot",
      resultSinks: [
        {
          kind: "chat_post",
          chatRef: replyTo ? { kind: "explicit", chatId: replyTo } : { kind: "parent" },
          identity: "bot",
        },
      ],
      ...(requestedBy ? { requestedBy, triggerKind: "session" as const } : { triggerKind: "human" as const }),
    });

    if (isSpawnChildQueuedResult(result)) {
      return {
        replyText: `✓ 子 session 已排队，ref=${result.ref}`,
      };
    }

    const preview = result.finalMessage.length > 200
      ? result.finalMessage.slice(0, 200) + "..."
      : result.finalMessage;
    const resultText = `✓ 子 session「${result.session.name}」执行完毕\n\n${preview}`;

    // Determine where to send the result:
    // 1. Explicit --reply-to overrides everything
    // 2. Default: parent session's bound group
    const targetGroupId = replyTo ?? (await deps.store.findBySession(target.id))?.groupId ?? null;
    if (targetGroupId) {
      await deps.lark.sendMessage(targetGroupId, resultText);
    }

    return {
      replyText: `✓ 子 session「${result.session.name}」已完成${targetGroupId ? "（结果已发送到目标群）" : ""}`,
    };
  };
}
