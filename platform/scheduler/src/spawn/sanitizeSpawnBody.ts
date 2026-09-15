export type SchedulerSpawnContext = {
  taskId: string;
  runId: string;
  triggeredAt: number;
  // Task owner. triggerShell injects this as SM_SESSION_NAME so a script task
  // runs under the OWNER's identity, not scheduler's leaked one. Without it,
  // owner scripts that resolve their session/group from $SM_SESSION_NAME (e.g.
  // wechat_mention_watcher's resolve_caller_session_name) mis-attribute to
  // "scheduler" — sending Feishu to the wrong group and routing spawn callbacks
  // back to scheduler's pool.
  owner: string;
};

type SanitizeSpawnBodyArgs = {
  pathname: string;
  body: Record<string, unknown>;
  schedulerContext?: SchedulerSpawnContext;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderSchedulerClientRequestId(
  body: Record<string, unknown>,
  context?: SchedulerSpawnContext,
): string | undefined {
  if (!context) return undefined;
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!context.taskId || !context.runId || !target) return undefined;
  const date = new Date(context.triggeredAt).toISOString().slice(0, 10);
  return `${date}:scheduler:${context.taskId}:${context.runId}:${target}`;
}

/**
 * Safety net keeping scheduler-fired bodies compatible with the spawn2.0
 * contract. Ported verbatim from old src/lifecycle/trigger.ts (logic unchanged).
 */
export function sanitizeSpawnBody(args: SanitizeSpawnBodyArgs): Record<string, unknown> {
  const { pathname, body, schedulerContext: context } = args;
  if (pathname === "/api/spawn2.0" && "target" in body) {
    const next = { ...body };
    delete next.mode;
    delete next.supermatrix_internal;
    if (typeof next.from !== "string" || next.from.trim() === "") next.from = "scheduler";
    if (typeof next.client_request_id !== "string" || next.client_request_id.trim() === "") {
      const rendered = renderSchedulerClientRequestId(next, context);
      if (rendered) next.client_request_id = rendered;
    }
    if (!isPlainRecord(next.closure)) {
      next.closure = { kind: "message", target: { type: "inline" } };
    }
    if (context) {
      const existing = next.origin;
      const existingKind = isPlainRecord(existing) ? existing.kind : undefined;
      const legalKinds = new Set(["scheduler", "message_run", "other"]);
      const shouldOverwrite =
        !isPlainRecord(existing) ||
        typeof existingKind !== "string" ||
        !legalKinds.has(existingKind) ||
        existingKind === "message_run";
      if (shouldOverwrite) {
        next.origin = {
          kind: "scheduler",
          task_id: context.taskId,
          run_id: context.runId,
          triggered_at: context.triggeredAt,
        };
      }
    }
    return next;
  }
  return body;
}
