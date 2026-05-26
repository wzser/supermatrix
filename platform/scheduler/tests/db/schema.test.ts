import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema";

describe("schema migrations", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => db.close());

  it("007 adds class/expectedDuration/overlapPolicy/ownerSession/overrides columns to tasks", () => {
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain("class");
    expect(names).toContain("expected_duration_ms");
    expect(names).toContain("overlap_policy");
    expect(names).toContain("owner_session");
    expect(names).toContain("overrides");
  });

  it("008 adds new lifecycle fields to task_runs", () => {
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain("trigger_status");
    expect(names).toContain("triggered_at");
    expect(names).toContain("running_pid");
    expect(names).toContain("child_session_id");
    expect(names).toContain("child_message_run_id");
    expect(names).toContain("process_exited_at");
    expect(names).toContain("verify_status");
    expect(names).toContain("verify_attempts");
    expect(names).toContain("receipt_evidence");
    expect(names).toContain("final_status");
  });

  it("009 creates task_verifications table with due_at index", () => {
    applyMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain("task_verifications");

    const cols = db.prepare("PRAGMA table_info(task_verifications)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "run_id", "due_at", "attempts", "status", "created_at"
    ]));

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_verifications'").all() as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toContain("idx_task_verifications_due");
  });

  it("010 creates heal_proposals table (reserved for Plan 2)", () => {
    applyMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain("heal_proposals");

    const cols = db.prepare("PRAGMA table_info(heal_proposals)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "task_id", "run_id", "reason", "spawned_at",
      "child_session_id", "status", "spawn_retry_count",
      "reply_action", "reply_raw", "replied_at", "default_applied_at"
    ]));
  });

  describe("migration 011: migration_proposals + migration_preview_sent + tasks.migration_escalation_stage", () => {
    it("creates migration_proposals with expected columns", () => {
      const db = new Database(":memory:");
      applyMigrations(db);
      const cols = db.prepare("PRAGMA table_info(migration_proposals)").all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "id", "task_id", "owner_session", "status",
          "child_session_id", "spawned_at", "replied_at",
          "reply_action", "reply_raw", "default_applied_at",
          "suggested_class", "suggested_expected_duration_ms",
        ])
      );
      db.close();
    });

    it("creates migration_preview_sent with owner_session primary key", () => {
      const db = new Database(":memory:");
      applyMigrations(db);
      const cols = db.prepare("PRAGMA table_info(migration_preview_sent)").all() as Array<{ name: string; pk: number }>;
      const pkCol = cols.find((c) => c.pk === 1);
      expect(pkCol?.name).toBe("owner_session");
      db.close();
    });

    it("adds migration_escalation_stage column to tasks with default 0", () => {
      const db = new Database(":memory:");
      applyMigrations(db);
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; dflt_value: string | null }>;
      const c = cols.find((c) => c.name === "migration_escalation_stage");
      expect(c).toBeDefined();
      expect(c?.dflt_value).toBe("0");
      db.close();
    });
  });

  it("012 creates bitable_delete_retries with task_id PK and expected columns", () => {
    applyMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain("bitable_delete_retries");

    const cols = db.prepare("PRAGMA table_info(bitable_delete_retries)").all() as Array<{ name: string; pk: number; notnull: number }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(["task_id", "queued_at", "attempts", "last_error"]));
    const pk = cols.find(c => c.pk === 1);
    expect(pk?.name).toBe("task_id");
  });
});

describe("creation_reviews schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("creates creation_reviews table with required columns", () => {
    const cols = db.prepare("PRAGMA table_info(creation_reviews)").all() as Array<{name: string}>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "created_at","decided_at","decision_patch","decision_reason",
      "dispatched_at","id","l1_report","status","task_id","task_snapshot",
      "trigger","updated_at",
    ].sort());
  });

  it("creates indexes on status and task_id", () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='creation_reviews'").all() as Array<{name: string}>;
    const names = idx.map(i => i.name).sort();
    expect(names).toContain("idx_creation_reviews_status");
    expect(names).toContain("idx_creation_reviews_task");
  });

  it("status defaults to pending", () => {
    db.exec(`INSERT INTO tasks (id, name, cron, executor, config, created_at, updated_at) VALUES ('t1', 'n', '* * * * *', 'shell', '{}', 0, 0)`);
    db.prepare(`INSERT INTO creation_reviews (id, task_id, trigger, task_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("r1", "t1", "post_create", "{}", 0, 0);
    const row = db.prepare("SELECT status FROM creation_reviews WHERE id=?").get("r1") as {status: string};
    expect(row.status).toBe("pending");
  });

  it("cascades on task delete", () => {
    db.exec(`INSERT INTO tasks (id, name, cron, executor, config, created_at, updated_at) VALUES ('t2', 'n', '* * * * *', 'shell', '{}', 0, 0)`);
    db.prepare(`INSERT INTO creation_reviews (id, task_id, trigger, task_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("r2", "t2", "post_create", "{}", 0, 0);
    db.exec(`PRAGMA foreign_keys = ON`);
    db.prepare(`DELETE FROM tasks WHERE id=?`).run("t2");
    const row = db.prepare(`SELECT id FROM creation_reviews WHERE id=?`).get("r2");
    expect(row).toBeUndefined();
  });
});
