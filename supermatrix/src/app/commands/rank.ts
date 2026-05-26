import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandHandler, HandlerContext } from "../commandRegistry.ts";
import type {
  BindingStore,
  GetRankStatsInput,
  DisplayNameEntry,
} from "../../ports/BindingStore.ts";
import type { LarkGroupId } from "../../domain/ids.ts";
import type { Logger } from "../../ports/Logger.ts";

// Documented as the group that triggers root/global scope ranking.
// Not used in runtime logic (scope field on ctx is sufficient), kept for
// clarity on which Feishu group is considered root.
const CONSOLE_GROUP_ID = (process.env.SM_ROOT_GROUP_ID ?? "LARK_ROOT_GROUP_ID") as LarkGroupId;
void CONSOLE_GROUP_ID;

const DISPLAY_NAME_TTL_MS = 24 * 60 * 60 * 1000;

// Cold-miss path runs hrhrhrhrhr's refresh script directly (Feishu
// contact API + sqlite upsert, ~1s). The previous implementation went
// through /api/spawn → Claude Opus 4.7 child to invoke the same script,
// which observed at 28-63s and always tripped the client AbortController.
// Owner contract for the script (path + argv) is documented in
// hrhrhrhrhr/scripts/refresh_user_display_names.py docstring.
const HRHR_SESSION_NAME = "hrhrhrhrhr";
const REFRESH_SCRIPT_RELATIVE = "scripts/refresh_user_display_names.py";
const REFRESH_TIMEOUT_MS = 30_000;
const OPEN_ID_RE = /^ou_[A-Za-z0-9]+$/u;

const execFileP = promisify(execFile);

export type RankHandlerDeps = {
  store: BindingStore;
  logger?: Logger;
  /** Override for testing: skip cache + refresh and provide names directly. */
  resolveNames?: (senderIds: string[]) => Promise<Map<string, string>>;
};

async function runRefreshScript(
  openIds: string[],
  store: BindingStore,
  logger: Logger | undefined,
): Promise<void> {
  const safeIds = openIds.filter((id) => OPEN_ID_RE.test(id));
  if (safeIds.length === 0) return;

  const session = await store.findSessionByName(HRHR_SESSION_NAME);
  if (!session) {
    throw new Error(`session not found: ${HRHR_SESSION_NAME}`);
  }
  const scriptPath = `${session.workdir}/${REFRESH_SCRIPT_RELATIVE}`;

  await execFileP(scriptPath, safeIds, {
    cwd: session.workdir,
    timeout: REFRESH_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  logger?.info("rank: refresh_user_display_names ok", {
    count: safeIds.length,
  });
}

async function defaultResolveNames(
  senderIds: string[],
  store: BindingStore,
  logger: Logger | undefined,
): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = await store.getDisplayNames(senderIds);

  const result = new Map<string, string>();
  const stale: string[] = [];

  for (const id of senderIds) {
    const entry: DisplayNameEntry | undefined = cached.get(id);
    if (entry && now - entry.fetchedAt < DISPLAY_NAME_TTL_MS) {
      result.set(id, entry.displayName);
    } else {
      stale.push(id);
    }
  }

  if (stale.length > 0) {
    try {
      await runRefreshScript(stale, store, logger);
      const refreshed = await store.getDisplayNames(stale);
      for (const id of stale) {
        const entry = refreshed.get(id);
        if (entry) result.set(id, entry.displayName);
      }
    } catch (err) {
      // Refresh failed (script missing, hrhrhrhrhr down, Feishu API
      // unreachable, etc). Fall through to id-suffix placeholder so the
      // /rank reply still renders. Do NOT change the fallback to "未知用户"
      // — it hides the real ID and complicates manual lookup.
      logger?.warn("rank: display name refresh failed; falling back to id suffix", {
        err: err instanceof Error ? err.message : String(err),
        stale,
      });
    }
  }

  for (const id of senderIds) {
    if (!result.has(id)) {
      result.set(id, id.slice(-8));
    }
  }

  return result;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function createRankHandler(deps: RankHandlerDeps): CommandHandler {
  const resolve = deps.resolveNames
    ? deps.resolveNames
    : (ids: string[]) => defaultResolveNames(ids, deps.store, deps.logger);

  return async (ctx: HandlerContext): Promise<{ replyText: string }> => {
    const isRoot = ctx.scope === "root";

    const statsInput: GetRankStatsInput = isRoot
      ? { scope: "global" }
      : { scope: "group", groupId: ctx.msg.groupId };

    const stats = await deps.store.getRankStats(statsInput);

    if (stats.rows.length === 0) {
      return { replyText: "📊 近 7 天暂无数据。" };
    }

    const senderIds = stats.rows.map((r) => r.senderId);
    const names = await resolve(senderIds);

    const since = stats.trackingSince ? formatDate(stats.trackingSince) : "?";
    const title = isRoot
      ? `📊 SuperMatrix 消息排行榜（近 7 天，自 ${since}）`
      : `📊 消息统计（近 7 天，自 ${since}）`;

    const lines = stats.rows.map((row, i) => {
      const name = names.get(row.senderId) ?? row.senderId.slice(-8);
      const countPart = `${formatCount(row.total)} 条 / ${formatCount(row.inputChars)} 字`;
      if (isRoot && row.top3Sessions.length > 0) {
        const top3 = row.top3Sessions.map((s) => `${s.sessionName} ${s.count}`).join(" / ");
        return `${i + 1}. ${name.padEnd(10)} ${countPart}   ${top3}`;
      }
      return `${i + 1}. ${name.padEnd(10)} ${countPart}`;
    });

    const totalMsgs = stats.rows.reduce((sum, r) => sum + r.total, 0);
    const totalInputChars = stats.rows.reduce((sum, r) => sum + r.inputChars, 0);
    const footer = `\n共 ${stats.rows.length} 位用户，${formatCount(totalMsgs)} 条消息，${formatCount(totalInputChars)} 字输入`;

    return { replyText: [title, "", ...lines, footer].join("\n") };
  };
}
