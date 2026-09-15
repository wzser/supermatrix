import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ChildCompletionNoticeInput,
  ChildCompletionSummaryProvider,
} from "./childCompletionNotice.ts";
import type { Logger } from "../ports/Logger.ts";

type Env = Record<string, string | undefined>;

type MiniMaxConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

type MiniMaxProviderOptions = MiniMaxConfig & {
  fetchFn?: typeof fetch;
};

export function createMiniMaxChildCompletionSummaryProvider(
  env: Env = process.env,
  logger?: Logger,
): ChildCompletionSummaryProvider | undefined {
  const config = resolveMiniMaxConfig(env);
  if (!config.apiKey) {
    logger?.warn("child completion MiniMax summary disabled: API key missing");
    return undefined;
  }
  return miniMaxChildCompletionSummaryProvider(config);
}

export function miniMaxChildCompletionSummaryProvider(
  options: MiniMaxProviderOptions,
): ChildCompletionSummaryProvider {
  const fetchFn = options.fetchFn ?? fetch;
  return async (input) => {
    const finalMessage = input.finalMessage?.trim();
    if (!finalMessage) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetchFn(`${options.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: buildSummaryPrompt(input) }],
          temperature: 0,
          max_tokens: 512,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`MiniMax summary failed with HTTP ${response.status}: ${raw}`);
      }
      const data = JSON.parse(raw) as unknown;
      const content = readMiniMaxContent(data);
      return preferUsefulSummary(normalizeShortSummary(content), fallbackChildCompletionSummary(input));
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function normalizeShortSummary(raw: string): string | null {
  const withoutThinking = stripMiniMaxThinking(raw) || extractQuotedSummaryFromThinking(raw);
  const firstLine = withoutThinking.split(/\r?\n/u).find((line) => line.trim()) ?? "";
  let cleaned = cleanSummaryText(firstLine);
  if (isGenericSummary(cleaned)) {
    const quoted = cleanSummaryText(extractQuotedSummaryFromThinking(raw));
    cleaned = isGenericSummary(quoted) ? "" : quoted;
  }
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, 15).join("");
}

export function fallbackChildCompletionSummary(input: ChildCompletionNoticeInput): string | null {
  const text = input.finalMessage ?? "";
  const lower = text.toLowerCase();
  if (
    lower.includes("lingxing-awd-satellite-cargo")
    || lower.includes("lingxing_awd_satellite_cargo")
    || lower.includes("awd_satellite_cargo")
  ) {
    return "更新AWD卫星仓";
  }
  if (/目标表已更新|table.+updated|数据表已更新/u.test(text)) {
    return "更新数据表";
  }
  if (/提交\s*SHA|commit\s+[0-9a-f]{6,}|committed locally/iu.test(text)) {
    return "提交代码修复";
  }
  if (/tests?.+passed|测试.+通过|验证.+通过/iu.test(text)) {
    return "测试验证通过";
  }
  return null;
}

function preferUsefulSummary(summary: string | null, fallback: string | null): string | null {
  if (summary && Array.from(summary).length >= 4 && !isGenericSummary(summary)) return summary;
  return fallback ?? summary;
}

function cleanSummaryText(value: string): string {
  return value
    .replace(/^内容概括[:：]/u, "")
    .replace(/^标题[:：]/u, "")
    .replace(/^[`"'“”‘’【\[]+/u, "")
    .replace(/[`"'“”‘’】\].。！？!?，,；;：:\s]+$/u, "")
    .replace(/\s+/gu, "")
    .trim();
}

function isGenericSummary(value: string): boolean {
  return /^(子会话|子session|任务)?(已)?(执行)?完成$/iu.test(value);
}

function resolveMiniMaxConfig(env: Env): MiniMaxConfig {
  const registry = loadSmallModelMiniMaxConfig(env);
  return {
    apiKey: firstNonEmpty(
      env["SM_CHILD_COMPLETION_MINIMAX_API_KEY"],
      env["SM_MINIMAX_API_KEY"],
      env["HEARTBEAT_MINIMAX_API_KEY"],
      env["MINIMAX_API_KEY"],
      registry.apiKey,
    ),
    baseUrl: firstNonEmpty(
      env["SM_CHILD_COMPLETION_MINIMAX_BASE_URL"],
      env["SM_MINIMAX_BASE_URL"],
      env["HEARTBEAT_MINIMAX_BASE_URL"],
      registry.baseUrl,
      "https://api.minimaxi.com/v1",
    ),
    model: firstNonEmpty(
      env["SM_CHILD_COMPLETION_MINIMAX_MODEL"],
      env["SM_MINIMAX_MODEL"],
      env["HEARTBEAT_MINIMAX_MODEL"],
      "MiniMax-M2.7",
    ),
    timeoutMs: positiveInt(env["SM_CHILD_COMPLETION_SUMMARY_TIMEOUT_MS"], 15000),
  };
}

function loadSmallModelMiniMaxConfig(env: Env): { apiKey: string; baseUrl: string } {
  const root = env["SMALLMODEL_MANAGER_ROOT"] || "/Users/LOCAL_USER/CodexSkills/smallmodel-manager";
  const secretsPath = path.join(root, "catalog", "secrets.local.yaml");
  if (!fs.existsSync(secretsPath)) return { apiKey: "", baseUrl: "" };
  try {
    const parsed = parseYaml(fs.readFileSync(secretsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return { apiKey: "", baseUrl: "" };
    const providers = parsed["providers"];
    if (!isRecord(providers)) return { apiKey: "", baseUrl: "" };
    const minimax = providers["minimax-cn"];
    if (!isRecord(minimax)) return { apiKey: "", baseUrl: "" };
    return {
      apiKey: typeof minimax["api_key"] === "string" ? minimax["api_key"] : "",
      baseUrl: typeof minimax["base_url"] === "string" ? minimax["base_url"] : "",
    };
  } catch {
    return { apiKey: "", baseUrl: "" };
  }
}

function buildSummaryPrompt(input: ChildCompletionNoticeInput): string {
  const finalMessage = truncate(input.finalMessage ?? "", 3000);
  return [
    "请给下面子 session 完成结果生成一个中文短标题。",
    "要求：",
    "1. 15个汉字以内。",
    "2. 只输出标题，不要解释、标点、引号。",
    "3. 概括它具体做了什么；不要写“已完成”“子会话”“执行完成”。",
    "",
    `子 session：${input.childSession.name}`,
    `结果：${finalMessage}`,
  ].join("\n");
}

function readMiniMaxContent(data: unknown): string {
  if (!isRecord(data)) throw new Error("MiniMax summary returned non-object JSON");
  const choices = data["choices"];
  if (!Array.isArray(choices)) throw new Error("MiniMax summary response missing choices");
  const first = choices[0];
  if (!isRecord(first)) throw new Error("MiniMax summary response missing choices[0]");
  const message = first["message"];
  if (!isRecord(message)) throw new Error("MiniMax summary response missing message");
  const content = message["content"];
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("MiniMax summary returned empty content");
  }
  return content;
}

function stripMiniMaxThinking(content: string): string {
  const stripped = content.trim();
  if (!stripped.startsWith("<think>")) return stripped;
  const end = stripped.indexOf("</think>");
  if (end === -1) return stripped;
  return stripped.slice(end + "</think>".length).trim();
}

function extractQuotedSummaryFromThinking(content: string): string {
  const candidates = Array.from(content.matchAll(/["“]([^"“”\n]{2,30})["”]/gu))
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => /[\u4e00-\u9fff]/u.test(value));
  return candidates.at(-1) ?? "";
}

function truncate(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return chars.slice(0, maxChars).join("");
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
