import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { routeCompletedSpawnClosure } from "../../../src/app/spawnClosure/fastPathRoute.ts";
import { asMessageRunId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import type { SpawnAsyncItemRecord, SpawnAsyncItemStatus } from "../../../src/ports/BindingStore.ts";

describe("spawn closure fast path", () => {
  test("claims a completed async item, enqueues heartbeat todo, and closes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    let closed = false;
    const item: SpawnAsyncItemRecord = {
      ref: "async_1",
      commId: "comm_1",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: "sess_child_1",
      messageRunId: asMessageRunId("mr_1"),
      commStatus: "completed",
      finalMessage: "full result",
      errorMessage: null,
      originRunId: asMessageRunId("mr_caller_batch_1"),
    };
    const child: Session = {
      id: asSessionId("sess_child_1"),
      name: "child_target_000001",
      alias: "",
      avatar: "",
      category: "",
      fpManaged: null,
      scope: "child",
      backend: "codex",
      model: null,
      effort: null,
      thinking: false,
      modelLocked: false,
      workdir: "/tmp/child" as Session["workdir"],
      backendSessionId: null,
      chatName: null,
      purpose: "",
      status: "deleted",
      parentId: asSessionId("sess_target"),
      depth: 1,
      inactivityTimeoutS: null,
      maxRuntimeS: null,
      childType: "one_shot_delegation",
      triggerKind: "session",
      postIdentity: null,
      callerInvocation: "async_kickoff",
      continuationHook: null,
      capabilityPayload: null,
      createdAt: asTimestamp(0),
      updatedAt: asTimestamp(0),
    };

    const result = await routeCompletedSpawnClosure({
      ref: "async_1",
      commId: "comm_1",
      store: {
        async claimSpawnAsyncItemForDelivery(ref) {
          if (ref !== item.ref || status !== "waiting_child") return null;
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem(ref) {
          if (ref === item.ref && status === "delivering") return { ...item, status };
          return null;
        },
        async listResultSinkAttemptsBySpawn(spawnCommId) {
          return [{
            id: "sink_engine_owned_response",
            spawnCommId,
            childSessionId: child.id,
            messageRunId: asMessageRunId("mr_1"),
            sinkIndex: 0,
            sinkKind: "http_response",
            status: "skipped" as const,
            note: "skipped: sync_inline handler owns delivery",
            errorMessage: null,
            createdAt: asTimestamp(101),
          }];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("non-adjudication path should not escalate");
        },
        async markSpawnAsyncItemDelivered(ref, closure) {
          expect(ref).toBe("async_1");
          expect(closure).toEqual({
            verdict: "delivered",
            reason: "fast-path heartbeat todo enqueued for caller",
          });
          closed = true;
          status = "closed";
          return true;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("deliverable path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
          status = previousStatus;
        },
        async findSessionById(id) {
          return id === child.id ? child : null;
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({ action: "delivered", ref: "async_1", commId: "comm_1" });
    expect(closed).toBe(true);
    const call = JSON.parse(readFileSync(calls, "utf8").trim()) as string[];
    expect(call).toContain("--session");
    expect(call).toContain("caller");
    expect(call).toContain("--key");
    expect(call).toContain("comm_1");
    expect(call).toContain("--source");
    expect(call).toContain("spawn-closure-fast-path");
    expect(call).toContain("--source-session");
    expect(call).toContain("target");
    expect(call).toContain("--batch-key");
    expect(call).toContain("mr_caller_batch_1");
    expect(call.join("\n")).toContain("框架自动送回");
    expect(call.join("\n")).toContain("<sm-child-completed child_id=\"sess_child_1\" child_name=\"child_target_000001\"");
    expect(call.join("\n")).toContain("full result");
  });

  test("suppresses heartbeat todo for completed adjudication children", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    let closed = false;
    const original: SpawnAsyncItemRecord = {
      ref: "async_original",
      commId: "comm_original",
      callerSession: "scheduler",
      targetSession: "scheduler",
      failedPhase: "execution",
      failureKind: "run_timeout",
      status: "closed",
      attemptCount: 2,
      verdict: "false_alarm",
      verdictReason: "already handled",
      createdAt: asTimestamp(90),
      updatedAt: asTimestamp(490),
      lastAttemptAt: asTimestamp(200),
      childSessionId: null,
      messageRunId: null,
      commStatus: "completed",
      finalMessage: "original result",
      errorMessage: null,
      originRunId: null,
    };
    const item: SpawnAsyncItemRecord = {
      ref: "async_adjudication",
      commId: "comm_adjudication",
      callerSession: "supermatrix-root",
      targetSession: "sk-watcher",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: "sess_child_sk_watcher",
      messageRunId: asMessageRunId("mr_adjudication"),
      commStatus: "completed",
      finalMessage: "adjudication completed",
      errorMessage: null,
      clientRequestId: `2026-06-01:spawn-adjudication:${original.commId}:${original.ref}`,
      originRunId: null,
    };

    const result = await routeCompletedSpawnClosure({
      ref: item.ref,
      commId: item.commId,
      store: {
        async claimSpawnAsyncItemForDelivery(ref) {
          if (ref !== item.ref || status !== "waiting_child") return null;
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem(ref) {
          return ref === original.ref ? original : null;
        },
        async listResultSinkAttemptsBySpawn() {
          return [];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("valid adjudication outcome should not be escalated");
        },
        async markSpawnAsyncItemDelivered(ref, closure) {
          expect(ref).toBe(item.ref);
          expect(closure).toEqual({
            verdict: "adjudication_result_recorded",
            reason: "adjudication result recorded; heartbeat delivery suppressed",
          });
          closed = true;
          status = "closed";
          return true;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("deliverable path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
          status = previousStatus;
        },
        async findSessionById() {
          throw new Error("adjudication suppression should not load child session");
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({
      action: "noop",
      ref: item.ref,
      commId: item.commId,
      reason: "adjudication result recorded; heartbeat delivery suppressed",
    });
    expect(closed).toBe(true);
    expect(status).toBe("closed");
    expect(() => readFileSync(calls, "utf8")).toThrow();
  });

  test("closes an async item without Heartbeat only for its exact sync_inline response record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    let closed = false;
    const item: SpawnAsyncItemRecord = {
      ref: "async_inline_response",
      commId: "comm_inline_response",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: "sess_child_inline_response",
      messageRunId: asMessageRunId("mr_inline_response"),
      commStatus: "completed",
      finalMessage: "already returned inline",
      errorMessage: null,
      originRunId: null,
    };

    const result = await routeCompletedSpawnClosure({
      ref: item.ref,
      commId: item.commId,
      store: {
        async claimSpawnAsyncItemForDelivery(ref) {
          if (ref !== item.ref || status !== "waiting_child") return null;
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem() {
          return null;
        },
        async listResultSinkAttemptsBySpawn(spawnCommId) {
          return [{
            id: "sink_inline_response",
            spawnCommId,
            childSessionId: asSessionId("sess_child_inline_response"),
            messageRunId: asMessageRunId("mr_inline_response"),
            sinkIndex: 0,
            sinkKind: "http_response",
            status: "delivered" as const,
            note: "sync_inline response written",
            errorMessage: null,
            createdAt: asTimestamp(101),
          }];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("inline response path should not escalate");
        },
        async markSpawnAsyncItemDelivered(ref, closure) {
          expect(ref).toBe(item.ref);
          expect(closure).toEqual({
            verdict: "delivered",
            reason: "sync_inline response already written; caller received the result over HTTP",
          });
          closed = true;
          status = "closed";
          return true;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("deliverable path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
          status = previousStatus;
        },
        async findSessionById() {
          throw new Error("inline response path should not load child session");
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({
      action: "noop",
      ref: item.ref,
      commId: item.commId,
      reason: "sync_inline response already written; heartbeat delivery suppressed",
    });
    expect(closed).toBe(true);
    expect(status).toBe("closed");
    expect(() => readFileSync(calls, "utf8")).toThrow();
  });

  test("suppresses Heartbeat after a parent continuation sink already delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-session-sink-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    const item: SpawnAsyncItemRecord = {
      ref: "async_session_sink",
      commId: "comm_session_sink",
      callerSession: "pinglunmaster",
      targetSession: "tobedone",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: "sess_child_session_sink",
      messageRunId: asMessageRunId("mr_session_sink"),
      commStatus: "completed",
      finalMessage: "child continuation result",
      errorMessage: null,
      originRunId: null,
    };

    const result = await routeCompletedSpawnClosure({
      ref: item.ref,
      commId: item.commId,
      store: {
        async claimSpawnAsyncItemForDelivery(ref) {
          if (ref !== item.ref || status !== "waiting_child") return null;
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem() {
          return null;
        },
        async listResultSinkAttemptsBySpawn(spawnCommId) {
          return [{
            id: "sink_session_delivery",
            spawnCommId,
            childSessionId: asSessionId("sess_child_session_sink"),
            messageRunId: asMessageRunId("mr_session_sink"),
            sinkIndex: 0,
            sinkKind: "parent_continuation_inject" as const,
            status: "delivered" as const,
            note: null,
            errorMessage: null,
            createdAt: asTimestamp(101),
          }];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("session sink path should not escalate");
        },
        async markSpawnAsyncItemDelivered(ref, closure) {
          expect(ref).toBe(item.ref);
          expect(closure).toEqual({
            verdict: "delivered",
            reason: "parent_continuation_inject delivery already completed; heartbeat delivery suppressed",
          });
          status = "closed";
          return true;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("session sink path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
          status = previousStatus;
        },
        async findSessionById() {
          throw new Error("session sink path should not load child session");
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({
      action: "noop",
      ref: item.ref,
      commId: item.commId,
      reason: "parent_continuation_inject delivery already completed; heartbeat delivery suppressed",
    });
    expect(status).toBe("closed");
    expect(() => readFileSync(calls, "utf8")).toThrow();
  });

  test("escalates original async item when adjudication child finishes without a valid outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    let closed = false;
    let escalatedReason: string | null = null;
    const original: SpawnAsyncItemRecord = {
      ref: "async_original",
      commId: "comm_original",
      callerSession: "scheduler",
      targetSession: "scheduler",
      failedPhase: "execution",
      failureKind: "run_timeout",
      status: "adjudicating",
      attemptCount: 2,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(90),
      updatedAt: asTimestamp(490),
      lastAttemptAt: asTimestamp(200),
      childSessionId: null,
      messageRunId: null,
      commStatus: "completed",
      finalMessage: null,
      errorMessage: "timeout",
      originRunId: null,
    };
    const clientRequestId = `2026-06-01:spawn-adjudication:${original.commId}:${original.ref}`;
    const item: SpawnAsyncItemRecord = {
      ref: "async_adjudication",
      commId: "comm_adjudication",
      callerSession: "supermatrix-root",
      targetSession: "sk-watcher",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: "sess_child_sk_watcher",
      messageRunId: asMessageRunId("mr_adjudication"),
      commStatus: "completed",
      finalMessage: "adjudication completed",
      errorMessage: null,
      clientRequestId,
      originRunId: null,
    };

    const result = await routeCompletedSpawnClosure({
      ref: item.ref,
      commId: item.commId,
      store: {
        async claimSpawnAsyncItemForDelivery(ref) {
          if (ref !== item.ref || status !== "waiting_child") return null;
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem(ref) {
          return ref === original.ref ? original : null;
        },
        async listResultSinkAttemptsBySpawn() {
          return [];
        },
        async markSpawnAsyncItemAdjudicationEscalated(ref, reason) {
          expect(ref).toBe(original.ref);
          escalatedReason = reason;
        },
        async markSpawnAsyncItemDelivered(ref, closure) {
          expect(ref).toBe(item.ref);
          expect(closure.verdict).toBe("adjudication_result_recorded");
          closed = true;
          status = "closed";
          return true;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("deliverable path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
          status = previousStatus;
        },
        async findSessionById() {
          throw new Error("invalid adjudication suppression should not load child session");
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({
      action: "noop",
      ref: item.ref,
      commId: item.commId,
      reason: "adjudication completed without valid state transition; original escalated",
    });
    expect(escalatedReason).toBe(
      `adjudication spawn ${clientRequestId} completed without a valid status/verdict transition`,
    );
    expect(closed).toBe(true);
    expect(status).toBe("closed");
    expect(() => readFileSync(calls, "utf8")).toThrow();
  });

  test("does not release the claim after the todo has been enqueued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    const item: SpawnAsyncItemRecord = {
      ref: "async_1",
      commId: "comm_1",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: null,
      messageRunId: asMessageRunId("mr_1"),
      commStatus: "completed",
      finalMessage: "full result",
      errorMessage: null,
      originRunId: null,
    };

    await expect(
      routeCompletedSpawnClosure({
        ref: "async_1",
        commId: "comm_1",
        store: {
          async claimSpawnAsyncItemForDelivery() {
            status = "delivering";
            return { ...item, status: "waiting_child" };
          },
          async getSpawnAsyncItem(ref) {
            if (ref === item.ref && status === "delivering") return { ...item, status };
            return null;
          },
          async listResultSinkAttemptsBySpawn() {
            return [];
          },
          async markSpawnAsyncItemAdjudicationEscalated() {
            throw new Error("non-adjudication path should not escalate");
          },
          async markSpawnAsyncItemDelivered() {
            throw new Error("db locked");
          },
          async parkSpawnAsyncItemDeliveryUnsupported() {
            throw new Error("deliverable path should not park as unsupported");
          },
          async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
            status = previousStatus;
          },
          async findSessionById() {
            return null;
          },
        },
        heartbeatEnqueuePath: heartbeat,
        sourceSession: "supermatrix-root",
        now: asTimestamp(500),
      }),
    ).rejects.toThrow("db locked");
    expect(status).toBe("delivering");
  });

  test("parks terminally without releasing or retrying when the caller has heartbeat disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-hb-off-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    // Mirrors the real enqueue-heartbeat-todo contract: exit 3, reason on stdout.
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ok:false,status:'target_not_heartbeat_enabled',target_session:'caller'}));",
        "process.exit(3);",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    let parkedReason: string | null = null;
    let released = false;
    const item: SpawnAsyncItemRecord = {
      ref: "async_1",
      commId: "comm_1",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: null,
      messageRunId: asMessageRunId("mr_1"),
      commStatus: "completed",
      finalMessage: "full result",
      errorMessage: null,
      originRunId: null,
    };
    const notified: Array<{ callerSession: string; ref: string; reason: string }> = [];

    const result = await routeCompletedSpawnClosure({
      ref: "async_1",
      commId: "comm_1",
      store: {
        async claimSpawnAsyncItemForDelivery() {
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem(ref) {
          if (ref === item.ref && status === "delivering") return { ...item, status };
          return null;
        },
        async listResultSinkAttemptsBySpawn() {
          return [];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("non-adjudication path should not escalate");
        },
        async markSpawnAsyncItemDelivered() {
          throw new Error("undeliverable channel must not be recorded as delivered");
        },
        async parkSpawnAsyncItemDeliveryUnsupported(ref, reason) {
          expect(ref).toBe(item.ref);
          parkedReason = reason;
          status = "parked";
          return true;
        },
        async releaseSpawnAsyncItemDelivery() {
          released = true;
        },
        async findSessionById() {
          return null;
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
      notifyUndeliverable: async (input) => {
        notified.push({ callerSession: input.callerSession, ref: input.ref, reason: input.reason });
      },
    });

    expect(result).toEqual({
      action: "noop",
      ref: item.ref,
      commId: item.commId,
      reason: "caller session has heartbeat delivery disabled; result parked for take",
    });
    expect(status).toBe("parked");
    expect(released).toBe(false);
    expect(parkedReason).toContain("target_not_heartbeat_enabled");
    expect(parkedReason).toContain(`/api/spawn_async_items/${item.ref}/take`);
    expect(notified).toEqual([{
      callerSession: "caller",
      ref: item.ref,
      reason: expect.stringContaining("target_not_heartbeat_enabled") as unknown as string,
    }]);
  });

  test("carries a scheduler-synthesized origin run id as the batch key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    const item: SpawnAsyncItemRecord = {
      ref: "async_1",
      commId: "comm_1",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: null,
      messageRunId: asMessageRunId("mr_1"),
      commStatus: "completed",
      finalMessage: "full result",
      errorMessage: null,
      originRunId: asMessageRunId("scheduler:amzdata-daily-inspection:run_abc123"),
    };

    const result = await routeCompletedSpawnClosure({
      ref: "async_1",
      commId: "comm_1",
      store: {
        async claimSpawnAsyncItemForDelivery() {
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem(ref) {
          if (ref === item.ref && status === "delivering") return { ...item, status };
          return null;
        },
        async listResultSinkAttemptsBySpawn() {
          return [];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("non-adjudication path should not escalate");
        },
        async markSpawnAsyncItemDelivered() {
          status = "closed";
          return true;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("deliverable path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
          status = previousStatus;
        },
        async findSessionById() {
          return null;
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({ action: "delivered", ref: "async_1", commId: "comm_1" });
    const call = JSON.parse(readFileSync(calls, "utf8").trim()) as string[];
    expect(call).toContain("--batch-key");
    expect(call).toContain("scheduler:amzdata-daily-inspection:run_abc123");
  });

  test("does not escalate an original that reached terminal delivered success during adjudication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    let closed = false;
    const original: SpawnAsyncItemRecord = {
      ref: "async_original",
      commId: "comm_original",
      callerSession: "scheduler",
      targetSession: "scheduler",
      failedPhase: "execution",
      failureKind: "run_timeout",
      status: "closed",
      attemptCount: 1,
      verdict: "delivered",
      verdictReason: "fast-path heartbeat todo enqueued for caller",
      createdAt: asTimestamp(90),
      updatedAt: asTimestamp(490),
      lastAttemptAt: asTimestamp(200),
      childSessionId: null,
      messageRunId: null,
      commStatus: "completed",
      finalMessage: "original result",
      errorMessage: null,
      originRunId: null,
    };
    const item: SpawnAsyncItemRecord = {
      ref: "async_adjudication",
      commId: "comm_adjudication",
      callerSession: "supermatrix-root",
      targetSession: "sk-watcher",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: "sess_child_sk_watcher",
      messageRunId: asMessageRunId("mr_adjudication"),
      commStatus: "completed",
      finalMessage: "adjudication completed",
      errorMessage: null,
      clientRequestId: `2026-06-01:spawn-adjudication:${original.commId}:${original.ref}`,
      originRunId: null,
    };

    const result = await routeCompletedSpawnClosure({
      ref: item.ref,
      commId: item.commId,
      store: {
        async claimSpawnAsyncItemForDelivery(ref) {
          if (ref !== item.ref || status !== "waiting_child") return null;
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem(ref) {
          return ref === original.ref ? original : null;
        },
        async listResultSinkAttemptsBySpawn() {
          return [];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("terminal delivered success must not be escalated");
        },
        async markSpawnAsyncItemDelivered(ref, closure) {
          expect(ref).toBe(item.ref);
          expect(closure.verdict).toBe("adjudication_result_recorded");
          closed = true;
          status = "closed";
          return true;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("deliverable path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery(_ref, previousStatus) {
          status = previousStatus;
        },
        async findSessionById() {
          throw new Error("adjudication suppression should not load child session");
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({
      action: "noop",
      ref: item.ref,
      commId: item.commId,
      reason: "adjudication result recorded; heartbeat delivery suppressed",
    });
    expect(closed).toBe(true);
    expect(() => readFileSync(calls, "utf8")).toThrow();
  });

  test("noops without enqueue or release when claim is stolen before enqueue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-fast-path-"));
    const heartbeat = join(dir, "enqueue-heartbeat-todo");
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      heartbeat,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ok:true,todo_id:'todo_1'}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    let status: SpawnAsyncItemStatus = "waiting_child";
    let released = false;
    let finalized = false;
    const item: SpawnAsyncItemRecord = {
      ref: "async_stolen",
      commId: "comm_stolen",
      callerSession: "caller",
      targetSession: "target",
      failedPhase: "delivery",
      failureKind: "late_result",
      status,
      attemptCount: 0,
      verdict: null,
      verdictReason: null,
      createdAt: asTimestamp(100),
      updatedAt: asTimestamp(100),
      lastAttemptAt: null,
      childSessionId: null,
      messageRunId: asMessageRunId("mr_stolen"),
      commStatus: "completed",
      finalMessage: "full result",
      errorMessage: null,
      originRunId: null,
    };

    const result = await routeCompletedSpawnClosure({
      ref: item.ref,
      commId: item.commId,
      store: {
        async claimSpawnAsyncItemForDelivery(ref) {
          if (ref !== item.ref || status !== "waiting_child") return null;
          status = "delivering";
          return { ...item, status: "waiting_child" };
        },
        async getSpawnAsyncItem(ref) {
          // Simulate take stealing the claim after push claimed delivering.
          if (ref === item.ref && status === "delivering") {
            status = "closed";
            return {
              ...item,
              status: "closed",
              verdict: "caller_consumed",
              verdictReason: "result taken via POST /api/spawn_async_items/:ref/take",
            };
          }
          return null;
        },
        async listResultSinkAttemptsBySpawn() {
          return [];
        },
        async markSpawnAsyncItemAdjudicationEscalated() {
          throw new Error("stolen-claim path should not escalate");
        },
        async markSpawnAsyncItemDelivered() {
          finalized = true;
          return false;
        },
        async parkSpawnAsyncItemDeliveryUnsupported() {
          throw new Error("deliverable path should not park as unsupported");
        },
        async releaseSpawnAsyncItemDelivery() {
          released = true;
        },
        async findSessionById() {
          throw new Error("stolen-claim path should not load child session");
        },
      },
      heartbeatEnqueuePath: heartbeat,
      sourceSession: "supermatrix-root",
      now: asTimestamp(500),
    });

    expect(result).toEqual({
      action: "noop",
      ref: item.ref,
      commId: item.commId,
      reason: "delivery claim lost before enqueue",
    });
    expect(released).toBe(false);
    expect(finalized).toBe(false);
    expect(status).toBe("closed");
    expect(() => readFileSync(calls, "utf8")).toThrow();
  });
});
