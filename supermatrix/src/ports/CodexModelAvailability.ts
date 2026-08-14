export type ModelAvailabilityResult =
  | { kind: "available"; checkedAt: number }
  | { kind: "unavailable"; checkedAt: number; reason: string }
  | { kind: "transient_failure"; checkedAt: number; reason: string }
  // No probe was run because the model cannot be reached on the active route
  // (sm-switch pins codex to a proxy-served route that does not serve it), so
  // there is no availability evidence either way. Distinct from
  // `transient_failure`: nothing failed and a retry would change nothing.
  // Callers must report the skip instead of treating it as a verdict.
  | { kind: "skipped"; checkedAt: number; reason: string };

export interface CodexModelAvailability {
  probe(model: string): Promise<ModelAvailabilityResult>;
}
