import Database from "better-sqlite3";
import type { InboxMessagePredicate } from "../../../domain/spawnPredicate.ts";
import { lintSpawnPredicate } from "../lint.ts";
import type { PredicateEvaluationContext, PredicateEvaluatorOutcome } from "../evaluate.ts";

type ClassifiedError = Error & { predicateErrorKind?: "transient" | "permanent" };

const FRAMEWORK_DB_REF = "framework:supermatrix";
const DEFAULT_FRAMEWORK_DB_PATH = "/Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db";

function permanentError(message: string): ClassifiedError {
  const error = new Error(message) as ClassifiedError;
  error.predicateErrorKind = "permanent";
  return error;
}

function sinceMs(predicate: InboxMessagePredicate, context: PredicateEvaluationContext): number {
  if (predicate.since.kind === "timestamp_ms") return predicate.since.value;
  if (context.spawnCreatedAtMs === undefined) {
    throw permanentError("spawnCreatedAtMs is required for spawn_created_at inbox-message predicate");
  }
  return context.spawnCreatedAtMs;
}

function frameworkDbPath(context: PredicateEvaluationContext): string {
  const connection = context.dbRegistry?.resolve(FRAMEWORK_DB_REF);
  if (connection) {
    if (connection.kind !== "sqlite") throw permanentError(`unsupported db kind for inbox-message: ${connection.kind}`);
    return connection.path;
  }

  const env = context.env ?? process.env;
  return env.SM_DB_PATH ?? DEFAULT_FRAMEWORK_DB_PATH;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function textMatches(value: string, predicate: InboxMessagePredicate, regex: RegExp | undefined): boolean {
  if (!(predicate.contains_all ?? []).every((token) => value.includes(token))) return false;
  if ((predicate.contains_any?.length ?? 0) > 0 && !predicate.contains_any!.some((token) => value.includes(token))) {
    return false;
  }
  if (regex && !regex.test(value)) return false;
  return true;
}

export async function evaluateInboxMessagePredicate(
  predicate: InboxMessagePredicate,
  context: PredicateEvaluationContext = {}
): Promise<PredicateEvaluatorOutcome> {
  const lintErrors = lintSpawnPredicate(predicate, context);
  if (lintErrors.length > 0) throw permanentError(lintErrors.join("; "));

  const since = sinceMs(predicate, context);
  const field = quoteIdentifier(predicate.field);
  const db = new Database(frameworkDbPath(context), {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const contentKind = predicate.field === "prompt" || predicate.field === "final_message"
      ? predicate.field
      : null;
    const hasPointerTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_run_canonical_pointers'",
    ).get() !== undefined;
    const pointerClause = contentKind && hasPointerTable
      ? ` OR EXISTS (
           SELECT 1 FROM message_run_canonical_pointers p
           WHERE p.message_run_id = mr.id AND p.content_kind = '${contentKind}'
         )`
      : "";
    const rows = db
      .prepare(
        `SELECT mr.id, ${field} AS value${contentKind && hasPointerTable ? `,
           EXISTS (
             SELECT 1 FROM message_run_canonical_pointers p
             WHERE p.message_run_id = mr.id AND p.content_kind = '${contentKind}'
           ) AS has_pointer` : ", 0 AS has_pointer"}
         FROM message_runs mr
         JOIN sessions s ON s.id = mr.session_id
         LEFT JOIN sessions parent ON parent.id = s.parent_id
         WHERE (s.name = ? OR parent.name = ?)
           AND mr.started_at >= ?
           AND (${field} IS NOT NULL${pointerClause})
         ORDER BY mr.started_at DESC`
      )
      .all(predicate.session_name, predicate.session_name, since) as Array<{
        id: string;
        value: string | null;
        has_pointer: number;
      }>;

    const regex = predicate.regex ? new RegExp(predicate.regex) : undefined;
    const count = rows.filter((row) => {
      let value = row.value;
      if (contentKind && (value === null || value === "") && row.has_pointer === 1) {
        if (!context.resolveMessageRunContent) {
          throw permanentError("canonical message-run resolver is required for pointerized inbox content");
        }
        value = context.resolveMessageRunContent(frameworkDbPath(context), row.id, contentKind, value);
      }
      return value !== null && textMatches(value, predicate, regex);
    }).length;

    return {
      matched: count >= predicate.min_count,
      observed_count: count,
      reason: count >= predicate.min_count ? "inbox-message predicate matched" : "inbox-message predicate did not match",
    };
  } finally {
    db.close();
  }
}
