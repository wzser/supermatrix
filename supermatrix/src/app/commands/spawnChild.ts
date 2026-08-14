import type { AbsolutePath, LarkGroupId, SessionId } from "../../domain/ids.ts";
import { asLarkGroupId } from "../../domain/ids.ts";
import type { Binding } from "../../domain/binding.ts";
import type { BackendKind, EffortLevel } from "../../domain/session.ts";
import type { ChildSessionDefaults } from "../../ports/ChildSessionDefaults.ts";
import { UserError } from "../../domain/errors.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { isSpawnChildQueuedResult, type SpawnChildInput, type SpawnChildResult } from "../childSession.ts";
import { resolveAndValidateModel } from "./setModel.ts";
import { resolveAndValidateEffort } from "./setEffort.ts";

export type SpawnChildHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{
      id: SessionId;
      workdir: AbsolutePath;
      backend: BackendKind;
      model: string | null;
    } | null>;
    getChildSessionDefaults(): Promise<ChildSessionDefaults>;
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
const BACKEND_RE = /--backend\s+(claude|codex|kimi)/;
const FROM_RE = /--from\s+(\S+)/;
const MODEL_RE = /--model\s+(\S+)/;
const EFFORT_RE = /(?:^|\s)--effort(?:\s+(\S+))?/g;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "ultra", "ultracode", "default"]);

function extractEffortOverride(prompt: string): { prompt: string; effortOverride: string | undefined } {
  const matches = [...prompt.matchAll(EFFORT_RE)];
  if (matches.length === 0) return { prompt, effortOverride: undefined };
  if (matches.length > 1) throw new UserError("--effort 只能指定一次");

  const [match] = matches;
  const effort = match![1];
  if (!effort || effort.startsWith("--")) {
    throw new UserError("--effort 缺少 level");
  }
  if (!EFFORT_LEVELS.has(effort)) {
    throw new UserError(`无效的 effort level：${effort}`);
  }
  return { prompt: prompt.replace(match![0], "").trim(), effortOverride: effort };
}

function formatSpawnTuple(tuple: {
  backend: BackendKind;
  model: string | null;
  effort: EffortLevel | null | undefined;
}): string {
  const model = tuple.model ?? "default";
  const effort = tuple.effort === undefined ? "inherit" : tuple.effort ?? "default";
  return `backend=${tuple.backend}, model=${model}, effort=${effort}`;
}

export function createSpawnChildHandler(deps: SpawnChildHandlerDeps): CommandHandler {
  return async ({ args, scope }) => {
    if (scope !== "root") throw new UserError("/spawn 只能在 root 群使用");
    const targetName = args.name;
    let prompt = args.prompt;
    if (!targetName || !prompt) {
      throw new UserError("用法：/spawn <session-name> [--backend claude|codex|kimi] [--model <model|default>] [--effort <low|medium|high|xhigh|max|ultra|ultracode|default>] [--reply-to <chat_id>] <prompt...>");
    }

    const parsedEffort = extractEffortOverride(prompt);
    prompt = parsedEffort.prompt;
    const effortOverride = parsedEffort.effortOverride;

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
      throw new UserError("用法：/spawn <session-name> [--backend claude|codex|kimi] [--model <model|default>] [--effort <low|medium|high|xhigh|max|ultra|ultracode|default>] [--from <session>] [--reply-to <chat_id>] <prompt...>");
    }

    const target = await deps.store.findSessionByName(targetName);
    if (!target) throw new UserError(`session 不存在：${targetName}`);
    const defaults = await deps.store.getChildSessionDefaults();

    let requestedBy: SessionId | undefined;
    if (fromName) {
      const fromSession = await deps.store.findSessionByName(fromName);
      if (!fromSession) throw new UserError(`from session 不存在：${fromName}`);
      requestedBy = fromSession.id;
    }

    const backend = backendOverride ?? (defaults.backend.configured ? defaults.backend.value! : target.backend);
    const useConfiguredTuple = !backendOverride || backendOverride === defaults.backend.value;
    let model =
      modelOverride !== undefined
        ? modelOverride === null
          ? null
          : resolveAndValidateModel(modelOverride, backend)
        : useConfiguredTuple && defaults.model.configured
          ? defaults.model.value
          : backend === target.backend
            ? target.model
            : null;
    if (backend === "codex" && model !== null) {
      model = resolveAndValidateModel(model, backend);
    }
    const effort =
      effortOverride !== undefined
        ? resolveAndValidateEffort(effortOverride, { backend, model })
        : useConfiguredTuple && defaults.effort.configured
          ? defaults.effort.value
          : undefined;
    if (effortOverride === undefined && effort !== null && effort !== undefined) {
      resolveAndValidateEffort(effort, { backend, model });
    }
    const executionOverride: NonNullable<SpawnChildInput["executionOverride"]> = {};
    if (backendOverride) executionOverride.backend = backend;
    if (modelOverride !== undefined) executionOverride.model = model;
    if (effortOverride !== undefined && effort !== undefined) executionOverride.effort = effort;

    // /spawn is the one_shot_delegation entrypoint: run once, post result to
    // parent's group (or --reply-to override), with bot identity.
    const result = await deps.childSession.spawnChild({
      parentId: target.id,
      backend,
      model,
      ...(effort !== undefined ? { effort } : {}),
      ...(Object.keys(executionOverride).length > 0 ? { executionOverride } : {}),
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
        replyText: `✓ 子 session 已排队，ref=${result.ref}（请求 ${formatSpawnTuple({ backend, model, effort })}）`,
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

    const delivery = targetGroupId ? "（结果已发送到目标群）" : "";
    return {
      replyText: `✓ 子 session「${result.session.name}」已完成（${formatSpawnTuple(result.session)}）${delivery}`,
    };
  };
}
