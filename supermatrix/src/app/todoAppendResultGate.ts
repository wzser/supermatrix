import { createHash } from "node:crypto";
import type {
  ChildExecutionEvidence,
  TodoAppendResultGate,
} from "../domain/childCapabilities.ts";

const UNVERIFIED_RECEIPT = "❌ /todo 失败：未收到可验证的脚本执行回执";
const TODO_APPEND_COMMAND = /^(?:python3?|\.\/python3?)\s+(?:\.\/)?scripts\/todo_append\.py(?:\s|$)/u;

/**
 * Converts framework-observed tool-result evidence into the only text the
 * guarded chat sink may publish. Child-authored prose is never forwarded
 * across this boundary.
 */
export function formatTodoAppendResult(
  _finalMessage: string,
  gate: TodoAppendResultGate,
  evidence?: ChildExecutionEvidence,
): string {
  const execution = [...(evidence?.toolResults ?? [])]
    .reverse()
    .find((toolResult) => typeof toolResult.command === "string" && isDirectTodoAppendCommand(toolResult.command));
  const receipt = execution ? parseScriptExecution(execution.result) : null;
  if (!receipt) {
    return UNVERIFIED_RECEIPT;
  }

  const stdoutReceipt = parseObject(receipt.stdout);
  if (
    receipt.exitCode === 0 &&
    stdoutReceipt?.ok === true &&
    stdoutReceipt.status === "appended" &&
    Number.isSafeInteger(stdoutReceipt.todo_serial) &&
    stdoutReceipt.todo_serial === gate.todoSerial &&
    typeof stdoutReceipt.record_id === "string" &&
    stdoutReceipt.record_id.trim().length > 0 &&
    isMatchingIntentFingerprint(stdoutReceipt.intent_fingerprint, gate)
  ) {
    return `✓ 已追加 Todo：${gate.assignee} / ${gate.todoSerial} / ${gate.appendContent}`;
  }

  return `❌ /todo 失败：${failureReason(receipt, stdoutReceipt)}`;
}

function isMatchingIntentFingerprint(value: unknown, gate: TodoAppendResultGate): boolean {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) return false;
  const canonicalIntent = JSON.stringify({
    append_content: gate.appendContent,
    assignee: gate.assignee,
    todo_serial: gate.todoSerial,
  });
  const expected = createHash("sha256").update(canonicalIntent, "utf8").digest("hex");
  return value === expected;
}

function isDirectTodoAppendCommand(command: string): boolean {
  const normalized = command.trim();
  if (/[\r\n;&|`$<>]/u.test(normalized)) return false;
  return TODO_APPEND_COMMAND.test(normalized);
}

type ScriptExecution = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function parseScriptExecution(value: unknown): ScriptExecution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const exitCode = record.exitCode ?? record.exit_code;
  const stdout = typeof record.output === "string"
    ? record.output
    : record.stdout;
  const stderr = record.stderr;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || typeof stdout !== "string") return null;
  return {
    exitCode,
    stdout,
    stderr: typeof stderr === "string" ? stderr : "",
  };
}

function failureReason(
  execution: ScriptExecution,
  receipt: Record<string, unknown> | null,
): string {
  const stderr = execution.stderr.trim();
  if (stderr) return stderr;

  for (const key of ["error", "error_message", "message", "reason"] as const) {
    const value = receipt?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  if (typeof receipt?.status === "string" && receipt.status !== "appended") {
    return `返回状态 ${receipt.status}`;
  }

  const stdout = execution.stdout.trim();
  if (stdout) return stdout;

  return `脚本退出码 ${execution.exitCode}`;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
