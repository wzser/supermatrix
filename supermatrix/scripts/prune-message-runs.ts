#!/usr/bin/env tsx
// Prunes message_runs.stream_log payloads past a retention window so the live
// supermatrix.db stops growing unbounded (stream logs are debugging aids with
// no long-term value; prompt/final_message stay untouched for traceability).
// Freed pages go to the SQLite freelist and get reused by new runs; the file
// only shrinks under an explicit --vacuum, which takes an exclusive lock and
// must only run in a low-traffic window.
import DatabaseConstructor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findMessageRunCanonicalPointer,
  reconstructMessageRunContent,
  sha256Utf8,
  visibleMessageRunContent,
} from "../src/adapters/store-sqlite/messageRunCanonical.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_BUSY_TIMEOUT_MS = 60_000;
// Only pointerize runs that have been terminal for a while, so an in-flight
// delivery never races the body clear even though every reader is pointer-aware.
const DEFAULT_POINTERIZE_SETTLE_MS = 10 * 60 * 1000;

export type PruneSummary = {
  mode: "dry-run" | "apply";
  dbPath: string;
  retentionDays: number;
  cutoffMs: number;
  candidateRows: number;
  candidateStreamBytes: number;
  prunedRows: number;
  walCheckpoint?: string;
  vacuum?: { requested: boolean; ran: boolean; error?: string };
  dbFileBytesBefore: number;
  dbFileBytesAfter: number;
};

type CliOptions = {
  apply: boolean;
  json: boolean;
  vacuum: boolean;
  retentionDays: number;
  dbPath: string;
  receiptDir: string;
  nowMs: number;
  classifyCanonical: boolean;
  pointerize: boolean;
  pointerizeSettleMs: number;
  manifestPath: string | null;
  stateDbPath: string;
  outputDir: string;
};

function defaultDbPath(env: Record<string, string | undefined>): string {
  const runtimeRoot = env.SM_RUNTIME_ROOT?.trim() || "/Users/LOCAL_USER/SuperMatrixRuntime";
  return join(runtimeRoot, "data", "supermatrix.db");
}

function parseArgs(argv: string[], env: Record<string, string | undefined>): CliOptions {
  let apply = false;
  let json = false;
  let vacuum = false;
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let dbPath = defaultDbPath(env);
  let receiptDir = env.SM_PRUNE_MESSAGE_RUNS_RECEIPT_DIR ?? "/Users/LOCAL_USER/SuperMatrixRuntime/data/prune-message-runs";
  let nowMs = Date.now();
  let classifyCanonical = false;
  let pointerize = false;
  let pointerizeSettleMs = DEFAULT_POINTERIZE_SETTLE_MS;
  let manifestPath: string | null = null;
  let stateDbPath = process.env.SM_CODEX_STATE_DB_PATH?.trim() || "/Users/LOCAL_USER/.codex/state_5.sqlite";
  let outputDir = "/Users/LOCAL_USER/SuperMatrixRuntime/data/storage-optimization/2026-08-20";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--classify-canonical") {
      classifyCanonical = true;
    } else if (arg === "--pointerize") {
      pointerize = true;
    } else if (arg === "--pointerize-settle-ms") {
      const next = argv[i + 1];
      if (!next) throw new Error("--pointerize-settle-ms requires a number");
      pointerizeSettleMs = Number(next);
      if (!Number.isFinite(pointerizeSettleMs) || pointerizeSettleMs < 0) {
        throw new Error("--pointerize-settle-ms must be >= 0");
      }
      i += 1;
    } else if (arg === "--manifest") {
      const next = argv[i + 1];
      if (!next) throw new Error("--manifest requires a path");
      manifestPath = resolve(next);
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--vacuum") {
      vacuum = true;
    } else if (arg === "--retention-days") {
      const next = argv[i + 1];
      if (!next) throw new Error("--retention-days requires a number");
      retentionDays = Number(next);
      if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("--retention-days must be >= 1");
      i += 1;
    } else if (arg === "--db") {
      const next = argv[i + 1];
      if (!next) throw new Error("--db requires a path");
      dbPath = resolve(next);
      i += 1;
    } else if (arg === "--receipt-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--receipt-dir requires a path");
      receiptDir = resolve(next);
      i += 1;
    } else if (arg === "--now-ms") {
      const next = argv[i + 1];
      if (!next) throw new Error("--now-ms requires a timestamp");
      nowMs = Number(next);
      if (!Number.isFinite(nowMs)) throw new Error("--now-ms must be numeric");
      i += 1;
    } else if (arg === "--state-db") {
      const next = argv[i + 1];
      if (!next) throw new Error("--state-db requires a path");
      stateDbPath = resolve(next);
      i += 1;
    } else if (arg === "--output-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--output-dir requires a path");
      outputDir = resolve(next);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (vacuum && !apply) throw new Error("--vacuum requires --apply (it takes an exclusive lock on the live db)");
  if (classifyCanonical && (apply || vacuum)) {
    throw new Error("--classify-canonical is dry-run only and cannot be combined with --apply/--vacuum");
  }
  if (pointerize && classifyCanonical) throw new Error("--pointerize cannot be combined with --classify-canonical");
  if (pointerize && vacuum) throw new Error("--pointerize cannot be combined with --vacuum");
  return {
    apply, json, vacuum, retentionDays, dbPath, receiptDir, nowMs,
    classifyCanonical, pointerize, pointerizeSettleMs, manifestPath, stateDbPath, outputDir,
  };
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function runPrune(options: {
  dbPath: string;
  apply: boolean;
  vacuum: boolean;
  retentionDays: number;
  nowMs: number;
  busyTimeoutMs?: number;
}): PruneSummary {
  if (!existsSync(options.dbPath)) throw new Error(`db not found: ${options.dbPath}`);
  const cutoffMs = options.nowMs - options.retentionDays * DAY_MS;
  const summary: PruneSummary = {
    mode: options.apply ? "apply" : "dry-run",
    dbPath: options.dbPath,
    retentionDays: options.retentionDays,
    cutoffMs,
    candidateRows: 0,
    candidateStreamBytes: 0,
    prunedRows: 0,
    dbFileBytesBefore: fileBytes(options.dbPath),
    dbFileBytesAfter: 0,
  };

  const db: Database = new DatabaseConstructor(options.dbPath, { readonly: !options.apply });
  try {
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(stream_log)), 0) AS bytes FROM message_runs WHERE started_at < ? AND stream_log IS NOT NULL",
      )
      .get(cutoffMs) as { n: number; bytes: number };
    summary.candidateRows = row.n;
    summary.candidateStreamBytes = row.bytes;

    if (options.apply && row.n > 0) {
      const result = db
        .prepare("UPDATE message_runs SET stream_log = NULL WHERE started_at < ? AND stream_log IS NOT NULL")
        .run(cutoffMs);
      summary.prunedRows = result.changes;
      try {
        const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as unknown;
        summary.walCheckpoint = JSON.stringify(checkpoint);
      } catch (err) {
        summary.walCheckpoint = `failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (options.vacuum) {
      summary.vacuum = { requested: true, ran: false };
      try {
        db.exec("VACUUM");
        summary.vacuum.ran = true;
      } catch (err) {
        summary.vacuum.error = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    db.close();
  }

  summary.dbFileBytesAfter = fileBytes(options.dbPath);
  return summary;
}

export function writePruneReceipt(summary: PruneSummary, receiptDir: string, nowMs: number): string {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
  const receiptPath = join(receiptDir, `${stamp}-${summary.mode}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return receiptPath;
}

type HistoricalRunRow = {
  id: string;
  prompt: string | null;
  final_message: string | null;
  stream_log: string | null;
  started_at: number;
  session_id: string;
  backend_session_id: string | null;
};

type CanonicalRecord = {
  offset: number;
  length: number;
  payload: Record<string, unknown>;
};

type CanonicalValue = { sha256: string; offset: number; length: number };

type CanonicalTurn = {
  turnId: string;
  offset: number;
  length: number;
  streamSha256: string;
  prompts: CanonicalValue[];
  finals: CanonicalValue[];
};

export type CanonicalClassificationSummary = {
  classificationReport: string;
  reconstructionSamples: string;
  classification: {
    exact_reconstructible: number;
    ambiguous: number;
    unique_db_state: number;
  };
  reconstructionSampleTotal: number;
  reconstructionHashMatches: number;
  productionRowsModified: 0;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function promptVariants(value: string): string[] {
  const variants = new Set([value]);
  for (const marker of ["\n[User]\n", "[Current user message]\n"]) {
    const index = value.lastIndexOf(marker);
    if (index >= 0) variants.add(value.slice(index + marker.length));
  }
  return Array.from(variants);
}

function recordValues(record: CanonicalRecord): { prompts: string[]; finals: string[] } {
  const payload = record.payload;
  const prompts: string[] = [];
  const finals: string[] = [];
  if (payload.type === "user_message" && typeof payload.message === "string") prompts.push(payload.message);
  if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
    finals.push(payload.last_agent_message);
  }
  if (payload.type === "agent_message" && typeof payload.message === "string") finals.push(payload.message);
  if (payload.type === "message" && Array.isArray(payload.content)) {
    for (const item of payload.content) {
      const content = objectValue(item);
      if (!content || typeof content.text !== "string") continue;
      if (payload.role === "user" && content.type === "input_text") prompts.push(content.text);
      if (payload.role === "assistant" && content.type === "output_text") finals.push(content.text);
    }
  }
  return { prompts: prompts.flatMap(promptVariants), finals };
}

function parseCanonicalTurns(path: string): CanonicalTurn[] {
  const bytes = readFileSync(path);
  const turns: CanonicalTurn[] = [];
  let current: {
    turnId: string;
    offset: number;
    prompts: CanonicalValue[];
    finals: CanonicalValue[];
  } | null = null;
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline + 1;
    const parsed = JSON.parse(bytes.subarray(offset, end).toString("utf8").trimEnd()) as { payload?: unknown };
    const record: CanonicalRecord = {
      offset,
      length: end - offset,
      payload: objectValue(parsed.payload) ?? {},
    };
    if (record.payload.type === "task_started" && typeof record.payload.turn_id === "string") {
      current = { turnId: record.payload.turn_id, offset, prompts: [], finals: [] };
    }
    if (current) {
      const values = recordValues(record);
      current.prompts.push(...values.prompts.map((value) => ({
        sha256: sha256Utf8(value), offset: record.offset, length: record.length,
      })));
      current.finals.push(...values.finals.map((value) => ({
        sha256: sha256Utf8(value), offset: record.offset, length: record.length,
      })));
      if (record.payload.type === "task_complete" && record.payload.turn_id === current.turnId) {
        const length = end - current.offset;
        turns.push({
          turnId: current.turnId,
          offset: current.offset,
          length,
          streamSha256: sha256Utf8(bytes.subarray(current.offset, end).toString("utf8")),
          prompts: current.prompts,
          finals: current.finals,
        });
        current = null;
      }
    }
    offset = end;
  }
  return turns;
}

function tableExists(db: Database, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

function chooseStratifiedSamples<T extends { startedAt: number }>(rows: T[], perBand: number): Array<T & { band: string }> {
  const ordered = [...rows].sort((a, b) => a.startedAt - b.startedAt);
  if (ordered.length < perBand * 3) return [];
  const early = ordered.slice(0, perBand);
  const late = ordered.slice(-perBand);
  const middlePool = ordered.slice(perBand, -perBand);
  const middleStart = Math.max(0, Math.floor((middlePool.length - perBand) / 2));
  const middle = middlePool.slice(middleStart, middleStart + perBand);
  return [
    ...early.map((row) => ({ ...row, band: "early" })),
    ...middle.map((row) => ({ ...row, band: "middle" })),
    ...late.map((row) => ({ ...row, band: "late" })),
  ];
}

export function classifyCanonicalHistory(options: {
  dbPath: string;
  stateDbPath: string;
  outputDir: string;
  nowMs: number;
  samplePerBand?: number;
}): CanonicalClassificationSummary {
  if (!existsSync(options.dbPath)) throw new Error(`db not found: ${options.dbPath}`);
  if (!existsSync(options.stateDbPath)) throw new Error(`codex state db not found: ${options.stateDbPath}`);
  mkdirSync(options.outputDir, { recursive: true });
  const db: Database = new DatabaseConstructor(options.dbPath, { readonly: true, fileMustExist: true });
  const stateDb: Database = new DatabaseConstructor(options.stateDbPath, { readonly: true, fileMustExist: true });
  try {
    const hasPointers = tableExists(db, "message_run_canonical_pointers");
    const completedContentFilter = hasPointers
      ? `AND (mr.final_message IS NOT NULL OR EXISTS (
           SELECT 1 FROM message_run_canonical_pointers p
           WHERE p.message_run_id = mr.id AND p.content_kind = 'final_message'
         ))`
      : "AND mr.final_message IS NOT NULL";
    const runs = db.prepare(
      `SELECT mr.id, mr.prompt, mr.final_message, mr.stream_log, mr.started_at,
              mr.session_id, s.backend_session_id
       FROM message_runs mr
       JOIN sessions s ON s.id = mr.session_id
       WHERE s.backend = 'codex'
         AND mr.status = 'completed'
         ${completedContentFilter}
       ORDER BY mr.started_at ASC, mr.id ASC`,
    );
    const threadRows = stateDb.prepare("SELECT id, rollout_path FROM threads").all() as Array<{
      id: string;
      rollout_path: string;
    }>;
    const rolloutBySession = new Map(threadRows.map((row) => [row.id, row.rollout_path]));
    const turnCache = new Map<string, CanonicalTurn[]>();
    const candidates: Array<{
      messageRunId: string;
      backendSessionId: string;
      archivePath: string;
      startedAt: number;
      promptHash: string;
      finalHash: string;
      turn: CanonicalTurn;
      promptRecord: CanonicalValue;
      finalRecord: CanonicalValue;
    }> = [];
    const entries: Array<Record<string, unknown>> = [];
    const classification = { exact_reconstructible: 0, ambiguous: 0, unique_db_state: 0 };

    for (const run of runs.iterate() as IterableIterator<HistoricalRunRow>) {
      const archivePath = run.backend_session_id ? rolloutBySession.get(run.backend_session_id) : undefined;
      let category: keyof typeof classification = archivePath && existsSync(archivePath)
        ? "ambiguous"
        : "unique_db_state";
      let reason = archivePath && existsSync(archivePath)
        ? "backend_session_id_only_no_native_message_run_to_turn_key"
        : "no_readable_rollout_for_current_backend_session_id";
      if (hasPointers) {
        const pointerKinds = db.prepare(
          "SELECT content_kind FROM message_run_canonical_pointers WHERE message_run_id = ?",
        ).all(run.id) as Array<{ content_kind: string }>;
        if (pointerKinds.some((row) => row.content_kind === "prompt") && pointerKinds.some((row) => row.content_kind === "final_message")) {
          try {
            const prompt = reconstructMessageRunContent(db, run.id, "prompt");
            const finalMessage = reconstructMessageRunContent(db, run.id, "final_message");
            if (
              (run.prompt === null || run.prompt === "" || sha256Utf8(run.prompt) === sha256Utf8(prompt))
              && (run.final_message === null || run.final_message === "" || sha256Utf8(run.final_message) === sha256Utf8(finalMessage))
            ) {
              category = "exact_reconstructible";
              reason = "native_message_run_pointer_and_content_hash_verified";
            }
          } catch (error) {
            category = "ambiguous";
            reason = `pointer_verification_failed:${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
      classification[category] += 1;
      entries.push({
        message_run_id: run.id,
        session_id: run.session_id,
        backend_session_id: run.backend_session_id,
        started_at: run.started_at,
        classification: category,
        reason,
      });

      if (!archivePath || !existsSync(archivePath) || run.prompt === null || run.final_message === null) continue;
      let turns = turnCache.get(archivePath);
      if (!turns) {
        turns = parseCanonicalTurns(archivePath);
        turnCache.set(archivePath, turns);
      }
      const promptHash = sha256Utf8(run.prompt);
      const finalHash = sha256Utf8(run.final_message);
      const matches = turns.flatMap((turn) => {
        const promptRecord = turn.prompts.find((value) => value.sha256 === promptHash);
        const finalRecord = turn.finals.find((value) => value.sha256 === finalHash);
        return promptRecord && finalRecord ? [{ turn, promptRecord, finalRecord }] : [];
      });
      if (matches.length === 1) {
        candidates.push({
          messageRunId: run.id,
          backendSessionId: run.backend_session_id!,
          archivePath,
          startedAt: run.started_at,
          promptHash,
          finalHash,
          ...matches[0]!,
        });
      }
    }

    const candidateKeyCounts = new Map<string, number>();
    for (const candidate of candidates) {
      const key = `${candidate.archivePath}\u0000${candidate.turn.turnId}`;
      candidateKeyCounts.set(key, (candidateKeyCounts.get(key) ?? 0) + 1);
    }
    const uniqueCandidates = candidates.filter((candidate) =>
      candidateKeyCounts.get(`${candidate.archivePath}\u0000${candidate.turn.turnId}`) === 1
    );
    const samplePerBand = options.samplePerBand ?? 20;
    const selected = chooseStratifiedSamples(uniqueCandidates, samplePerBand);
    if (selected.length !== samplePerBand * 3) {
      throw new Error(`insufficient unique canonical reconstruction samples: ${uniqueCandidates.length}`);
    }
    const samples = selected.map((sample) => {
      const promptHash = sample.promptHash;
      const finalHash = sample.finalHash;
      const rebuiltPromptHash = sample.promptRecord.sha256;
      const rebuiltFinalHash = sample.finalRecord.sha256;
      return {
        band: sample.band,
        message_run_id: sample.messageRunId,
        backend_session_id: sample.backendSessionId,
        canonical_object_id: sample.turn.turnId,
        started_at: sample.startedAt,
        prompt: {
          db_sha256: promptHash,
          reconstructed_sha256: rebuiltPromptHash,
          match: promptHash === rebuiltPromptHash,
          pointer: {
            archive_path: sample.archivePath,
            byte_offset: sample.promptRecord.offset,
            byte_length: sample.promptRecord.length,
            content_sha256: promptHash,
            schema_version: 1,
            created_at: options.nowMs,
          },
        },
        final_message: {
          db_sha256: finalHash,
          reconstructed_sha256: rebuiltFinalHash,
          match: finalHash === rebuiltFinalHash,
          pointer: {
            archive_path: sample.archivePath,
            byte_offset: sample.finalRecord.offset,
            byte_length: sample.finalRecord.length,
            content_sha256: finalHash,
            schema_version: 1,
            created_at: options.nowMs,
          },
        },
        canonical_stream: {
          content_sha256: sample.turn.streamSha256,
          archive_path: sample.archivePath,
          byte_offset: sample.turn.offset,
          byte_length: sample.turn.length,
          schema_version: 1,
          created_at: options.nowMs,
        },
      };
    });
    const reconstructionHashMatches = samples.filter(
      (sample) => sample.prompt.match && sample.final_message.match,
    ).length;
    const classificationReport = join(options.outputDir, "T01-classification.json");
    const reconstructionSamples = join(options.outputDir, "T01-reconstruction-samples.json");
    writeFileSync(classificationReport, `${JSON.stringify({
      schema: "message-run-canonical-classification/v1",
      generated_at: new Date(options.nowMs).toISOString(),
      mode: "dry-run",
      production_rows_modified: 0,
      counts: classification,
      entries,
    }, null, 2)}\n`, "utf8");
    writeFileSync(reconstructionSamples, `${JSON.stringify({
      schema: "message-run-canonical-reconstruction-samples/v1",
      generated_at: new Date(options.nowMs).toISOString(),
      sample_total: samples.length,
      hash_matches: reconstructionHashMatches,
      bands: { early: samplePerBand, middle: samplePerBand, late: samplePerBand },
      stream_claim: "canonical rollout byte range only; DB stream_log is retained and not claimed reconstructible",
      samples,
    }, null, 2)}\n`, "utf8");
    return {
      classificationReport,
      reconstructionSamples,
      classification,
      reconstructionSampleTotal: samples.length,
      reconstructionHashMatches,
      productionRowsModified: 0,
    };
  } finally {
    stateDb.close();
    db.close();
  }
}

export type PointerizeVerdict =
  | "pointerized"
  | "verified_dry_run"
  | "skipped_stored_body_absent"
  | "skipped_hash_mismatch"
  | "skipped_pointer_unreadable"
  | "skipped_row_changed";

export type PointerizeEntry = {
  message_run_id: string;
  session_id: string;
  status: string;
  finished_at: number | null;
  verdict: PointerizeVerdict;
  reason: string;
  canonical: {
    prompt: { archive_path: string; byte_offset: number; byte_length: number; canonical_object_id: string } | null;
    final_message: { archive_path: string; byte_offset: number; byte_length: number; canonical_object_id: string } | null;
  };
  pre_reconstruct_sha256: { prompt: string | null; final_message: string | null };
  post_reconstruct_sha256: { prompt: string | null; final_message: string | null };
  cleared_bytes: { prompt: number; final_message: number };
};

export type PointerizeSummary = {
  schema: "message-run-pointerize-manifest/v1";
  mode: "dry-run" | "apply";
  dbPath: string;
  settleMs: number;
  cutoffMs: number;
  eligibleRows: number;
  pointerizedRows: number;
  skippedRows: number;
  clearedBytes: number;
  dbFileBytesBefore: number;
  dbFileBytesAfter: number;
  verdicts: Record<string, number>;
  entries: PointerizeEntry[];
};

type PointerizeCandidateRow = {
  id: string;
  session_id: string;
  status: string;
  finished_at: number | null;
  prompt: string;
  final_message: string | null;
};

/**
 * Clears the duplicated prompt/final_message body of Codex runs whose content is
 * already indexed into the immutable rollout canonical, and only those: every row
 * is re-derived from its pointer and hash-compared against the stored text before
 * the clear, and re-derived again afterwards inside the same transaction so a
 * post-clear mismatch rolls the row back instead of losing the only copy.
 * stream_log is deliberately untouched: T01 never claimed rollout/stream equivalence.
 */
export function pointerizeExactReconstructible(options: {
  dbPath: string;
  apply: boolean;
  nowMs: number;
  settleMs?: number;
  busyTimeoutMs?: number;
}): PointerizeSummary {
  if (!existsSync(options.dbPath)) throw new Error(`db not found: ${options.dbPath}`);
  const settleMs = options.settleMs ?? DEFAULT_POINTERIZE_SETTLE_MS;
  const cutoffMs = options.nowMs - settleMs;
  const summary: PointerizeSummary = {
    schema: "message-run-pointerize-manifest/v1",
    mode: options.apply ? "apply" : "dry-run",
    dbPath: options.dbPath,
    settleMs,
    cutoffMs,
    eligibleRows: 0,
    pointerizedRows: 0,
    skippedRows: 0,
    clearedBytes: 0,
    dbFileBytesBefore: fileBytes(options.dbPath),
    dbFileBytesAfter: 0,
    verdicts: {},
    entries: [],
  };

  const db: Database = new DatabaseConstructor(options.dbPath, { readonly: !options.apply });
  try {
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    if (!tableExists(db, "message_run_canonical_pointers")) {
      summary.dbFileBytesAfter = fileBytes(options.dbPath);
      return summary;
    }
    const rows = db.prepare(
      `SELECT mr.id, mr.session_id, mr.status, mr.finished_at, mr.prompt, mr.final_message
       FROM message_runs mr
       WHERE mr.status = 'completed'
         AND mr.finished_at IS NOT NULL
         AND mr.finished_at <= ?
         AND EXISTS (SELECT 1 FROM message_run_canonical_pointers p
                     WHERE p.message_run_id = mr.id AND p.content_kind = 'prompt')
         AND EXISTS (SELECT 1 FROM message_run_canonical_pointers p
                     WHERE p.message_run_id = mr.id AND p.content_kind = 'final_message')
       ORDER BY mr.finished_at ASC, mr.id ASC`,
    ).all(cutoffMs) as PointerizeCandidateRow[];

    const clearRow = options.apply
      ? db.prepare(
        `UPDATE message_runs SET prompt = '', final_message = NULL
         WHERE id = ? AND status = 'completed' AND prompt = ? AND final_message IS ?`,
      )
      : null;

    for (const row of rows) {
      summary.eligibleRows += 1;
      const promptPointer = findMessageRunCanonicalPointer(db, row.id, "prompt");
      const finalPointer = findMessageRunCanonicalPointer(db, row.id, "final_message");
      const entry: PointerizeEntry = {
        message_run_id: row.id,
        session_id: row.session_id,
        status: row.status,
        finished_at: row.finished_at,
        verdict: "skipped_pointer_unreadable",
        reason: "",
        canonical: {
          prompt: promptPointer
            ? {
              archive_path: promptPointer.archivePath,
              byte_offset: promptPointer.byteOffset,
              byte_length: promptPointer.byteLength,
              canonical_object_id: promptPointer.canonicalObjectId,
            }
            : null,
          final_message: finalPointer
            ? {
              archive_path: finalPointer.archivePath,
              byte_offset: finalPointer.byteOffset,
              byte_length: finalPointer.byteLength,
              canonical_object_id: finalPointer.canonicalObjectId,
            }
            : null,
        },
        pre_reconstruct_sha256: { prompt: null, final_message: null },
        post_reconstruct_sha256: { prompt: null, final_message: null },
        cleared_bytes: { prompt: 0, final_message: 0 },
      };

      const storedPrompt = row.prompt;
      const storedFinal = row.final_message;
      if (storedPrompt === "" && (storedFinal === null || storedFinal === "")) {
        entry.verdict = "skipped_stored_body_absent";
        entry.reason = "row already carries no duplicated body";
        summary.skippedRows += 1;
        summary.verdicts[entry.verdict] = (summary.verdicts[entry.verdict] ?? 0) + 1;
        summary.entries.push(entry);
        continue;
      }

      let rebuiltPrompt: string;
      let rebuiltFinal: string;
      try {
        rebuiltPrompt = reconstructMessageRunContent(db, row.id, "prompt");
        rebuiltFinal = reconstructMessageRunContent(db, row.id, "final_message");
      } catch (error) {
        entry.reason = `canonical reconstruction failed: ${error instanceof Error ? error.message : String(error)}`;
        summary.skippedRows += 1;
        summary.verdicts[entry.verdict] = (summary.verdicts[entry.verdict] ?? 0) + 1;
        summary.entries.push(entry);
        continue;
      }
      const promptHash = sha256Utf8(rebuiltPrompt);
      const finalHash = sha256Utf8(rebuiltFinal);
      entry.pre_reconstruct_sha256 = { prompt: promptHash, final_message: finalHash };

      const promptMatches = storedPrompt === "" || sha256Utf8(storedPrompt) === promptHash;
      const finalMatches = storedFinal === null || storedFinal === "" || sha256Utf8(storedFinal) === finalHash;
      if (!promptMatches || !finalMatches) {
        entry.verdict = "skipped_hash_mismatch";
        entry.reason = `stored body differs from canonical (prompt_match=${promptMatches}, final_match=${finalMatches})`;
        summary.skippedRows += 1;
        summary.verdicts[entry.verdict] = (summary.verdicts[entry.verdict] ?? 0) + 1;
        summary.entries.push(entry);
        continue;
      }

      entry.cleared_bytes = {
        prompt: Buffer.byteLength(storedPrompt, "utf8"),
        final_message: storedFinal ? Buffer.byteLength(storedFinal, "utf8") : 0,
      };

      if (!options.apply) {
        entry.verdict = "verified_dry_run";
        entry.reason = "native pointer key and content hash both verified";
        entry.post_reconstruct_sha256 = { prompt: promptHash, final_message: finalHash };
        summary.verdicts[entry.verdict] = (summary.verdicts[entry.verdict] ?? 0) + 1;
        summary.entries.push(entry);
        continue;
      }

      let cleared = false;
      try {
        db.transaction(() => {
          const result = clearRow!.run(row.id, storedPrompt, storedFinal);
          if (result.changes === 0) throw new RowChangedError();
          const afterPrompt = visibleMessageRunContent(db, row.id, "prompt", "");
          const afterFinal = visibleMessageRunContent(db, row.id, "final_message", null);
          if (afterPrompt === null || sha256Utf8(afterPrompt) !== promptHash) {
            throw new Error("post-clear prompt reconstruction hash mismatch");
          }
          if (afterFinal === null || sha256Utf8(afterFinal) !== finalHash) {
            throw new Error("post-clear final_message reconstruction hash mismatch");
          }
          entry.post_reconstruct_sha256 = {
            prompt: sha256Utf8(afterPrompt),
            final_message: sha256Utf8(afterFinal),
          };
          cleared = true;
        })();
      } catch (error) {
        cleared = false;
        entry.post_reconstruct_sha256 = { prompt: null, final_message: null };
        entry.cleared_bytes = { prompt: 0, final_message: 0 };
        if (error instanceof RowChangedError) {
          entry.verdict = "skipped_row_changed";
          entry.reason = "row body changed between read and clear; left untouched";
        } else {
          entry.verdict = "skipped_hash_mismatch";
          entry.reason = `post-clear verification failed, transaction rolled back: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (cleared) {
        entry.verdict = "pointerized";
        entry.reason = "native pointer key and content hash verified before and after the clear";
        summary.pointerizedRows += 1;
        summary.clearedBytes += entry.cleared_bytes.prompt + entry.cleared_bytes.final_message;
      } else {
        summary.skippedRows += 1;
      }
      summary.verdicts[entry.verdict] = (summary.verdicts[entry.verdict] ?? 0) + 1;
      summary.entries.push(entry);
    }
  } finally {
    db.close();
  }
  summary.dbFileBytesAfter = fileBytes(options.dbPath);
  return summary;
}

class RowChangedError extends Error {}

function formatMiB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.pointerize) {
    const summary = pointerizeExactReconstructible({
      dbPath: options.dbPath,
      apply: options.apply,
      nowMs: options.nowMs,
      settleMs: options.pointerizeSettleMs,
    });
    const manifestPath = options.manifestPath
      ?? join(options.outputDir, `R25-pointerize-${summary.mode}.json`);
    mkdirSync(options.manifestPath ? resolve(manifestPath, "..") : options.outputDir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    const { entries: _entries, ...totals } = summary;
    console.log(JSON.stringify({ ...totals, manifestPath }, null, options.json ? 2 : 0));
    return;
  }
  if (options.classifyCanonical) {
    const summary = classifyCanonicalHistory({
      dbPath: options.dbPath,
      stateDbPath: options.stateDbPath,
      outputDir: options.outputDir,
      nowMs: options.nowMs,
    });
    console.log(JSON.stringify(summary, null, options.json ? 2 : 0));
    return;
  }
  const summary = runPrune(options);
  const receiptPath = writePruneReceipt(summary, options.receiptDir, options.nowMs);
  if (options.json) {
    console.log(JSON.stringify({ ...summary, receiptPath }, null, 2));
    return;
  }
  console.log(`[prune-message-runs] mode=${summary.mode} db=${summary.dbPath}`);
  console.log(
    `[prune-message-runs] candidates=${summary.candidateRows} streamBytes=${formatMiB(summary.candidateStreamBytes)} pruned=${summary.prunedRows}`,
  );
  if (summary.vacuum) {
    console.log(`[prune-message-runs] vacuum ran=${summary.vacuum.ran}${summary.vacuum.error ? ` error=${summary.vacuum.error}` : ""}`);
  }
  console.log(
    `[prune-message-runs] dbFile ${formatMiB(summary.dbFileBytesBefore)} -> ${formatMiB(summary.dbFileBytesAfter)} receipt=${receiptPath}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
