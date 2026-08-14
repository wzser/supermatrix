import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { FileMtimePredicate } from "../../../domain/spawnPredicate.ts";
import { lintSpawnPredicate } from "../lint.ts";
import type { PredicateEvaluationContext, PredicateEvaluatorOutcome } from "../evaluate.ts";

type ClassifiedError = Error & { predicateErrorKind?: "transient" | "permanent" };

const MAX_DIRECTORY_ENTRIES = 10_000;

function permanentError(message: string): ClassifiedError {
  const error = new Error(message) as ClassifiedError;
  error.predicateErrorKind = "permanent";
  return error;
}

function sinceMs(predicate: FileMtimePredicate, context: PredicateEvaluationContext): number {
  if (predicate.since.kind === "timestamp_ms") return predicate.since.value;
  if (context.spawnCreatedAtMs === undefined) {
    throw permanentError("spawnCreatedAtMs is required for spawn_created_at file-mtime predicate");
  }
  return context.spawnCreatedAtMs;
}

function hasGlobMagic(pathGlob: string): boolean {
  return /[*?]/.test(pathGlob);
}

function normalizeRelativePath(path: string): string {
  return path.split(/[\\/]/g).join("/");
}

function escapeRegex(char: string): string {
  return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pathGlob: string): RegExp {
  const glob = normalizeRelativePath(pathGlob);
  let pattern = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 2;
        } else {
          pattern += ".*";
          i += 1;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegex(char);
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function fileMatches(fileStat: Stats, since: number, minSizeBytes: number): boolean {
  return fileStat.isFile() && fileStat.mtimeMs >= since && fileStat.size >= minSizeBytes;
}

async function countExactMatch(predicate: FileMtimePredicate, since: number): Promise<number> {
  const root = resolve(predicate.root_path);
  const target = resolve(root, predicate.path_glob);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "" || resolve(root, rel) !== target) {
    throw permanentError("path_glob must resolve under root_path");
  }
  const fileStat = await statIfExists(target);
  return fileStat && fileMatches(fileStat, since, predicate.min_size_bytes) ? 1 : 0;
}

async function countGlobMatches(predicate: FileMtimePredicate, since: number): Promise<number> {
  const root = resolve(predicate.root_path);
  const matcher = globToRegExp(predicate.path_glob);
  let entriesSeen = 0;
  let count = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_DIRECTORY_ENTRIES) {
        throw permanentError(`file-mtime glob exceeded ${MAX_DIRECTORY_ENTRIES} directory entries`);
      }

      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = normalizeRelativePath(relative(root, absolutePath));
      if (!matcher.test(relativePath)) continue;
      const fileStat = await stat(absolutePath);
      if (fileMatches(fileStat, since, predicate.min_size_bytes)) count += 1;
    }
  }

  await walk(root);
  return count;
}

export async function evaluateFileMtimePredicate(
  predicate: FileMtimePredicate,
  context: PredicateEvaluationContext = {}
): Promise<PredicateEvaluatorOutcome> {
  const lintErrors = lintSpawnPredicate(predicate, context);
  if (lintErrors.length > 0) throw permanentError(lintErrors.join("; "));

  const since = sinceMs(predicate, context);
  const count = hasGlobMagic(predicate.path_glob)
    ? await countGlobMatches(predicate, since)
    : await countExactMatch(predicate, since);

  return {
    matched: count >= predicate.min_count,
    observed_count: count,
    reason: count >= predicate.min_count ? "file-mtime predicate matched" : "file-mtime predicate did not match",
  };
}
