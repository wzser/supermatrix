import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createNotifyClient } from "../notify/console.js";

const TARGET_CHAT_ID = process.env.WATCHDOG_WEEKLY_RANK_CHAT_ID ?? "";
const LARK = process.env.WATCHDOG_LARK_CLI_PATH ?? process.env.SM_LARK_CLI_PATH ?? "lark-cli";
const DB_PATH = process.env.SM_DB_PATH ?? "";
const DISPLAY_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const SENT_LOCK_PATH = "/tmp/weekly-rank-last-sent";
const DEDUP_WINDOW_MS = 23 * 60 * 60 * 1000;
const OPEN_ID_RE = /^ou_[A-Za-z0-9]+$/u;
const REAL_USER_FILTER_SQL = "mr.sender_id GLOB 'ou_*'";
const RANK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RANK_LINK_RE = /data:[^\s"'<>]+|https?:\/\/[^\s"'<>]+|www\.[^\s"'<>]+/giu;

type RankRow = {
  sender_id: string;
  total: number;
  input_chars: number;
  sessions: Map<string, number>;
};

type Top3Row = {
  session_name: string;
  cnt: number;
};

type MessageRow = {
  sender_id: string;
  prompt: string;
  session_name: string;
};

type DisplayNameRow = {
  sender_id: string;
  display_name: string;
  fetched_at: number;
};

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function countRankInputChars(prompt: string): number {
  return prompt.replace(RANK_LINK_RE, "").trim().length;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  // Idempotency guard: skip if already sent within 23h (prevents duplicate sends on scheduler retry)
  if (!dryRun && existsSync(SENT_LOCK_PATH)) {
    const age = Date.now() - statSync(SENT_LOCK_PATH).mtimeMs;
    if (age < DEDUP_WINDOW_MS) {
      console.log(`weekly-rank: already sent ${Math.round(age / 60000)}m ago, skipping`);
      return;
    }
  }

  const db = new Database(DB_PATH);

  try {
    const windowStart = Date.now() - RANK_WINDOW_MS;
    const messageRows = db
      .prepare(
        `SELECT mr.sender_id, mr.prompt, s.name as session_name
         FROM message_runs mr
         JOIN sessions s ON s.id = mr.session_id
         WHERE ${REAL_USER_FILTER_SQL} AND mr.started_at >= ?
         ORDER BY mr.started_at ASC`,
      )
      .all(windowStart) as MessageRow[];

    const totals = new Map<string, RankRow>();
    for (const row of messageRows) {
      const current = totals.get(row.sender_id) ?? {
        sender_id: row.sender_id,
        total: 0,
        input_chars: 0,
        sessions: new Map<string, number>(),
      };
      current.total += 1;
      current.input_chars += countRankInputChars(row.prompt);
      current.sessions.set(row.session_name, (current.sessions.get(row.session_name) ?? 0) + 1);
      totals.set(row.sender_id, current);
    }

    const rows = Array.from(totals.values()).sort(
      (a, b) => b.total - a.total || b.input_chars - a.input_chars,
    );

    if (rows.length === 0) {
      const text = "📊 近 7 天暂无数据。";
      if (dryRun) {
        console.log(text);
        return;
      }
      execFileSync(
        LARK,
        ["im", "+messages-send", "--as", "bot", "--chat-id", TARGET_CHAT_ID, "--text", text],
        { encoding: "utf-8", timeout: 30_000 },
      );
      return;
    }

    const since = formatDate(windowStart);

    // Resolve display names from cache (TTL 24h)
    const senderIds = rows.map((r) => r.sender_id);
    const placeholders = senderIds.map(() => "?").join(",");
    const cached = db
      .prepare(
        `SELECT sender_id, display_name, fetched_at FROM user_display_names WHERE sender_id IN (${placeholders})`,
      )
      .all(...senderIds) as DisplayNameRow[];

    const now = Date.now();
    const nameMap = new Map<string, string>();
    for (const row of cached) {
      if (now - row.fetched_at < DISPLAY_NAME_TTL_MS) {
        nameMap.set(row.sender_id, row.display_name);
      }
    }

    // Fetch missing/expired names from Feishu API and write to cache
    const upsertName = db.prepare(
      "INSERT OR REPLACE INTO user_display_names (sender_id, display_name, fetched_at) VALUES (?, ?, ?)",
    );
    for (const id of senderIds) {
      if (nameMap.has(id)) continue;
      if (!OPEN_ID_RE.test(id)) continue;
      try {
        const raw = execFileSync(
          LARK,
          ["contact", "+get-user", "--user-id", id, "--user-id-type", "open_id"],
          { encoding: "utf-8", timeout: 10_000 },
        );
        const name: string | undefined = JSON.parse(raw)?.data?.user?.name;
        if (name) {
          upsertName.run(id, name, Date.now());
          nameMap.set(id, name);
        }
      } catch {
        // ignore — falls back to sender_id suffix below
      }
    }

    // Build leaderboard lines
    const lines = rows.map((row, i) => {
      const name = nameMap.get(row.sender_id) ?? row.sender_id.slice(-8);

      const top3 = Array.from(row.sessions.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([session_name, cnt]) => ({ session_name, cnt })) as Top3Row[];

      const top3Str =
        top3.length > 0
          ? "   " + top3.map((s) => `${s.session_name} ${s.cnt}`).join(" / ")
          : "";

      return `${i + 1}. ${name.padEnd(10)} ${formatCount(row.total)} 条 / ${formatCount(row.input_chars)} 字${top3Str}`;
    });

    const totalMsgs = rows.reduce((sum, r) => sum + r.total, 0);
    const totalInputChars = rows.reduce((sum, r) => sum + r.input_chars, 0);
    const text = [
      `📊 SuperMatrix 消息排行榜（近 7 天，自 ${since}）`,
      ``,
      ...lines,
      ``,
      `共 ${rows.length} 位用户，${formatCount(totalMsgs)} 条消息，${formatCount(totalInputChars)} 字输入`,
    ].join("\n");

    if (dryRun) {
      console.log(text);
      return;
    }

    execFileSync(
      LARK,
      ["im", "+messages-send", "--as", "bot", "--chat-id", TARGET_CHAT_ID, "--text", text],
      { encoding: "utf-8", timeout: 30_000 },
    );
    writeFileSync(SENT_LOCK_PATH, String(Date.now()));
    console.log(`weekly-rank sent to ${TARGET_CHAT_ID}`);
  } finally {
    db.close();
  }
}

main().catch(async (err) => {
  const reason = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error("weekly-rank failed:", reason);
  try {
    const notify = createNotifyClient();
    await notify.notify({
      source: "watchdog",
      title: "消息排行榜周报失败",
      level: "error",
      body: `weekly-rank 失败：${err instanceof Error ? err.message : String(err)}`,
    });
  } catch (notifyErr) {
    console.error("notify also failed:", notifyErr);
  }
  process.exit(1);
});
