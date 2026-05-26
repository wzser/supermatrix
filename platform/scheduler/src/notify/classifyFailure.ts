export type FailureClass = "transient_network" | "task_issue";

const TRANSIENT_PATTERNS: RegExp[] = [
  /fetch failed/i,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /socket hang up/i,
  /request timeout after/i,
  /network timeout/i,
  /\bHTTP 5(02|03|04)\b/,
];

export function classifyFailure(error: string | null | undefined): FailureClass {
  if (!error) return "task_issue";
  for (const re of TRANSIENT_PATTERNS) {
    if (re.test(error)) return "transient_network";
  }
  return "task_issue";
}
