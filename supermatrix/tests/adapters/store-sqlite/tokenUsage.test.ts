import { describe, expect, test } from "vitest";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "tu",
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/tu"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore token_usage", () => {
  test("recordTokenUsage inserts one row per message_run", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.startMessageRun({
        id: asMessageRunId("mr1"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "hi",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.recordTokenUsage({
        sessionId: asSessionId("s1"),
        messageRunId: asMessageRunId("mr1"),
        backend: "claude",
        model: "claude-opus-4-7",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        reasoningTokens: 0,
        rawUsageJson: '{"input_tokens":100}',
        createdAt: asTimestamp(1_700_000_200_000),
      });
      const rows = (store as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db
        .prepare("SELECT * FROM token_usage WHERE message_run_id = 'mr1'")
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].input_tokens).toBe(100);
      expect(rows[0].output_tokens).toBe(50);
      expect(rows[0].cache_read_tokens).toBe(20);
      expect(rows[0].cache_write_tokens).toBe(5);
      expect(rows[0].reasoning_tokens).toBe(0);
      expect(rows[0].backend).toBe("claude");
      expect(rows[0].model).toBe("claude-opus-4-7");
    } finally {
      await cleanup();
    }
  });

  test("recordTokenUsage is retry-safe via INSERT OR IGNORE on UNIQUE(message_run_id)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.startMessageRun({
        id: asMessageRunId("mr1"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "hi",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      const row = {
        sessionId: asSessionId("s1"),
        messageRunId: asMessageRunId("mr1"),
        backend: "claude" as const,
        model: null,
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsageJson: null,
        createdAt: asTimestamp(1_700_000_200_000),
      };
      await store.recordTokenUsage(row);
      await store.recordTokenUsage({ ...row, inputTokens: 999 });
      const rows = (store as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db
        .prepare("SELECT * FROM token_usage WHERE message_run_id = 'mr1'")
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].input_tokens).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("stores Codex input as net input while preserving the native raw snapshot", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE, backend: "codex" },
        asLarkGroupId("oc_1"),
      );
      await store.startMessageRun({
        id: asMessageRunId("mr-codex-net"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "hi",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.recordTokenUsage({
        sessionId: asSessionId("s1"),
        messageRunId: asMessageRunId("mr-codex-net"),
        backend: "codex",
        model: "gpt-5.6-terra",
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
        rawUsageJson: '{"input_tokens":100,"cached_input_tokens":80,"output_tokens":25}',
        createdAt: asTimestamp(1_700_000_200_000),
      });

      const row = (store as unknown as {
        db: { prepare: (sql: string) => { get: () => Record<string, unknown> | undefined } };
      }).db.prepare("SELECT * FROM token_usage WHERE message_run_id = 'mr-codex-net'").get();
      expect(row?.input_tokens).toBe(20);
      expect(row?.cache_read_tokens).toBe(80);
      expect(row?.raw_usage_json).toBe(
        '{"input_tokens":100,"cached_input_tokens":80,"output_tokens":25}',
      );
    } finally {
      await cleanup();
    }
  });

  test("getLatestTokenUsageRawTotals returns the latest native cumulative totals", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE, backend: "codex" },
        asLarkGroupId("oc_1")
      );
      for (const [runId, createdAt, rawUsageJson] of [
        [
          "mr1",
          asTimestamp(1_700_000_200_000),
          '{"input_tokens":1000,"cached_input_tokens":500,"output_tokens":40}',
        ],
        [
          "mr2",
          asTimestamp(1_700_000_300_000),
          '{"input_tokens":2000,"cached_input_tokens":700,"output_tokens":100,"reasoning_output_tokens":20}',
        ],
      ] as const) {
        await store.startMessageRun({
          id: asMessageRunId(runId),
          sessionId: asSessionId("s1"),
          groupId: asLarkGroupId("oc_1"),
          prompt: "hi",
          startedAt: createdAt,
        });
        await store.recordTokenUsage({
          sessionId: asSessionId("s1"),
          messageRunId: asMessageRunId(runId),
          backend: "codex",
          model: "gpt-5.5",
          inputTokens: 123,
          outputTokens: 45,
          cacheReadTokens: 67,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          rawUsageJson,
          createdAt,
        });
      }

      await expect(store.getLatestTokenUsageRawTotals(asSessionId("missing"))).resolves.toBeNull();
      await expect(store.getLatestTokenUsageRawTotals(asSessionId("s1"))).resolves.toEqual({
        inputTokens: 2000,
        outputTokens: 80,
        cacheReadTokens: 700,
        cacheWriteTokens: 0,
        reasoningTokens: 20,
      });
    } finally {
      await cleanup();
    }
  });

  test("getTokenUsageSummary rolls up child session usage via recursive CTE", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("parent"), ...BASE, name: "parent" },
        asLarkGroupId("oc_parent")
      );
      await store.createSession({
        id: asSessionId("child"),
        name: "child",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/tmp/ws/child"),
        purpose: "",
        createdAt: asTimestamp(1_700_000_000_000),
        parentId: asSessionId("parent"),
        depth: 1,
      });
      await store.startMessageRun({
        id: asMessageRunId("mr_p"),
        sessionId: asSessionId("parent"),
        groupId: asLarkGroupId("oc_parent"),
        prompt: "p",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.startMessageRun({
        id: asMessageRunId("mr_c"),
        sessionId: asSessionId("child"),
        // Child uses a synthetic group id (see childSession.ts)
        groupId: asLarkGroupId("spawn:parent"),
        prompt: "c",
        startedAt: asTimestamp(1_700_000_110_000),
      });
      await store.recordTokenUsage({
        sessionId: asSessionId("parent"),
        messageRunId: asMessageRunId("mr_p"),
        backend: "claude",
        model: null,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsageJson: null,
        createdAt: asTimestamp(Date.now()),
      });
      await store.recordTokenUsage({
        sessionId: asSessionId("child"),
        messageRunId: asMessageRunId("mr_c"),
        backend: "claude",
        model: null,
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsageJson: null,
        createdAt: asTimestamp(Date.now()),
      });
      const now = Date.now();
      const todayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
      const summary = await store.getTokenUsageSummary(asSessionId("parent"), {
        todayStart: asTimestamp(todayStart),
        weekStart: asTimestamp(now - 7 * 86400000),
      });
      // Parent 10+20 + Child 7+3 = 17 input + 23 output
      expect(summary.cumulative.inputTokens).toBe(17);
      expect(summary.cumulative.outputTokens).toBe(23);
      expect(summary.cumulative.cacheReadTokens).toBe(5);
      expect(summary.cumulative.rowCount).toBe(2);
      // Child alone should have only its own
      const childOnly = await store.getTokenUsageSummary(asSessionId("child"), {
        todayStart: asTimestamp(todayStart),
        weekStart: asTimestamp(now - 7 * 86400000),
      });
      expect(childOnly.cumulative.inputTokens).toBe(7);
      expect(childOnly.cumulative.rowCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("getTokenUsageSummary windows filter by created_at", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.startMessageRun({
        id: asMessageRunId("old"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "old",
        startedAt: asTimestamp(1_000_000_000_000),
      });
      await store.startMessageRun({
        id: asMessageRunId("new"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "new",
        startedAt: asTimestamp(Date.now()),
      });
      // old row: 30 days ago
      await store.recordTokenUsage({
        sessionId: asSessionId("s1"),
        messageRunId: asMessageRunId("old"),
        backend: "claude",
        model: null,
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsageJson: null,
        createdAt: asTimestamp(Date.now() - 30 * 86400000),
      });
      // new row: now
      await store.recordTokenUsage({
        sessionId: asSessionId("s1"),
        messageRunId: asMessageRunId("new"),
        backend: "claude",
        model: null,
        inputTokens: 2000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsageJson: null,
        createdAt: asTimestamp(Date.now()),
      });
      const now = Date.now();
      const todayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
      const summary = await store.getTokenUsageSummary(asSessionId("s1"), {
        todayStart: asTimestamp(todayStart),
        weekStart: asTimestamp(now - 7 * 86400000),
      });
      expect(summary.today.inputTokens).toBe(2000);
      expect(summary.last7Days.inputTokens).toBe(2000);
      expect(summary.cumulative.inputTokens).toBe(3000);
      expect(summary.cumulative.rowCount).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("FK cascade: deleting session wipes its token_usage rows", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.startMessageRun({
        id: asMessageRunId("mr1"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "hi",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.recordTokenUsage({
        sessionId: asSessionId("s1"),
        messageRunId: asMessageRunId("mr1"),
        backend: "claude",
        model: null,
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsageJson: null,
        createdAt: asTimestamp(1_700_000_200_000),
      });
      const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: () => unknown[] } } }).db;
      // Hard delete via raw SQL — the production deleteSessionAndBinding does a
      // soft delete (status='deleted'); we're testing that the schema-level FK
      // cascade is wired up correctly.
      db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");
      const rows = db.prepare("SELECT * FROM token_usage").all() as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("usage_by_parent view rolls up child tokens recursively (decisions.md D6)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("root"), ...BASE, name: "root" },
        asLarkGroupId("oc_root"),
      );
      await store.createSession({
        id: asSessionId("child"),
        ...BASE,
        name: "child",
        scope: "child",
        parentId: asSessionId("root"),
        depth: 1,
      });
      await store.createSession({
        id: asSessionId("grand"),
        ...BASE,
        name: "grand",
        scope: "child",
        parentId: asSessionId("child"),
        depth: 2,
      });
      for (const [id, sessionId, group] of [
        ["mr_r", "root", "oc_root"],
        ["mr_c", "child", "spawn:root"],
        ["mr_g", "grand", "spawn:child"],
      ] as const) {
        await store.startMessageRun({
          id: asMessageRunId(id),
          sessionId: asSessionId(sessionId),
          groupId: asLarkGroupId(group),
          prompt: "p",
          startedAt: asTimestamp(1_700_000_100_000),
        });
        await store.recordTokenUsage({
          sessionId: asSessionId(sessionId),
          messageRunId: asMessageRunId(id),
          backend: "claude",
          model: null,
          inputTokens: 1,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          rawUsageJson: null,
          createdAt: asTimestamp(Date.now()),
        });
      }

      const db = (store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } }).db;

      const rootRow = db
        .prepare("SELECT * FROM usage_by_parent WHERE session_id = ?")
        .all("root") as Array<{ input_tokens: number; output_tokens: number; run_count: number }>;
      expect(rootRow[0]?.input_tokens).toBe(3);
      expect(rootRow[0]?.output_tokens).toBe(30);
      expect(rootRow[0]?.run_count).toBe(3);

      const childRow = db
        .prepare("SELECT * FROM usage_by_parent WHERE session_id = ?")
        .all("child") as Array<{ input_tokens: number; run_count: number }>;
      expect(childRow[0]?.input_tokens).toBe(2);
      expect(childRow[0]?.run_count).toBe(2);

      const grandRow = db
        .prepare("SELECT * FROM usage_by_parent WHERE session_id = ?")
        .all("grand") as Array<{ input_tokens: number; run_count: number }>;
      expect(grandRow[0]?.input_tokens).toBe(1);
      expect(grandRow[0]?.run_count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("usage_by_requester view aggregates via cross_session_log.from_session_id (decisions.md D6)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("requester"), ...BASE, name: "requester" },
        asLarkGroupId("oc_requester"),
      );
      await store.createSessionWithBinding(
        { id: asSessionId("target"), ...BASE, name: "target" },
        asLarkGroupId("oc_target"),
      );
      await store.createSession({
        id: asSessionId("child"),
        ...BASE,
        name: "child",
        scope: "child",
        parentId: asSessionId("target"),
        depth: 1,
      });
      await store.startMessageRun({
        id: asMessageRunId("mr_c"),
        sessionId: asSessionId("child"),
        groupId: asLarkGroupId("spawn:target"),
        prompt: "p",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.recordTokenUsage({
        sessionId: asSessionId("child"),
        messageRunId: asMessageRunId("mr_c"),
        backend: "claude",
        model: null,
        inputTokens: 42,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsageJson: null,
        createdAt: asTimestamp(Date.now()),
      });
      await store.logCrossSessionComm({
        id: "comm1",
        fromSessionId: asSessionId("requester"),
        toSessionId: asSessionId("target"),
        kind: "spawn",
        prompt: "go",
        createdAt: asTimestamp(Date.now()),
      });
      await store.finishCrossSessionComm(
        "comm1",
        "completed",
        "child",
        "done",
        undefined,
        "final",
        asMessageRunId("mr_c"),
      );

      const db = (store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
      const rows = db
        .prepare("SELECT * FROM usage_by_requester WHERE requester_session_id = ?")
        .all("requester") as Array<{ input_tokens: number; output_tokens: number; run_count: number }>;
      expect(rows[0]?.input_tokens).toBe(42);
      expect(rows[0]?.output_tokens).toBe(100);
      expect(rows[0]?.run_count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("getSchedulerTokenUsage groups scheduler-origin runs once per message run within a half-open window", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const from = asTimestamp(2_000_000_000_000);
      const to = asTimestamp(from + 1_000);
      await store.createSessionWithBinding(
        { id: asSessionId("requester"), ...BASE, name: "requester" },
        asLarkGroupId("oc_requester"),
      );
      await store.createSessionWithBinding(
        { id: asSessionId("target"), ...BASE, name: "target" },
        asLarkGroupId("oc_target"),
      );
      await store.createSession({
        id: asSessionId("child"),
        ...BASE,
        name: "child",
        scope: "child",
        parentId: asSessionId("target"),
        depth: 1,
      });

      const createRun = async (input: {
        id: string;
        createdAt: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
      }) => {
        await store.startMessageRun({
          id: asMessageRunId(input.id),
          sessionId: asSessionId("child"),
          groupId: asLarkGroupId("spawn:target"),
          prompt: input.id,
          startedAt: asTimestamp(input.createdAt),
        });
        await store.recordTokenUsage({
          sessionId: asSessionId("child"),
          messageRunId: asMessageRunId(input.id),
          backend: "claude",
          model: null,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cacheReadTokens: input.cacheReadTokens,
          cacheWriteTokens: input.cacheWriteTokens,
          reasoningTokens: input.reasoningTokens,
          rawUsageJson: null,
          createdAt: asTimestamp(input.createdAt),
        });
      };
      const linkRun = async (commId: string, originRunId: string, messageRunId: string) => {
        await store.logCrossSessionComm({
          id: commId,
          fromSessionId: asSessionId("requester"),
          toSessionId: asSessionId("target"),
          kind: "spawn",
          prompt: commId,
          originRunId: asMessageRunId(originRunId),
          createdAt: from,
        });
        await store.attachCrossSessionChild(
          commId,
          asSessionId("child"),
          asMessageRunId(messageRunId),
        );
      };

      await createRun({
        id: "alpha_1",
        createdAt: from,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
      });
      await linkRun("comm_alpha_1", "scheduler:alpha:run_1", "alpha_1");
      await linkRun("comm_alpha_1_duplicate", "scheduler:alpha:run_1_retry", "alpha_1");

      await createRun({
        id: "alpha_2",
        createdAt: from + 1,
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
      await linkRun("comm_alpha_2", "scheduler:alpha:run_2", "alpha_2");

      await createRun({
        id: "beta_1",
        createdAt: to - 1,
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 4,
        reasoningTokens: 1,
      });
      await linkRun("comm_beta_1", "scheduler:beta:run_1", "beta_1");

      await createRun({
        id: "before_window",
        createdAt: from - 1,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
      await linkRun("comm_before_window", "scheduler:alpha:before", "before_window");

      await createRun({
        id: "at_window_end",
        createdAt: to,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
      await linkRun("comm_at_window_end", "scheduler:alpha:at_end", "at_window_end");

      await createRun({
        id: "not_scheduler",
        createdAt: from + 2,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
      await linkRun("comm_not_scheduler", "message_run:not_scheduler", "not_scheduler");

      await createRun({
        id: "invalid_scheduler_origin",
        createdAt: from + 3,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
      await linkRun("comm_invalid_scheduler_origin", "scheduler::run", "invalid_scheduler_origin");

      const tasks = await (store as unknown as {
        getSchedulerTokenUsage(windowFrom: number, windowTo: number): Promise<Array<{
          taskId: string;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          reasoningTokens: number;
          totalTokens: number;
          runCount: number;
        }>>;
      }).getSchedulerTokenUsage(from, to);

      expect(tasks).toEqual([
        {
          taskId: "beta",
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 4,
          reasoningTokens: 1,
          totalTokens: 40,
          runCount: 1,
        },
        {
          taskId: "alpha",
          inputTokens: 14,
          outputTokens: 7,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          reasoningTokens: 1,
          totalTokens: 28,
          runCount: 2,
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("getSchedulerTokenUsage recursively attributes scheduler child and grandchild runs once despite duplicate links and a cycle", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const from = asTimestamp(2_000_000_100_000);
      const to = asTimestamp(from + 1_000);
      await store.createSessionWithBinding(
        { id: asSessionId("requester"), ...BASE, name: "requester" },
        asLarkGroupId("oc_requester"),
      );
      await store.createSessionWithBinding(
        { id: asSessionId("worker"), ...BASE, name: "worker" },
        asLarkGroupId("oc_worker"),
      );

      const createRun = async (input: {
        id: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
      }) => {
        await store.startMessageRun({
          id: asMessageRunId(input.id),
          sessionId: asSessionId("worker"),
          groupId: asLarkGroupId("oc_worker"),
          prompt: input.id,
          startedAt: from,
        });
        await store.recordTokenUsage({
          sessionId: asSessionId("worker"),
          messageRunId: asMessageRunId(input.id),
          backend: "claude",
          model: null,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cacheReadTokens: input.cacheReadTokens,
          cacheWriteTokens: input.cacheWriteTokens,
          reasoningTokens: input.reasoningTokens,
          rawUsageJson: null,
          createdAt: from,
        });
      };
      const linkRun = async (commId: string, originRunId: string, messageRunId: string) => {
        await store.logCrossSessionComm({
          id: commId,
          fromSessionId: asSessionId("requester"),
          toSessionId: asSessionId("worker"),
          kind: "spawn",
          prompt: commId,
          originRunId: asMessageRunId(originRunId),
          createdAt: from,
        });
        await store.attachCrossSessionChild(
          commId,
          asSessionId("worker"),
          asMessageRunId(messageRunId),
        );
      };

      await createRun({
        id: "root_run",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        reasoningTokens: 5,
      });
      await createRun({
        id: "child_run",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        reasoningTokens: 50,
      });
      await createRun({
        id: "grandchild_run",
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 400,
        reasoningTokens: 500,
      });

      await linkRun("comm_root", "scheduler:alpha:run_1", "root_run");
      await linkRun("comm_child", "root_run", "child_run");
      await linkRun("comm_child_duplicate", "root_run", "child_run");
      await linkRun("comm_grandchild", "child_run", "grandchild_run");
      await linkRun("comm_grandchild_duplicate", "child_run", "grandchild_run");
      await linkRun("comm_cycle", "grandchild_run", "root_run");

      await expect(store.getSchedulerTokenUsage(from, to)).resolves.toEqual([
        {
          taskId: "alpha",
          inputTokens: 111,
          outputTokens: 222,
          cacheReadTokens: 333,
          cacheWriteTokens: 444,
          reasoningTokens: 555,
          totalTokens: 1_665,
          runCount: 3,
        },
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe("cross_session_log child_model", () => {
  const BASE = {
    name: "s",
    scope: "user" as const,
    backend: "claude" as const,
    workdir: asAbsolutePath("/tmp/ws"),
    purpose: "test",
    createdAt: asTimestamp(1_700_000_000_000),
  };

  test("logCrossSessionComm persists child_model", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("sess_a"), ...BASE, name: "sess_a" },
        asLarkGroupId("oc_a"),
      );
      await store.createSessionWithBinding(
        { id: asSessionId("sess_b"), ...BASE, name: "sess_b" },
        asLarkGroupId("oc_b"),
      );

      await store.logCrossSessionComm({
        id: "comm_model_1",
        fromSessionId: asSessionId("sess_a"),
        toSessionId: asSessionId("sess_b"),
        kind: "spawn",
        prompt: "do stuff",
        childModel: "claude-sonnet-4-6",
        createdAt: asTimestamp(Date.now()),
      });

      const rows = await store.listAllCrossSessionComms(10);
      const comm = rows.find((r) => r.id === "comm_model_1");
      expect(comm?.childModel).toBe("claude-sonnet-4-6");
    } finally {
      await cleanup();
    }
  });

  test("childModel is null when not provided", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("sess_c"), ...BASE, name: "sess_c" },
        asLarkGroupId("oc_c"),
      );
      await store.createSessionWithBinding(
        { id: asSessionId("sess_d"), ...BASE, name: "sess_d" },
        asLarkGroupId("oc_d"),
      );

      await store.logCrossSessionComm({
        id: "comm_model_2",
        fromSessionId: asSessionId("sess_c"),
        toSessionId: asSessionId("sess_d"),
        kind: "spawn",
        prompt: "do stuff",
        createdAt: asTimestamp(Date.now()),
      });

      const rows = await store.listAllCrossSessionComms(10);
      const comm = rows.find((r) => r.id === "comm_model_2");
      expect(comm?.childModel).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
