import type Database from "better-sqlite3";

export type RateLimitHit = {
  scope: string;
  quietUntilMs: number;
  detectedAtMs: number;
  sourceTaskId: string | null;
  sourceRunId: string | null;
  sourceSnippet: string | null;
};

export type RateLimitStore = {
  getQuietUntil(scope: string): number | null;
  recordHit(params: {
    scope: string;
    detectedAt: number;
    quietUntil: number;
    sourceTaskId?: string | null;
    sourceRunId?: string | null;
    sourceSnippet?: string | null;
  }): void;
  getLatest(scope: string): RateLimitHit | null;
};

export function createRateLimitStore(db: Database.Database): RateLimitStore {
  const getStmt = db.prepare("SELECT quiet_until_ms FROM rate_limit_quiet WHERE scope = ?");
  const getRowStmt = db.prepare("SELECT * FROM rate_limit_quiet WHERE scope = ?");
  const upsertStmt = db.prepare(`
    INSERT INTO rate_limit_quiet
      (scope, quiet_until_ms, detected_at_ms, source_task_id, source_run_id, source_snippet)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      quiet_until_ms = excluded.quiet_until_ms,
      detected_at_ms = excluded.detected_at_ms,
      source_task_id = excluded.source_task_id,
      source_run_id  = excluded.source_run_id,
      source_snippet = excluded.source_snippet
  `);

  return {
    getQuietUntil(scope) {
      const row = getStmt.get(scope) as { quiet_until_ms: number } | undefined;
      return row ? row.quiet_until_ms : null;
    },
    recordHit(p) {
      upsertStmt.run(
        p.scope,
        p.quietUntil,
        p.detectedAt,
        p.sourceTaskId ?? null,
        p.sourceRunId ?? null,
        p.sourceSnippet ?? null,
      );
    },
    getLatest(scope) {
      const row = getRowStmt.get(scope) as
        | {
            scope: string;
            quiet_until_ms: number;
            detected_at_ms: number;
            source_task_id: string | null;
            source_run_id: string | null;
            source_snippet: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        scope: row.scope,
        quietUntilMs: row.quiet_until_ms,
        detectedAtMs: row.detected_at_ms,
        sourceTaskId: row.source_task_id,
        sourceRunId: row.source_run_id,
        sourceSnippet: row.source_snippet,
      };
    },
  };
}
