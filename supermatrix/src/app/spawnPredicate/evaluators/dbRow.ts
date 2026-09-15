import Database from "better-sqlite3";
import type {
  DbRowPredicate,
  DbRowRequireCondition,
  DbRowWhereCondition,
  PredicateScalar,
} from "../../../domain/spawnPredicate.ts";
import { lintSpawnPredicate } from "../lint.ts";
import type { PredicateEvaluationContext, PredicateEvaluatorOutcome } from "../evaluate.ts";

type ClassifiedError = Error & { predicateErrorKind?: "transient" | "permanent" };
type SqlParam = string | number | null;

function permanentError(message: string): ClassifiedError {
  const error = new Error(message) as ClassifiedError;
  error.predicateErrorKind = "permanent";
  return error;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function hasOwnValue(condition: { value?: unknown }): boolean {
  return Object.prototype.hasOwnProperty.call(condition, "value");
}

function toSqlValue(value: PredicateScalar): SqlParam {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function addWhereCondition(condition: DbRowWhereCondition, params: SqlParam[]): string {
  const column = quoteIdentifier(condition.column);
  switch (condition.op) {
    case "eq":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} = ?`;
    case "ne":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} != ?`;
    case "gt":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} > ?`;
    case "gte":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} >= ?`;
    case "lt":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} < ?`;
    case "lte":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} <= ?`;
    case "contains":
      params.push(`%${escapeLike(String(condition.value))}%`);
      return `CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`;
    case "matches":
      params.push(String(condition.value));
      return `regexp(?, ${column})`;
    case "is_null":
      return `${column} IS NULL`;
    case "not_null":
      return `${column} IS NOT NULL`;
    case "in": {
      const values = condition.value as PredicateScalar[];
      params.push(...values.map(toSqlValue));
      return `${column} IN (${values.map(() => "?").join(", ")})`;
    }
  }
}

function addRequireCondition(condition: DbRowRequireCondition, params: SqlParam[]): string {
  const column = quoteIdentifier(condition.column);
  switch (condition.op) {
    case "not_null":
      return `${column} IS NOT NULL`;
    case "non_empty_string":
      return `TRIM(CAST(${column} AS TEXT)) != ''`;
    case "eq":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} = ?`;
    case "ne":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} != ?`;
    case "gte":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} >= ?`;
    case "lte":
      params.push(toSqlValue(condition.value as PredicateScalar));
      return `${column} <= ?`;
    case "contains":
      params.push(`%${escapeLike(String(condition.value))}%`);
      return `CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`;
    case "matches":
      params.push(String(condition.value));
      return `regexp(?, ${column})`;
  }
}

function tableRef(predicate: DbRowPredicate): string {
  if (predicate.schema) return `${quoteIdentifier(predicate.schema)}.${quoteIdentifier(predicate.table)}`;
  return quoteIdentifier(predicate.table);
}

export async function evaluateDbRowPredicate(
  predicate: DbRowPredicate,
  context: PredicateEvaluationContext = {}
): Promise<PredicateEvaluatorOutcome> {
  const lintErrors = lintSpawnPredicate(predicate, context);
  if (lintErrors.length > 0) throw permanentError(lintErrors.join("; "));

  const connection = context.dbRegistry?.resolve(predicate.db_ref);
  if (!connection) throw permanentError(`db_ref is not registered: ${predicate.db_ref}`);
  if (connection.kind !== "sqlite") throw permanentError(`unsupported db kind for 0.1: ${connection.kind}`);

  const db = new Database(connection.path, {
    readonly: connection.readonly,
    fileMustExist: true,
  });
  try {
    db.function("regexp", { deterministic: true }, (pattern: string, value: unknown) => {
      if (value === null || value === undefined) return 0;
      return new RegExp(pattern).test(String(value)) ? 1 : 0;
    });

    const params: SqlParam[] = [];
    const clauses = [
      ...predicate.where_all.map((condition) => addWhereCondition(condition, params)),
      ...(predicate.require_columns ?? []).map((condition) => addRequireCondition(condition, params)),
    ];
    if (clauses.length === 0 || predicate.where_all.some((condition) => !hasOwnValue(condition) && condition.op !== "is_null" && condition.op !== "not_null")) {
      throw permanentError("db-row predicate has invalid conditions");
    }

    const sql = `SELECT COUNT(*) AS count FROM ${tableRef(predicate)} WHERE ${clauses.join(" AND ")}`;
    const row = db.prepare(sql).get(...params) as { count: number };
    const count = row.count;
    return {
      matched: count >= predicate.min_count,
      observed_count: count,
      reason: count >= predicate.min_count ? "db-row predicate matched" : "db-row predicate did not match",
    };
  } finally {
    db.close();
  }
}
