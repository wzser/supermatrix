import type { HttpGetPredicate, PredicateScalar } from "../../../domain/spawnPredicate.ts";
import { lintSpawnPredicate } from "../lint.ts";
import type { PredicateEvaluationContext, PredicateEvaluatorOutcome } from "../evaluate.ts";

type ClassifiedError = Error & { predicateErrorKind?: "transient" | "permanent" };
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function permanentError(message: string): ClassifiedError {
  const error = new Error(message) as ClassifiedError;
  error.predicateErrorKind = "permanent";
  return error;
}

function transientError(message: string): ClassifiedError {
  const error = new Error(message) as ClassifiedError;
  error.predicateErrorKind = "transient";
  return error;
}

function expectedStatuses(predicate: HttpGetPredicate): number[] {
  return Array.isArray(predicate.expected_status) ? predicate.expected_status : [predicate.expected_status];
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readBody(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (totalBytes + value.byteLength > maxBytes) {
        const allowedBytes = maxBytes - totalBytes;
        if (allowedBytes > 0) {
          chunks.push(value.slice(0, allowedBytes));
          totalBytes += allowedBytes;
        }
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: new TextDecoder().decode(concatChunks(chunks, totalBytes)),
    truncated,
  };
}

function allContained(text: string, tokens: string[] | undefined): boolean {
  return (tokens ?? []).every((token) => text.includes(token));
}

function anyContained(text: string, tokens: string[] | undefined): boolean {
  if (!tokens || tokens.length === 0) return true;
  return tokens.some((token) => text.includes(token));
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function pointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveJsonPointer(value: JsonValue, pointer: string): unknown {
  if (pointer === "") return value;

  let current: unknown = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = pointerSegment(rawSegment);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function scalarEquals(left: unknown, right: PredicateScalar): boolean {
  return left === right;
}

function jsonPointersMatch(text: string, predicate: HttpGetPredicate): boolean {
  const checks = predicate.json_pointer_equals ?? [];
  if (checks.length === 0) return true;
  const parsed = parseJson(text);
  if (parsed === undefined) return false;
  return checks.every((check) => scalarEquals(resolveJsonPointer(parsed, check.pointer), check.value));
}

function reasonFor(
  statusMatched: boolean,
  bodyAllMatched: boolean,
  bodyAnyMatched: boolean,
  jsonMatched: boolean
): string {
  if (!statusMatched) return "http-get status did not match";
  if (!bodyAllMatched) return "http-get body_contains_all did not match";
  if (!bodyAnyMatched) return "http-get body_contains_any did not match";
  if (!jsonMatched) return "http-get json_pointer_equals did not match";
  return "http-get predicate matched";
}

export async function evaluateHttpGetPredicate(
  predicate: HttpGetPredicate,
  context: PredicateEvaluationContext = {}
): Promise<PredicateEvaluatorOutcome> {
  const lintErrors = lintSpawnPredicate(predicate, context);
  if (lintErrors.length > 0) throw permanentError(lintErrors.join("; "));

  let response: Response;
  try {
    response = await fetch(predicate.url, {
      method: "GET",
      signal: AbortSignal.timeout(predicate.evaluation_timeout_ms),
    });
  } catch (error) {
    throw transientError(`http-get request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { text, truncated } = await readBody(response, predicate.max_body_bytes);
  const statusMatched = expectedStatuses(predicate).includes(response.status);
  const bodyAllMatched = allContained(text, predicate.body_contains_all);
  const bodyAnyMatched = anyContained(text, predicate.body_contains_any);
  const jsonMatched = jsonPointersMatch(text, predicate);
  const matched = statusMatched && bodyAllMatched && bodyAnyMatched && jsonMatched;

  return {
    matched,
    reason: reasonFor(statusMatched, bodyAllMatched, bodyAnyMatched, jsonMatched),
    details: {
      status: response.status,
      truncated,
    },
  };
}
