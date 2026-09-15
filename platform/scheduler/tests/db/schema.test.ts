import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";

describe("v2 schema", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  it("creates tasks with all tunable columns", () => {
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
      .map((c) => c.name).sort();
    expect(cols).toEqual([
      "alert_channel","alert_threshold","category","config","created_at","created_by",
      "cron","description","enabled","id","last_success_at","name","oneshot","owner",
      "retry_delay_ms","retry_enabled","retry_exit_codes","retry_max","type","updated_at",
    ].sort());
  });

  it("adds nullable retry_exit_codes without changing legacy task rows", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
        config TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        oneshot INTEGER NOT NULL DEFAULT 0, category TEXT, retry_enabled INTEGER NOT NULL DEFAULT 0,
        retry_max INTEGER NOT NULL DEFAULT 0, retry_delay_ms INTEGER NOT NULL DEFAULT 0,
        alert_threshold INTEGER NOT NULL DEFAULT 0, alert_channel TEXT NOT NULL DEFAULT 'owner_dm',
        last_success_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO tasks (id,name,owner,type,config,cron,created_at,updated_at)
      VALUES ('legacy','legacy task','owner','script','{}','* * * * *',1,1);
    `);

    applyMigrations(legacy);

    expect(legacy.prepare("SELECT name,retry_exit_codes FROM tasks WHERE id='legacy'").get()).toEqual({
      name: "legacy task",
      retry_exit_codes: null,
    });
  });

  it("creates task_runs with fire-and-forget columns", () => {
    const cols = (db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>)
      .map((c) => c.name).sort();
    expect(cols).toEqual([
      "attempts","child_session_id","error","finished_at","id","outcome","pid",
      "scheduled_at","task_id","triggered_at",
    ].sort());
  });

  it("creates an append-only task mutation audit table with mutation context and states", () => {
    const cols = (db.prepare("PRAGMA table_info(task_mutations)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual([
      "id", "timestamp", "occurred_at_utc", "task_id", "action", "actor_class",
      "actor_session", "source_comm_id", "before_state", "after_state",
    ]);
  });

  it("upgrades legacy mutation rows without inventing actor or comm context", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE task_mutations (
        id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('create', 'patch', 'delete')),
        actor_class TEXT NOT NULL
      );
      INSERT INTO task_mutations (timestamp,task_id,action,actor_class)
      VALUES (1786100000000,'legacy-task','patch','scheduler_admin');
    `);

    applyMigrations(legacy);

    expect(legacy.prepare(`
      SELECT occurred_at_utc,task_id,action,actor_class,actor_session,
             source_comm_id,before_state,after_state
      FROM task_mutations
    `).get()).toEqual({
      occurred_at_utc: expect.stringMatching(/Z$/),
      task_id: "legacy-task",
      action: "update",
      actor_class: "scheduler_admin",
      actor_session: null,
      source_comm_id: null,
      before_state: null,
      after_state: null,
    });
  });

  it("name is unique", () => {
    const ins = db.prepare(
      `INSERT INTO tasks (id,name,owner,type,config,cron,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`);
    ins.run("t1","dup","o","script","{}","* * * * *",0,0);
    expect(() => ins.run("t2","dup","o","script","{}","* * * * *",0,0)).toThrow();
  });

  it("task_runs.outcome defaults to failed (pessimistic)", () => {
    db.prepare(`INSERT INTO tasks (id,name,owner,type,config,cron,created_at,updated_at)
      VALUES ('t1','n','o','script','{}','* * * * *',0,0)`).run();
    db.prepare(`INSERT INTO task_runs (id,task_id,triggered_at) VALUES ('r1','t1',1)`).run();
    const row = db.prepare("SELECT outcome,attempts FROM task_runs WHERE id='r1'").get() as
      { outcome: string; attempts: number };
    expect(row.outcome).toBe("failed");
    expect(row.attempts).toBe(1);
  });

  it("cascades run deletes when task is removed", () => {
    db.prepare(`INSERT INTO tasks (id,name,owner,type,config,cron,created_at,updated_at)
      VALUES ('t1','n','o','script','{}','* * * * *',0,0)`).run();
    db.prepare(`INSERT INTO task_runs (id,task_id,triggered_at) VALUES ('r1','t1',1)`).run();
    db.prepare("DELETE FROM tasks WHERE id='t1'").run();
    expect(db.prepare("SELECT count(*) c FROM task_runs").get()).toEqual({ c: 0 });
  });
});
