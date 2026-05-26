import { describe, expect, test } from "vitest";
import {
  asAbsolutePath,
  asCardId,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "foo",
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/foo"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore message_runs", () => {
  test("start → card id → finish round trip", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      const runId = await store.startMessageRun({
        id: asMessageRunId("mr1"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "do it",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      expect(runId).toBe("mr1");
      await store.setMessageRunCardId(asMessageRunId("mr1"), asCardId("c1"));
      const running = await store.findRunningMessageRunBySession(asSessionId("s1"));
      expect(running?.cardId).toBe("c1");
      expect(running?.status).toBe("running");
      await store.finishMessageRun(asMessageRunId("mr1"), "completed", "done", undefined);
      expect(await store.findRunningMessageRunBySession(asSessionId("s1"))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("findLatestMessageRunBySession returns terminal run after finish", async () => {
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
        prompt: "first",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.finishMessageRun(asMessageRunId("mr1"), "completed", "first done", undefined);
      await store.startMessageRun({
        id: asMessageRunId("mr2"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "second",
        startedAt: asTimestamp(1_700_000_200_000),
      });
      await store.finishMessageRun(asMessageRunId("mr2"), "completed", "second done", undefined);
      const latest = await store.findLatestMessageRunBySession(asSessionId("s1"));
      expect(latest?.id).toBe("mr2");
      expect(latest?.status).toBe("completed");
      expect(latest?.finalMessage).toBe("second done");
    } finally {
      await cleanup();
    }
  });

  test("listRecentCompletedMessageRuns returns newest completed runs with prompt and final message", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.createSessionWithBinding(
        { id: asSessionId("s2"), ...BASE, name: "bar" },
        asLarkGroupId("oc_2")
      );

      await store.startMessageRun({
        id: asMessageRunId("mr1"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "first",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      await store.finishMessageRun(asMessageRunId("mr1"), "completed", "first done", undefined);

      await store.startMessageRun({
        id: asMessageRunId("mr2"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "failed",
        startedAt: asTimestamp(1_700_000_200_000),
      });
      await store.finishMessageRun(asMessageRunId("mr2"), "failed", undefined, "boom");

      await store.startMessageRun({
        id: asMessageRunId("mr3"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "third",
        startedAt: asTimestamp(1_700_000_300_000),
      });
      await store.finishMessageRun(asMessageRunId("mr3"), "completed", "third done", undefined);

      await store.startMessageRun({
        id: asMessageRunId("mr4"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "empty final",
        startedAt: asTimestamp(1_700_000_400_000),
      });
      await store.finishMessageRun(asMessageRunId("mr4"), "completed", "", undefined);

      await store.startMessageRun({
        id: asMessageRunId("mr5"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "fifth",
        startedAt: asTimestamp(1_700_000_500_000),
      });
      await store.finishMessageRun(asMessageRunId("mr5"), "completed", "fifth done", undefined);

      await store.startMessageRun({
        id: asMessageRunId("mr6"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "sixth",
        startedAt: asTimestamp(1_700_000_600_000),
      });
      await store.finishMessageRun(asMessageRunId("mr6"), "completed", "sixth done", undefined);

      await store.startMessageRun({
        id: asMessageRunId("mr7"),
        sessionId: asSessionId("s1"),
        groupId: asLarkGroupId("oc_1"),
        prompt: "",
        startedAt: asTimestamp(1_700_000_700_000),
      });
      await store.finishMessageRun(asMessageRunId("mr7"), "completed", "empty prompt done", undefined);

      await store.startMessageRun({
        id: asMessageRunId("mr8"),
        sessionId: asSessionId("s2"),
        groupId: asLarkGroupId("oc_2"),
        prompt: "other session",
        startedAt: asTimestamp(1_700_000_800_000),
      });
      await store.finishMessageRun(asMessageRunId("mr8"), "completed", "other done", undefined);

      const recent = await store.listRecentCompletedMessageRuns(asSessionId("s1"), 3);
      expect(recent.map((run) => run.id)).toEqual(["mr6", "mr5", "mr3"]);
      expect(recent.map((run) => run.finalMessage)).toEqual([
        "sixth done",
        "fifth done",
        "third done",
      ]);
    } finally {
      await cleanup();
    }
  });

  test("finishMessageRun persists streamLogJson into stream_log column", async () => {
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
        prompt: "do it",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      const log = JSON.stringify([
        { ts: 1, kind: "assistant_message", text: "方案 A", final: false },
        { ts: 2, kind: "assistant_message", text: "等你确认", final: true },
      ]);
      await store.finishMessageRun(
        asMessageRunId("mr1"),
        "completed",
        "方案 A\n\n等你确认",
        undefined,
        log,
      );
      const raw = (store as unknown as {
        db: { prepare: (sql: string) => { get: () => { stream_log: string | null; final_message: string } } };
      }).db;
      const row = raw
        .prepare("SELECT stream_log, final_message FROM message_runs WHERE id = 'mr1'")
        .get();
      expect(row.stream_log).toBe(log);
      expect(row.final_message).toBe("方案 A\n\n等你确认");
    } finally {
      await cleanup();
    }
  });

  test("resetRunningMessageRunsOnBoot flips running → timeout", async () => {
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
        prompt: "p",
        startedAt: asTimestamp(1_700_000_100_000),
      });
      const count = await store.resetRunningMessageRunsOnBoot(asTimestamp(1_700_000_999_000));
      expect(count).toBe(1);
      expect(await store.findRunningMessageRunBySession(asSessionId("s1"))).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
