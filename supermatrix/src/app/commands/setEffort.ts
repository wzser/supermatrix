import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { BackendKind, EffortLevel, Session } from "../../domain/session.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { errorMessage } from "../errorMessage.ts";

const VALID_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

const BATCH_TARGETS: Record<string, BackendKind | undefined> = {
  all: undefined,
  "all-claude": "claude",
  "all-codex": "codex",
  "all-kimi": "kimi",
};

export type SetEffortHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{ id: SessionId; effort: EffortLevel | null } | null>;
    updateSessionEffort(id: SessionId, effort: string | null): Promise<void>;
    listActiveSessionsByBackend(backend?: BackendKind): Promise<Session[]>;
  };
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
};

export function createSetEffortHandler(deps: SetEffortHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;
    const level = args.level;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (!sessionName || !level) {
      throw new UserError(
        scope === "root"
          ? "用法：/effort <session-name|all|all-claude|all-codex|all-kimi> <low|medium|high|xhigh|max|default>"
          : "用法：/effort <low|medium|high|xhigh|max|default>",
      );
    }

    if (level !== "default" && !VALID_LEVELS.has(level)) {
      throw new UserError(
        `无效的 effort level：${level}，可选值：low / medium / high / xhigh / max / default`,
      );
    }

    if (scope === "root" && sessionName in BATCH_TARGETS) {
      const backend = BATCH_TARGETS[sessionName];
      const newEffort = level === "default" ? null : level;
      const targets = await deps.store.listActiveSessionsByBackend(backend);
      let succeeded = 0;
      const failures: string[] = [];
      for (const s of targets) {
        try {
          await deps.store.updateSessionEffort(s.id, newEffort);
          succeeded++;
        } catch (err) {
          failures.push(`${s.name}: ${errorMessage(err)}`);
        }
      }
      const backendTag = backend ? `backend=${backend}` : "all user scope";
      const effortTag = newEffort ?? "default";
      const head = `✓ 已更新 ${succeeded} 个 session（${backendTag}）→ ${effortTag}`;
      const tail = failures.length > 0 ? `\n失败 ${failures.length} 个：\n${failures.join("\n")}` : "";
      return { replyText: head + tail };
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    const newEffort = level === "default" ? null : level;
    await deps.store.updateSessionEffort(session.id, newEffort);

    return {
      replyText: newEffort
        ? `✓ session「${sessionName}」effort 已切换为 ${newEffort}`
        : `✓ session「${sessionName}」已恢复默认 effort`,
    };
  };
}
