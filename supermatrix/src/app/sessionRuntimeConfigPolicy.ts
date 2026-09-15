import type { BackendKind, EffortLevel, Session } from "../domain/session.ts";
import {
  CODEX_REASONING_EFFORT_ORDER,
  isCodexReasoningEffort,
  type CodexReasoningEffort,
  type CodexModelCatalogSnapshot,
} from "../ports/CodexModelCatalog.ts";
import {
  KIMI_DEFAULT_MODEL,
  resolveKimiThinkingLevel,
} from "../ports/KimiModelCatalog.ts";

export type RuntimeConfigTuple = Pick<
  Session,
  "backend" | "model" | "effort" | "backendSessionId"
>;

export type RuntimeConfigIntent =
  | { kind: "set-model"; model: string | null; modelAvailable?: boolean }
  | { kind: "set-effort"; effort: EffortLevel | null }
  | { kind: "set-backend"; backend: BackendKind }
  | { kind: "inherit"; backend: BackendKind; model: string | null; effort: EffortLevel | null }
  | { kind: "reconcile" }
  | { kind: "runtime-model-unavailable"; fallbackModel: string };

export type RuntimeConfigDecision = {
  action: "accept" | "clamp" | "fallback_model" | "reject";
  after: RuntimeConfigTuple;
  reason: string;
};

export type ResolveSessionRuntimeConfigInput = {
  current: RuntimeConfigTuple;
  intent: RuntimeConfigIntent;
  catalog: CodexModelCatalogSnapshot;
};

export function clampCodexEffort(
  effort: CodexReasoningEffort,
  supported: readonly string[],
): CodexReasoningEffort {
  const supportedSet = new Set(supported);
  if (supportedSet.size === 0) {
    throw new Error("Codex catalog advertises no supported effort");
  }
  const requestedRank = CODEX_REASONING_EFFORT_ORDER.indexOf(effort);
  for (let rank = requestedRank; rank >= 0; rank -= 1) {
    const candidate: CodexReasoningEffort = CODEX_REASONING_EFFORT_ORDER[rank]!;
    if (supportedSet.has(candidate)) return candidate;
  }
  throw new Error(`Codex catalog has no supported effort at or below ${effort}`);
}

export function resolveSessionRuntimeConfig(
  input: ResolveSessionRuntimeConfigInput,
): RuntimeConfigDecision {
  const { current, intent, catalog } = input;

  if (intent.kind === "set-model" && intent.modelAvailable === false) {
    return { action: "reject", after: { ...current }, reason: "selected model is unavailable" };
  }

  if (intent.kind === "set-backend") {
    return changed({ backend: intent.backend, model: null, effort: null }, null, "backend changed");
  }
  if (intent.kind === "inherit") {
    return resolveCandidate(current, intent.backend, intent.model, intent.effort, null, catalog, "inherited config");
  }
  if (intent.kind === "set-effort") {
    return resolveCandidate(
      current, current.backend, current.model, intent.effort, current.backendSessionId, catalog, "effort changed",
    );
  }
  if (intent.kind === "set-model") {
    if (current.backend === "codex" && intent.model !== null && !findModel(catalog, intent.model)) {
      return { action: "reject", after: { ...current }, reason: "selected model is not in the catalog" };
    }
    return resolveCandidate(
      current, current.backend, intent.model, current.effort, current.backendSessionId, catalog, "model changed",
    );
  }
  if (intent.kind === "runtime-model-unavailable") {
    if (!findModel(catalog, intent.fallbackModel)) {
      return { action: "reject", after: { ...current }, reason: "fallback model is not in the catalog" };
    }
    const decision = resolveCandidate(
      current, current.backend, intent.fallbackModel, current.effort, current.backendSessionId,
      catalog, "runtime model unavailable",
    );
    return { ...decision, action: "fallback_model" };
  }

  if (current.backend !== "codex") {
    return { action: "accept", after: { ...current }, reason: "stored defaults remain unchanged" };
  }
  if (current.model !== null && !findModel(catalog, current.model)) {
    const decision = resolveCandidate(
      current, current.backend, catalog.defaultModel, current.effort, current.backendSessionId,
      catalog, "stored model is unavailable",
    );
    return { ...decision, action: "fallback_model" };
  }
  return resolveCandidate(
    current, current.backend, current.model, current.effort, current.backendSessionId,
    catalog, "stored config reconciled",
  );
}

function resolveCandidate(
  current: RuntimeConfigTuple,
  backend: BackendKind,
  model: string | null,
  effort: EffortLevel | null,
  backendSessionId: string | null,
  catalog: CodexModelCatalogSnapshot,
  reason: string,
): RuntimeConfigDecision {
  if (backend === "kimi") {
    // Kimi capability lives in the Kimi catalog (single model-aware source):
    // a null model follows Kimi's own default, which is a fixed-on K2.7 model.
    // K3 models map requests to native low/high/max (clamp action when the
    // mapping changes the value); fixed-on models cannot hold an explicit
    // level, so a model change into K2.7 clears a stale K3 effort instead of
    // retaining an invalid one.
    const capabilityModel = model ?? KIMI_DEFAULT_MODEL;
    if (effort === null) {
      return changed({ backend, model, effort: null }, backendSessionId, reason);
    }
    const native = resolveKimiThinkingLevel(capabilityModel, effort);
    if (native === null) {
      return changed({ backend, model, effort: null }, backendSessionId, reason, "clamp");
    }
    return changed(
      { backend, model, effort: native },
      backendSessionId,
      reason,
      native === effort ? "accept" : "clamp",
    );
  }
  if (backend !== "codex") {
    return changed({ backend, model, effort }, backendSessionId, reason);
  }
  const capabilityModel = model ?? catalog.defaultModel;
  const entry = findModel(catalog, capabilityModel);
  if (!entry) {
    if (model === null) {
      throw new Error(`Codex catalog default model ${catalog.defaultModel} is not in the catalog`);
    }
    return { action: "reject", after: { ...current }, reason: `${reason}: model is not in the catalog` };
  }
  if (effort === null) {
    return changed({ backend, model, effort }, backendSessionId, reason);
  }
  if (!isCodexReasoningEffort(effort)) {
    throw new Error(`Codex does not support effort "${effort}"; it must not reach Codex clamping.`);
  }
  const resolvedEffort = clampCodexEffort(effort, entry.supportedEfforts);
  return changed(
    { backend, model, effort: resolvedEffort },
    backendSessionId,
    reason,
    resolvedEffort === effort ? "accept" : "clamp",
  );
}

function changed(
  next: Pick<RuntimeConfigTuple, "backend" | "model" | "effort">,
  backendSessionId: string | null,
  reason: string,
  action: RuntimeConfigDecision["action"] = "accept",
): RuntimeConfigDecision {
  return {
    action,
    after: { ...next, backendSessionId },
    reason,
  };
}

function findModel(catalog: CodexModelCatalogSnapshot, model: string) {
  return catalog.models.find((entry) => entry.slug === model);
}
