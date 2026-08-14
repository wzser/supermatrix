import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * sm-switch route-state consumer (contract: sm-switch.route-state/v1).
 *
 * sm-switch writes /data/sm-switch/route-state.json atomically on every
 * account switch. When the codex route is "deepseek", the dispatched model
 * must be resolved here — explicitly, at the single conversation-creation
 * point — instead of being silently rewritten inside the proxy, so run
 * records (plan.model → usage events → token_usage.model) carry the model
 * that actually serves the run.
 *
 * Every failure mode (file missing, unreadable JSON, unknown contract
 * version, malformed fields) fails open to the requested model: that equals
 * openai passthrough, i.e. the pre-route-state status quo, and never blocks
 * a run.
 */

export const ROUTE_STATE_CONTRACT_VERSION = "sm-switch.route-state/v1";

export function defaultCodexRouteStatePath(): string {
  const override = process.env["SM_CODEX_ROUTE_STATE_PATH"]?.trim();
  if (override) return override;
  const runtimeRoot = process.env["SM_RUNTIME_ROOT"] || "/Users/LOCAL_USER/SuperMatrixRuntime";
  return join(runtimeRoot, "data", "sm-switch", "route-state.json");
}

type CodexRouteState = {
  route: "openai" | "deepseek";
  defaultModel: string | null;
  servedModels: string[];
  activatedAt: number | null;
};

function readCodexRouteState(path: string): CodexRouteState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const state = parsed as Record<string, unknown>;
  if (state["contractVersion"] !== ROUTE_STATE_CONTRACT_VERSION) return null;
  if (state["backend"] !== "codex") return null;
  const route = state["route"];
  if (route !== "openai" && route !== "deepseek") return null;
  const defaultModel =
    typeof state["defaultModel"] === "string" && state["defaultModel"].trim()
      ? state["defaultModel"].trim()
      : null;
  const servedModels = Array.isArray(state["servedModels"])
    ? state["servedModels"].filter((model): model is string => typeof model === "string")
    : [];
  if (typeof state["activatedAt"] !== "string" || !state["activatedAt"].trim()) return null;
  const activatedAt = Date.parse(state["activatedAt"]);
  if (!Number.isFinite(activatedAt)) return null;
  return {
    route,
    defaultModel,
    servedModels,
    activatedAt,
  };
}

/**
 * Reads the activation time for the currently active Codex route. This is
 * deliberately separate from model resolution: a valid OpenAI passthrough
 * state has no model override, but it still establishes a history boundary
 * for a thread that may have been extended through a different route.
 *
 * Missing, unreadable, malformed, or unknown-version state returns null so
 * callers preserve the pre-route-state resume behavior.
 */
export function resolveCodexRouteActivationTimestamp(
  path: string = defaultCodexRouteStatePath(),
): number | null {
  const state = readCodexRouteState(path);
  // A deepseek state without its serving model is malformed as a whole. Do
  // not let a partial record reset a thread when model routing itself would
  // fail open.
  if (!state || (state.route === "deepseek" && !state.defaultModel)) return null;
  return state.activatedAt;
}

/** A one-read route snapshot for the app-server's model and resume decision. */
export type CodexRouteExecution = {
  model: string;
  activatedAt: number | null;
};

export function resolveCodexRouteExecution(
  requestedModel: string,
  path: string = defaultCodexRouteStatePath(),
): CodexRouteExecution {
  const state = readCodexRouteState(path);
  if (!state || (state.route === "deepseek" && !state.defaultModel)) {
    return { model: requestedModel, activatedAt: null };
  }
  const model = state.route === "deepseek" && !state.servedModels.includes(requestedModel)
    ? state.defaultModel!
    : requestedModel;
  return { model, activatedAt: state.activatedAt };
}

/**
 * A route actually overriding the requested model: the route that serves the
 * run and the model it serves it with. `null` means "no override" — either the
 * route is passthrough / unreadable (fail open) or the requested model is
 * itself served, so intent and effect already agree.
 */
export type CodexRouteOverride = {
  route: string;
  model: string;
};

type ActiveRouteState = {
  route: string;
  defaultModel: string;
  servedModels: string[];
};

function readActiveRouteState(path: string): ActiveRouteState | null {
  const state = readCodexRouteState(path);
  if (!state || state.route !== "deepseek" || !state.defaultModel) return null;
  return { route: state.route, defaultModel: state.defaultModel, servedModels: state.servedModels };
}

export function resolveCodexRouteOverride(
  requestedModel: string,
  path: string = defaultCodexRouteStatePath(),
): CodexRouteOverride | null {
  const state = readActiveRouteState(path);
  if (!state) return null;
  if (state.servedModels.includes(requestedModel)) return null;
  return { route: state.route, model: state.defaultModel };
}

export function resolveCodexRouteModel(
  requestedModel: string,
  path: string = defaultCodexRouteStatePath(),
): string {
  return resolveCodexRouteOverride(requestedModel, path)?.model ?? requestedModel;
}

/**
 * True while a non-openai codex route is active — i.e. the model that serves a
 * codex run is decided by sm-switch routing, not by the session's own model
 * intent. Unlike `resolveCodexRouteOverride` this is model-independent: it
 * answers "is routing in charge right now", which is what callers that have no
 * intended model to compare against (a session with `model = null`) need.
 *
 * Fails open to false through the same paths as the resolvers — no contract,
 * no override, status quo behavior.
 */
export function isCodexRouteOverrideActive(
  path: string = defaultCodexRouteStatePath(),
): boolean {
  return readActiveRouteState(path) !== null;
}
