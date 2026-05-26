import type { CommandHandler } from "../commandRegistry.ts";
import { formatRelativeChinese } from "../../domain/format.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { Clock } from "../../ports/Clock.ts";

export type ListHandlerDeps = {
  store: BindingStore;
  clock: Clock;
};

export function createListHandler(deps: ListHandlerDeps): CommandHandler {
  return async () => {
    const sessions = await deps.store.listActiveSessions();
    if (sessions.length === 0) {
      return { replyText: "当前没有 active session。使用 /new 创建一个。" };
    }
    const now = deps.clock.now();
    const lines = ["当前 sessions:"];
    for (const s of sessions) {
      const rel = formatRelativeChinese(s.createdAt, now);
      lines.push(`  • ${s.name}  (${s.backend}, ${s.status}, 创建于 ${rel})`);
    }
    return { replyText: lines.join("\n") };
  };
}
