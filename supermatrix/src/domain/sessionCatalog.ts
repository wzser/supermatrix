import { formatIso } from "./format.ts";
import type { Timestamp } from "./ids.ts";
import type { Session } from "./session.ts";

// One flat record per FP-governed work session. Every field a router needs
// (name / alias / backend / category / status) is its own JSON key, so a
// deterministic lookup — `jq '.sessions[] | select(.alias=="SK")'` — replaces
// the substring scan over markdown prose that the old CONSTITUTION roster
// forced. `capability` carries the session's purpose verbatim from
// `sessions.purpose` (the compressed block the capability rollout wrote);
// SM core does not parse or re-shape it — that format is FP's contract.
export type SessionCatalogEntry = {
  name: string;
  alias: string;
  backend: string;
  category: string;
  status: string;
  fp_managed: boolean | null;
  capability: string;
};

// The global session catalog — one file, symlinked into every workspace.
// Replaces the 68 per-session CONSTITUTION.md files.
export type SessionCatalog = {
  generated_at: string;
  sessions: SessionCatalogEntry[];
};

// Pure projection of the sessions table into the catalog shape. Mirrors the
// scope of the old CONSTITUTION roster: child sessions are internal execution
// units, deleted rows are gone, and an explicit fpManaged=false drops the
// session (null/unmarked and true both stay — FP governance scope). Entries
// are sorted by name so regeneration produces a stable, diff-friendly file.
export function buildSessionCatalog(
  sessions: Session[],
  generatedAt: Timestamp,
): SessionCatalog {
  const entries = sessions
    .filter(
      (s) =>
        s.scope !== "child" &&
        s.status !== "deleted" &&
        s.fpManaged !== false,
    )
    .map(
      (s): SessionCatalogEntry => ({
        name: s.name,
        alias: s.alias,
        backend: s.backend,
        category: s.category,
        status: s.status,
        fp_managed: s.fpManaged,
        capability: s.purpose,
      }),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { generated_at: formatIso(generatedAt), sessions: entries };
}
