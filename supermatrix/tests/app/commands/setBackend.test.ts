import { describe, expect, test, vi } from "vitest";
import {
  createSetBackendHandler,
  type SetBackendHandlerDeps,
  type ScheduledTaskSummary,
} from "../../../src/app/commands/setBackend.ts";
import { UserError } from "../../../src/domain/errors.ts";
import {
  asLarkGroupId,
  asSessionId,
  type LarkGroupId,
  type SessionId,
} from "../../../src/domain/ids.ts";
import type { BackendKind } from "../../../src/domain/session.ts";

function msg(groupId: string, text: string) {
  return {
    groupId: asLarkGroupId(groupId),
    messageId: "m",
    userId: "u",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

type SessionRow = { id: SessionId; backend: BackendKind; status: string };

function fakeStore(initial: { name: string; row: SessionRow; binding?: LarkGroupId }) {
  const sessions = new Map<string, SessionRow>();
  sessions.set(initial.name, { ...initial.row });
  const bindings = new Map<SessionId, LarkGroupId>();
  if (initial.binding) bindings.set(initial.row.id, initial.binding);

  const store: SetBackendHandlerDeps["store"] = {
    async findSessionByName(name) {
      const row = sessions.get(name);
      return row ? { ...row } : null;
    },
    async findBySession(sessionId) {
      const groupId = bindings.get(sessionId);
      return groupId ? { groupId } : null;
    },
    async updateSessionBackend(id, backend) {
      for (const [name, row] of sessions) {
        if (row.id === id) sessions.set(name, { ...row, backend });
      }
    },
    async updateSessionBackendSessionId() {},
    async updateSessionModel() {},
  };
  return { store, sessions };
}

describe("createSetBackendHandler", () => {
  const baseRow: SessionRow = {
    id: asSessionId("s1"),
    backend: "claude",
    status: "idle",
  };

  test("rejects when backend arg missing", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({ store });
    await expect(
      handler({
        args: { name: "foo" },
        scope: "root",
        msg: msg("oc_root", "/backend foo"),
      }),
    ).rejects.toThrow(UserError);
  });

  test("rejects invalid backend value", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({ store });
    await expect(
      handler({
        args: { name: "foo", backend: "gemini" },
        scope: "root",
        msg: msg("oc_root", "/backend foo gemini"),
      }),
    ).rejects.toThrow(/无效的 backend/);
  });

  test("noop when backend unchanged — does NOT trigger cascades", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const listScheduledTasks = vi.fn(async () => []);
    const regenerateCatalog = vi.fn(async () => {});
    const handler = createSetBackendHandler({
      store,
      listScheduledTasks,
      regenerateCatalog,
    });
    const result = await handler({
      args: { name: "foo", backend: "claude" },
      scope: "root",
      msg: msg("oc_root", "/backend foo claude"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已经在使用 claude");
    expect(listScheduledTasks).not.toHaveBeenCalled();
    expect(regenerateCatalog).not.toHaveBeenCalled();
  });

  test("rejects when session busy", async () => {
    const { store } = fakeStore({ name: "foo", row: { ...baseRow, status: "busy" } });
    const handler = createSetBackendHandler({ store });
    await expect(
      handler({
        args: { name: "foo", backend: "codex" },
        scope: "root",
        msg: msg("oc_root", "/backend foo codex"),
      }),
    ).rejects.toThrow(/session 正在运行/);
  });

  test("happy path (no cascade deps) succeeds and returns confirmation", async () => {
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({ store });
    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已从 claude 切换为 codex");
    expect(sessions.get("foo")?.backend).toBe("codex");
  });

  test("appends cron task list when scheduler returns tasks", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const tasks: ScheduledTaskSummary[] = [
      { id: "t_abc123", cronExpression: "*/5 * * * *", prompt: "review daily logs and summarize anomalies for team" },
      { id: "t_xyz", cronExpression: "0 8 * * *", prompt: "short" },
    ];
    const handler = createSetBackendHandler({
      store,
      listScheduledTasks: async (name) => {
        expect(name).toBe("foo");
        return tasks;
      },
    });
    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("相关定时任务");
    expect(result.replyText).toContain("t_abc123");
    expect(result.replyText).toContain("*/5 * * * *");
    // prompt truncated to 50 chars — full is 52 chars, so the last two chars drop
    expect(result.replyText).toContain("review daily logs and summarize anomalies for team");
    expect(result.replyText).not.toContain("review daily logs and summarize anomalies for team!"); // sanity
    expect(result.replyText).toContain("t_xyz");
  });

  test("shows '无相关定时任务' when scheduler returns empty", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({
      store,
      listScheduledTasks: async () => [],
    });
    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("相关定时任务：无相关定时任务");
  });

  test("scheduler failure becomes a warning, does not block success", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({
      store,
      listScheduledTasks: async () => {
        throw new Error("scheduler down");
      },
    });
    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已从 claude 切换为 codex");
    expect(result.replyText).toContain("查询定时任务失败：scheduler down");
  });

  test("regenerateCatalog called with reason describing the transition", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const regenerateCatalog = vi.fn(async (_reason: string) => {});
    const handler = createSetBackendHandler({ store, regenerateCatalog });
    await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });
    expect(regenerateCatalog).toHaveBeenCalledTimes(1);
    const reason = regenerateCatalog.mock.calls[0]![0];
    expect(reason).toContain("foo");
    expect(reason).toContain("claude");
    expect(reason).toContain("codex");
  });

  test("regenerateCatalog failure becomes a warning, does not block success", async () => {
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({
      store,
      regenerateCatalog: async () => {
        throw new Error("disk full");
      },
    });
    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已从 claude 切换为 codex");
    expect(result.replyText).toContain("session-catalog 重新生成失败：disk full");
    // DB mutation still took effect — no rollback
    expect(sessions.get("foo")?.backend).toBe("codex");
  });

  test("user scope resolves session from group binding", async () => {
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow });
    const resolveUserGroupSession = vi.fn(async () => ({
      name: "foo",
      id: asSessionId("s1"),
    }));
    const handler = createSetBackendHandler({ store, resolveUserGroupSession });
    await handler({
      args: { backend: "codex" },
      scope: "user",
      msg: msg("oc_foo", "/backend codex"),
    });
    expect(resolveUserGroupSession).toHaveBeenCalled();
    expect(sessions.get("foo")?.backend).toBe("codex");
  });

  test("accepts 'kimi' as valid backend", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({ store });
    const res = await handler({
      args: { name: "foo", backend: "kimi" },
      scope: "root",
      msg: msg("oc_root", "/backend foo kimi"),
    });
    if (!("replyText" in res)) throw new Error("expected replyText");
    expect(res.replyText).toContain("已从 claude 切换为 kimi");
  });

  test("rejects bad backend, error lists kimi", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({ store });
    await expect(
      handler({
        args: { name: "foo", backend: "gpt" },
        scope: "root",
        msg: msg("oc_root", "/backend foo gpt"),
      }),
    ).rejects.toThrow(/kimi/);
  });
});
