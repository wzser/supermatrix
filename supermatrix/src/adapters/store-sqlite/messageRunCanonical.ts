import DatabaseConstructor from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db.ts";

export const MESSAGE_RUN_CANONICAL_SCHEMA_VERSION = 1;

/** Reason prefix returned when the backend state DB cannot be opened, read or parsed. */
export const CANONICAL_STATE_DB_UNREADABLE_REASON = "state_db_unreadable";

export function defaultCodexCanonicalStateDbPath(): string {
  return process.env.SM_CODEX_STATE_DB_PATH?.trim() || join(homedir(), ".codex", "state_5.sqlite");
}

export type MessageRunCanonicalContentKind =
  | "prompt"
  | "final_message"
  | "canonical_stream";

export type MessageRunCanonicalRef = {
  backendSessionId: string;
  canonicalObjectId: string;
};

export type MessageRunCanonicalPointer = {
  messageRunId: string;
  contentKind: MessageRunCanonicalContentKind;
  backendSessionId: string;
  canonicalObjectId: string;
  contentSha256: string;
  archivePath: string;
  byteOffset: number;
  byteLength: number;
  schemaVersion: number;
  createdAt: number;
};

export class CanonicalContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalContentError";
  }
}

export class CanonicalContentHashMismatchError extends CanonicalContentError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalContentHashMismatchError";
  }
}

type JsonRecord = Record<string, unknown>;

type RolloutRecord = {
  offset: number;
  length: number;
  raw: Buffer;
  value: JsonRecord;
};

type PointerRow = {
  message_run_id: string;
  content_kind: MessageRunCanonicalContentKind;
  backend_session_id: string;
  canonical_object_id: string;
  content_sha256: string;
  archive_path: string;
  byte_offset: number;
  byte_length: number;
  schema_version: number;
  created_at: number;
};

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadOf(value: JsonRecord): JsonRecord | null {
  return isRecord(value.payload) ? value.payload : null;
}

function recordTurnId(value: JsonRecord): string | null {
  const payload = payloadOf(value);
  if (!payload) return null;
  if (typeof payload.turn_id === "string") return payload.turn_id;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (isRecord(metadata) && typeof metadata.turn_id === "string") return metadata.turn_id;
  return null;
}

function parseRollout(path: string): RolloutRecord[] {
  const bytes = readFileSync(path);
  const records: RolloutRecord[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline + 1;
    const raw = bytes.subarray(offset, end);
    const text = raw.toString("utf8").trimEnd();
    if (text) {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) throw new CanonicalContentError(`rollout record is not an object at byte ${offset}`);
      records.push({ offset, length: raw.length, raw, value: parsed });
    }
    offset = end;
  }
  return records;
}

function stringsFromRecord(record: RolloutRecord, kind: "prompt" | "final_message"): string[] {
  const payload = payloadOf(record.value);
  if (!payload) return [];
  const out: string[] = [];
  if (kind === "prompt") {
    if (payload.type === "user_message" && typeof payload.message === "string") out.push(payload.message);
    if (payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
      for (const item of payload.content) {
        if (isRecord(item) && item.type === "input_text" && typeof item.text === "string") out.push(item.text);
      }
    }
  } else {
    if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
      out.push(payload.last_agent_message);
    }
    if (payload.type === "agent_message" && typeof payload.message === "string") out.push(payload.message);
    if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      for (const item of payload.content) {
        if (isRecord(item) && item.type === "output_text" && typeof item.text === "string") out.push(item.text);
      }
    }
  }
  if (kind === "final_message") return out;
  const variants = new Set(out);
  for (const value of out) {
    for (const marker of ["\n[User]\n", "[Current user message]\n"]) {
      const markerIndex = value.lastIndexOf(marker);
      if (markerIndex >= 0) variants.add(value.slice(markerIndex + marker.length));
    }
  }
  return Array.from(variants);
}

function matchingRecord(
  records: RolloutRecord[],
  turnId: string,
  kind: "prompt" | "final_message",
  expected: string,
): RolloutRecord | null {
  const expectedHash = sha256Utf8(expected);
  return records.find((record) =>
    recordTurnId(record.value) === turnId
      && stringsFromRecord(record, kind).some((value) => sha256Utf8(value) === expectedHash)
  ) ?? null;
}

function turnRange(records: RolloutRecord[], turnId: string): { offset: number; length: number; bytes: Buffer } | null {
  const startedIndex = records.findIndex((record) => {
    const payload = payloadOf(record.value);
    return recordTurnId(record.value) === turnId && payload?.type === "task_started";
  });
  if (startedIndex < 0) return null;
  const completedIndex = records.findIndex((record, index) => {
    if (index < startedIndex) return false;
    const payload = payloadOf(record.value);
    return recordTurnId(record.value) === turnId && payload?.type === "task_complete";
  });
  if (completedIndex < 0) return null;
  const selected = records.slice(startedIndex, completedIndex + 1);
  const offset = selected[0]!.offset;
  const end = selected.at(-1)!.offset + selected.at(-1)!.length;
  return { offset, length: end - offset, bytes: Buffer.concat(selected.map((record) => record.raw)) };
}

type RolloutPathLookup =
  | { ok: true; rolloutPath: string | null }
  | { ok: false; reason: string };

// The backend state DB is an external artifact: it may be absent, truncated,
// locked or schema-drifted at any moment. Every read of it stays inside this
// narrow boundary so a state-DB fault can never escape into run finalisation.
function rolloutPathForBackendSession(stateDbPath: string, backendSessionId: string): RolloutPathLookup {
  let stateDb: DatabaseConstructor.Database | null = null;
  try {
    stateDb = new DatabaseConstructor(stateDbPath, { readonly: true, fileMustExist: true });
    const row = stateDb.prepare("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1").get(backendSessionId) as
      | { rollout_path: string }
      | undefined;
    return { ok: true, rolloutPath: row?.rollout_path ?? null };
  } catch (error) {
    return {
      ok: false,
      reason: `${CANONICAL_STATE_DB_UNREADABLE_REASON}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      stateDb?.close();
    } catch {
      // Closing a handle that never opened cleanly must not mask the lookup result.
    }
  }
}

function pointerFromRow(row: PointerRow): MessageRunCanonicalPointer {
  return {
    messageRunId: row.message_run_id,
    contentKind: row.content_kind,
    backendSessionId: row.backend_session_id,
    canonicalObjectId: row.canonical_object_id,
    contentSha256: row.content_sha256,
    archivePath: row.archive_path,
    byteOffset: row.byte_offset,
    byteLength: row.byte_length,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  };
}

export function findMessageRunCanonicalPointer(
  db: Db,
  messageRunId: string,
  contentKind: MessageRunCanonicalContentKind,
): MessageRunCanonicalPointer | null {
  let row: PointerRow | undefined;
  try {
    row = db.prepare(
      `SELECT message_run_id, content_kind, backend_session_id, canonical_object_id,
              content_sha256, archive_path, byte_offset, byte_length, schema_version, created_at
       FROM message_run_canonical_pointers
       WHERE message_run_id = ? AND content_kind = ?`,
    ).get(messageRunId, contentKind) as PointerRow | undefined;
  } catch (error) {
    if (error instanceof Error && /no such table: message_run_canonical_pointers/u.test(error.message)) return null;
    throw error;
  }
  return row ? pointerFromRow(row) : null;
}

function readPointerBytes(pointer: MessageRunCanonicalPointer): Buffer {
  if (pointer.schemaVersion !== MESSAGE_RUN_CANONICAL_SCHEMA_VERSION) {
    throw new CanonicalContentError(`unsupported canonical pointer schema: ${pointer.schemaVersion}`);
  }
  const buffer = Buffer.alloc(pointer.byteLength);
  let file = -1;
  try {
    file = openSync(pointer.archivePath, "r");
    const bytesRead = readSync(file, buffer, 0, pointer.byteLength, pointer.byteOffset);
    if (bytesRead !== pointer.byteLength) {
      throw new CanonicalContentError(
        `canonical byte range truncated for ${pointer.messageRunId}/${pointer.contentKind}`,
      );
    }
    return buffer;
  } finally {
    if (file >= 0) closeSync(file);
  }
}

export function reconstructMessageRunContent(
  db: Db,
  messageRunId: string,
  contentKind: "prompt" | "final_message",
): string {
  const pointer = findMessageRunCanonicalPointer(db, messageRunId, contentKind);
  if (!pointer) throw new CanonicalContentError(`canonical pointer missing for ${messageRunId}/${contentKind}`);
  const raw = readPointerBytes(pointer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8").trimEnd()) as unknown;
  } catch (error) {
    throw new CanonicalContentError(
      `canonical record is invalid JSON for ${messageRunId}/${contentKind}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || recordTurnId(parsed) !== pointer.canonicalObjectId) {
    throw new CanonicalContentError(`canonical object id mismatch for ${messageRunId}/${contentKind}`);
  }
  const synthetic: RolloutRecord = {
    offset: pointer.byteOffset,
    length: pointer.byteLength,
    raw,
    value: parsed,
  };
  const value = stringsFromRecord(synthetic, contentKind).find(
    (candidate) => sha256Utf8(candidate) === pointer.contentSha256,
  );
  if (value === undefined) {
    throw new CanonicalContentHashMismatchError(`canonical content hash mismatch for ${messageRunId}/${contentKind}`);
  }
  return value;
}

export function verifyMessageRunCanonicalPointer(
  db: Db,
  messageRunId: string,
  contentKind: MessageRunCanonicalContentKind,
): boolean {
  if (contentKind === "prompt" || contentKind === "final_message") {
    reconstructMessageRunContent(db, messageRunId, contentKind);
    return true;
  }
  const pointer = findMessageRunCanonicalPointer(db, messageRunId, contentKind);
  if (!pointer) throw new CanonicalContentError(`canonical pointer missing for ${messageRunId}/${contentKind}`);
  const raw = readPointerBytes(pointer);
  if (sha256Bytes(raw) !== pointer.contentSha256) {
    throw new CanonicalContentHashMismatchError(`canonical content hash mismatch for ${messageRunId}/${contentKind}`);
  }
  const records = raw.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  const hasStarted = records.some((record) => {
    if (!isRecord(record)) return false;
    const payload = payloadOf(record);
    return payload?.type === "task_started" && recordTurnId(record) === pointer.canonicalObjectId;
  });
  const hasCompleted = records.some((record) => {
    if (!isRecord(record)) return false;
    const payload = payloadOf(record);
    return payload?.type === "task_complete" && recordTurnId(record) === pointer.canonicalObjectId;
  });
  if (!hasStarted || !hasCompleted) {
    throw new CanonicalContentError(`canonical stream object id mismatch for ${messageRunId}`);
  }
  return true;
}

export function visibleMessageRunContent(
  db: Db,
  messageRunId: string,
  contentKind: "prompt" | "final_message",
  storedValue: string | null | undefined,
): string | null {
  if (storedValue !== null && storedValue !== undefined && storedValue !== "") return storedValue;
  const pointer = findMessageRunCanonicalPointer(db, messageRunId, contentKind);
  if (!pointer) return storedValue ?? null;
  return reconstructMessageRunContent(db, messageRunId, contentKind);
}

export function visibleMessageRunContentAtPath(
  dbPath: string,
  messageRunId: string,
  contentKind: "prompt" | "final_message",
  storedValue: string | null | undefined,
): string | null {
  const db = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
  try {
    return visibleMessageRunContent(db, messageRunId, contentKind, storedValue);
  } finally {
    db.close();
  }
}

export async function indexMessageRunCanonicalPointers(input: {
  db: Db;
  stateDbPath: string;
  messageRunId: string;
  ref: MessageRunCanonicalRef;
  createdAt: number;
  attempts?: number;
  retryDelayMs?: number;
}): Promise<{ indexed: MessageRunCanonicalContentKind[]; reason?: string }> {
  const row = input.db.prepare(
    "SELECT prompt, final_message FROM message_runs WHERE id = ?",
  ).get(input.messageRunId) as { prompt: string | null; final_message: string | null } | undefined;
  if (!row) return { indexed: [], reason: "message_run_missing" };
  const lookup = rolloutPathForBackendSession(input.stateDbPath, input.ref.backendSessionId);
  if (!lookup.ok) return { indexed: [], reason: lookup.reason };
  const archivePath = lookup.rolloutPath;
  if (!archivePath) return { indexed: [], reason: "rollout_path_missing" };

  const attempts = input.attempts ?? 8;
  const retryDelayMs = input.retryDelayMs ?? 25;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const records = parseRollout(archivePath);
      const range = turnRange(records, input.ref.canonicalObjectId);
      if (!range) throw new CanonicalContentError("canonical turn is not complete");
      const promptRecord = row.prompt === null
        ? null
        : matchingRecord(records, input.ref.canonicalObjectId, "prompt", row.prompt);
      const finalRecord = row.final_message === null
        ? null
        : matchingRecord(records, input.ref.canonicalObjectId, "final_message", row.final_message);
      if (row.prompt !== null && !promptRecord) throw new CanonicalContentError("prompt not found in canonical turn");
      if (row.final_message !== null && !finalRecord) {
        throw new CanonicalContentError("final_message not found in canonical turn");
      }

      const pointers: MessageRunCanonicalPointer[] = [];
      if (row.prompt !== null && promptRecord) {
        pointers.push({
          messageRunId: input.messageRunId,
          contentKind: "prompt",
          backendSessionId: input.ref.backendSessionId,
          canonicalObjectId: input.ref.canonicalObjectId,
          contentSha256: sha256Utf8(row.prompt),
          archivePath,
          byteOffset: promptRecord.offset,
          byteLength: promptRecord.length,
          schemaVersion: MESSAGE_RUN_CANONICAL_SCHEMA_VERSION,
          createdAt: input.createdAt,
        });
      }
      if (row.final_message !== null && finalRecord) {
        pointers.push({
          messageRunId: input.messageRunId,
          contentKind: "final_message",
          backendSessionId: input.ref.backendSessionId,
          canonicalObjectId: input.ref.canonicalObjectId,
          contentSha256: sha256Utf8(row.final_message),
          archivePath,
          byteOffset: finalRecord.offset,
          byteLength: finalRecord.length,
          schemaVersion: MESSAGE_RUN_CANONICAL_SCHEMA_VERSION,
          createdAt: input.createdAt,
        });
      }
      pointers.push({
        messageRunId: input.messageRunId,
        contentKind: "canonical_stream",
        backendSessionId: input.ref.backendSessionId,
        canonicalObjectId: input.ref.canonicalObjectId,
        contentSha256: sha256Bytes(range.bytes),
        archivePath,
        byteOffset: range.offset,
        byteLength: range.length,
        schemaVersion: MESSAGE_RUN_CANONICAL_SCHEMA_VERSION,
        createdAt: input.createdAt,
      });

      const insert = input.db.prepare(
        `INSERT INTO message_run_canonical_pointers
         (message_run_id, content_kind, backend_session_id, canonical_object_id,
          content_sha256, archive_path, byte_offset, byte_length, schema_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_run_id, content_kind) DO NOTHING`,
      );
      input.db.transaction(() => {
        for (const pointer of pointers) {
          insert.run(
            pointer.messageRunId,
            pointer.contentKind,
            pointer.backendSessionId,
            pointer.canonicalObjectId,
            pointer.contentSha256,
            pointer.archivePath,
            pointer.byteOffset,
            pointer.byteLength,
            pointer.schemaVersion,
            pointer.createdAt,
          );
        }
      })();
      for (const pointer of pointers) {
        const stored = findMessageRunCanonicalPointer(input.db, pointer.messageRunId, pointer.contentKind);
        if (
          !stored
          || stored.backendSessionId !== pointer.backendSessionId
          || stored.canonicalObjectId !== pointer.canonicalObjectId
          || stored.contentSha256 !== pointer.contentSha256
          || stored.archivePath !== pointer.archivePath
          || stored.byteOffset !== pointer.byteOffset
          || stored.byteLength !== pointer.byteLength
        ) {
          throw new CanonicalContentError(
            `immutable canonical pointer conflict for ${pointer.messageRunId}/${pointer.contentKind}`,
          );
        }
      }
      return { indexed: pointers.map((pointer) => pointer.contentKind) };
    } catch (error) {
      if (attempt === attempts) {
        return { indexed: [], reason: error instanceof Error ? error.message : String(error) };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return { indexed: [], reason: "canonical_index_retry_exhausted" };
}
