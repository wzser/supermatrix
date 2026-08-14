import type {
  CodexModelAvailability,
  ModelAvailabilityResult,
} from "../../ports/CodexModelAvailability.ts";
import { resolveCodexRouteOverride, type CodexRouteOverride } from "./routeState.ts";

/**
 * Route-aware wrapper around the account availability probe.
 *
 * The probe verifies a model by actually running `codex exec --model <model>`.
 * While a non-openai sm-switch route is active that run never reaches the model
 * it names: it goes to the route proxy, which serves only its own models and
 * rejects every other one with 400 `model_not_served`. Probing a catalog intent
 * model there yields a routing fact, not availability evidence — and because
 * `model_not_served` is not a confirmed-entitlement code, callers file it as a
 * transient failure and give up without saying why.
 *
 * So skip the process instead of running it, and hand callers an explicit
 * `skipped` result carrying the route reason. Only models the route does not
 * serve are skipped; a served model is still probed for real.
 *
 * Fail-open is inherited from {@link resolveCodexRouteOverride}: no contract,
 * unreadable contract, or passthrough route means no override, which restores
 * the exact pre-routing probe behavior.
 */
export function createRouteAwareCodexModelAvailability(
  inner: CodexModelAvailability,
  dependencies: {
    resolveRouteOverride?: (model: string) => CodexRouteOverride | null;
    now?: () => number;
  } = {},
): CodexModelAvailability {
  const resolveRouteOverride =
    dependencies.resolveRouteOverride ?? ((model: string) => resolveCodexRouteOverride(model));
  const now = dependencies.now ?? Date.now;

  return {
    async probe(model: string): Promise<ModelAvailabilityResult> {
      const override = resolveRouteOverride(model);
      if (!override) return inner.probe(model);
      return {
        kind: "skipped",
        checkedAt: now(),
        reason:
          `codex route "${override.route}" is active and serves ${override.model}; ` +
          `${model} is not served on this route, so it was not probed`,
      };
    },
  };
}
