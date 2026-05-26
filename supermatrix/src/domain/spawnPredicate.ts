export type PredicateType =
  | "git-log"
  | "db-row"
  | "file-mtime"
  | "http-get"
  | "inbox-message";

export type PredicateSince =
  | { kind: "spawn_created_at" }
  | { kind: "timestamp_ms"; value: number };

export type GitPredicateSince = PredicateSince | { kind: "commit"; value: string };

export type PredicateCommon = {
  expected_window_sec: number;
  evaluation_timeout_ms: number;
  retry_on_transient_fail: number;
};

export type GitLogPredicate = PredicateCommon & {
  type: "git-log";
  repo_path: string;
  since: GitPredicateSince;
  path_globs?: string[];
  message_regex?: string;
  author_regex?: string;
  min_count: number;
};

export type PredicateScalar = string | number | boolean | null;

export type DbRowWhereOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "matches"
  | "is_null"
  | "not_null"
  | "in";

export type DbRowRequireOperator =
  | "not_null"
  | "non_empty_string"
  | "eq"
  | "ne"
  | "gte"
  | "lte"
  | "contains"
  | "matches";

export type DbRowWhereCondition = {
  column: string;
  op: DbRowWhereOperator;
  value?: PredicateScalar | PredicateScalar[];
};

export type DbRowRequireCondition = {
  column: string;
  op: DbRowRequireOperator;
  value?: PredicateScalar;
};

export type DbRowPredicate = PredicateCommon & {
  type: "db-row";
  db_ref: string;
  schema?: string;
  table: string;
  where_all: DbRowWhereCondition[];
  require_columns?: DbRowRequireCondition[];
  min_count: number;
};

export type FileMtimePredicate = PredicateCommon & {
  type: "file-mtime";
  root_path: string;
  path_glob: string;
  since: PredicateSince;
  min_count: number;
  min_size_bytes: number;
};

export type JsonPointerEquals = {
  pointer: string;
  value: PredicateScalar;
};

export type HttpGetPredicate = PredicateCommon & {
  type: "http-get";
  url: string;
  expected_status: number | number[];
  body_contains_all?: string[];
  body_contains_any?: string[];
  json_pointer_equals?: JsonPointerEquals[];
  max_body_bytes: number;
};

export type InboxMessagePredicate = PredicateCommon & {
  type: "inbox-message";
  session_name: string;
  field: "prompt" | "final_message" | "error_message";
  since: PredicateSince;
  contains_all?: string[];
  contains_any?: string[];
  regex?: string;
  min_count: number;
};

export type SpawnPredicate =
  | GitLogPredicate
  | DbRowPredicate
  | FileMtimePredicate
  | HttpGetPredicate
  | InboxMessagePredicate;

export type PredicateEvaluationResultState =
  | "true"
  | "false"
  | "transient_fail"
  | "permanent_fail";

export type PredicateEvaluationResult = {
  result: PredicateEvaluationResultState;
  duration_ms: number;
  observed_count?: number;
  reason?: string;
  error_message?: string;
  error_kind?: "transient" | "permanent";
  details?: Record<string, unknown>;
};

export type PredicateTriggerSignal =
  | "predicate_long_false"
  | "predicate_patch_churn"
  | "child_unhealthy"
  | "delivery_failed"
  | "spawn_creation_missing_child";
