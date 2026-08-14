import { execFileSync } from "node:child_process";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createNotifyClient } from "../notify/console.js";

const TARGET_CHAT_ID = "oc_REDACTEDCHATID";
const LARK = "/Users/LOCAL_USER/SuperMatrix/node_modules/.bin/lark-cli";
const KIMI_HOME = process.env.SM_KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");

// ccusage daily --since accepts YYYYMMDD; @ccusage/codex accepts YYYY-MM-DD or
// YYYYMMDD. Use compact form for both.
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ymdCompact(d: Date): string {
  return ymd(d).replace(/-/g, "");
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Previous calendar week (Mon ~ Sun). On Monday this returns the just-ended week.
function previousWeekRange(now: Date): { start: Date; end: Date } {
  const today = startOfDay(now);
  const dow = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceLastMonday = dow === 0 ? 13 : dow + 6;
  const start = new Date(today);
  start.setDate(today.getDate() - daysSinceLastMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start, end };
}

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function runJson(pkg: string, args: string[]): unknown {
  // Defensive timeout/buffer: cumulative ccusage output can exceed Node's 1MB
  // default in heavy weeks, and the npx fetch leg occasionally takes >30s.
  //
  // Retry on ENOENT: ccusage walks ~/.claude/projects/<dir>/*.jsonl. The legacy
  // /Users/LOCAL_USER/SuperMatrix project dir is still actively written by
  // claude-code, so readdir/open can race — listed file gets rotated away before
  // ccusage opens it (observed 2026-05-11 09:00 run). One retry usually clears it.
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = execFileSync("npx", ["-y", pkg, ...args, "--json"], {
        encoding: "utf-8",
        timeout: 300_000,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      return JSON.parse(out);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? (err.message + (("stderr" in err) ? String((err as { stderr?: unknown }).stderr ?? "") : "")) : String(err);
      if (msg.includes("ENOENT") && attempt < maxAttempts) {
        console.error(`[weekly-token-report] ${pkg} ENOENT race, retry ${attempt}/${maxAttempts - 1}`);
        sleepSync(1000 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

type CcTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
};

type CxTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUSD: number;
};

type KimiTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

// Kimi Code usage: ACP carries no usage notifications, but every kimi-code
// session writes usage.record events (one per LLM call, non-cumulative) into
// ~/.kimi-code/sessions/<wd>/<session>/agents/<agent>/wire.jsonl. Scanning
// those logs mirrors how ccusage walks ~/.claude / ~/.codex — machine-wide,
// including sessions SuperMatrix did not drive. Kimi is a subscription
// product, so only token counts are reported (no USD).
function listKimiWireFiles(): string[] {
  const sessionsRoot = join(KIMI_HOME, "sessions");
  const out: string[] = [];
  let wdDirs: string[];
  try {
    wdDirs = readdirSync(sessionsRoot);
  } catch {
    return out;
  }
  for (const wd of wdDirs) {
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(join(sessionsRoot, wd));
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      let agentDirs: string[];
      try {
        agentDirs = readdirSync(join(sessionsRoot, wd, sid, "agents"));
      } catch {
        continue;
      }
      for (const agent of agentDirs) {
        const wire = join(sessionsRoot, wd, sid, "agents", agent, "wire.jsonl");
        try {
          if (statSync(wire).isFile()) out.push(wire);
        } catch {
          // no wire log for this agent
        }
      }
    }
  }
  return out;
}

function emptyKimiTotals(): KimiTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addKimiRecord(t: KimiTotals, usage: Record<string, unknown>): void {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  t.inputTokens += num(usage["inputOther"]);
  t.outputTokens += num(usage["output"]);
  t.cacheReadTokens += num(usage["inputCacheRead"]);
  t.cacheWriteTokens += num(usage["inputCacheCreation"]);
}

async function collectKimiUsage(
  weekStartMs: number,
  weekEndMs: number,
): Promise<{ week: KimiTotals; all: KimiTotals }> {
  const week = emptyKimiTotals();
  const all = emptyKimiTotals();
  for (const wire of listKimiWireFiles()) {
    const rl = createInterface({ input: createReadStream(wire, "utf-8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage.record"')) continue;
      let rec: { type?: unknown; time?: unknown; usage?: Record<string, unknown> };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== "usage.record" || !rec.usage) continue;
      addKimiRecord(all, rec.usage);
      const t = typeof rec.time === "number" ? rec.time : 0;
      if (t >= weekStartMs && t <= weekEndMs) addKimiRecord(week, rec.usage);
    }
  }
  for (const t of [week, all]) {
    t.totalTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  }
  return { week, all };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const now = new Date();
  const { start, end } = previousWeekRange(now);

  const ccWeek = runJson("ccusage@latest", [
    "claude",
    "daily",
    "--since",
    ymdCompact(start),
    "--until",
    ymdCompact(end),
  ]) as { totals: CcTotals };
  const ccAll = runJson("ccusage@latest", ["claude", "daily"]) as { totals: CcTotals };
  const cxWeek = runJson("ccusage@latest", [
    "codex",
    "daily",
    "--since",
    ymdCompact(start),
    "--until",
    ymdCompact(end),
  ]) as { totals: CxTotals };
  const cxAll = runJson("ccusage@latest", ["codex", "daily"]) as { totals: CxTotals };

  const ccWeekT = ccWeek.totals.totalTokens;
  const ccWeekC = ccWeek.totals.totalCost;
  const ccAllT = ccAll.totals.totalTokens;
  const ccAllC = ccAll.totals.totalCost;
  const cxWeekT = cxWeek.totals.totalTokens;
  const cxWeekC = cxWeek.totals.costUSD;
  const cxAllT = cxAll.totals.totalTokens;
  const cxAllC = cxAll.totals.costUSD;

  // Kimi Code: token counts from local wire logs (no USD — subscription).
  const kimi = await collectKimiUsage(start.getTime(), end.getTime() + 86_400_000 - 1);

  const lines = [
    `📊 Token 周报  上周 (${ymd(start)} ~ ${ymd(end)})`,
    ``,
    `Claude Code`,
    `  本周  ${fmtTokens(ccWeekT)} tokens   ${fmtUsd(ccWeekC)}`,
    `  累计  ${fmtTokens(ccAllT)} tokens   ${fmtUsd(ccAllC)}`,
    ``,
    `Codex CLI`,
    `  本周  ${fmtTokens(cxWeekT)} tokens   ${fmtUsd(cxWeekC)}`,
    `  累计  ${fmtTokens(cxAllT)} tokens   ${fmtUsd(cxAllC)}`,
    ``,
    `Kimi Code`,
    `  本周  ${fmtTokens(kimi.week.totalTokens)} tokens   (订阅)`,
    `  累计  ${fmtTokens(kimi.all.totalTokens)} tokens   (订阅)`,
    ``,
    `合计(Claude+Codex)  本周 ${fmtUsd(ccWeekC + cxWeekC)}   累计 ${fmtUsd(ccAllC + cxAllC)}`,
  ];
  const text = lines.join("\n");

  if (dryRun) {
    console.log(text);
    return;
  }

  execFileSync(
    LARK,
    [
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      TARGET_CHAT_ID,
      "--text",
      text,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
  console.log(`weekly-token-report sent to ${TARGET_CHAT_ID}`);
}

main().catch(async (err) => {
  const reason = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error("weekly-token-report failed:", reason);
  try {
    const notify = createNotifyClient();
    await notify.notify({
      source: "watchdog",
      title: "Token 周报失败",
      level: "error",
      body: `weekly-token-report 失败：${err instanceof Error ? err.message : String(err)}`,
    });
  } catch (notifyErr) {
    console.error("notify also failed:", notifyErr);
  }
  process.exit(1);
});
