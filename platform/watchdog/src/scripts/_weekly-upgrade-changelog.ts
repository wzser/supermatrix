// weekly CLI upgrade 的 changelog 抓取：do entry 在派 root review 前把
// before→after 区间内每个版本的官方 changelog 条目抓下来，直接嵌进 review
// prompt 并存档。这样 review 的输入是确定的，不依赖 root 现场检索；
// report entry 再用 coverageExpectations 校验 root 的 ## Changelog coverage
// 段逐版本覆盖（见 _weekly-upgrade-shared.ts assessChangelogCoverage）。
//
// 来源（与 docs/weekly-cli-upgrade-checklist.md 保持一致）：
// - claude-code: GitHub anthropics/claude-code CHANGELOG.md
// - codex:       GitHub openai/codex releases（tag rust-v<version>）
// - lark-cli:    npm registry @larksuite/cli（仅版本号+发布时间，无正文）
// - kimi-code:   GitHub MoonshotAI/kimi-code releases（tag @moonshot-ai/kimi-code@<version>）
//
// 抓取失败 fail-open：review 照派，capture 标 unavailable 并在 prompt 里
// 要求 root 自行取源；coverage 校验只对抓到版本列表的 CLI 生效。

import type { ChangelogCoverageExpectation } from "./_weekly-upgrade-shared.js";

export const CLAUDE_CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
export const CODEX_RELEASES_URL =
  "https://api.github.com/repos/openai/codex/releases?per_page=60";
export const LARK_CLI_REGISTRY_URL = "https://registry.npmjs.org/@larksuite/cli";
export const KIMI_RELEASES_URL =
  "https://api.github.com/repos/MoonshotAI/kimi-code/releases?per_page=60";

const FETCH_TIMEOUT_MS = 20000;
const MAX_BODY_PER_CLI = 6000;

export type ChangelogVersionEntry = {
  version: string;
  publishedAt?: string;
  body?: string;
};

export type CliChangelogCapture = {
  cli: string;
  before: string;
  after: string;
  status: "ok" | "unavailable" | "skipped";
  source: string;
  versions: ChangelogVersionEntry[];
  reason?: string;
};

// 数字点分版本比较；非数字段按字符串比较兜底，unknown 永远最小。
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "unknown") return -1;
  if (b === "unknown") return 1;
  const as = a.split(/[.+-]/);
  const bs = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = as[i];
    const bv = bs[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

// 半开区间 (before, after]：升级后的目标版本含在内，起点版本已在上次 review 覆盖。
export function versionInRange(version: string, before: string, after: string): boolean {
  return compareVersions(version, before) > 0 && compareVersions(version, after) <= 0;
}

export function filterVersionRange(
  entries: ChangelogVersionEntry[],
  before: string,
  after: string,
): ChangelogVersionEntry[] {
  return entries
    .filter((entry) => versionInRange(entry.version, before, after))
    .sort((a, b) => compareVersions(a.version, b.version));
}

// 解析 Claude Code CHANGELOG.md：`## X.Y.Z` 段落切分。
export function parseClaudeChangelogMarkdown(markdown: string): ChangelogVersionEntry[] {
  const entries: ChangelogVersionEntry[] = [];
  const matches = [...markdown.matchAll(/^##\s+(\d+\.\d+\.\S+)[^\n]*\n/gm)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : markdown.length;
    entries.push({ version: match[1]!, body: markdown.slice(start, end).trim() });
  }
  return entries;
}

function parseGithubReleases(releases: unknown, tagToVersion: (tag: string) => string): ChangelogVersionEntry[] {
  if (!Array.isArray(releases)) return [];
  const entries: ChangelogVersionEntry[] = [];
  for (const release of releases) {
    if (!release || typeof release !== "object") continue;
    const rec = release as Record<string, unknown>;
    const tag = typeof rec.tag_name === "string" ? rec.tag_name : "";
    const version = tagToVersion(tag);
    if (!/^\d+\.\d+\.\d+/.test(version)) continue;
    entries.push({
      version,
      ...(typeof rec.published_at === "string" ? { publishedAt: rec.published_at } : {}),
      ...(typeof rec.body === "string" && rec.body.trim() ? { body: rec.body.trim() } : {}),
    });
  }
  return entries;
}

// openai/codex 的 tag 形如 rust-v0.146.1。
export function parseCodexReleases(releases: unknown): ChangelogVersionEntry[] {
  return parseGithubReleases(releases, (tag) => tag.replace(/^rust-v/, "").replace(/^v/, ""));
}

// MoonshotAI/kimi-code 的 tag 形如 @moonshot-ai/kimi-code@0.33.0。
export function parseKimiReleases(releases: unknown): ChangelogVersionEntry[] {
  return parseGithubReleases(releases, (tag) => tag.replace(/^.*@/, ""));
}

// 解析 npm registry 文档：只有版本号和发布时间，没有 changelog 正文。
export function parseNpmRegistryVersions(doc: unknown): ChangelogVersionEntry[] {
  if (!doc || typeof doc !== "object") return [];
  const rec = doc as Record<string, unknown>;
  const versions = rec.versions && typeof rec.versions === "object" ? Object.keys(rec.versions as object) : [];
  const time = rec.time && typeof rec.time === "object" ? rec.time as Record<string, unknown> : {};
  return versions.map((version) => ({
    version,
    ...(typeof time[version] === "string" ? { publishedAt: time[version] as string } : {}),
  }));
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "watchdog-weekly-cli-upgrade" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "watchdog-weekly-cli-upgrade" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

async function captureOne(change: { cli: string; before: string; after: string }): Promise<CliChangelogCapture> {
  const { cli, before, after } = change;
  try {
    if (cli === "claude-code") {
      const markdown = await fetchText(CLAUDE_CHANGELOG_URL);
      return {
        cli, before, after, status: "ok", source: CLAUDE_CHANGELOG_URL,
        versions: filterVersionRange(parseClaudeChangelogMarkdown(markdown), before, after),
      };
    }
    if (cli === "codex") {
      const releases = await fetchJson(CODEX_RELEASES_URL);
      return {
        cli, before, after, status: "ok", source: CODEX_RELEASES_URL,
        versions: filterVersionRange(parseCodexReleases(releases), before, after),
      };
    }
    if (cli === "lark-cli") {
      const doc = await fetchJson(LARK_CLI_REGISTRY_URL);
      return {
        cli, before, after, status: "ok", source: LARK_CLI_REGISTRY_URL,
        versions: filterVersionRange(parseNpmRegistryVersions(doc), before, after),
        reason: "npm registry 无 changelog 正文，仅版本号与发布时间",
      };
    }
    if (cli === "kimi-code") {
      const releases = await fetchJson(KIMI_RELEASES_URL);
      return {
        cli, before, after, status: "ok", source: KIMI_RELEASES_URL,
        versions: filterVersionRange(parseKimiReleases(releases), before, after),
      };
    }
    return { cli, before, after, status: "skipped", source: "none", versions: [], reason: `no changelog source registered for ${cli}` };
  } catch (error) {
    return {
      cli, before, after, status: "unavailable", source: "fetch-failed",
      versions: [],
      reason: (error as Error).message.slice(0, 200),
    };
  }
}

export async function captureChangelogs(
  changes: { cli: string; before: string; after: string }[],
): Promise<CliChangelogCapture[]> {
  return Promise.all(changes.map((change) => captureOne(change)));
}

// review prompt 用的材料段。正文超长时按版本边界截断并注明。
export function formatChangelogSection(captures: CliChangelogCapture[]): string {
  if (captures.length === 0) return "（本周无 CLI 版本变更，无 changelog 材料）";
  const parts: string[] = [];
  for (const capture of captures) {
    const header = `### ${capture.cli} ${capture.before} → ${capture.after}（来源：${capture.source}）`;
    if (capture.status !== "ok") {
      parts.push(`${header}\nwatchdog 抓取${capture.status === "skipped" ? "跳过" : "失败"}：${capture.reason ?? "unknown"}。${capture.status === "unavailable" ? "请自行取源核对该区间后再填 Changelog coverage。" : ""}`);
      continue;
    }
    if (capture.versions.length === 0) {
      parts.push(`${header}\n区间内未解析到版本条目（可能来源尚未收录该版本）；请自行确认后填 Changelog coverage。`);
      continue;
    }
    let budget = MAX_BODY_PER_CLI;
    const lines: string[] = [header];
    for (const entry of capture.versions) {
      const bodyRaw = entry.body?.trim() ?? "（该来源无正文，仅版本记录）";
      const body = bodyRaw.length > budget ? `${bodyRaw.slice(0, budget)}\n…（截断，全文见 watchdog 存档）` : bodyRaw;
      budget = Math.max(0, budget - body.length);
      lines.push(`#### ${entry.version}${entry.publishedAt ? `（${entry.publishedAt}）` : ""}\n${body}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

// report entry 校验用：只有真的抓到版本列表的 CLI 才要求逐版本覆盖。
export function coverageExpectations(captures: CliChangelogCapture[]): ChangelogCoverageExpectation[] {
  return captures
    .filter((capture) => capture.status === "ok" && capture.versions.length > 0)
    .map((capture) => ({ cli: capture.cli, versions: capture.versions.map((entry) => entry.version) }));
}
