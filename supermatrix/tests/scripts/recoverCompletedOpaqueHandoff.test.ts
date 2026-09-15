import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { parseOpaqueHandoffPrompt } from "../../src/app/opaqueHandoff.ts";
import {
  recoverCompletedOpaqueHandoff,
  type CompletedOpaqueHandoffRecoveryInput,
} from "../../scripts/lib/recoverCompletedOpaqueHandoff.ts";

const commId = "comm_af60b6b0_1787849196340";
const clientRequestId = "2026-08-28:pinglunmaster:product-tracker:parent-comment-followup:cbf298d1fb2520c79f020ca1";
const sourcePrompt = [
  "[parent-comment-follow-up handoff]",
  "Invoke exactly this fixed command: bin/parent-comment-problem-sync.sh --input - --handoff-comm-id '<framework comm_id>'.",
  "[opaque_envelope_base64]",
  Buffer.from('{"handoff":{"delivery_mode":"spawn2_todo_pool"}}', "utf8").toString("base64"),
  "[/opaque_envelope_base64]",
].join("\n");
const envelopeSha256 = parseOpaqueHandoffPrompt(sourcePrompt)!.bytesSha256;

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

describe("recoverCompletedOpaqueHandoff", () => {
  test("releases the original key for a closed delivered failure receipt with zero side effects", async () => {
    const db = await seededDb({ asyncStatus: "closed", asyncVerdict: "delivered" });
    try {
      const input = recoveryInput();
      expect(recoverCompletedOpaqueHandoff(db, input, { apply: false })).toMatchObject({
        outcome: "eligible",
        envelopeSha256,
        keyRetryable: false,
        wouldMakeKeyRetryable: true,
      });
      expect(recoverCompletedOpaqueHandoff(db, input, { apply: true })).toMatchObject({
        outcome: "recovered",
        applied: true,
        keyRetryable: true,
        clientRequestId,
      });
      expect(db.prepare("SELECT status, error_message FROM cross_session_log WHERE id = ?").get(commId)).toMatchObject({
        status: "failed",
        error_message: expect.stringContaining("no-write/no-readback proof"),
      });
      expect(db.prepare("SELECT status, verdict FROM spawn_async_items WHERE comm_id = ?").get(commId)).toEqual({ status: "closed", verdict: "delivered" });
    } finally {
      db.close();
    }
  });

  test("blocks recovery when the terminal message is a real delivery success", async () => {
    const db = await seededDb({
      asyncStatus: "closed",
      asyncVerdict: "delivered",
      finalMessage: '{"ok":true,"row_count":1,"read_back_verified":true}',
    });
    try {
      expect(recoverCompletedOpaqueHandoff(db, recoveryInput(), { apply: true })).toMatchObject({
        outcome: "blocked",
        blocker: "terminal_failure_receipt_missing",
      });
      expect(db.prepare("SELECT status FROM cross_session_log WHERE id = ?").get(commId)).toEqual({ status: "completed" });
    } finally {
      db.close();
    }
  });

  test("aggregates every async receipt for the comm and blocks if any was consumed", async () => {
    const db = await seededDb({ asyncStatus: "parked", asyncVerdict: null });
    try {
      db.prepare(
        "INSERT INTO spawn_async_items (ref, comm_id, status, verdict, verdict_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("async_delivered_second", commId, "closed", "caller_consumed", "caller took result", 2);
      expect(recoverCompletedOpaqueHandoff(db, recoveryInput(), { apply: true })).toMatchObject({
        outcome: "blocked",
        blocker: "prior_delivery_terminal",
      });
      expect(db.prepare("SELECT status FROM cross_session_log WHERE id = ?").get(commId)).toEqual({ status: "completed" });
    } finally {
      db.close();
    }
  });

  test("blocks recovery while the historical receipt is not closed", async () => {
    const db = await seededDb({ asyncStatus: "parked", asyncVerdict: null });
    try {
      db.prepare(
        "INSERT INTO spawn_async_items (ref, comm_id, status, verdict, verdict_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("async_delivering_second", commId, "delivering", null, null, 2);
      expect(recoverCompletedOpaqueHandoff(db, recoveryInput(), { apply: true })).toMatchObject({
        outcome: "blocked",
        blocker: "async_receipt_not_closed",
      });
    } finally {
      db.close();
    }
  });

  test("blocks recovery when no closed delivered historical receipt exists", async () => {
    const db = await seededDb({ asyncStatus: "parked", asyncVerdict: null });
    try {
      expect(recoverCompletedOpaqueHandoff(db, recoveryInput(), { apply: true })).toMatchObject({
        outcome: "blocked",
        blocker: "async_receipt_not_closed",
      });
    } finally {
      db.close();
    }
  });

  test("blocks a proof that does not bind the exact original envelope bytes", async () => {
    const db = await seededDb();
    try {
      const input = recoveryInput();
      input.proof.envelope_sha256 = createHash("sha256").update("spawnr_todo_pool").digest("hex");
      expect(recoverCompletedOpaqueHandoff(db, input, { apply: true })).toMatchObject({
        outcome: "blocked",
        blocker: "proof_envelope_digest_mismatch",
      });
      expect(db.prepare("SELECT status FROM cross_session_log WHERE id = ?").get(commId)).toEqual({ status: "completed" });
    } finally {
      db.close();
    }
  });

  test("blocks caller-consumed failure receipts even when the business side effect was absent", async () => {
    const db = await seededDb({ asyncStatus: "closed", asyncVerdict: "caller_consumed" });
    try {
      expect(recoverCompletedOpaqueHandoff(db, recoveryInput(), { apply: false })).toMatchObject({
        outcome: "blocked",
        blocker: "prior_delivery_terminal",
      });
    } finally {
      db.close();
    }
  });

  test("blocks a terminal receipt whose client request id is not the recovered key", async () => {
    const db = await seededDb({ asyncStatus: "closed", asyncVerdict: "delivered", terminalClientRequestId: "other-key" });
    try {
      expect(recoverCompletedOpaqueHandoff(db, recoveryInput(), { apply: false })).toMatchObject({
        outcome: "blocked",
        blocker: "terminal_failure_receipt_missing",
      });
    } finally {
      db.close();
    }
  });

  test("does not use a receipt belonging to another comm with the same client request id", async () => {
    const db = await seededDb({ asyncStatus: "closed", asyncVerdict: "delivered" });
    try {
      db.prepare(
        `INSERT INTO cross_session_log
          (id, from_session_id, to_session_id, kind, child_session_id, status, final_message, message_run_id, client_request_id, prompt)
         VALUES (?, ?, ?, 'spawn', 'other-child', 'failed', ?, NULL, ?, ?)`,
      ).run("comm_other", "source", "target", "{}", clientRequestId, sourcePrompt);
      db.prepare(
        "INSERT INTO spawn_async_items (ref, comm_id, status, verdict, verdict_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("async_other", "comm_other", "closed", "delivered", "other comm", 2);
      expect(recoverCompletedOpaqueHandoff(db, recoveryInput(), { apply: false })).toMatchObject({
        outcome: "blocked",
        blocker: "receipt_comm_id_mismatch",
      });
    } finally {
      db.close();
    }
  });

  test("blocks any proof that reports a queue, write, or high-water side effect", async () => {
    const db = await seededDb({ asyncStatus: "closed", asyncVerdict: "delivered" });
    try {
      const input = recoveryInput();
      input.proof.queue_job_count = 1 as never;
      expect(recoverCompletedOpaqueHandoff(db, input, { apply: false })).toMatchObject({
        outcome: "blocked",
        blocker: "proof_reports_side_effects",
      });
    } finally {
      db.close();
    }
  });
});

function recoveryInput(): CompletedOpaqueHandoffRecoveryInput {
  return {
    commId,
    clientRequestId,
    sourcePrompt,
    proof: {
      schema_version: "spawn2.opaque_handoff_no_side_effect.v1",
      comm_id: commId,
      client_request_id: clientRequestId,
      envelope_sha256: envelopeSha256,
      no_write_confirmed: true,
      no_readback_confirmed: true,
      queue_job_count: 0,
      feishu_write_count: 0,
      high_water_advanced: false,
    },
  };
}

async function seededDb(options: {
  asyncStatus?: string;
  asyncVerdict?: string | null;
  finalMessage?: string;
  terminalClientRequestId?: string;
} = {}): Promise<Database.Database> {
  const dir = await mkdtemp(join(tmpdir(), "sm-recover-opaque-handoff-"));
  cleanup.push(dir);
  const db = new Database(join(dir, "supermatrix.db"));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL);
    CREATE TABLE cross_session_log (
      id TEXT PRIMARY KEY, from_session_id TEXT NOT NULL, to_session_id TEXT NOT NULL,
      kind TEXT NOT NULL, child_session_id TEXT, status TEXT NOT NULL,
      final_message TEXT, error_message TEXT, message_run_id TEXT,
      client_request_id TEXT, prompt TEXT, finished_at INTEGER
    );
    CREATE TABLE message_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
      prompt TEXT, final_message TEXT, error_message TEXT
    );
    CREATE TABLE spawn_async_items (
      ref TEXT PRIMARY KEY, comm_id TEXT NOT NULL, status TEXT NOT NULL,
      verdict TEXT, verdict_reason TEXT, updated_at INTEGER
    );
  `);
  db.prepare("INSERT INTO sessions (id, name, scope) VALUES (?, ?, ?), (?, ?, ?)").run(
    "source", "pinglunmaster", "user", "target", "product-tracker", "user",
  );
  const terminalMessage = options.finalMessage ?? JSON.stringify({
    ok: false,
    failed: 1,
    row_count: 0,
    read_back_verified: false,
    error: "handoff_transport_invalid",
    handoff: {
      client_request_id: options.terminalClientRequestId ?? clientRequestId,
      delivery_mode: "spawnr_todo_pool",
      from_session: "pinglunmaster",
    },
  });
  db.prepare("INSERT INTO message_runs (id, session_id, status, prompt, final_message) VALUES (?, ?, ?, ?, ?)").run(
    "mr_child", "child", "completed", sourcePrompt, terminalMessage,
  );
  db.prepare(
    `INSERT INTO cross_session_log
      (id, from_session_id, to_session_id, kind, child_session_id, status, final_message, message_run_id, client_request_id, prompt)
     VALUES (?, ?, ?, 'spawn', 'child', 'completed', ?, 'mr_child', ?, ?)`,
  ).run(
    commId,
    "source",
    "target",
    terminalMessage,
    clientRequestId,
    sourcePrompt,
  );
  db.prepare("INSERT INTO spawn_async_items (ref, comm_id, status, verdict, verdict_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "async_f4171b7e",
    commId,
    options.asyncStatus ?? "waiting_child",
    options.asyncVerdict ?? null,
    null,
    1,
  );
  return db;
}
