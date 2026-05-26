import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { join } from "node:path";
import Database from "better-sqlite3";
import { createNotifyClient } from "../notify/console.js";

const SM_DB = process.env.SM_DB_PATH ?? "";
const LARK = process.env.WATCHDOG_LARK_CLI_PATH ?? process.env.SM_LARK_CLI_PATH ?? "lark-cli";
const NOTIFIED_FILE = join(process.cwd(), "data", "idle-notified.json");

type SessionRow = {
  name: string;
  status: string;
  backend: string;
  group_id: string;
};

type NotifiedMap = Record<string, string>;

function loadNotified(): NotifiedMap {
  try {
    return JSON.parse(readFileSync(NOTIFIED_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveNotified(map: NotifiedMap): void {
  writeFileSync(NOTIFIED_FILE, JSON.stringify(map, null, 2));
}

function getIdleSessions(): SessionRow[] {
  const db = new Database(SM_DB, { readonly: true });
  const rows = db.prepare(`
    SELECT s.name, s.status, s.backend, b.group_id
    FROM sessions s JOIN bindings b ON s.id = b.session_id
    WHERE s.status = 'idle' AND s.scope = 'user'
    ORDER BY s.name
  `).all() as SessionRow[];
  db.close();
  return rows;
}

async function getLastBotMessage(groupId: string): Promise<{ content: string; messageId: string } | null> {
  try {
    const { stdout } = await execFileAsync(LARK, [
      "im", "+chat-messages-list",
      "--chat-id", groupId,
      "--sort", "desc",
      "--page-size", "5",
    ], { encoding: "utf-8", timeout: 15000 });

    const data = JSON.parse(stdout);
    const msgs = data?.data?.messages ?? [];
    for (const m of msgs) {
      if (m.sender?.sender_type === "app") {
        return {
          content: (m.content ?? "").slice(0, 500),
          messageId: m.message_id ?? "",
        };
      }
    }
  } catch {}
  return null;
}

async function isWaitingForReply(sessionName: string, lastMessage: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("claude", [
      "-p", "--model", "haiku",
      `这是 AI session "${sessionName}" 发给用户的最后一条消息。判断：这条消息是否在等待用户回复？只回答 YES 或 NO。\n\n${lastMessage}`,
    ], { encoding: "utf-8", timeout: 30000 });
    return stdout.trim().toUpperCase().startsWith("YES");
  } catch {
    return false;
  }
}

async function main() {
  console.log("Checking idle sessions...\n");
  const sessions = getIdleSessions();
  const notified = loadNotified();
  const newNotified: NotifiedMap = {};
  const waiting: Array<{ name: string; snippet: string }> = [];

  const results = await Promise.all(sessions.map(async (s) => {
    const lastMsg = await getLastBotMessage(s.group_id);
    if (!lastMsg) return { session: s, lastMsg: null, isWaiting: false, error: null as string | null };
    try {
      const isWaiting = await isWaitingForReply(s.name, lastMsg.content);
      return { session: s, lastMsg, isWaiting, error: null };
    } catch (err) {
      return { session: s, lastMsg, isWaiting: false, error: (err as Error).message };
    }
  }));

  for (const r of results) {
    if (!r.lastMsg) continue;
    if (r.error) {
      console.error(`Error checking ${r.session.name}:`, r.error);
      continue;
    }
    const status = r.isWaiting ? "⏰ WAITING" : "✅ DONE";
    console.log(`${status} ${r.session.name}`);
    if (r.isWaiting) {
      if (notified[r.session.name] === r.lastMsg.messageId) {
        console.log(`  (已提醒过，跳过)`);
      } else {
        waiting.push({ name: r.session.name, snippet: r.lastMsg.content.slice(0, 100) });
      }
      newNotified[r.session.name] = r.lastMsg.messageId;
    }
  }

  saveNotified(newNotified);

  if (waiting.length === 0) {
    console.log("\n没有新的 session 需要提醒。");
    return;
  }

  const body = waiting
    .map((w) => `- **${w.name}**：${w.snippet.replace(/\n/g, " ")}`)
    .join("\n");

  console.log(`\n以下 ${waiting.length} 个 session 可能在等待回复：\n${body}`);

  const client = createNotifyClient();
  try {
    await client.notify({
      source: "watchdog",
      title: `${waiting.length} 个 session 在等待回复`,
      body,
      level: "info",
      metadata: { count: waiting.length },
    });
    console.log("\n提醒已发送。");
  } catch (err) {
    console.error("发送提醒失败:", (err as Error).message);
  }
}

main();
