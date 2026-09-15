// Shared canonicalization primitive for command SELECTOR slots only: command
// name, enum values, named-flag keys, and the enumerated domain selectors.
// NEVER applied to free-text slots (session/branch names, paths, prompt/rest
// bodies). NFKC folds full-width -> half-width; toLowerCase folds case. The
// pre-existing whole-input NFKC fold in parseCommand stays; this adds the case
// fold and is reused by every domain resolver so there is exactly one
// definition, not a copy. See spec 2026-07-14-command-input-aliases-design.md
// section 4 / section 6 (decision D1-B).
export function canonicalizeToken(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}
