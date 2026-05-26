import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  DbRowRequireCondition,
  DbRowWhereCondition,
  PredicateScalar,
  SpawnPredicate,
} from "../../domain/spawnPredicate.ts";
import type { PredicateDbRegistry } from "../../ports/PredicateDbRegistry.ts";

export type PredicateLintContext = {
  allowedPathRoots?: string[];
  dbRegistry?: PredicateDbRegistry;
  env?: NodeJS.ProcessEnv;
  httpAllowlist?: string[];
};

const DEFAULT_PATH_ALLOWLIST = [process.env.SM_REPO_ROOT ?? process.cwd()];

function envList(value: string | undefined): string[] {
  if (!value) return [];
  const separator = value.includes(",") ? "," : ":";
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function resolvePathAllowlist(context: PredicateLintContext = {}): string[] {
  const env = context.env ?? process.env;
  return [
    ...DEFAULT_PATH_ALLOWLIST,
    ...(env.SM_WORKSPACE_ROOT ? [env.SM_WORKSPACE_ROOT] : []),
    ...envList(env.SM_WATCHER_PATH_ALLOWLIST),
    ...(context.allowedPathRoots ?? []),
  ]
    .map((root) => resolve(root))
    .filter((root, index, roots) => roots.indexOf(root) === index);
}

export function isAllowedAbsolutePath(candidate: string, context: PredicateLintContext = {}): boolean {
  if (!isAbsolute(candidate)) return false;
  const absoluteCandidate = resolve(candidate);
  return resolvePathAllowlist(context).some((root) => {
    const rel = relative(root, absoluteCandidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function lintAbsoluteAllowedPath(
  errors: string[],
  field: string,
  candidate: string,
  context: PredicateLintContext
): void {
  if (!isAbsolute(candidate)) {
    errors.push(`${field} must be absolute`);
    return;
  }
  if (!isAllowedAbsolutePath(candidate, context)) {
    errors.push(`${field} must be under the watcher path allowlist`);
    return;
  }
  if (!existsSync(candidate)) {
    errors.push(`${field} must exist`);
  }
}

export function isSafeRegex(pattern: string): boolean {
  if (pattern.length > 200) return false;
  if (/\((?:\?:|\?=|\?!|\?<=|\?<!)?[^)]*[*+{][^)]*\)\s*[*+{]/.test(pattern)) {
    return false;
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function lintRegex(errors: string[], field: string, pattern: string | undefined): void {
  if (pattern === undefined) return;
  if (!isSafeRegex(pattern)) {
    errors.push(`${field} must be a safe regular expression`);
  }
}

function hasOwnValue(condition: { value?: unknown }): boolean {
  return Object.prototype.hasOwnProperty.call(condition, "value");
}

function isScalar(value: unknown): value is PredicateScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function lintWhereCondition(errors: string[], condition: DbRowWhereCondition): void {
  const carriesValue = hasOwnValue(condition);

  if (condition.op === "is_null" || condition.op === "not_null") {
    if (carriesValue) errors.push(`${condition.column}.${condition.op} cannot carry value`);
    return;
  }

  if (condition.op === "in") {
    if (!Array.isArray(condition.value)) {
      errors.push(`${condition.column}.in requires array value`);
    }
    return;
  }

  if (!carriesValue || Array.isArray(condition.value)) {
    errors.push(`${condition.column}.${condition.op} requires scalar value`);
    return;
  }

  if ((condition.op === "contains" || condition.op === "matches") && typeof condition.value !== "string") {
    errors.push(`${condition.column}.${condition.op} requires string value`);
  }
  if (condition.op === "matches" && typeof condition.value === "string") {
    lintRegex(errors, `${condition.column}.matches`, condition.value);
  }
}

function lintRequireCondition(errors: string[], condition: DbRowRequireCondition): void {
  const carriesValue = hasOwnValue(condition);

  if (condition.op === "not_null" || condition.op === "non_empty_string") {
    if (carriesValue) errors.push(`${condition.column}.${condition.op} cannot carry value`);
    return;
  }

  if (!carriesValue || !isScalar(condition.value)) {
    errors.push(`${condition.column}.${condition.op} requires scalar value`);
    return;
  }

  if ((condition.op === "contains" || condition.op === "matches") && typeof condition.value !== "string") {
    errors.push(`${condition.column}.${condition.op} requires string value`);
  }
  if (condition.op === "matches" && typeof condition.value === "string") {
    lintRegex(errors, `${condition.column}.matches`, condition.value);
  }
}

function hasConcreteAnchor(token: string): boolean {
  return (
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(token) ||
    /\b(?:sess|comm|mr)_[A-Za-z0-9_-]+\b/.test(token) ||
    /\b[0-9a-f]{7,40}\b/i.test(token) ||
    /\b\d{10,13}\b/.test(token) ||
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(token) ||
    /(?:[<>]=?|=)\s*\d+|\b\d+\s*(?:ms|s|sec|seconds|count|rows|times|%)\b/i.test(token)
  );
}

function httpAllowlist(context: PredicateLintContext): string[] {
  const env = context.env ?? process.env;
  return [...envList(env.SM_WATCHER_HTTP_ALLOWLIST), ...(context.httpAllowlist ?? [])];
}

function isAllowedHttpUrl(url: string, context: PredicateLintContext): boolean {
  const parsed = new URL(url);
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return true;
  return httpAllowlist(context).some((entry) => entry === parsed.hostname || entry === parsed.host);
}

export function lintSpawnPredicate(
  predicate: SpawnPredicate,
  context: PredicateLintContext = {}
): string[] {
  const errors: string[] = [];

  switch (predicate.type) {
    case "git-log":
      lintAbsoluteAllowedPath(errors, "repo_path", predicate.repo_path, context);
      if (!predicate.path_globs && !predicate.message_regex && !predicate.author_regex) {
        errors.push("git-log must include path_globs, message_regex, or author_regex");
      }
      lintRegex(errors, "message_regex", predicate.message_regex);
      lintRegex(errors, "author_regex", predicate.author_regex);
      break;
    case "db-row":
      if (!context.dbRegistry?.resolve(predicate.db_ref)) {
        errors.push(`db_ref is not registered: ${predicate.db_ref}`);
      }
      for (const condition of predicate.where_all) lintWhereCondition(errors, condition);
      for (const condition of predicate.require_columns ?? []) lintRequireCondition(errors, condition);
      break;
    case "file-mtime":
      lintAbsoluteAllowedPath(errors, "root_path", predicate.root_path, context);
      if (predicate.path_glob.startsWith("/") || predicate.path_glob.includes("..") || /[{}]/.test(predicate.path_glob)) {
        errors.push("path_glob must be relative and cannot contain '..', leading '/', or brace expansion");
      }
      break;
    case "http-get":
      if (!isAllowedHttpUrl(predicate.url, context)) {
        errors.push("http-get url host must be localhost, 127.0.0.1, or HTTP allowlist");
      }
      if (
        (predicate.body_contains_all?.length ?? 0) === 0 &&
        (predicate.body_contains_any?.length ?? 0) === 0 &&
        (predicate.json_pointer_equals?.length ?? 0) === 0
      ) {
        errors.push("http-get must include body_contains_all, body_contains_any, or json_pointer_equals");
      }
      break;
    case "inbox-message": {
      lintRegex(errors, "regex", predicate.regex);
      const containsAll = predicate.contains_all ?? [];
      const containsAny = predicate.contains_any ?? [];
      if (containsAll.length === 0 && containsAny.length === 0 && !predicate.regex) {
        errors.push("inbox-message must include contains_all, contains_any, or regex");
      }
      const containsTokens = [...containsAll, ...containsAny];
      if (containsTokens.length > 0 && !containsTokens.some(hasConcreteAnchor)) {
        errors.push("weak inbox-message predicate: contains tokens need a concrete anchor");
      }
      break;
    }
  }

  return errors;
}
