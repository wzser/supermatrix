import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { BackendKind, Session } from "../../domain/session.ts";
import {
  codexModelUnknownMessage,
  formatAvailableCodexModels,
  isKnownCodexModel,
} from "../../ports/CodexModelCatalog.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { errorMessage } from "../errorMessage.ts";

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  "opus4.7": "claude-opus-4-7",
  "opus-4.7": "claude-opus-4-7",
  "opus4.6": "claude-opus-4-6",
  "opus-4.6": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  "sonnet4.6": "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "haiku4.5": "claude-haiku-4-5-20251001",
  "haiku-4.5": "claude-haiku-4-5-20251001",
};

export const CODEX_MODEL_ALIASES: Record<string, string> = {
  "gpt5.5": "gpt-5.5",
  "gpt5.4": "gpt-5.4",
  "gpt5.4-mini": "gpt-5.4-mini",
  "gpt5.3-codex": "gpt-5.3-codex",
  "gpt5.2": "gpt-5.2",
};

const CLAUDE_ALIAS_KEYS = new Set(Object.keys(CLAUDE_MODEL_ALIASES));
const CODEX_ALIAS_KEYS = new Set(Object.keys(CODEX_MODEL_ALIASES));

export function resolveModelAlias(input: string, backend: BackendKind): string {
  const key = input.toLowerCase();
  if (backend === "claude") {
    if (CODEX_ALIAS_KEYS.has(key)) {
      throw new UserError(`模型别名「${input}」是 codex 模型，不能用于 claude session`);
    }
    return CLAUDE_MODEL_ALIASES[key] ?? input;
  }
  if (CLAUDE_ALIAS_KEYS.has(key)) {
    throw new UserError(`模型别名「${input}」是 claude 模型，不能用于 codex session`);
  }
  return CODEX_MODEL_ALIASES[key] ?? input;
}

export function resolveAndValidateModel(input: string, backend: BackendKind): string {
  const resolved = resolveModelAlias(input, backend);
  if (backend === "codex" && !isKnownCodexModel(resolved)) {
    throw new UserError(codexModelUnknownMessage(resolved));
  }
  return resolved;
}

export function assertCodexModelAliasesInCatalog(): void {
  const invalid = Object.entries(CODEX_MODEL_ALIASES).filter(
    ([, target]) => !isKnownCodexModel(target),
  );
  if (invalid.length === 0) return;
  const aliases = invalid.map(([alias, target]) => `${alias}->${target}`).join(", ");
  throw new Error(
    `codex model aliases outside bundled catalog: ${aliases}; available: ${formatAvailableCodexModels()}`,
  );
}

const BATCH_TARGETS: Record<string, BackendKind | undefined> = {
  all: undefined,
  "all-claude": "claude",
  "all-codex": "codex",
};

const LOCK_TOKEN = "Fixed";
const UNLOCK_TOKEN = "Unfixed";

export type SetModelHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{
      id: SessionId;
      backend: BackendKind;
      model: string | null;
      modelLocked: boolean;
    } | null>;
    updateSessionModel(id: SessionId, model: string | null): Promise<void>;
    updateSessionModelLocked(id: SessionId, locked: boolean): Promise<void>;
    listActiveSessionsByBackend(backend?: BackendKind): Promise<Session[]>;
  };
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
};

export function createSetModelHandler(deps: SetModelHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;
    const model = args.model;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (!sessionName || !model) {
      throw new UserError(
        scope === "root"
          ? "用法：/model <session-name|all|all-claude|all-codex> <model-id>"
          : "用法：/model <model-id>",
      );
    }

    if (model === LOCK_TOKEN || model === UNLOCK_TOKEN) {
      if (sessionName in BATCH_TARGETS) {
        throw new UserError(
          `${model} 是锁定子命令，不能与 ${sessionName} 组合使用。请显式指名 session 或在群内发 /model ${model}。`,
        );
      }
      const session = await deps.store.findSessionByName(sessionName);
      if (!session) throw new UserError(`session 不存在：${sessionName}`);
      const lock = model === LOCK_TOKEN;
      await deps.store.updateSessionModelLocked(session.id, lock);
      const modelDisplay = session.model ?? "backend 默认";
      return {
        replyText: lock
          ? `🔒 session「${sessionName}」已锁定模型 ${modelDisplay}，console 的 bulk 指令将跳过本 session。/model Unfixed 解锁。`
          : `🔓 session「${sessionName}」已解锁，console 的 bulk 指令将再次命中本 session。`,
      };
    }

    if (scope === "root" && sessionName in BATCH_TARGETS) {
      const backend = BATCH_TARGETS[sessionName];
      const targets = await deps.store.listActiveSessionsByBackend(backend);
      let succeeded = 0;
      const failures: string[] = [];
      const skipped: string[] = [];
      for (const s of targets) {
        if (s.modelLocked) {
          skipped.push(s.name);
          continue;
        }
        try {
          const resolved = model === "default" ? null : resolveAndValidateModel(model, s.backend);
          await deps.store.updateSessionModel(s.id, resolved);
          succeeded++;
        } catch (err) {
          failures.push(`${s.name}: ${errorMessage(err)}`);
        }
      }
      const backendTag = backend ? `backend=${backend}` : "all user scope";
      const modelTag = model === "default" ? "default" : model;
      const lines = [`✓ 已更新 ${succeeded} 个 session（${backendTag}）→ ${modelTag}`];
      if (skipped.length > 0) {
        lines.push(`🔒 跳过 ${skipped.length} 个锁定 session: ${skipped.join(", ")}`);
      }
      if (failures.length > 0) {
        lines.push(`失败 ${failures.length} 个：\n${failures.join("\n")}`);
      }
      return { replyText: lines.join("\n") };
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    const resolved = model === "default" ? null : resolveAndValidateModel(model, session.backend);
    await deps.store.updateSessionModel(session.id, resolved);

    return {
      replyText: resolved
        ? `✓ session「${sessionName}」模型已切换为 ${resolved}`
        : `✓ session「${sessionName}」已恢复默认模型`,
    };
  };
}
