import { execFile } from "node:child_process";
export { getCodexBundledModels } from "../../ports/CodexModelCatalog.ts";

// `codex debug models --bundled` returns the bundled (no remote refresh)
// catalog as JSON: { models: [{ slug, priority, visibility, supported_in_api, ... }] }.
// We pick the lowest-priority list-visible API-supported slug as the
// framework default for codex, so SM tracks new top picks without manual env
// bumps.
//
// Per T800: `debug models` is an experimental command — neither the JSON
// shape nor the priority semantics are part of any stable API contract.
// This resolver is best-effort: every parse step is defensive, and any
// failure surfaces as `{ kind: "fail" }` so the boot self-check can warn
// without blocking startup.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024;

export type DefaultModelResolution =
  | { kind: "ok"; slug: string; models: string[]; totalCandidates: number }
  | { kind: "fail"; error: string };

export type ExecCmd = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string }>;

export type ResolveOptions = {
  execCmd?: ExecCmd;
  timeoutMs?: number;
};

export async function resolveCodexDefaultModel(
  opts: ResolveOptions = {},
): Promise<DefaultModelResolution> {
  const exec = opts.execCmd ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stdout: string;
  try {
    const out = await exec("codex", ["debug", "models", "--bundled"], { timeoutMs });
    stdout = out.stdout;
  } catch (err) {
    return { kind: "fail", error: `codex debug models failed: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      kind: "fail",
      error: `codex debug models output not JSON: ${(err as Error).message}`,
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    return { kind: "fail", error: "codex debug models output missing .models[] array" };
  }

  type Candidate = { slug: string; priority: number; index: number };
  const candidates: Candidate[] = [];
  parsed.models.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (!slug) return;
    if (entry.visibility !== "list") return;
    if (entry.supported_in_api !== true) return;
    const priority =
      typeof entry.priority === "number" && Number.isFinite(entry.priority)
        ? entry.priority
        : Number.MAX_SAFE_INTEGER;
    candidates.push({ slug, priority, index });
  });

  if (candidates.length === 0) {
    return {
      kind: "fail",
      error: "no candidate models matched filter (visibility=list, supported_in_api=true)",
    };
  }

  // priority ascending; ties broken by catalog order so the first listed
  // wins when priority is missing/equal across models.
  candidates.sort((a, b) => a.priority - b.priority || a.index - b.index);
  const models = candidates.map((candidate) => candidate.slug);
  return {
    kind: "ok",
    slug: models[0]!,
    models,
    totalCandidates: models.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultExec(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs, maxBuffer: DEFAULT_MAX_BUFFER },
      (err, stdout) => {
        if (err) reject(err);
        else resolve({ stdout: stdout.toString() });
      },
    );
  });
}
