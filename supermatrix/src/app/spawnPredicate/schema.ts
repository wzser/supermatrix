import { createHash } from "node:crypto";
import { z } from "zod";
import type { SpawnPredicate } from "../../domain/spawnPredicate.ts";
import { lintSpawnPredicate, type PredicateLintContext } from "./lint.ts";

const common = z.object({
  expected_window_sec: z.number().int().min(60).max(604800).default(3600),
  evaluation_timeout_ms: z.number().int().min(100).max(30000).default(10000),
  retry_on_transient_fail: z.number().int().min(0).max(5).default(2),
});

const spawnCreatedAtSince = z.object({ kind: z.literal("spawn_created_at") }).strict();
const timestampSince = z.object({
  kind: z.literal("timestamp_ms"),
  value: z.number().int().min(0),
}).strict();
const commitSince = z.object({
  kind: z.literal("commit"),
  value: z.string().regex(/^[0-9a-f]{7,40}$/),
}).strict();

const predicateSince = z.union([spawnCreatedAtSince, timestampSince]);
const gitPredicateSince = z.union([spawnCreatedAtSince, timestampSince, commitSince]);

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const scalarArray = z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).max(100);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const dbWhereCondition = z.object({
  column: identifier,
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "matches", "is_null", "not_null", "in"]),
  value: z.union([scalar, scalarArray]).optional(),
}).strict();

const dbRequireCondition = z.object({
  column: identifier,
  op: z.enum(["not_null", "non_empty_string", "eq", "ne", "gte", "lte", "contains", "matches"]),
  value: scalar.optional(),
}).strict();

export const gitLogPredicateSchema = common.extend({
  type: z.literal("git-log"),
  repo_path: z.string().min(1).max(500),
  since: gitPredicateSince.default({ kind: "spawn_created_at" }),
  path_globs: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  message_regex: z.string().min(1).max(200).optional(),
  author_regex: z.string().min(1).max(200).optional(),
  min_count: z.number().int().min(1).max(100).default(1),
}).strict();

export const dbRowPredicateSchema = common.extend({
  type: z.literal("db-row"),
  db_ref: z.string().regex(/^[a-z][a-z0-9_-]*:[A-Za-z0-9_.:-]+$/),
  schema: identifier.optional(),
  table: identifier,
  where_all: z.array(dbWhereCondition).min(1).max(20),
  require_columns: z.array(dbRequireCondition).max(20).optional(),
  min_count: z.number().int().min(1).max(100000),
}).strict();

export const fileMtimePredicateSchema = common.extend({
  type: z.literal("file-mtime"),
  root_path: z.string().min(1).max(500),
  path_glob: z.string().min(1).max(240),
  since: predicateSince.default({ kind: "spawn_created_at" }),
  min_count: z.number().int().min(1).max(1000).default(1),
  min_size_bytes: z.number().int().min(0).max(1073741824).default(1),
}).strict();

export const httpGetPredicateSchema = common.extend({
  type: z.literal("http-get"),
  url: z.string().url().max(1000),
  expected_status: z.union([
    z.number().int().min(100).max(599),
    z.array(z.number().int().min(100).max(599)).min(1).max(20),
  ]),
  body_contains_all: z.array(z.string().min(1).max(200)).max(20).optional(),
  body_contains_any: z.array(z.string().min(1).max(200)).max(20).optional(),
  json_pointer_equals: z.array(z.object({
    pointer: z.string().regex(/^(\/([^/~]|~0|~1)*)*$/).max(240),
    value: scalar,
  }).strict()).max(20).optional(),
  max_body_bytes: z.number().int().min(1).max(1048576).default(262144),
}).strict();

export const inboxMessagePredicateSchema = common.extend({
  type: z.literal("inbox-message"),
  session_name: z.string().min(1).max(200),
  field: z.enum(["prompt", "final_message", "error_message"]),
  since: predicateSince.default({ kind: "spawn_created_at" }),
  contains_all: z.array(z.string().min(1).max(200)).max(20).optional(),
  contains_any: z.array(z.string().min(1).max(200)).max(20).optional(),
  regex: z.string().min(1).max(200).optional(),
  min_count: z.number().int().min(1).max(1000).default(1),
}).strict();

export const spawnPredicateSchema = z.discriminatedUnion("type", [
  gitLogPredicateSchema,
  dbRowPredicateSchema,
  fileMtimePredicateSchema,
  httpGetPredicateSchema,
  inboxMessagePredicateSchema,
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonicalize(child);
    }
    return out;
  }
  throw new Error(`Cannot canonicalize non-JSON value: ${typeof value}`);
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function predicateHash(value: unknown): string {
  const canonicalJson = canonicalJsonStringify(value);
  return `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

export type ValidatedSpawnPredicate = {
  predicate: SpawnPredicate;
  canonicalJson: string;
  predicateHash: string;
  predicate_hash: string;
};

export function validateSpawnPredicate(
  input: unknown,
  context: PredicateLintContext = {}
): ValidatedSpawnPredicate {
  const predicate = spawnPredicateSchema.parse(input) as SpawnPredicate;
  const lintErrors = lintSpawnPredicate(predicate, context);
  if (lintErrors.length > 0) {
    throw new Error(lintErrors.join("; "));
  }

  const canonicalJson = canonicalJsonStringify(predicate);
  const hash = `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
  return {
    predicate,
    canonicalJson,
    predicateHash: hash,
    predicate_hash: hash,
  };
}
