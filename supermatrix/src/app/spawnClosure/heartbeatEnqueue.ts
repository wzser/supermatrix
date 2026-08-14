/**
 * Shared decoding of the heartbeat enqueue script's machine-readable stdout.
 *
 * `enqueue-heartbeat-todo` answers on stdout as JSON and signals failures with
 * a non-zero exit code (exit 3 = the caller session has heartbeat_enabled=0,
 * stdout `{"ok":false,"status":"target_not_heartbeat_enabled",...}`). execFile
 * turns that into an opaque `Command failed: ...` Error whose stderr is empty,
 * so the reason only survives if the child's stdout is parsed back out.
 */

/** Caller session has heartbeat delivery turned off; retrying can never succeed. */
export const HEARTBEAT_ENQUEUE_CALLER_DISABLED_STATUS = "target_not_heartbeat_enabled";

const MAX_FAILURE_MESSAGE_CHARS = 500;

export type HeartbeatEnqueueFailure = {
  /** Enriched message: the exec failure plus the script's own status / error. */
  message: string;
  /** `status` field of the script's confirmation JSON, when present. */
  status: string | null;
  /** `error` field of the script's confirmation JSON, when present. */
  error: string | null;
  /**
   * Deterministic non-retryable failure: the caller cannot receive heartbeat
   * todos at all, so the delivery must settle terminally instead of burning
   * the attempt budget on identical retries.
   */
  callerHeartbeatDisabled: boolean;
};

/** Enqueue exited 0 but the confirmation JSON was missing / not `ok:true`. */
export class HeartbeatEnqueueRejected extends Error {
  readonly enqueueStatus: string | null;
  readonly enqueueError: string | null;

  constructor(message: string, fields?: { status?: unknown; error?: unknown }) {
    super(message);
    this.name = "HeartbeatEnqueueRejected";
    this.enqueueStatus = typeof fields?.status === "string" ? fields.status : null;
    this.enqueueError = typeof fields?.error === "string" ? fields.error : null;
  }
}

/** Last non-empty stdout line parsed as JSON; null when absent or unparseable. */
export function parseHeartbeatEnqueueConfirmation(stdout: string): Record<string, unknown> | null {
  const confirmation = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!confirmation) return null;
  try {
    const payload: unknown = JSON.parse(confirmation);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function describeHeartbeatEnqueueFailure(err: unknown): HeartbeatEnqueueFailure {
  const { status, error, base } = readFailureFields(err);
  const details: string[] = [];
  if (status) details.push(`status=${status}`);
  if (error && !base.includes(error)) details.push(`error=${error}`);
  return {
    message: details.length > 0 ? `${base} (${details.join("; ")})` : base,
    status,
    error,
    callerHeartbeatDisabled: status === HEARTBEAT_ENQUEUE_CALLER_DISABLED_STATUS,
  };
}

function readFailureFields(err: unknown): { status: string | null; error: string | null; base: string } {
  const rawMessage = truncate(err instanceof Error ? err.message : String(err));
  if (err instanceof HeartbeatEnqueueRejected) {
    return { status: err.enqueueStatus, error: err.enqueueError, base: rawMessage };
  }
  // execFile rejection: the child's own JSON answer rides on `err.stdout`.
  const stdout = isRecord(err) && typeof err.stdout === "string" ? err.stdout : null;
  const payload = stdout ? parseHeartbeatEnqueueConfirmation(stdout) : null;
  const status = payload && typeof payload.status === "string" ? payload.status : null;
  const error = payload && typeof payload.error === "string" ? payload.error : null;
  if (!status && !error) return { status: null, error: null, base: rawMessage };
  // The child answered with a real reason, so drop execFile's
  // `Command failed: <path> <every arg>` noise (it re-embeds the whole todo
  // message, result included) and keep the exit code as the only context.
  const exitCode = isRecord(err) && typeof err.code === "number" ? err.code : null;
  return {
    status,
    error,
    base: exitCode === null ? "heartbeat enqueue failed" : `heartbeat enqueue failed (exit ${exitCode})`,
  };
}

function truncate(value: string): string {
  return value.length > MAX_FAILURE_MESSAGE_CHARS
    ? `${value.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…`
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
