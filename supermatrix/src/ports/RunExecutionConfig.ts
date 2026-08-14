import { isVerifiedClaudeFableModel, type BackendKind, type EffortLevel, type Session } from "../domain/session.ts";
import { getConfiguredBackendRuntimeDefaults } from "./BackendRuntimeDefaults.ts";
import {
  resolveCodexExecutionEffort,
  getCodexDefaultModel,
  isCodexReasoningEffort,
} from "./CodexModelCatalog.ts";
import {
  getKimiThinkingCapability,
  KIMI_DEFAULT_MODEL,
  resolveKimiThinkingLevel,
} from "./KimiModelCatalog.ts";

const FALLBACK_CLAUDE_MODEL = "claude-opus-4-8";

/**
 * The single Claude model resolution chain: session override → configured
 * global default → SM_CLAUDE_DEFAULT_MODEL → runtime fallback. Exported so
 * read-only surfaces (`/model`) report exactly what execution would pick
 * instead of re-deriving the chain from duplicated literals.
 */
export function resolveClaudeExecutionModel(sessionModel: string | null | undefined): string {
  return (
    sessionModel
    ?? getConfiguredBackendRuntimeDefaults("claude").model
    ?? process.env["SM_CLAUDE_DEFAULT_MODEL"]
    ?? FALLBACK_CLAUDE_MODEL
  );
}

/**
 * The single Kimi model resolution chain: session override → configured global
 * default → the catalog default the backend applies when no model is selected.
 * Exported so the read-only `/model` surface reports exactly what a session
 * without an explicit model would execute instead of re-deriving the chain.
 */
export function resolveKimiExecutionModel(sessionModel: string | null | undefined): string {
  return (
    sessionModel?.trim()
    || getConfiguredBackendRuntimeDefaults("kimi").model
    || KIMI_DEFAULT_MODEL
  );
}

/**
 * The execution tuple selected once for a single backend invocation. It is
 * deliberately transient: persisted sessions keep their requested tuple so
 * runtime recovery can continue to guard and repair that state independently.
 */
export type RunExecutionConfig = Readonly<{
  backend: BackendKind;
  model: string | null;
  effort: EffortLevel | null;
}>;

export function resolveRunExecutionConfig(
  session: Pick<Session, "backend" | "model" | "effort">,
): RunExecutionConfig {
  if (session.backend === "codex") {
    const model = session.model?.trim() || getCodexDefaultModel();
    const requestedEffort = session.effort ?? getConfiguredBackendRuntimeDefaults("codex").effort;
    if (requestedEffort && !isCodexReasoningEffort(requestedEffort)) {
      throw new Error(`Codex does not support effort "${requestedEffort}"; it must not reach Codex argv.`);
    }
    return Object.freeze({
      backend: "codex",
      model,
      effort: resolveCodexExecutionEffort(requestedEffort, model) as EffortLevel | null,
    });
  }

  if (session.backend === "claude") {
    const defaults = getConfiguredBackendRuntimeDefaults("claude");
    const model = resolveClaudeExecutionModel(session.model);
    const effort = session.effort ?? defaults.effort;
    if (effort === "ultracode" && !isVerifiedClaudeFableModel(model)) {
      throw new Error(`Claude effort "ultracode" is only supported by Claude Fable 5; current model is "${model}".`);
    }
    if (effort === "ultra") {
      throw new Error(
        isVerifiedClaudeFableModel(model)
          ? "Claude Fable 5 rejects effort \"ultra\"; use \"ultracode\"."
          : `Claude model "${model}" rejects effort "ultra".`,
      );
    }
    return Object.freeze({
      backend: "claude",
      model,
      effort,
    });
  }

  // Kimi Code ACP (kimi-code 0.33.0): per-session model via session/set_model
  // and per-session thinking level via session/set_config_option. K3
  // holds a native low/high/max level — a null request resolves
  // to the native default "high" here so a reused ACP session cannot retain an
  // earlier override. K2.7 models are fixed-on: no level ever reaches them
  // (effort resolves to null). A session without an explicit model falls back
  // to the configured global kimi default; with neither set the model stays
  // null and follows the live ACP model, which only the backend can observe —
  // pass model and effort through unresolved so the backend resolves the level
  // against its ACP configOptions snapshot (and never acts on a K2.7 session it
  // cannot identify).
  const defaults = getConfiguredBackendRuntimeDefaults("kimi");
  const model = session.model?.trim() || defaults.model;
  if (model === null) {
    return Object.freeze({
      backend: "kimi",
      model: null,
      effort: session.effort ?? null,
    });
  }
  // A global effort is meaningful only with a verified, level-bearing global
  // model. Do not let a stale/default row reach an unresolved ACP model.
  const globalEffort = defaults.model && getKimiThinkingCapability(defaults.model)?.kind === "levels"
    ? defaults.effort
    : null;
  return Object.freeze({
    backend: "kimi",
    model,
    effort: resolveKimiThinkingLevel(model, session.effort ?? globalEffort),
  });
}
