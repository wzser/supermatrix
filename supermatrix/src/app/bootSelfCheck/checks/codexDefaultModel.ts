import type { BootCheck } from "../types.ts";
import {
  SAFE_CODEX_MODEL_FALLBACKS,
  codexModelUnknownMessage,
  getCodexBundledModels,
  isKnownCodexModel,
  setCodexModelCatalog,
} from "../../../ports/CodexModelCatalog.ts";
import { assertCodexModelAliasesInCatalog } from "../../commands/setModel.ts";

// Mirrors the resolver result type without importing from the adapters
// layer (app must not depend on adapters). The structural shape is a
// stable contract between bootstrap (which wires the resolver) and this
// check.
export type CodexDefaultModelResolution =
  | { kind: "ok"; slug: string; models: string[]; totalCandidates: number }
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
        setCodexModelCatalog(result.models, "bundled");
        try {
          assertCodexModelAliasesInCatalog();
        } catch (err) {
          return {
            name: "codex-default-model",
            status: "fail",
            message: err instanceof Error ? err.message : String(err),
          };
        }
        if (explicit) {
          if (isKnownCodexModel(explicit)) {
            return {
              name: "codex-default-model",
              status: "ok",
              detail: {
                source: "env",
                slug: explicit,
                candidates: result.totalCandidates,
              },
            };
          }
          return {
            name: "codex-default-model",
            status: "warn",
            message: codexModelUnknownMessage(explicit),
            detail: {
              source: "detected",
              fallbackSlug: result.slug,
              candidates: result.totalCandidates,
            },
          };
        }
        process.env["SM_CODEX_DEFAULT_MODEL"] = result.slug;
        return {
          name: "codex-default-model",
          status: "ok",
          detail: {
            source: "detected",
            slug: result.slug,
            candidates: result.totalCandidates,
          },
        };
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
