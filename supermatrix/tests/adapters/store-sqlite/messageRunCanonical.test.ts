import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  CANONICAL_STATE_DB_UNREADABLE_REASON,
  CanonicalContentHashMismatchError,
  indexMessageRunCanonicalPointers,
  reconstructMessageRunContent,
  verifyMessageRunCanonicalPointer,
} from "../../../src/adapters/store-sqlite/messageRunCanonical.ts";
import { pointerizeExactReconstructible } from "../../../scripts/prune-message-runs.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "message-run-canonical-"));
  roots.push(root);
  return root;
}

function rolloutLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("message run canonical pointers", () => {
  test("finish writes verifiable pointers and empty DB values read through canonical", async () => {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    const stateDbPath = join(root, "state_5.sqlite");
    const rolloutPath = join(root, "rollout.jsonl");
    const backendSessionId = "thread_native_1";
    const turnId = "turn_native_1";
    const prompt = "do the exact task";
    const finalMessage = "done exactly";
    writeFileSync(rolloutPath, [
      rolloutLine({ type: "session_meta", payload: { id: backendSessionId } }),
      rolloutLine({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
      rolloutLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[System]\nrules\n\n[User]\n${prompt}` }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
      rolloutLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: finalMessage }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
      rolloutLine({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: finalMessage } }),
    ].join(""), "utf8");
    const stateDb = new Database(stateDbPath);
    stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    stateDb.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(backendSessionId, rolloutPath);
    stateDb.close();

    const store = new SqliteBindingStore(dbPath, { codexStateDbPath: stateDbPath });
    await store.init();
    await store.createSessionWithBinding({
      id: asSessionId("s1"),
      name: "canonical-test",
      scope: "user",
      backend: "codex",
      workdir: asAbsolutePath(root),
      purpose: "",
      createdAt: asTimestamp(1_700_000_000_000),
    }, asLarkGroupId("oc_1"));
    await store.startMessageRun({
      id: asMessageRunId("mr1"),
      sessionId: asSessionId("s1"),
      groupId: asLarkGroupId("oc_1"),
      prompt,
      startedAt: asTimestamp(1_700_000_100_000),
    });
    await store.finishMessageRun(
      asMessageRunId("mr1"),
      "completed",
      finalMessage,
      undefined,
      JSON.stringify([{ ts: 1, kind: "assistant_message", text: finalMessage, final: true }]),
      { backendSessionId, canonicalObjectId: turnId },
    );

    const pointers = store.db.prepare(
      `SELECT content_kind, backend_session_id, canonical_object_id, content_sha256,
              archive_path, byte_offset, byte_length, schema_version, created_at
       FROM message_run_canonical_pointers WHERE message_run_id = ? ORDER BY content_kind`,
    ).all("mr1") as Array<Record<string, unknown>>;
    expect(pointers.map((row) => row.content_kind)).toEqual(["canonical_stream", "final_message", "prompt"]);
    for (const pointer of pointers) {
      expect(pointer).toMatchObject({
        backend_session_id: backendSessionId,
        canonical_object_id: turnId,
        archive_path: rolloutPath,
        schema_version: 1,
      });
      expect(String(pointer.content_sha256)).toHaveLength(64);
      expect(Number(pointer.byte_offset)).toBeGreaterThanOrEqual(0);
      expect(Number(pointer.byte_length)).toBeGreaterThan(0);
      expect(Number(pointer.created_at)).toBeGreaterThan(0);
    }

    store.db.prepare("UPDATE message_runs SET prompt = '', final_message = NULL WHERE id = 'mr1'").run();
    const visible = await store.findLatestMessageRunBySession(asSessionId("s1"));
    expect(visible?.prompt).toBe(prompt);
    expect(visible?.finalMessage).toBe(finalMessage);
    expect(reconstructMessageRunContent(store.db, "mr1", "prompt")).toBe(prompt);
    expect(verifyMessageRunCanonicalPointer(store.db, "mr1", "canonical_stream")).toBe(true);
    await store.close();
    expect(readFileSync(rolloutPath, "utf8")).toContain(turnId);
  });

  test("hash drift fails closed instead of returning guessed canonical text", async () => {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    const stateDbPath = join(root, "state_5.sqlite");
    const rolloutPath = join(root, "rollout.jsonl");
    writeFileSync(rolloutPath, [
      rolloutLine({ type: "event_msg", payload: { type: "task_started", turn_id: "turn1" } }),
      rolloutLine({ type: "response_item", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "prompt" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn1" },
      } }),
      rolloutLine({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn1", last_agent_message: "final" } }),
    ].join(""));
    const stateDb = new Database(stateDbPath);
    stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    stateDb.prepare("INSERT INTO threads VALUES (?, ?)").run("thread1", rolloutPath);
    stateDb.close();
    const store = new SqliteBindingStore(dbPath, { codexStateDbPath: stateDbPath });
    await store.init();
    await store.createSessionWithBinding({
      id: asSessionId("s1"), name: "hash-test", scope: "user", backend: "codex",
      workdir: asAbsolutePath(root), purpose: "", createdAt: asTimestamp(1),
    }, asLarkGroupId("oc_1"));
    await store.startMessageRun({
      id: asMessageRunId("mr1"), sessionId: asSessionId("s1"), groupId: asLarkGroupId("oc_1"),
      prompt: "prompt", startedAt: asTimestamp(2),
    });
    await store.finishMessageRun(asMessageRunId("mr1"), "completed", "final", undefined, undefined, {
      backendSessionId: "thread1", canonicalObjectId: "turn1",
    });
    store.db.prepare(
      "UPDATE message_run_canonical_pointers SET content_sha256 = ? WHERE message_run_id = ? AND content_kind = 'final_message'",
    ).run("0".repeat(64), "mr1");
    store.db.prepare("UPDATE message_runs SET final_message = NULL WHERE id = 'mr1'").run();
    await expect(store.findLatestMessageRunBySession(asSessionId("s1"))).rejects.toBeInstanceOf(
      CanonicalContentHashMismatchError,
    );
    await store.close();
  });
});

describe("canonical state db open failures fail closed inside the indexer", () => {
  async function storeWithRun(input: {
    root: string;
    stateDbPath: string;
    prompt: string;
    finalMessage: string;
  }): Promise<SqliteBindingStore> {
    const store = new SqliteBindingStore(join(input.root, "supermatrix.db"), {
      codexStateDbPath: input.stateDbPath,
    });
    await store.init();
    await store.createSessionWithBinding({
      id: asSessionId("s1"),
      name: "state-db-failure",
      scope: "user",
      backend: "codex",
      workdir: asAbsolutePath(input.root),
      purpose: "",
      createdAt: asTimestamp(1),
    }, asLarkGroupId("oc_1"));
    await store.startMessageRun({
      id: asMessageRunId("mr1"),
      sessionId: asSessionId("s1"),
      groupId: asLarkGroupId("oc_1"),
      prompt: input.prompt,
      startedAt: asTimestamp(2),
    });
    return store;
  }

  test("missing state db does not throw out of finishMessageRun and keeps stored text", async () => {
    const root = tempRoot();
    const stateDbPath = join(root, "absent-state_5.sqlite");
    const prompt = "prompt that must survive";
    const finalMessage = "final that must survive";
    const store = await storeWithRun({ root, stateDbPath, prompt, finalMessage });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        store.finishMessageRun(asMessageRunId("mr1"), "completed", finalMessage, undefined, undefined, {
          backendSessionId: "thread1",
          canonicalObjectId: "turn1",
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("not canonicalised"),
        expect.objectContaining({
          messageRunId: "mr1",
          reason: expect.stringContaining(CANONICAL_STATE_DB_UNREADABLE_REASON),
        }),
      );
    } finally {
      warn.mockRestore();
    }

    const run = store.db.prepare(
      "SELECT status, prompt, final_message, error_message FROM message_runs WHERE id = 'mr1'",
    ).get() as { status: string; prompt: string; final_message: string; error_message: string | null };
    expect(run.status).toBe("completed");
    expect(run.prompt).toBe(prompt);
    expect(run.final_message).toBe(finalMessage);
    expect(run.error_message).toBeNull();
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM message_run_canonical_pointers WHERE message_run_id = 'mr1'")
        .get() as { n: number },
    ).toEqual({ n: 0 });
    await store.close();
  });

  test("unreadable state db reports a diagnosable reason instead of pointerising the run", async () => {
    const root = tempRoot();
    const stateDbPath = join(root, "state_5.sqlite");
    writeFileSync(stateDbPath, "this is not a sqlite database", "utf8");
    const store = await storeWithRun({ root, stateDbPath, prompt: "p", finalMessage: "f" });

    const result = await indexMessageRunCanonicalPointers({
      db: store.db,
      stateDbPath,
      messageRunId: "mr1",
      ref: { backendSessionId: "thread1", canonicalObjectId: "turn1" },
      createdAt: 3,
      attempts: 1,
      retryDelayMs: 0,
    });
    expect(result.indexed).toEqual([]);
    expect(result.reason).toContain(CANONICAL_STATE_DB_UNREADABLE_REASON);
    await store.close();
  });

  test("state db without a threads table is a state-db failure, not rollout_path_missing", async () => {
    const root = tempRoot();
    const stateDbPath = join(root, "state_5.sqlite");
    const stateDb = new Database(stateDbPath);
    stateDb.exec("CREATE TABLE unrelated (id TEXT)");
    stateDb.close();
    const store = await storeWithRun({ root, stateDbPath, prompt: "p", finalMessage: "f" });

    const result = await indexMessageRunCanonicalPointers({
      db: store.db,
      stateDbPath,
      messageRunId: "mr1",
      ref: { backendSessionId: "thread1", canonicalObjectId: "turn1" },
      createdAt: 3,
      attempts: 1,
      retryDelayMs: 0,
    });
    expect(result.indexed).toEqual([]);
    expect(result.reason).toContain(CANONICAL_STATE_DB_UNREADABLE_REASON);
    await store.close();
  });

  test("readable state db with no matching thread still reports rollout_path_missing", async () => {
    const root = tempRoot();
    const stateDbPath = join(root, "state_5.sqlite");
    const stateDb = new Database(stateDbPath);
    stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    stateDb.close();
    const store = await storeWithRun({ root, stateDbPath, prompt: "p", finalMessage: "f" });

    const result = await indexMessageRunCanonicalPointers({
      db: store.db,
      stateDbPath,
      messageRunId: "mr1",
      ref: { backendSessionId: "thread-absent", canonicalObjectId: "turn1" },
      createdAt: 3,
      attempts: 1,
      retryDelayMs: 0,
    });
    expect(result).toEqual({ indexed: [], reason: "rollout_path_missing" });
    await store.close();
  });
});

describe("pointerizeExactReconstructible", () => {
  async function seedPointerizedStore(): Promise<{
    root: string;
    dbPath: string;
    prompt: string;
    finalMessage: string;
  }> {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    const stateDbPath = join(root, "state_5.sqlite");
    const rolloutPath = join(root, "rollout.jsonl");
    const backendSessionId = "thread_pointerize_1";
    const prompt = "pointerize me exactly";
    const finalMessage = "pointerize result";
    const lines: string[] = [
      `${JSON.stringify({ type: "session_meta", payload: { id: backendSessionId } })}\n`,
    ];
    for (const index of [1, 2]) {
      const turnId = `turn_pointerize_${index}`;
      lines.push(
        `${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } })}\n`,
        `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `${prompt} ${index}` }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        })}\n`,
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turnId, last_agent_message: `${finalMessage} ${index}` },
        })}\n`,
      );
    }
    writeFileSync(rolloutPath, lines.join(""), "utf8");
    const stateDb = new Database(stateDbPath);
    stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    stateDb.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(backendSessionId, rolloutPath);
    stateDb.close();

    const store = new SqliteBindingStore(dbPath, { codexStateDbPath: stateDbPath });
    await store.init();
    await store.createSessionWithBinding({
      id: asSessionId("s1"),
      name: "pointerize-test",
      scope: "user",
      backend: "codex",
      workdir: asAbsolutePath(root),
      purpose: "",
      createdAt: asTimestamp(1_700_000_000_000),
    }, asLarkGroupId("oc_1"));
    for (const index of [1, 2]) {
      await store.startMessageRun({
        id: asMessageRunId(`mr${index}`),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: `${prompt} ${index}`,
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.finishMessageRun(
        asMessageRunId(`mr${index}`),
        "completed",
        `${finalMessage} ${index}`,
        undefined,
        JSON.stringify([{ ts: 1, kind: "assistant_message", text: `${finalMessage} ${index}`, final: true }]),
        { backendSessionId, canonicalObjectId: `turn_pointerize_${index}` },
      );
    }
    await store.close();
    const settle = new Database(dbPath);
    settle.prepare("UPDATE message_runs SET finished_at = ?").run(1_700_000_200_000);
    settle.close();
    return { root, dbPath, prompt, finalMessage };
  }

  test("clears only hash-verified bodies and keeps them readable through the pointer", async () => {
    const { dbPath, prompt, finalMessage } = await seedPointerizedStore();
    const nowMs = 1_700_000_200_000 + 60 * 60 * 1000;

    const dry = pointerizeExactReconstructible({ dbPath, apply: false, nowMs });
    expect(dry.mode).toBe("dry-run");
    expect(dry.eligibleRows).toBe(2);
    expect(dry.pointerizedRows).toBe(0);
    expect(dry.entries.every((entry) => entry.verdict === "verified_dry_run")).toBe(true);
    const stillStored = new Database(dbPath, { readonly: true });
    expect(stillStored.prepare("SELECT prompt FROM message_runs WHERE id = 'mr1'").get())
      .toEqual({ prompt: `${prompt} 1` });
    stillStored.close();

    const applied = pointerizeExactReconstructible({ dbPath, apply: true, nowMs });
    expect(applied.pointerizedRows).toBe(2);
    expect(applied.skippedRows).toBe(0);
    expect(applied.clearedBytes).toBeGreaterThan(0);
    for (const entry of applied.entries) {
      expect(entry.verdict).toBe("pointerized");
      expect(entry.post_reconstruct_sha256.prompt).toBe(entry.pre_reconstruct_sha256.prompt);
      expect(entry.post_reconstruct_sha256.final_message).toBe(entry.pre_reconstruct_sha256.final_message);
    }

    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare("SELECT prompt, final_message, stream_log FROM message_runs WHERE id = 'mr1'").get())
      .toMatchObject({ prompt: "", final_message: null });
    expect(
      (after.prepare("SELECT stream_log FROM message_runs WHERE id = 'mr1'").get() as { stream_log: string | null })
        .stream_log,
    ).not.toBeNull();
    expect(reconstructMessageRunContent(after, "mr1", "prompt")).toBe(`${prompt} 1`);
    expect(reconstructMessageRunContent(after, "mr2", "final_message")).toBe(`${finalMessage} 2`);
    after.close();

    const rerun = pointerizeExactReconstructible({ dbPath, apply: true, nowMs });
    expect(rerun.pointerizedRows).toBe(0);
    expect(rerun.verdicts.skipped_stored_body_absent).toBe(2);
  });

  test("leaves rows untouched when the stored body does not match the canonical hash", async () => {
    const { dbPath } = await seedPointerizedStore();
    const nowMs = 1_700_000_200_000 + 60 * 60 * 1000;
    const tamper = new Database(dbPath);
    tamper.prepare("UPDATE message_runs SET final_message = 'drifted' WHERE id = 'mr1'").run();
    tamper.close();

    const applied = pointerizeExactReconstructible({ dbPath, apply: true, nowMs });
    expect(applied.pointerizedRows).toBe(1);
    expect(applied.verdicts.skipped_hash_mismatch).toBe(1);
    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare("SELECT final_message FROM message_runs WHERE id = 'mr1'").get())
      .toEqual({ final_message: "drifted" });
    after.close();
  });

  test("skips runs that have not settled and rows whose canonical archive is gone", async () => {
    const { root, dbPath } = await seedPointerizedStore();
    const tooEarly = pointerizeExactReconstructible({
      dbPath,
      apply: true,
      nowMs: 1_700_000_200_000 + 60 * 1000,
    });
    expect(tooEarly.eligibleRows).toBe(0);
    expect(tooEarly.pointerizedRows).toBe(0);

    rmSync(join(root, "rollout.jsonl"), { force: true });
    const orphaned = pointerizeExactReconstructible({
      dbPath,
      apply: true,
      nowMs: 1_700_000_200_000 + 60 * 60 * 1000,
    });
    expect(orphaned.pointerizedRows).toBe(0);
    expect(orphaned.verdicts.skipped_pointer_unreadable).toBe(2);
    const after = new Database(dbPath, { readonly: true });
    expect(
      (after.prepare("SELECT prompt FROM message_runs WHERE id = 'mr1'").get() as { prompt: string }).prompt,
    ).not.toBe("");
    after.close();
  });
});
