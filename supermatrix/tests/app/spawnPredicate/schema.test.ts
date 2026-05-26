import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  canonicalJsonStringify,
  predicateHash,
  validateSpawnPredicate,
} from "../../../src/app/spawnPredicate/schema.ts";
import type { PredicateDbRegistry } from "../../../src/ports/PredicateDbRegistry.ts";

const repoRoot = process.cwd();

const registry: PredicateDbRegistry = {
  resolve(dbRef) {
    if (dbRef !== "framework:test") return undefined;
    return {
      dbRef,
      kind: "sqlite",
      path: "/tmp/supermatrix-predicate-test.sqlite",
      readonly: true,
    };
  },
};

const validationContext = {
  allowedPathRoots: [repoRoot],
  dbRegistry: registry,
};

describe("spawn predicate schema", () => {
  test("accepts valid git-log predicate and applies common defaults", () => {
    const result = validateSpawnPredicate(
      {
        type: "git-log",
        repo_path: repoRoot,
        message_regex: "spawn-closure",
      },
      validationContext
    );

    expect(result.predicate).toMatchObject({
      type: "git-log",
      expected_window_sec: 3600,
      evaluation_timeout_ms: 10000,
      retry_on_transient_fail: 2,
      since: { kind: "spawn_created_at" },
      min_count: 1,
    });
    expect(result.canonicalJson).toBe(canonicalJsonStringify(result.predicate));
    expect(result.predicateHash).toBe(
      `sha256:${createHash("sha256").update(result.canonicalJson).digest("hex")}`
    );
  });

  test("accepts valid db-row predicate", () => {
    const result = validateSpawnPredicate(
      {
        type: "db-row",
        db_ref: "framework:test",
        table: "spawn_predicates",
        where_all: [{ column: "status", op: "eq", value: "active" }],
        min_count: 1,
      },
      validationContext
    );

    expect(result.predicate.type).toBe("db-row");
    expect(result.predicate.retry_on_transient_fail).toBe(2);
  });

  test("accepts valid file-mtime predicate", () => {
    const result = validateSpawnPredicate(
      {
        type: "file-mtime",
        root_path: repoRoot,
        path_glob: "SM-SOURCE-CHANGES.md",
      },
      validationContext
    );

    expect(result.predicate).toMatchObject({
      type: "file-mtime",
      since: { kind: "spawn_created_at" },
      min_count: 1,
      min_size_bytes: 1,
    });
  });

  test("accepts valid http-get predicate", () => {
    const result = validateSpawnPredicate(
      {
        type: "http-get",
        url: "http://localhost:3000/health",
        expected_status: [200, 204],
        body_contains_any: ["ready"],
      },
      validationContext
    );

    expect(result.predicate).toMatchObject({
      type: "http-get",
      max_body_bytes: 262144,
    });
  });

  test("accepts valid inbox-message predicate", () => {
    const result = validateSpawnPredicate(
      {
        type: "inbox-message",
        session_name: "socail-king",
        field: "prompt",
        contains_all: ["comm_spawn_123"],
      },
      validationContext
    );

    expect(result.predicate).toMatchObject({
      type: "inbox-message",
      since: { kind: "spawn_created_at" },
      min_count: 1,
    });
  });

  test("canonical JSON and predicate hash are stable across key order", () => {
    const left = { b: 1, a: { d: true, c: ["x"] } };
    const right = { a: { c: ["x"], d: true }, b: 1 };

    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
    expect(predicateHash(left)).toBe(predicateHash(right));
  });

  test("rejects weak inbox-message contains tokens", () => {
    expect(() =>
      validateSpawnPredicate(
        {
          type: "inbox-message",
          session_name: "socail-king",
          field: "final_message",
          contains_any: ["done"],
        },
        validationContext
      )
    ).toThrow(/weak inbox-message predicate/i);
  });

  test("rejects SQL-like db-row identifiers", () => {
    expect(() =>
      validateSpawnPredicate(
        {
          type: "db-row",
          db_ref: "framework:test",
          table: "sessions;DROP",
          where_all: [{ column: "status", op: "eq", value: "idle" }],
          min_count: 1,
        },
        validationContext
      )
    ).toThrow();
  });

  test("rejects missing required fields", () => {
    expect(() =>
      validateSpawnPredicate(
        {
          type: "git-log",
          message_regex: "feat",
        },
        validationContext
      )
    ).toThrow();
  });

  test("rejects db-row where_all value shapes that do not match operators", () => {
    expect(() =>
      validateSpawnPredicate(
        {
          type: "db-row",
          db_ref: "framework:test",
          table: "sessions",
          where_all: [{ column: "status", op: "in", value: "idle" }],
          min_count: 1,
        },
        validationContext
      )
    ).toThrow(/requires array value/i);
  });
});
