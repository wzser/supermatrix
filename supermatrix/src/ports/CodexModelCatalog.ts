import { createHash } from "node:crypto";
import {
  getConfiguredBackendRuntimeDefaults,
  getEffectiveBackendRuntimeModel,
  setEffectiveBackendRuntimeModel,
} from "./BackendRuntimeDefaults.ts";

export const LAST_RESORT_CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
export const SAFE_CODEX_MODEL_FALLBACKS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
] as const;

export const CODEX_REASONING_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_ORDER)[number];
export const CODEX_REASONING_EFFORTS_SOL_TERRA = CODEX_REASONING_EFFORT_ORDER;
export const CODEX_REASONING_EFFORTS_LUNA = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_REASONING_EFFORTS_LEGACY = ["low", "medium", "high", "xhigh"] as const;
const CODEX_CATALOG_REASONING_EFFORT_SET = new Set<string>([
  ...CODEX_REASONING_EFFORTS_SOL_TERRA,
]);
const DEFAULT_CODEX_REASONING_EFFORTS = CODEX_REASONING_EFFORTS_LEGACY;
const CODEX_REASONING_EFFORTS_BY_MODEL: Record<string, readonly string[]> = {
  "gpt-5.6-sol": CODEX_REASONING_EFFORTS_SOL_TERRA,
  "gpt-5.6-terra": CODEX_REASONING_EFFORTS_SOL_TERRA,
  "gpt-5.6-luna": CODEX_REASONING_EFFORTS_LUNA,
  "gpt-5.5": CODEX_REASONING_EFFORTS_LEGACY,
  "gpt-5.4": CODEX_REASONING_EFFORTS_LEGACY,
  "gpt-5.4-mini": CODEX_REASONING_EFFORTS_LEGACY,
  "gpt-5.2": DEFAULT_CODEX_REASONING_EFFORTS,
};

// `codex debug models` only describes the CLI's bundled API catalog. It does
// not account for the current ChatGPT login: 0.144.1 lists gpt-5.2 as API
// supported but the actual run is rejected as unavailable for this account.
// Keep user-facing model selection truthful until the upstream catalog gains
// account-aware availability metadata.
const CURRENT_LOGIN_UNAVAILABLE_CODEX_MODELS = new Set(["gpt-5.2"]);

export type CodexModelCatalogSource = "bundled" | "fallback" | "test";
export type CodexModelCatalogEntry = {
  slug: string;
  supportedEfforts?: readonly string[];
};
export type CodexModelCatalogSnapshot = {
  defaultModel: string;
  models: Array<{ slug: string; supportedEfforts: string[] }>;
};

let cachedModels: string[] = [...SAFE_CODEX_MODEL_FALLBACKS];
let cachedEffortsByModel = new Map<string, string[]>(
  cachedModels.map((model) => [model, fallbackEffortsForModel(model)]),
);
let catalogSource: CodexModelCatalogSource = "fallback";
let effectiveDefaultModel = cachedModels[0] ?? LAST_RESORT_CODEX_DEFAULT_MODEL;

export function setCodexModelCatalog(
  models: readonly string[],
  source: CodexModelCatalogSource,
): void {
  const normalized = normalizeModels(models);
  cachedModels =
    normalized.length > 0 ? normalized : [LAST_RESORT_CODEX_DEFAULT_MODEL];
  cachedEffortsByModel = new Map(
    cachedModels.map((model) => [model, fallbackEffortsForModel(model)]),
  );
  effectiveDefaultModel = cachedModels[0] ?? LAST_RESORT_CODEX_DEFAULT_MODEL;
  catalogSource = source;
}

export function setCodexModelCatalogEntries(
  entries: readonly CodexModelCatalogEntry[],
  source: CodexModelCatalogSource,
): void {
  const seen = new Set<string>();
  const models: string[] = [];
  const effortsByModel = new Map<string, string[]>();

  for (const entry of entries) {
    const slug = entry.slug.trim();
    if (!slug || seen.has(slug) || CURRENT_LOGIN_UNAVAILABLE_CODEX_MODELS.has(slug)) continue;
    seen.add(slug);
    models.push(slug);
    effortsByModel.set(slug, normalizeEfforts(entry.supportedEfforts, slug));
  }

  cachedModels = models.length > 0 ? models : [LAST_RESORT_CODEX_DEFAULT_MODEL];
  cachedEffortsByModel = models.length > 0
    ? effortsByModel
    : new Map([
        [
          LAST_RESORT_CODEX_DEFAULT_MODEL,
          fallbackEffortsForModel(LAST_RESORT_CODEX_DEFAULT_MODEL),
        ],
      ]);
  effectiveDefaultModel = cachedModels[0] ?? LAST_RESORT_CODEX_DEFAULT_MODEL;
  catalogSource = source;
}

export function getCodexBundledModels(): string[] {
  return [...cachedModels];
}

export function getCodexModelCatalogSource(): CodexModelCatalogSource {
  return catalogSource;
}

export function getCodexModelCatalogSnapshot(): CodexModelCatalogSnapshot {
  return {
    defaultModel: getCodexDefaultModel(),
    models: cachedModels.map((slug) => ({
      slug,
      supportedEfforts: [...(cachedEffortsByModel.get(slug) ?? fallbackEffortsForModel(slug))],
    })),
  };
}

export function getCodexModelCatalogFingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify(getCodexModelCatalogSnapshot()))
    .digest("hex");
}

export function getCodexDefaultModel(): string {
  return getEffectiveBackendRuntimeModel("codex") ?? effectiveDefaultModel;
}

export function setCodexEffectiveDefaultModel(model: string): void {
  const normalized = model.trim();
  if (!cachedModels.includes(normalized)) {
    throw new Error(`Codex effective default model ${normalized} is not in the catalog`);
  }
  effectiveDefaultModel = normalized;
  setEffectiveBackendRuntimeModel("codex", normalized);
}

export function isKnownCodexModel(model: string): boolean {
  return cachedModels.includes(model.trim());
}

export function formatAvailableCodexModels(): string {
  return getCodexBundledModels().join(" / ");
}

export function codexModelUnknownMessage(model: string): string {
  return `未知 codex 模型 "${model}"。当前可用：${formatAvailableCodexModels()}`;
}

export function getCodexEffortModel(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (trimmed && isKnownCodexModel(trimmed)) return trimmed;
  // Deprecated-but-explicitly-owned models (e.g. gpt-5.4 sessions persisted
  // before the selector was hidden) still execute as themselves on the CLI, so
  // their effort ceiling must come from their own static entry — not from the
  // default model, whose wider effort set would let ultra/max leak through.
  if (trimmed && Object.hasOwn(CODEX_REASONING_EFFORTS_BY_MODEL, trimmed)) return trimmed;
  return getCodexDefaultModel();
}

export function getCodexSupportedEfforts(model: string | null | undefined): string[] {
  const effortModel = getCodexEffortModel(model);
  return [...(cachedEffortsByModel.get(effortModel) ?? fallbackEffortsForModel(effortModel))];
}

export function isKnownCodexEffort(
  effort: string,
  model: string | null | undefined,
): boolean {
  return getCodexSupportedEfforts(model).includes(effort.trim());
}

export function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return (CODEX_REASONING_EFFORT_ORDER as readonly string[]).includes(value);
}

export function formatAvailableCodexEfforts(model: string | null | undefined): string {
  return getCodexSupportedEfforts(model).join(" / ");
}

export function formatCodexEffortMatrix(): string {
  const groups = new Map<string, string[]>();
  for (const model of cachedModels) {
    const efforts = (cachedEffortsByModel.get(model) ?? fallbackEffortsForModel(model)).join(" / ");
    groups.set(efforts, [...(groups.get(efforts) ?? []), model]);
  }
  return [...groups.entries()]
    .map(([efforts, models]) => `${models.join(" / ")}: ${efforts}`)
    .join("\n");
}

export function normalizeCodexReasoningEffortForCli(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const trimmed = effort?.trim();
  if (!trimmed) return null;
  const requestedRank = CODEX_REASONING_EFFORT_ORDER.indexOf(
    trimmed as (typeof CODEX_REASONING_EFFORT_ORDER)[number],
  );
  if (requestedRank < 0 || isKnownCodexEffort(trimmed, model)) return trimmed;
  const supported = new Set(getCodexSupportedEfforts(model));
  for (let rank = requestedRank - 1; rank >= 0; rank -= 1) {
    const candidate = CODEX_REASONING_EFFORT_ORDER[rank]!;
    if (supported.has(candidate)) return candidate;
  }
  return trimmed;
}

/**
 * Returns the effort actually passed to `codex exec`: the session request or
 * configured default, normalized for the exact execution model.
 */
export function resolveCodexExecutionEffort(
  effort: string | null | undefined,
  model: string,
): string | null {
  const requested = effort?.trim() || getConfiguredBackendRuntimeDefaults("codex").effort;
  return normalizeCodexReasoningEffortForCli(requested, model);
}

export function resetCodexModelCatalogForTests(
  models: readonly string[] = SAFE_CODEX_MODEL_FALLBACKS,
): void {
  setEffectiveBackendRuntimeModel("codex", null);
  setCodexModelCatalog(models, "test");
}

export function filterCodexModelsForCurrentLogin(models: readonly string[]): string[] {
  return models.filter((model) => !CURRENT_LOGIN_UNAVAILABLE_CODEX_MODELS.has(model.trim()));
}

function normalizeModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed) || CURRENT_LOGIN_UNAVAILABLE_CODEX_MODELS.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeEfforts(
  efforts: readonly string[] | undefined,
  model: string,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const effort of efforts ?? fallbackEffortsForModel(model)) {
    const trimmed = effort.trim();
    if (!trimmed || seen.has(trimmed) || !CODEX_CATALOG_REASONING_EFFORT_SET.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : fallbackEffortsForModel(model);
}

function fallbackEffortsForModel(model: string): string[] {
  return [...(CODEX_REASONING_EFFORTS_BY_MODEL[model] ?? DEFAULT_CODEX_REASONING_EFFORTS)];
}
