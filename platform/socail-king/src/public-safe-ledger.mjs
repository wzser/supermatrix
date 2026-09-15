import fs from "node:fs";
import path from "node:path";

const JUDGMENT_ID = /^judg-\d{4}-\d{2}-\d{2}-\d+$/;
const THEMES = new Set(["communication_gap", "wrong_owner", "false_success", "duplicate_work", "other"]);
const JUDGMENT_STATUSES = new Set(["pending", "pending_interview", "awaiting_verdict", "confirmed", "fixed", "closed"]);
const EXCEPTION_EVENTS = ["open", "intent", "closed"];
const EXCEPTION_VERDICTS = new Set([
  "b_fault",
  "contract_fault",
  "business_satisfied_elsewhere",
  "false_alarm",
  "suspended",
]);

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function validateSpawn2Request(request) {
  if (!request || typeof request !== "object") throw new Error("Spawn2 request must be an object");
  const allowedKeys = new Set(["from", "target", "prompt", "client_request_id", "closure"]);
  const unknownKeys = Object.keys(request).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) throw new Error(`unsupported Spawn2 request fields: ${unknownKeys.join(", ")}`);
  for (const key of ["from", "target", "prompt", "client_request_id"]) requireString(request[key], key);
  if (!/^\d{4}-\d{2}-\d{2}:/.test(request.client_request_id)) {
    throw new Error("client_request_id must start with YYYY-MM-DD:");
  }
  const closureKeys = Object.keys(request.closure ?? {});
  if (closureKeys.some((key) => !["kind", "target"].includes(key)) || request.closure?.kind !== "message" || request.closure?.target?.type !== "inline") {
    throw new Error("minimal interview closure must be message/inline");
  }
  if (Object.keys(request.closure.target).some((key) => key !== "type")) throw new Error("inline closure target has unsupported fields");
  return request;
}

export function validateTerminalInterview(result, label) {
  if (!result || result.status !== "completed") throw new Error(`${label} is not terminal completed`);
  requireString(result.finalMessage, `${label}.finalMessage`);
  return result;
}

export function validateJudgment(row) {
  if (!row || typeof row !== "object") throw new Error("judgment must be an object");
  for (const key of ["id", "judgment_id", "user_visible_symptom", "function_loss", "interview_a", "interview_b", "gray_zone_hit"]) {
    requireString(row[key], `judgment.${key}`);
  }
  if (!JUDGMENT_ID.test(row.id) || row.id !== row.judgment_id) throw new Error("id and judgment_id must be the same valid judgment ID");
  if (row.kind !== "primary") throw new Error("judgment.kind must be primary");
  if (!THEMES.has(row.theme)) throw new Error(`unsupported judgment theme: ${row.theme}`);
  if (!new Set(["high", "medium", "low"]).has(row.confidence)) throw new Error("unsupported confidence");
  if (!JUDGMENT_STATUSES.has(row.status)) throw new Error("unsupported judgment status");
  if (!row.evidence || row.evidence.source !== "cross_session_log") throw new Error("judgment evidence must cite cross_session_log");
  requireString(row.evidence.source_comm_id, "judgment.evidence.source_comm_id");
  requireString(row.evidence.interview_a, "judgment.evidence.interview_a");
  requireString(row.evidence.interview_b, "judgment.evidence.interview_b");
  if (row.applied_to_rule !== null && row.applied_to_rule !== undefined) requireString(row.applied_to_rule, "judgment.applied_to_rule");
  return row;
}

export function projectJudgmentTableRow(row, ts = row.ts_ms ?? Date.now()) {
  validateJudgment(row);
  const projected = {
    judgment_id: row.judgment_id,
    ts: Number.isInteger(ts) && ts >= 0 ? ts : Date.now(),
    theme: row.theme,
    user_visible_symptom: row.user_visible_symptom,
    function_loss: row.function_loss,
    evidence: row.evidence,
    confidence: row.confidence,
    gray_zone_hit: row.gray_zone_hit,
    applied_to_rule: row.applied_to_rule ?? null,
  };
  for (const forbidden of ["user_verdict", "user_note", "record_id"]) {
    if (Object.hasOwn(projected, forbidden)) throw new Error(`projection contains forbidden field: ${forbidden}`);
  }
  return projected;
}

export function validateExceptionEvent(event) {
  if (!event || typeof event !== "object") throw new Error("exception event must be an object");
  for (const key of ["ref", "comm_id", "event", "status"]) requireString(event[key], `exception.${key}`);
  if (!EXCEPTION_EVENTS.includes(event.event) || event.event !== event.status) throw new Error("exception event/status mismatch");
  if (event.event === "open") {
    if (!event.snapshot || typeof event.snapshot !== "object") throw new Error("open event needs a snapshot");
    for (const key of ["failed_phase", "failure_kind", "attempt_count", "async_status", "result_evidence", "target_evidence"]) {
      if (!Object.hasOwn(event.snapshot, key)) throw new Error(`snapshot is missing ${key}`);
    }
    for (const key of ["failed_phase", "failure_kind", "async_status"]) requireString(event.snapshot[key], `snapshot.${key}`);
    if (!Number.isInteger(event.snapshot.attempt_count) || event.snapshot.attempt_count < 0) throw new Error("snapshot.attempt_count must be a non-negative integer");
    if (!event.snapshot.result_evidence || typeof event.snapshot.result_evidence !== "object" || !event.snapshot.target_evidence || typeof event.snapshot.target_evidence !== "object") throw new Error("snapshot evidence must be objects");
  }
  if (event.event === "intent") requireString(event.action, "exception.action");
  if (event.event === "closed") {
    if (!EXCEPTION_VERDICTS.has(event.verdict)) throw new Error("closed event needs an allowed verdict");
    requireString(event.verdict_reason, "exception.verdict_reason");
    if (event.host_writeback?.read_back_verified !== true) throw new Error("closed event needs verified host writeback");
    requireString(event.host_writeback.ref, "exception.host_writeback.ref");
  }
  return event;
}

export function assertExceptionTransaction(events) {
  if (!Array.isArray(events) || events.length !== 3) throw new Error("transaction must contain open, intent, and closed events");
  events.forEach(validateExceptionEvent);
  const [open, intent, closed] = events;
  if (open.event !== "open" || intent.event !== "intent" || closed.event !== "closed") throw new Error("transaction events must be ordered open -> intent -> closed");
  if (new Set(events.map((event) => `${event.ref}:${event.comm_id}`)).size !== 1) throw new Error("transaction events must share ref and comm_id");
  if (closed.verdict === "false_alarm" && open.snapshot.target_evidence.present !== true) {
    throw new Error("false_alarm requires proven target evidence in the frozen snapshot");
  }
  return closed;
}

export function appendJsonl(filePath, row) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
