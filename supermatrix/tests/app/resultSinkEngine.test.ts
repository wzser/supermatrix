import { describe, expect, test, vi } from "vitest";
import { deliverResultSinks, redeliverResultSinks } from "../../src/app/resultSinkEngine.ts";
import { asAbsolutePath, asLarkGroupId, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { ResultSink } from "../../src/domain/childCapabilities.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import type { ResultSinkAttemptInput } from "../../src/ports/BindingStore.ts";

const TODO_APPEND_ASSIGNEE = "EXAMPLE_OWNER";

function makeChild(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("child_x"),
    name: "child_x",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "child",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/x"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "busy",
    parentId: asSessionId("parent_x"),
    depth: 1,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: "one_shot_delegation",
    triggerKind: "session",
    postIdentity: "bot",
    callerInvocation: "async_kickoff",
    continuationHook: "none",
    capabilityPayload: { resultSinks: [] },
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
    ...overrides,
  };
}

function makeTodoAppendGatedChild(): Session {
  return makeChild({
    capabilityPayload: {
      resultSinks: [
        {
          kind: "chat_post",
          chatRef: { kind: "explicit", chatId: "oc_target" },
          identity: "bot",
          resultGate: {
            kind: "todo_append_v1",
            assignee: TODO_APPEND_ASSIGNEE,
            todoSerial: 450,
            appendContent: "补充检查广告字段口径",
          },
        },
      ],
    },
  });
}

const TODO_APPEND_INTENT_FINGERPRINT = "49f058e3ec7ba521ee7ce922e4a02a3cbd661a5b4f06ac512860158ba2df8ca6";

describe("resultSinkEngine", () => {
  test("sync_inline callerInvocation short-circuits the whole engine", async () => {
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      callerInvocation: "sync_inline",
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_x" }, identity: "bot" },
        ],
      },
    });
    const summary = await deliverResultSinks(child, "hi", {
      store: createFakeBindingStore(),
      postToChat,
    });
    expect(postToChat).not.toHaveBeenCalled();
    expect(summary.delivered[0]?.note).toMatch(/sync_inline/);
  });

  test("sync_inline still delivers a declared parent continuation sink", async () => {
    const injectContinuation = vi.fn(async () => {});
    const child = makeChild({
      callerInvocation: "sync_inline",
      capabilityPayload: {
        resultSinks: [
          { kind: "parent_continuation_inject", parentSessionId: asSessionId("tobedone") },
        ],
      },
    });

    await deliverResultSinks(child, "child done", {
      store: createFakeBindingStore(),
      injectContinuation,
    });

    expect(injectContinuation).toHaveBeenCalledWith({
      parentSessionId: asSessionId("tobedone"),
      childSession: child,
      finalMessage: "child done",
    });
  });

  test("http_response / pollable_endpoint / audit_only are no-ops by design", async () => {
    const sinks: ResultSink[] = [
      { kind: "http_response" },
      { kind: "pollable_endpoint" },
      { kind: "audit_only" },
    ];
    const child = makeChild({ capabilityPayload: { resultSinks: sinks } });
    const summary = await deliverResultSinks(child, "ignored", {
      store: createFakeBindingStore(),
    });
    expect(summary.delivered).toHaveLength(3);
    expect(summary.delivered.every((d) => d.ok && /no-op/.test(d.note ?? ""))).toBe(true);
  });

  test("chat_post with explicit chatRef posts with declared identity", async () => {
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_target" }, identity: "user" },
        ],
      },
    });
    await deliverResultSinks(child, "the final word", {
      store: createFakeBindingStore(),
      postToChat,
    });
    expect(postToChat).toHaveBeenCalledWith(asLarkGroupId("oc_target"), "the final word", "user");
  });

  test("todo append result gate rejects an unverified human success message", async () => {
    const postToChat = vi.fn(async () => {});
    const child = makeTodoAppendGatedChild();

    await deliverResultSinks(child, `✓ 已追加 Todo：${TODO_APPEND_ASSIGNEE} / 450 / 补充检查广告字段口径`, {
      store: createFakeBindingStore(),
      postToChat,
    });

    expect(postToChat).toHaveBeenCalledWith(
      asLarkGroupId("oc_target"),
      "❌ /todo 失败：未收到可验证的脚本执行回执",
      "bot",
    );
  });

  test("todo append result gate renders success only from a verified script receipt", async () => {
    const postToChat = vi.fn(async () => {});
    const child = makeTodoAppendGatedChild();
    const finalMessage = JSON.stringify({
      kind: "todo_append_result/v1",
      exit_code: 0,
      stdout: JSON.stringify({
        ok: true,
        status: "appended",
        todo_serial: 450,
        record_id: "rec_1",
        intent_fingerprint: TODO_APPEND_INTENT_FINGERPRINT,
      }),
      stderr: "",
    });

    await deliverResultSinks(child, finalMessage, {
      store: createFakeBindingStore(),
      postToChat,
    }, {
      toolResults: [{
        command: `python3 scripts/todo_append.py --payload-file payload.json --assignee ${TODO_APPEND_ASSIGNEE} --content 补充检查广告字段口径`,
        result: {
          output: JSON.stringify({
            ok: true,
            status: "appended",
            todo_serial: 450,
            record_id: "rec_1",
            intent_fingerprint: TODO_APPEND_INTENT_FINGERPRINT,
          }),
          exitCode: 0,
        },
      }],
    });

    expect(postToChat).toHaveBeenCalledWith(
      asLarkGroupId("oc_target"),
      `✓ 已追加 Todo：${TODO_APPEND_ASSIGNEE} / 450 / 补充检查广告字段口径`,
      "bot",
    );
  });

  test.each([
    ["missing", undefined],
    ["wrong type", 1],
    ["uppercase", TODO_APPEND_INTENT_FINGERPRINT.toUpperCase()],
    ["wrong length", TODO_APPEND_INTENT_FINGERPRINT.slice(0, -1)],
    ["different append content", "0826ed1a7651917e9c3ff6b56e3c3baffaaPHONE_REDACTEDd118f26e68a5775c76"],
    ["different assignee", "e66169ba31cdaf516d23a2e288f673c47c22889dfc7b38254c831f7a66c3f0bb"],
    ["different serial", "33ed79fd7410b1cbb5f5244d81bae834b263587f88193d57d9d2980831b16098"],
  ])("todo append result gate rejects %s intent fingerprint", async (_case, intentFingerprint) => {
    const postToChat = vi.fn(async () => {});
    const child = makeTodoAppendGatedChild();
    const stdout = JSON.stringify({
      ok: true,
      status: "appended",
      todo_serial: 450,
      record_id: "rec_1",
      intent_fingerprint: intentFingerprint,
    });

    await deliverResultSinks(child, "child-authored success", {
      store: createFakeBindingStore(),
      postToChat,
    }, {
      toolResults: [{
        command: "python3 scripts/todo_append.py --payload-file payload.json",
        result: { output: stdout, exitCode: 0 },
      }],
    });

    expect(postToChat).toHaveBeenCalledWith(
      asLarkGroupId("oc_target"),
      `❌ /todo 失败：${stdout}`,
      "bot",
    );
  });

  test.each([
    [
      "non-zero exit",
      { kind: "todo_append_result/v1", exit_code: 1, stdout: "", stderr: "record not found" },
      "❌ /todo 失败：record not found",
    ],
    [
      "malformed stdout",
      { kind: "todo_append_result/v1", exit_code: 0, stdout: "not json", stderr: "" },
      "❌ /todo 失败：not json",
    ],
    [
      "non-object stdout",
      { kind: "todo_append_result/v1", exit_code: 0, stdout: "[]", stderr: "" },
      "❌ /todo 失败：[]",
    ],
    [
      "ok is not true",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: false, status: "appended", error: "owner mismatch" }),
        stderr: "",
      },
      "❌ /todo 失败：owner mismatch",
    ],
    [
      "status is not appended",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "queued" }),
        stderr: "",
      },
      "❌ /todo 失败：返回状态 queued",
    ],
    [
      "todo serial is mismatched",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "appended", todo_serial: 451, record_id: "rec_1" }),
        stderr: "",
      },
      "❌ /todo 失败：{\"ok\":true,\"status\":\"appended\",\"todo_serial\":451,\"record_id\":\"rec_1\"}",
    ],
    [
      "todo serial is missing",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "appended", record_id: "rec_1" }),
        stderr: "",
      },
      "❌ /todo 失败：{\"ok\":true,\"status\":\"appended\",\"record_id\":\"rec_1\"}",
    ],
    [
      "todo serial is unsafe",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "appended", todo_serial: Number.MAX_SAFE_INTEGER + 1, record_id: "rec_1" }),
        stderr: "",
      },
      `❌ /todo 失败：${JSON.stringify({ ok: true, status: "appended", todo_serial: Number.MAX_SAFE_INTEGER + 1, record_id: "rec_1" })}`,
    ],
    [
      "todo serial has the wrong type",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "appended", todo_serial: "450", record_id: "rec_1" }),
        stderr: "",
      },
      "❌ /todo 失败：{\"ok\":true,\"status\":\"appended\",\"todo_serial\":\"450\",\"record_id\":\"rec_1\"}",
    ],
    [
      "record id is missing",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "appended", todo_serial: 450 }),
        stderr: "",
      },
      "❌ /todo 失败：{\"ok\":true,\"status\":\"appended\",\"todo_serial\":450}",
    ],
    [
      "record id is not a string",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "appended", todo_serial: 450, record_id: 1 }),
        stderr: "",
      },
      "❌ /todo 失败：{\"ok\":true,\"status\":\"appended\",\"todo_serial\":450,\"record_id\":1}",
    ],
    [
      "record id is blank",
      {
        kind: "todo_append_result/v1",
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, status: "appended", todo_serial: 450, record_id: "   " }),
        stderr: "",
      },
      "❌ /todo 失败：{\"ok\":true,\"status\":\"appended\",\"todo_serial\":450,\"record_id\":\"   \"}",
    ],
  ])("todo append result gate fails closed for %s", async (_case, envelope, expected) => {
    const postToChat = vi.fn(async () => {});
    const child = makeTodoAppendGatedChild();

    await deliverResultSinks(child, JSON.stringify(envelope), {
      store: createFakeBindingStore(),
      postToChat,
    }, {
      toolResults: [{
        command: "python3 scripts/todo_append.py --payload-file payload.json",
        result: {
          output: typeof envelope.stdout === "string" ? envelope.stdout : "",
          exitCode: typeof envelope.exit_code === "number" ? envelope.exit_code : 1,
          ...(typeof envelope.stderr === "string" ? { stderr: envelope.stderr } : {}),
        },
      }],
    });

    expect(postToChat).toHaveBeenCalledWith(asLarkGroupId("oc_target"), expected, "bot");
  });

  test.each([
    ["compound shell prefix", "echo ready && python3 scripts/todo_append.py --payload-file payload.json"],
    ["compound shell suffix", "python3 scripts/todo_append.py --payload-file payload.json; true"],
    ["non-invocation command text", "echo python3 scripts/todo_append.py --payload-file payload.json"],
  ])("todo append result gate ignores %s as script evidence", async (_case, command) => {
    const postToChat = vi.fn(async () => {});
    const child = makeTodoAppendGatedChild();

    await deliverResultSinks(child, "child-authored success", {
      store: createFakeBindingStore(),
      postToChat,
    }, {
      toolResults: [{
        command,
        result: {
          output: JSON.stringify({ ok: true, status: "appended", todo_serial: 450, record_id: "rec_1" }),
          exitCode: 0,
        },
      }],
    });

    expect(postToChat).toHaveBeenCalledWith(
      asLarkGroupId("oc_target"),
      "❌ /todo 失败：未收到可验证的脚本执行回执",
      "bot",
    );
  });

  test("chat_post with parent chatRef resolves through findBySession", async () => {
    const store = createFakeBindingStore();
    store.seedBinding({
      groupId: asLarkGroupId("oc_parent"),
      sessionId: asSessionId("parent_x"),
      createdAt: asTimestamp(1),
    });
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "parent" }, identity: "bot" },
        ],
      },
    });
    await deliverResultSinks(child, "hey", { store, postToChat });
    expect(postToChat).toHaveBeenCalledWith(asLarkGroupId("oc_parent"), "hey", "bot");
  });

  test("chat_post without postToChat wired reports deferred", async () => {
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_x" }, identity: "bot" },
        ],
      },
    });
    const summary = await deliverResultSinks(child, "hi", { store: createFakeBindingStore() });
    expect(summary.delivered[0]?.ok).toBe(false);
    expect(summary.delivered[0]?.note).toMatch(/postToChat not wired/);
  });

  test("parent_continuation_inject calls injectContinuation with the right payload", async () => {
    const injectContinuation = vi.fn(async () => {});
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "parent_continuation_inject", parentSessionId: asSessionId("parent_x") },
        ],
      },
    });
    await deliverResultSinks(child, "child done", {
      store: createFakeBindingStore(),
      injectContinuation,
    });
    expect(injectContinuation).toHaveBeenCalledWith({
      parentSessionId: asSessionId("parent_x"),
      childSession: child,
      finalMessage: "child done",
    });
  });

  test("eventbus_publish falls back to note when topicBus is not wired", async () => {
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [{ kind: "eventbus_publish", topic: "result.done" }],
      },
    });
    const summary = await deliverResultSinks(child, "whatever", {
      store: createFakeBindingStore(),
    });
    expect(summary.delivered[0]?.ok).toBe(false);
    expect(summary.delivered[0]?.note).toMatch(/topicBus not wired/);
  });

  test("eventbus_publish publishes a child_final_message payload when topicBus is wired", async () => {
    const published: Array<{ topic: string; payload: unknown }> = [];
    const topicBus = {
      async publish(topic: string, payload: unknown) {
        published.push({ topic, payload });
      },
      subscribe() {
        return () => {};
      },
      recent() {
        return [];
      },
    };
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [{ kind: "eventbus_publish", topic: "result.done" }],
      },
    });
    const summary = await deliverResultSinks(child, "done done", {
      store: createFakeBindingStore(),
      topicBus,
    });
    expect(summary.delivered[0]?.ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]?.topic).toBe("result.done");
    const payload = published[0]?.payload as { kind: string; childSessionId: string; finalMessage: string };
    expect(payload.kind).toBe("child_final_message");
    expect(payload.finalMessage).toBe("done done");
    expect(payload.childSessionId).toBe(child.id);
  });

  test("redeliverResultSinks replays delivery and records a delivered attempt without rerunning the child", async () => {
    const store = createFakeBindingStore();
    const attempts: ResultSinkAttemptInput[] = [];
    store.recordResultSinkAttempt = async (input) => {
      attempts.push(input);
    };
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      status: "deleted",
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_target" }, identity: "bot" },
        ],
      },
    });

    const summary = await redeliverResultSinks({
      session: child,
      finalMessage: "complete result",
      messageRunId: asMessageRunId("mr_redeliver"),
      spawnCommId: "comm_redeliver",
      deps: { store, postToChat },
      now: () => asTimestamp(10),
      idFactory: () => "sink_redeliver_1",
    });

    expect(postToChat).toHaveBeenCalledTimes(1);
    expect(postToChat).toHaveBeenCalledWith(asLarkGroupId("oc_target"), "complete result", "bot");
    expect(summary.delivered).toEqual([{ sinkKind: "chat_post", ok: true }]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: "sink_redeliver_1",
      spawnCommId: "comm_redeliver",
      childSessionId: child.id,
      messageRunId: asMessageRunId("mr_redeliver"),
      sinkIndex: 0,
      sinkKind: "chat_post",
      status: "delivered",
      createdAt: asTimestamp(10),
    });
  });

  test("redeliverResultSinks records failed attempts for dead addresses without throwing", async () => {
    const store = createFakeBindingStore();
    const attempts: ResultSinkAttemptInput[] = [];
    store.recordResultSinkAttempt = async (input) => {
      attempts.push(input);
    };
    const postToChat = vi.fn(async () => {
      throw new Error("chat not found");
    });
    const child = makeChild({
      status: "deleted",
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_dead" }, identity: "bot" },
        ],
      },
    });

    const summary = await redeliverResultSinks({
      session: child,
      finalMessage: "complete result",
      messageRunId: asMessageRunId("mr_redeliver_fail"),
      spawnCommId: "comm_redeliver_fail",
      deps: { store, postToChat },
      now: () => asTimestamp(11),
      idFactory: () => "sink_redeliver_failed",
    });

    expect(summary.delivered[0]).toMatchObject({
      sinkKind: "chat_post",
      ok: false,
      note: "delivery failed",
      errorMessage: "chat not found",
    });
    expect(attempts[0]).toMatchObject({
      id: "sink_redeliver_failed",
      status: "failed",
      sinkKind: "chat_post",
      errorMessage: "chat not found",
    });
  });
});
