// 共享给 weekly-upgrade.ts (do entry) 与 weekly-upgrade-report.ts (report entry)。
// 两 entry 通过 PENDING_FILE 做 handoff：do 写入 → report 读、轮询、清。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type UpgradeResult = {
  cli: string;
  before: string;
  after: string;
  changed: boolean;
  error?: string;
};

export type PendingState = {
  runDate: string;        // "YYYY-MM-DD"
  spawnedAt: number;      // ms epoch
  childSessionId: string;
  results: UpgradeResult[];
};

export const LOG_FILE = join(process.cwd(), "data", "cli-upgrade.log");
export const PENDING_FILE = join(process.cwd(), "data", "pending-upgrade-review.json");
// Stable path scheduler watches via receiptProof external_evidence file engine.
// Script touches it once writeLog succeeds — so even if notify/spawn hangs later
// in the run, scheduler still finds "upgrade phase completed" evidence.
export const RECEIPT_FILE = join(process.cwd(), "data", "scheduler_receipts", "weekly-cli-upgrade.receipt");
export const SPAWN_API = "http://localhost:3501/api/spawn";
export const ROOT_SESSION = "supermatrix-root";
export const SOURCE_SESSION = "watchdog";
export const SUPERMATRIX_REPO = process.env.SM_REPO_ROOT ?? process.cwd();
export const UPGRADE_COMMIT_MESSAGE_REGEX =
  "(?:update lark cli dependency|adapt to (?:claude-code|codex|lark-cli)@|weekly CLI upgrade)";

export type RootReviewSpawnBody = {
  target: typeof ROOT_SESSION;
  from: typeof SOURCE_SESSION;
  prompt: string;
  verification_predicate: {
    type: "git-log";
    repo_path: typeof SUPERMATRIX_REPO;
    since: { kind: "spawn_created_at" };
    message_regex: typeof UPGRADE_COMMIT_MESSAGE_REGEX;
    min_count: 1;
    expected_window_sec: 28800;
  };
};

type SpawnAdmissionErrorBody = {
  code?: unknown;
  error?: unknown;
  details?: unknown;
};

export function buildRootReviewSpawnBody(prompt: string): RootReviewSpawnBody {
  return {
    target: ROOT_SESSION,
    from: SOURCE_SESSION,
    prompt,
    verification_predicate: {
      type: "git-log",
      repo_path: SUPERMATRIX_REPO,
      since: { kind: "spawn_created_at" },
      message_regex: UPGRADE_COMMIT_MESSAGE_REGEX,
      min_count: 1,
      expected_window_sec: 28800,
    },
  };
}

export function formatSpawnAdmissionError(status: number, body: unknown): string {
  if (!body || typeof body !== "object") return `HTTP ${status}`;
  const parsed = body as SpawnAdmissionErrorBody;
  const code = typeof parsed.code === "string" ? ` ${parsed.code}` : "";
  const error = typeof parsed.error === "string" ? `: ${parsed.error}` : "";
  const details = Array.isArray(parsed.details)
    ? parsed.details.filter((detail): detail is string => typeof detail === "string").join("; ")
    : "";
  return `HTTP ${status}${code}${error}${details ? ` - ${details}` : ""}`;
}

export function writeReceipt(payload: Record<string, unknown>): void {
  mkdirSync(dirname(RECEIPT_FILE), { recursive: true });
  writeFileSync(RECEIPT_FILE, JSON.stringify({ writtenAt: Date.now(), ...payload }, null, 2));
}

export function readPending(): PendingState | null {
  if (!existsSync(PENDING_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PENDING_FILE, "utf-8")) as PendingState;
  } catch {
    return null;
  }
}

export function writePending(state: PendingState): void {
  mkdirSync(dirname(PENDING_FILE), { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify(state, null, 2));
}

export function clearPending(): void {
  if (existsSync(PENDING_FILE)) rmSync(PENDING_FILE);
}

export function fileProposedAsIssues(rootReview: string): { count: number; ids: string[]; failed: number } {
  // 解析 root finalMessage 里的 ## Proposed for human 段，每条 bullet 自动 add
  // 进 watchdog 队列，避免 "看一眼忘了"。
  const idx = rootReview.search(/^##\s*Proposed for human\b/im);
  if (idx < 0) return { count: 0, ids: [], failed: 0 };
  const after = rootReview.slice(idx).replace(/^##\s*Proposed for human[^\n]*\n/, "");
  const sectionEnd = after.search(/\n##\s/);
  const section = (sectionEnd >= 0 ? after.slice(0, sectionEnd) : after).trim();
  if (section === "" || section === "无") return { count: 0, ids: [], failed: 0 };

  const bullets: string[] = [];
  let current = "";
  for (const line of section.split("\n")) {
    if (/^- /.test(line)) {
      if (current.trim()) bullets.push(current.trim());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) bullets.push(current.trim());

  const filed: string[] = [];
  let failed = 0;
  for (const raw of bullets) {
    const titleMatch = raw.match(/^-\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)/s);
    const title = titleMatch
      ? `[CLI升级 review] ${titleMatch[1].trim().slice(0, 80)}`
      : `[CLI升级 review] ${raw.replace(/^-\s*/, "").split(/\n/)[0].slice(0, 80)}`;
    const description = `(由 weekly CLI upgrade root review 自动登记，待人工决策)\n\n${raw}`;
    try {
      const out = execFileSync("npx", ["tsx", "src/cli.ts", "add",
        "--title", title,
        "--source", "watchdog",
        "--description", description,
      ], { cwd: process.cwd(), encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      const m = out.match(/"id":\s*"([^"]+)"/);
      if (m) filed.push(m[1]);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { count: filed.length, ids: filed, failed };
}

export function fileChecklistMetaAsIssues(rootReview: string): { count: number; ids: string[]; failed: number } {
  // 解析 ## Checklist meta 段。每条建议（+ 增 / - 删 / ~ 改写）独立 add 一条 issue，
  // 由人审后手工编辑 data/upgrade-review-checklist.md。watchdog 自身不动 checklist 文件
  // 避免静默修改 review 规范。
  const idx = rootReview.search(/^##\s*Checklist meta\b/im);
  if (idx < 0) return { count: 0, ids: [], failed: 0 };
  const after = rootReview.slice(idx).replace(/^##\s*Checklist meta[^\n]*\n/, "");
  const sectionEnd = after.search(/\n##\s/);
  const section = (sectionEnd >= 0 ? after.slice(0, sectionEnd) : after).trim();
  if (section === "" || section === "无") return { count: 0, ids: [], failed: 0 };

  // 行级匹配：以 "- +" / "- -" / "- ~" 或 "+" / "-" / "~" 行起头
  const bullets: string[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^-?\s*([+\-~])\s+(.+)$/);
    if (m) bullets.push(`${m[1]} ${m[2].trim()}`);
  }
  if (bullets.length === 0) return { count: 0, ids: [], failed: 0 };

  const opLabel: Record<string, string> = { "+": "增加", "-": "删除", "~": "改写" };
  const filed: string[] = [];
  let failed = 0;
  for (const raw of bullets) {
    const op = raw[0]!;
    const body = raw.slice(2).trim();
    const title = `[CLI升级 checklist meta] ${opLabel[op] ?? op} — ${body.slice(0, 80)}`;
    const description = `(由 weekly CLI upgrade root review 自动登记的 checklist 演化建议，由人审后手工编辑 data/upgrade-review-checklist.md)\n\n操作：${opLabel[op] ?? op}\n建议原文：${raw}`;
    try {
      const out = execFileSync("npx", ["tsx", "src/cli.ts", "add",
        "--title", title,
        "--source", "watchdog",
        "--description", description,
      ], { cwd: process.cwd(), encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      const m = out.match(/"id":\s*"([^"]+)"/);
      if (m) filed.push(m[1]);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { count: filed.length, ids: filed, failed };
}

export function formatUpgradeLines(results: UpgradeResult[]): { lines: string[]; changed: number; failed: number } {
  let changed = 0;
  let failed = 0;
  const lines = results.map((r) => {
    if (r.error) { failed++; return `- ❌ **${r.cli}**: ${r.before} → upgrade failed (${r.error})`; }
    if (r.changed) { changed++; return `- ✅ **${r.cli}**: ${r.before} → ${r.after}`; }
    return `- ⏸ **${r.cli}**: ${r.before}（已是最新）`;
  });
  return { lines, changed, failed };
}
