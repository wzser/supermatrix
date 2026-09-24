import type { CommandHandler } from "../commandRegistry.ts";
import type { Clock } from "../../ports/Clock.ts";
import { asTimestamp } from "../../domain/ids.ts";
import { formatRelativeChinese } from "../../domain/format.ts";

export type UsageHandlerDeps = {
  /**
   * Returns the raw sm-switch quota snapshot JSON, or null when the file does
   * not exist yet. Reading lives outside the handler so the render path stays
   * testable without touching the runtime filesystem.
   */
  loadSnapshotText(): Promise<string | null>;
  clock: Clock;
};

export const QUOTA_SNAPSHOT_CONTRACT = "sm-switch.quota-snapshot/v1";

const VENDOR_INDENT = "";
const ACCOUNT_INDENT = "  ";
const WINDOW_INDENT = "    ";
const WINDOW_LABEL_WIDTH = 14;
const REMAINING_WIDTH = 12;

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function padEndVisual(s: string, width: number): string {
  const w = visualWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

const SHANGHAI_DATETIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// Composed from parts rather than a second formatter: dropping `year` flips
// most locales' field order (sv-SE renders "11/08 08:53" for Aug 11).
function shortFromFull(full: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/u.exec(full);
  return m ? `${m[1]}-${m[2]} ${m[3]}` : full;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function formatFull(iso: unknown): string {
  const ms = parseIso(iso);
  if (ms === null) return "未知";
  return SHANGHAI_DATETIME.format(new Date(ms)) + " CST";
}

function formatShort(iso: unknown): string {
  const ms = parseIso(iso);
  if (ms === null) return "—";
  return shortFromFull(SHANGHAI_DATETIME.format(new Date(ms)));
}

function formatPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

const STATUS_REASON_TEXT: Record<string, string> = {
  never_observed: "从未采集",
  inactive_account: "非活跃账号，不主动刷新",
  account_identity_missing: "账号身份缺失",
  account_identity_mismatch: "账号身份不匹配",
  collection_unavailable: "采集通道不可用",
  receipt_before_activation: "回执早于账号启用",
  source_observation_old: "来源观测过旧",
  collection_failed: "采集失败",
};

function reasonText(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  return STATUS_REASON_TEXT[reason] ?? reason;
}

type Window = { label: string; remainingPercent: unknown; resetAt: unknown };
type Account = {
  label: string;
  active: boolean;
  status: string;
  statusReason: unknown;
  stale: boolean;
  plan: string | null;
  observedAt: unknown;
  windows: Window[];
};
type Vendor = { label: string; accounts: Account[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type ParsedSnapshot = {
  generatedAt: unknown;
  staleAfterSeconds: number;
  vendors: Vendor[];
};

/**
 * Projects only the fields /usage renders. The snapshot deliberately carries no
 * tokens, credentials, config paths or account emails, and this projection is
 * what keeps that guarantee true for the command output as well: anything not
 * listed here can never reach Feishu.
 */
function parseSnapshot(text: string): ParsedSnapshot | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "额度快照不是合法 JSON，请联系 sm-switch 检查。" };
  }
  if (!isRecord(raw)) return { error: "额度快照格式异常（顶层不是对象）。" };
  if (raw["contract"] !== QUOTA_SNAPSHOT_CONTRACT) {
    return {
      error:
        `额度快照契约不匹配（期望 ${QUOTA_SNAPSHOT_CONTRACT}，实际 ${String(raw["contract"])}），` +
        "本命令暂不渲染以免展示错误数值。",
    };
  }
  const rawVendors = raw["vendors"];
  if (!Array.isArray(rawVendors)) return { error: "额度快照缺少 vendors 列表。" };

  const vendors: Vendor[] = [];
  for (const rv of rawVendors) {
    if (!isRecord(rv)) continue;
    const rawAccounts = Array.isArray(rv["accounts"]) ? rv["accounts"] : [];
    const accounts: Account[] = [];
    for (const ra of rawAccounts) {
      if (!isRecord(ra)) continue;
      const quota = isRecord(ra["quota"]) ? ra["quota"] : null;
      const rawWindows = quota && Array.isArray(quota["windows"]) ? quota["windows"] : [];
      const windows: Window[] = [];
      for (const rw of rawWindows) {
        if (!isRecord(rw)) continue;
        windows.push({
          label: String(rw["label"] ?? rw["id"] ?? "?"),
          remainingPercent: rw["remainingPercent"],
          resetAt: rw["resetAt"],
        });
      }
      accounts.push({
        label: String(ra["label"] ?? "?"),
        active: ra["active"] === true,
        status: typeof ra["status"] === "string" ? ra["status"] : "unavailable",
        statusReason: ra["statusReason"],
        stale: ra["stale"] === true,
        plan: quota && typeof quota["plan"] === "string" ? quota["plan"] : null,
        observedAt: quota ? quota["observedAt"] : null,
        windows,
      });
    }
    vendors.push({ label: String(rv["label"] ?? rv["id"] ?? "?"), accounts });
  }

  const staleAfter = raw["staleAfterSeconds"];
  return {
    generatedAt: raw["generatedAt"],
    staleAfterSeconds: typeof staleAfter === "number" && staleAfter > 0 ? staleAfter : 900,
    vendors,
  };
}

function accountStatusLine(account: Account): string {
  const marks: string[] = [];
  marks.push(account.active ? "当前账号" : "非当前账号");
  if (account.status === "unavailable") {
    marks.push("不可用");
  } else if (account.status === "stale" || account.stale) {
    // Never let an old reading read as live: the observation time is part of
    // the label, not a footnote.
    marks.push(`旧值（观测于 ${formatFull(account.observedAt)}）`);
  } else {
    marks.push("实时");
  }
  const reason = reasonText(account.statusReason);
  if (reason) marks.push(reason);
  if (account.plan) marks.push(`plan ${account.plan}`);
  return marks.join(" · ");
}

function renderAccount(account: Account): string[] {
  const lines = [`${ACCOUNT_INDENT}${account.label}  [${accountStatusLine(account)}]`];
  if (account.windows.length === 0) {
    lines.push(`${WINDOW_INDENT}（无额度数据）`);
    return lines;
  }
  for (const w of account.windows) {
    lines.push(
      WINDOW_INDENT +
        padEndVisual(w.label, WINDOW_LABEL_WIDTH) +
        padEndVisual(`剩余 ${formatPercent(w.remainingPercent)}`, REMAINING_WIDTH) +
        `重置 ${formatShort(w.resetAt)}`,
    );
  }
  return lines;
}

export function createUsageHandler(deps: UsageHandlerDeps): CommandHandler {
  return async () => {
    let text: string | null;
    try {
      text = await deps.loadSnapshotText();
    } catch (err) {
      return {
        replyText: `读取额度快照失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (text === null) {
      return { replyText: "还没有额度快照（sm-switch 尚未生成），稍后再试。" };
    }

    const parsed = parseSnapshot(text);
    if ("error" in parsed) return { replyText: parsed.error };

    const now = deps.clock.now();
    const generatedMs = parseIso(parsed.generatedAt);
    const lines: string[] = [];
    const age =
      generatedMs === null
        ? "未知"
        : formatRelativeChinese(asTimestamp(generatedMs), asTimestamp(now));
    lines.push(`快照生成于 ${formatFull(parsed.generatedAt)}（${age}）`);
    if (generatedMs !== null && now - generatedMs > parsed.staleAfterSeconds * 1000) {
      // A "fresh" account flag only describes the moment the snapshot was
      // written; once the file itself ages past its own threshold nothing in it
      // may be presented as live.
      lines.push(
        `⚠️ 快照已超过 ${Math.round(parsed.staleAfterSeconds / 60)} 分钟未刷新，以下数值一律按旧值看待`,
      );
    }
    lines.push("");

    for (const vendor of parsed.vendors) {
      lines.push(VENDOR_INDENT + vendor.label);
      if (vendor.accounts.length === 0) {
        lines.push(`${ACCOUNT_INDENT}（无账号）`);
        continue;
      }
      for (const account of vendor.accounts) {
        lines.push(...renderAccount(account));
      }
    }

    // Wrap in a markdown code fence so Feishu renders it monospace — the
    // columns only line up in a fixed-width font.
    const body = "```\n" + lines.join("\n") + "\n```";
    return { replyCard: { title: "订阅额度", body } };
  };
}
