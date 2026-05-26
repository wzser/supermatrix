import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { evaluateSpawnPredicate } from "../../../src/app/spawnPredicate/evaluate.ts";
import { validateSpawnPredicate } from "../../../src/app/spawnPredicate/schema.ts";
import type { PredicateDbRegistry } from "../../../src/ports/PredicateDbRegistry.ts";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, ...args]);
}

describe("spawn predicate evaluation", () => {
  test("git-log evaluator returns true and false in a temp git repo", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "sm-predicate-git-"));
    try {
      await execFileAsync("git", ["init", repoPath]);
      await git(repoPath, ["config", "user.email", "predicate@example.test"]);
      await git(repoPath, ["config", "user.name", "Predicate Test"]);
      await writeFile(join(repoPath, "target.txt"), "hello\n", "utf8");
      await git(repoPath, ["add", "target.txt"]);
      await git(repoPath, ["commit", "-m", "feat: predicate target commit"]);

      const truePredicate = validateSpawnPredicate(
        {
          type: "git-log",
          repo_path: repoPath,
          message_regex: "target commit",
          since: { kind: "timestamp_ms", value: 0 },
        },
        { allowedPathRoots: [repoPath] }
      ).predicate;
      const falsePredicate = validateSpawnPredicate(
        {
          type: "git-log",
          repo_path: repoPath,
          message_regex: "not present",
          since: { kind: "timestamp_ms", value: 0 },
        },
        { allowedPathRoots: [repoPath] }
      ).predicate;

      await expect(
        evaluateSpawnPredicate(truePredicate, {
          allowedPathRoots: [repoPath],
          spawnCreatedAtMs: 0,
        })
      ).resolves.toMatchObject({ result: "true", observed_count: 1 });
      await expect(
        evaluateSpawnPredicate(falsePredicate, {
          allowedPathRoots: [repoPath],
          spawnCreatedAtMs: 0,
        })
      ).resolves.toMatchObject({ result: "false", observed_count: 0 });
    } finally {
      await rm(repoPath, { force: true, recursive: true });
    }
  });

  test("db-row evaluator returns true and false in a temp SQLite DB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sm-predicate-db-"));
    const dbPath = join(dir, "predicate.sqlite");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL
        );
        INSERT INTO tasks (id, status, attempts) VALUES ('task-1', 'done', 3);
      `);
    } finally {
      db.close();
    }

    const registry: PredicateDbRegistry = {
      resolve(dbRef) {
        if (dbRef !== "framework:test") return undefined;
        return { dbRef, kind: "sqlite", path: dbPath, readonly: true };
      },
    };

    try {
      const truePredicate = validateSpawnPredicate(
        {
          type: "db-row",
          db_ref: "framework:test",
          table: "tasks",
          where_all: [
            { column: "status", op: "eq", value: "done" },
            { column: "attempts", op: "gte", value: 2 },
          ],
          min_count: 1,
        },
        { dbRegistry: registry }
      ).predicate;
      const falsePredicate = validateSpawnPredicate(
        {
          type: "db-row",
          db_ref: "framework:test",
          table: "tasks",
          where_all: [{ column: "status", op: "eq", value: "pending" }],
          min_count: 1,
        },
        { dbRegistry: registry }
      ).predicate;

      await expect(evaluateSpawnPredicate(truePredicate, { dbRegistry: registry })).resolves.toMatchObject({
        result: "true",
        observed_count: 1,
      });
      await expect(evaluateSpawnPredicate(falsePredicate, { dbRegistry: registry })).resolves.toMatchObject({
        result: "false",
        observed_count: 0,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("file-mtime evaluator dispatches through evaluateSpawnPredicate", async () => {
    const fileMtime = validateSpawnPredicate(
      {
        type: "file-mtime",
        root_path: process.cwd(),
        path_glob: "package.json",
        since: { kind: "timestamp_ms", value: 0 },
      },
      { allowedPathRoots: [process.cwd()] }
    ).predicate;
    if (fileMtime.type !== "file-mtime") throw new Error("expected file-mtime predicate");

    await expect(evaluateSpawnPredicate(fileMtime, { allowedPathRoots: [process.cwd()] })).resolves.toMatchObject({
      result: "true",
      observed_count: 1,
    });
  });
});
