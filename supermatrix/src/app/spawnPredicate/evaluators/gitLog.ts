import { execFile } from "node:child_process";
import type { GitLogPredicate } from "../../../domain/spawnPredicate.ts";
import { isAllowedAbsolutePath, lintSpawnPredicate } from "../lint.ts";
import type { PredicateEvaluationContext, PredicateEvaluatorOutcome } from "../evaluate.ts";

type ClassifiedError = Error & { predicateErrorKind?: "transient" | "permanent" };

function permanentError(message: string): ClassifiedError {
  const error = new Error(message) as ClassifiedError;
  error.predicateErrorKind = "permanent";
  return error;
}

function execGit(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function sinceArgs(predicate: GitLogPredicate, context: PredicateEvaluationContext): string[] {
  if (predicate.since.kind === "commit") return [`${predicate.since.value}..HEAD`];
  const sinceMs = predicate.since.kind === "timestamp_ms" ? predicate.since.value : context.spawnCreatedAtMs;
  if (sinceMs === undefined) {
    throw permanentError("spawnCreatedAtMs is required for spawn_created_at git-log predicate");
  }
  return [`--since=${new Date(sinceMs).toISOString()}`];
}

function compileRegex(pattern: string | undefined): RegExp | undefined {
  return pattern === undefined ? undefined : new RegExp(pattern);
}

export async function evaluateGitLogPredicate(
  predicate: GitLogPredicate,
  context: PredicateEvaluationContext = {}
): Promise<PredicateEvaluatorOutcome> {
  const lintErrors = lintSpawnPredicate(predicate, context);
  if (lintErrors.length > 0) throw permanentError(lintErrors.join("; "));
  if (!isAllowedAbsolutePath(predicate.repo_path, context)) {
    throw permanentError("repo_path must be absolute and in allowlist");
  }

  try {
    await execGit(["-C", predicate.repo_path, "rev-parse", "--show-toplevel"], predicate.evaluation_timeout_ms);
  } catch (error) {
    throw permanentError(`repo_path is not a readable git worktree: ${error instanceof Error ? error.message : String(error)}`);
  }

  const args = [
    "-C",
    predicate.repo_path,
    "log",
    "--format=%H%x1f%an%x1f%s",
    "--max-count=1000",
    ...sinceArgs(predicate, context),
  ];
  if (predicate.path_globs) args.push("--", ...predicate.path_globs);

  const messageRegex = compileRegex(predicate.message_regex);
  const authorRegex = compileRegex(predicate.author_regex);
  const { stdout } = await execGit(args, predicate.evaluation_timeout_ms);

  const count = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const [sha = "", author = "", ...messageParts] = line.split("\x1f");
      const message = messageParts.join("\x1f");
      if (!sha) return false;
      if (messageRegex && !messageRegex.test(message)) return false;
      if (authorRegex && !authorRegex.test(author)) return false;
      return true;
    }).length;

  return {
    matched: count >= predicate.min_count,
    observed_count: count,
    reason: count >= predicate.min_count ? "git-log predicate matched" : "git-log predicate did not match",
  };
}
