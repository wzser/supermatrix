import { UserError } from "../../domain/errors.ts";
import { formatIso } from "../../domain/format.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { BindingStore, CrossSessionComm } from "../../ports/BindingStore.ts";
import type { CommandHandler } from "../commandRegistry.ts";

const LOG_LIMIT = 10;
const PREVIEW_LIMIT = 150;

export type LogHandlerDeps = {
  store: Pick<BindingStore, "findSessionById" | "findSessionByName" | "listCrossSessionComms">;
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
};

export function createLogHandler(deps: LogHandlerDeps): CommandHandler {
  return async ({ scope, args, msg }) => {
    const target = await resolveTarget(deps, scope, args.name, msg.groupId);
    const rows = await deps.store.listCrossSessionComms(target.id, "to", LOG_LIMIT);
    if (rows.length === 0) {
      return { replyText: `暂无注入 ${target.name} 的记录。` };
    }

    const sourceNames = await resolveSourceNames(deps.store, rows);
    const lines = [`最近 ${rows.length} 条注入 ${target.name} 的信息：`];
    rows.forEach((row, index) => {
      const source = sourceNames.get(row.fromSessionId) ?? row.fromSessionId;
      lines.push(
        `${index + 1}. 来源: ${source} | 类型: ${row.kind}/${row.status} | 时间: ${formatIso(row.createdAt)}`,
      );
      lines.push(`   内容: ${preview(row.prompt)}`);
    });
    return { replyText: lines.join("\n") };
  };
}

async function resolveTarget(
  deps: LogHandlerDeps,
  scope: "root" | "user" | "child",
  name: string | undefined,
  groupId: LarkGroupId,
): Promise<{ id: SessionId; name: string }> {
  if (scope === "user") {
    const resolved = await deps.resolveUserGroupSession?.(groupId);
    if (!resolved) throw new UserError("当前群未绑定 session，无法查看 /log");
    return resolved;
  }

  if (!name) throw new UserError("请指定 session 名称：/log <session>");
  const session = await deps.store.findSessionByName(name);
  if (!session) throw new UserError(`session 不存在：${name}`);
  return { id: session.id, name: session.name };
}

async function resolveSourceNames(
  store: LogHandlerDeps["store"],
  rows: CrossSessionComm[],
): Promise<Map<SessionId, string>> {
  const uniqueIds = [...new Set(rows.map((row) => row.fromSessionId))];
  const pairs = await Promise.all(
    uniqueIds.map(async (id) => {
      const session = await store.findSessionById(id);
      return [id, session?.name] as const;
    }),
  );
  return new Map(pairs.filter((pair): pair is readonly [SessionId, string] => Boolean(pair[1])));
}

function preview(text: string): string {
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text;
}
