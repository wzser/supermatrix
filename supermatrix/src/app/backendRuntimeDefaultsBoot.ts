import type { BackendKind, EffortLevel } from "../domain/session.ts";
import { setConfiguredBackendRuntimeDefaults } from "../ports/BackendRuntimeDefaults.ts";
import { resolveAndValidateModel } from "./commands/setModel.ts";
import { errorMessage } from "./errorMessage.ts";

export type PersistedBackendRuntimeDefaults = {
  backend: BackendKind;
  model: string | null;
  effort: EffortLevel | null;
};

/**
 * Restore the persisted per-backend global defaults into the process-local
 * runtime state on boot. A row whose model no longer resolves against its
 * backend catalog (a model retired between two boots) is skipped entirely so a
 * stale id can never reach backend argv; the caller reports it.
 */
export function restoreBackendRuntimeDefaults(
  rows: readonly PersistedBackendRuntimeDefaults[],
  onInvalid: (row: PersistedBackendRuntimeDefaults, error: string) => void,
): void {
  for (const row of rows) {
    try {
      if (row.model) resolveAndValidateModel(row.model, row.backend);
      setConfiguredBackendRuntimeDefaults(row.backend, { model: row.model, effort: row.effort });
    } catch (err) {
      onInvalid(row, errorMessage(err));
    }
  }
}
