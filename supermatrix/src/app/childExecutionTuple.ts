import type { BackendKind, EffortLevel, Session } from "../domain/session.ts";
import type { SessionId } from "../domain/ids.ts";
import type { ChildSessionDefaults } from "../ports/ChildSessionDefaults.ts";

/**
 * Single source for the child execution tuple (backend / model / effort) that
 * a spawn will run with, BEFORE the shared runtime-config policy clamping.
 *
 * Precedence (must stay identical for every admission surface — /api/spawn2.0
 * validation and childSession.prepareSpawn both resolve through here so the
 * API cannot accept a tuple the child would reject):
 *   1. explicit executionOverride fields win;
 *   2. durable child_session_defaults apply when the override does not
 *      redirect the backend away from the configured one;
 *   3. same-backend children inherit the main session's tuple as fallback.
 */
export type ChildTupleOverride = {
  backend?: BackendKind;
  model?: string | null;
  effort?: EffortLevel | null;
};

export type ChildTupleFieldSource = "override" | "defaults" | "fallback";

export type ResolvedChildTuple = {
  backend: BackendKind;
  model: string | null;
  effort: EffortLevel | null;
  /** Where each field came from — admission validates explicit sources. */
  modelSource: ChildTupleFieldSource;
  effortSource: ChildTupleFieldSource;
};

export function resolveChildRequestedTuple(args: {
  defaults: Pick<ChildSessionDefaults, "backend" | "model" | "effort">;
  override: ChildTupleOverride | undefined;
  main: Pick<Session, "backend" | "model" | "effort">;
}): ResolvedChildTuple {
  const { defaults, override, main } = args;
  const configuredBackend = defaults.backend.configured ? defaults.backend.value : undefined;
  const backend = override?.backend ?? configuredBackend ?? main.backend;
  const useConfiguredTuple =
    override?.backend === undefined || override.backend === configuredBackend;
  const fallbackModel = backend === main.backend ? main.model : null;
  const fallbackEffort = backend === main.backend ? main.effort : null;
  const modelSource: ChildTupleFieldSource =
    override?.model !== undefined
      ? "override"
      : useConfiguredTuple && defaults.model.configured
        ? "defaults"
        : "fallback";
  const effortSource: ChildTupleFieldSource =
    override?.effort !== undefined
      ? "override"
      : useConfiguredTuple && defaults.effort.configured
        ? "defaults"
        : "fallback";
  const model =
    modelSource === "override"
      ? override!.model ?? null
      : modelSource === "defaults"
        ? defaults.model.value
        : fallbackModel;
  const effort =
    effortSource === "override"
      ? override!.effort ?? null
      : effortSource === "defaults"
        ? defaults.effort.value
        : fallbackEffort;
  return { backend, model, effort, modelSource, effortSource };
}

/**
 * Walk to the top-level main session the way childSession.prepareSpawn does:
 * child sessions never carry their own tuple inheritance chain, only the
 * top-level main session's tuple is a fallback source.
 */
export async function resolveMainSession(
  store: { findSessionById(id: SessionId): Promise<Session | null> },
  session: Session,
): Promise<Session> {
  let main = session;
  const visited = new Set<SessionId>([session.id]);
  while (main.scope === "child" && main.parentId) {
    if (visited.has(main.parentId)) break;
    visited.add(main.parentId);
    const ancestor = await store.findSessionById(main.parentId);
    if (!ancestor) break;
    main = ancestor;
  }
  return main;
}
