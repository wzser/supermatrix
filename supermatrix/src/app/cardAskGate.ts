import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BackendKind, Session } from "../domain/session.ts";
import type { Logger } from "../ports/Logger.ts";

export const CARD_ASK_SYSTEM_HINT = [
  "If this Lark group run is genuinely blocked on a finite user decision (2-5 options with materially different consequences) that you cannot resolve yourself — and you have already finished the investigation you can do — use the ask_user MCP tool instead of asking in plain text.",
  "Do not use it when the user already gave a clear directive (execute it) or when you can resolve the uncertainty yourself first.",
  "Keep ask_user questions short, actionable, and tied to the current run.",
].join(" ");

export type CardAskGateConfig = {
  sessions: string[];
  categories: string[];
  excludeSessions: string[];
  excludeCategories: string[];
  backends: BackendKind[];
};

export type CardAskGateInput = {
  gatePath?: string | undefined;
  session: Session;
  backend: BackendKind;
  logger?: Pick<Logger, "warn"> | undefined;
};

export type CardAskGateDecision = { enabled: boolean };
export type CardAskGateEvaluator = (input: CardAskGateInput) => Promise<CardAskGateDecision>;

const EMPTY_GATE: CardAskGateConfig = {
  sessions: [],
  categories: [],
  excludeSessions: [],
  excludeCategories: [],
  backends: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`card ask gate field ${field} must be an array`);
  }
  if (!raw.every((entry) => typeof entry === "string")) {
    throw new Error(`card ask gate field ${field} must contain only strings`);
  }
  return raw;
}

function backendArray(raw: unknown): BackendKind[] {
  const values = stringArray(raw, "backends");
  for (const value of values) {
    if (value !== "claude" && value !== "codex" && value !== "kimi") {
      throw new Error(`card ask gate backend ${value} is unsupported`);
    }
  }
  return values as BackendKind[];
}

function parseGateConfig(raw: unknown): CardAskGateConfig {
  if (!isRecord(raw)) {
    throw new Error("card ask gate root must be an object");
  }
  return {
    sessions: stringArray(raw.sessions, "sessions"),
    categories: stringArray(raw.categories, "categories"),
    excludeSessions: stringArray(raw.excludeSessions, "excludeSessions"),
    excludeCategories: stringArray(raw.excludeCategories, "excludeCategories"),
    backends: backendArray(raw.backends),
  };
}

function warn(logger: CardAskGateInput["logger"], message: string, context?: Record<string, unknown>): void {
  try {
    logger?.warn(message, context);
  } catch {
    // Gate diagnostics must never interfere with dispatch.
  }
}

export async function evaluateCardAskGate(input: CardAskGateInput): Promise<CardAskGateDecision> {
  if (!input.gatePath) {
    warn(input.logger, "card ask gate path missing; failing closed", {
      sessionName: input.session.name,
      backend: input.backend,
    });
    return { enabled: false };
  }

  let config: CardAskGateConfig;
  try {
    const text = await readFile(input.gatePath, "utf8");
    config = parseGateConfig(JSON.parse(text));
  } catch (err) {
    warn(input.logger, "card ask gate unavailable or invalid; failing closed", {
      gatePath: input.gatePath,
      sessionName: input.session.name,
      backend: input.backend,
      err: err instanceof Error ? err.message : String(err),
    });
    return { enabled: false };
  }

  if (!config.backends.includes(input.backend)) return { enabled: false };
  if (config.excludeSessions.includes(input.session.name)) return { enabled: false };
  if (config.excludeCategories.includes(input.session.category)) return { enabled: false };

  const included =
    config.sessions.includes(input.session.name) ||
    config.categories.includes(input.session.category);
  return { enabled: included };
}

export async function writeCardAskGateAtomic(
  gatePath: string,
  config: Partial<CardAskGateConfig>,
): Promise<void> {
  const normalized: CardAskGateConfig = {
    ...EMPTY_GATE,
    ...config,
  };
  const tmpPath = `${gatePath}.tmp`;
  await mkdir(dirname(gatePath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tmpPath, gatePath);
}
