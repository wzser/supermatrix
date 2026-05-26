export type InboxPredicate = {
  type: "inbox-message";
  session_name: string;
  field: "final_message";
  contains_any: string[];
  expected_window_sec: number;
};

export function inboxPredicate(opts: {
  sessionName: string;
  tokens: string[];
  expectedWindowSec?: number;
}): InboxPredicate {
  return {
    type: "inbox-message",
    session_name: opts.sessionName,
    field: "final_message",
    contains_any: opts.tokens,
    expected_window_sec: opts.expectedWindowSec ?? 86400,
  };
}

/** Tokens scheduler asks child sessions to include in their final_message. */
export const DECISION_TOKENS = ["ACTION:", "REPORT:"];
export const DELIVERY_TOKENS = ["[scheduler"];

/**
 * Default predicate for cron-task HTTP-executor bodies that lack their own.
 * Verifies the target session produced a final_message — loose, but prevents
 * 400 rejection when strict mode is on. Owners should replace with a
 * task-specific predicate (e.g. file-mtime for build outputs).
 */
export function defaultHttpExecutorPredicate(target: string): InboxPredicate {
  return inboxPredicate({
    sessionName: target,
    tokens: DECISION_TOKENS,
    expectedWindowSec: 86400,
  });
}
