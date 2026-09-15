import type { BootCheck } from "../types.ts";
import {
  SAFE_CODEX_MODEL_FALLBACKS,
  type CodexModelCatalogEntry,
  codexModelUnknownMessage,
  getCodexBundledModels,
  isKnownCodexModel,
  setCodexModelCatalog,
  setCodexModelCatalogEntries,
  setCodexEffectiveDefaultModel,
} from "../../../ports/CodexModelCatalog.ts";
import { getCodexModelAliasCatalogDrift } from "../../commands/setModel.ts";

const CODEX_ALIAS_CATALOG_DRIFT_REASON = "CODEX_ALIAS_CATALOG_DRIFT";

// Mirrors the resolver result type without importing from the adapters
// layer (app must not depend on adapters). The structural shape is a
// stable contract between bootstrap (which wires the resolver) and this
// check.
export type CodexDefaultModelResolution =
  | {
      kind: "ok";
      slug: string;
      models: string[];
      modelDetails?: CodexModelCatalogEntry[];
      totalCandidates: number;
    }
  | { kind: "fail"; error: string };

export type CodexDefaultModelCheckDeps = {
  resolve: () => Promise<CodexDefaultModelResolution>;
};

// Resolves codex backend's runtime model catalog:
//   1. Detector returns a list -> cache the whole bundled catalog for defaults
//      and input validation.
//   2. SM_CODEX_DEFAULT_MODEL is respected only when it is inside that cached
//      catalog; otherwise startup warns and commandBuilder ignores it.
//   3. Detector fails -> cache a tiny safe fallback list and warn, so boot does
//      not depend on the codex CLI being present on PATH.
export function createCodexDefaultModelCheck(
  deps: CodexDefaultModelCheckDeps,
): BootCheck {
  return {
    name: "codex-default-model",
    phases: ["pre-wiring"],
    async run(ctx) {
      const explicit = process.env["SM_CODEX_DEFAULT_MODEL"]?.trim();
      const result = await deps.resolve();
      if (result.kind === "ok") {
        if (result.modelDetails) {
          setCodexModelCatalogEntries(result.modelDetails, "bundled");
        } else {
          setCodexModelCatalog(result.models, "bundled");
        }
        const aliasDrift = getCodexModelAliasCatalogDrift();
        const aliasWarning = aliasDrift.length > 0
          ? `codex model aliases outside bundled catalog: ` +
            `${aliasDrift.map(({ alias, target }) => `${alias}->${target}`).join(", ")}; ` +
            `available: ${getCodexBundledModels().join(" / ")}`
          : undefined;
        const aliasDetail = aliasWarning
          ? {
              reasonCode: CODEX_ALIAS_CATALOG_DRIFT_REASON,
              aliases: aliasDrift,
            }
          : {};
        if (aliasWarning) {
          ctx.logger.warn("codex model alias catalog drift; stale aliases remain unavailable", {
            error: aliasWarning,
          });
        }
        if (explicit) {
          if (isKnownCodexModel(explicit)) {
            setCodexEffectiveDefaultModel(explicit);
            const detail = {
              source: "env",
              slug: explicit,
              candidates: result.totalCandidates,
              ...aliasDetail,
            };
            return aliasWarning
              ? {
                  name: "codex-default-model",
                  status: "warn",
                  message: aliasWarning,
                  detail,
                }
              : { name: "codex-default-model", status: "ok", detail };
          }
          const unknownMessage = codexModelUnknownMessage(explicit);
          return {
            name: "codex-default-model",
            status: "warn",
            message: aliasWarning
              ? `${unknownMessage}; ${aliasWarning}`
              : unknownMessage,
            detail: {
              source: "detected",
              fallbackSlug: result.slug,
              candidates: result.totalCandidates,
              ...aliasDetail,
            },
          };
        }
        process.env["SM_CODEX_DEFAULT_MODEL"] = result.slug;
        setCodexEffectiveDefaultModel(result.slug);
        const detail = {
          source: "detected",
          slug: result.slug,
          candidates: result.totalCandidates,
          ...aliasDetail,
        };
        return aliasWarning
          ? {
              name: "codex-default-model",
              status: "warn",
              message: aliasWarning,
              detail,
            }
          : { name: "codex-default-model", status: "ok", detail };
      }
      setCodexModelCatalog(SAFE_CODEX_MODEL_FALLBACKS, "fallback");
      ctx.logger.warn("using fallback codex model list, expect drift", {
        error: result.error,
        models: getCodexBundledModels(),
      });
      return {
        name: "codex-default-model",
        status: "warn",
        message:
          `codex 默认模型自动检测失败：${result.error}` +
          `（using fallback codex model list, expect drift：${getCodexBundledModels().join(" / ")}）`,
      };
    },
  };
}
