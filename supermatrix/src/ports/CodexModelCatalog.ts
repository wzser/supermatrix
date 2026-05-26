export const LAST_RESORT_CODEX_DEFAULT_MODEL = "gpt-5.5";
export const SAFE_CODEX_MODEL_FALLBACKS = ["gpt-5.5", "gpt-5.4"] as const;

export type CodexModelCatalogSource = "bundled" | "fallback" | "test";

let cachedModels: string[] = [...SAFE_CODEX_MODEL_FALLBACKS];
let catalogSource: CodexModelCatalogSource = "fallback";

export function setCodexModelCatalog(
  models: readonly string[],
  source: CodexModelCatalogSource,
): void {
  const normalized = normalizeModels(models);
  cachedModels =
    normalized.length > 0 ? normalized : [LAST_RESORT_CODEX_DEFAULT_MODEL];
  catalogSource = source;
}

export function getCodexBundledModels(): string[] {
  return [...cachedModels];
}

export function getCodexModelCatalogSource(): CodexModelCatalogSource {
  return catalogSource;
}

export function getCodexDefaultModel(): string {
  return cachedModels[0] ?? LAST_RESORT_CODEX_DEFAULT_MODEL;
}

export function isKnownCodexModel(model: string): boolean {
  return cachedModels.includes(model.trim());
}

export function resolveCodexEnvDefaultModel(
  envModel: string | null | undefined,
): string {
  const trimmed = envModel?.trim();
  if (trimmed && isKnownCodexModel(trimmed)) return trimmed;
  return getCodexDefaultModel();
}

export function formatAvailableCodexModels(): string {
  return getCodexBundledModels().join(" / ");
}

export function codexModelUnknownMessage(model: string): string {
  return `未知 codex 模型 "${model}"。当前可用：${formatAvailableCodexModels()}`;
}

export function resetCodexModelCatalogForTests(
  models: readonly string[] = SAFE_CODEX_MODEL_FALLBACKS,
): void {
  setCodexModelCatalog(models, "test");
}

function normalizeModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}
