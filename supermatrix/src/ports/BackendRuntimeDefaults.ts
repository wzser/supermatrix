import type { BackendKind, EffortLevel } from "../domain/session.ts";

export type BackendRuntimeDefaults = {
  model: string | null;
  effort: EffortLevel | null;
};

type BackendRuntimeDefaultState = {
  configured: BackendRuntimeDefaults;
  effectiveModel?: string | null;
};

const defaultsByBackend = new Map<BackendKind, BackendRuntimeDefaultState>();

function getState(backend: BackendKind): BackendRuntimeDefaultState {
  return defaultsByBackend.get(backend) ?? {
    configured: { model: null, effort: null },
  };
}

export function getConfiguredBackendRuntimeDefaults(backend: BackendKind): BackendRuntimeDefaults {
  return { ...getState(backend).configured };
}

export function getEffectiveBackendRuntimeModel(backend: BackendKind): string | null {
  const state = getState(backend);
  return Object.hasOwn(state, "effectiveModel")
    ? state.effectiveModel ?? null
    : state.configured.model;
}

export function setConfiguredBackendRuntimeDefaults(
  backend: BackendKind,
  patch: Partial<BackendRuntimeDefaults>,
): BackendRuntimeDefaults {
  const current = getState(backend);
  const configured = {
    model: Object.hasOwn(patch, "model") ? patch.model ?? null : current.configured.model,
    effort: Object.hasOwn(patch, "effort") ? patch.effort ?? null : current.configured.effort,
  };
  const next: BackendRuntimeDefaultState = { configured };
  if (Object.hasOwn(patch, "model")) next.effectiveModel = configured.model;
  else if (Object.hasOwn(current, "effectiveModel")) {
    next.effectiveModel = current.effectiveModel ?? null;
  }
  defaultsByBackend.set(backend, next);
  return { ...configured };
}

export function setEffectiveBackendRuntimeModel(
  backend: BackendKind,
  model: string | null,
): void {
  const current = getState(backend);
  defaultsByBackend.set(backend, { ...current, effectiveModel: model });
}

export function resetConfiguredBackendRuntimeDefaultsForTests(): void {
  defaultsByBackend.clear();
}
