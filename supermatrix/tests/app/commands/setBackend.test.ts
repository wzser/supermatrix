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
import type { BackendKind, SessionCategory } from "../../../src/domain/session.ts";
import { buildCommandRegistry } from "../../../src/app/commandRegistry.ts";
import { BACKEND_ALIASES, resolveBackendAlias } from "../../../src/app/commands/backendAliases.ts";
import { parseCommand } from "../../../src/domain/parseCommand.ts";

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

type SessionRow = { id: SessionId; backend: BackendKind; category: SessionCategory; status: string; model: null; effort: null; backendSessionId: string | null };

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
    async applySessionRuntimeConfigMutations(mutations) {
      for (const { sessionId: id, after } of mutations) {
      for (const [name, row] of sessions) {
        if (row.id === id) sessions.set(name, { ...row, backend: after.backend, model: null, effort: null, backendSessionId: after.backendSessionId });
      }
      }
      return { updated: mutations.length };
    },
  };
  return { store, sessions };
}

const baseRow: SessionRow = {
  id: asSessionId("s1"),
  backend: "claude",
  category: "",
  status: "idle",
  model: null,
  effort: null,
  backendSessionId: null,
};

describe("createSetBackendHandler", () => {
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
    const requestScheduledTaskReview = vi.fn(async () => {});
    const regenerateCatalog = vi.fn(async () => {});
    const handler = createSetBackendHandler({
      store,
      listScheduledTasks,
      requestScheduledTaskReview,
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
    expect(requestScheduledTaskReview).not.toHaveBeenCalled();
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

  test("backend switch clears the current tuple and delegates incompatible Feishu defaults to CAS migration", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const applySessionRuntimeConfigMutations = vi.fn(store.applySessionRuntimeConfigMutations);
    const handler = createSetBackendHandler({
      store: { ...store, applySessionRuntimeConfigMutations } as SetBackendHandlerDeps["store"],
    });

    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(applySessionRuntimeConfigMutations).toHaveBeenCalledTimes(1);
    expect(applySessionRuntimeConfigMutations.mock.calls[0]![0][0]!.after).toMatchObject({ backend: "codex", model: null, effort: null, backendSessionId: null });
    expect(applySessionRuntimeConfigMutations.mock.calls[0]![0][0]!.settingsPatch).toBeUndefined();
    expect(result.replyText).toContain("不兼容的飞书每日默认值将自动迁移");
  });

  test("successful backend switch requests a session-table sync", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const syncSessionTable = vi.fn();
    const handler = createSetBackendHandler({ store, syncSessionTable });

    await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });

    expect(syncSessionTable).toHaveBeenCalledOnce();
    expect(syncSessionTable).toHaveBeenCalledWith("backend-switch");
  });

  test("does not dispatch a scheduler review when the atomic backend mutation fails", async () => {
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow });
    const requestScheduledTaskReview = vi.fn(async () => {});
    const handler = createSetBackendHandler({
      store: {
        ...store,
        applySessionRuntimeConfigMutations: async () => { throw new Error("runtime config conflict"); },
      },
      requestScheduledTaskReview,
    });

    await expect(handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    })).rejects.toThrow("runtime config conflict");

    expect(requestScheduledTaskReview).not.toHaveBeenCalled();
    expect(sessions.get("foo")?.backend).toBe("claude");
  });

  test("post-commit binding lookup failure returns success with a warning and does not claim rollback", async () => {
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow, binding: asLarkGroupId("oc_foo") });
    const renameGroup = vi.fn(async () => {});
    const handler = createSetBackendHandler({
      store: { ...store, findBySession: vi.fn(async () => { throw new Error("binding lookup down"); }) },
      renameGroup,
    });

    const result = await handler({ args: { name: "foo", backend: "codex" }, scope: "root", msg: msg("oc_root", "") });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已从 claude 切换为 codex");
    expect(result.replyText).toContain("群名更新失败：binding lookup down");
    expect(result.replyText).not.toMatch(/回滚|未切换|切换失败/);
    expect(sessions.get("foo")?.backend).toBe("codex");
    expect(renameGroup).not.toHaveBeenCalled();
  });

  test("post-commit group rename failure returns success with a warning and keeps the runtime tuple committed", async () => {
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow, binding: asLarkGroupId("oc_foo") });
    const renameGroup = vi.fn(async () => { throw new Error("rename down"); });
    const handler = createSetBackendHandler({ store, renameGroup });

    const result = await handler({ args: { name: "foo", backend: "codex" }, scope: "root", msg: msg("oc_root", "") });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已从 claude 切换为 codex");
    expect(result.replyText).toContain("群名更新失败：rename down");
    expect(result.replyText).not.toMatch(/回滚|未切换|切换失败/);
    expect(sessions.get("foo")).toMatchObject({ backend: "codex", model: null, effort: null, backendSessionId: null });
    expect(renameGroup).toHaveBeenCalledWith(asLarkGroupId("oc_foo"), "codex");
  });

  test("codex switch persists atomically without probing even when an unavailable probe is injected", async () => {
    // /backend codex must validate catalog/policy and atomically persist without
    // a generative availability probe. Inject a probe that would reject and prove
    // the hot path never calls it: the switch commits and side effects proceed.
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow, binding: asLarkGroupId("oc_foo") });
    const apply = vi.fn(store.applySessionRuntimeConfigMutations);
    const renameGroup = vi.fn(async () => {});
    const requestScheduledTaskReview = vi.fn(async () => {});
    const regenerateCatalog = vi.fn(async () => {});
    const probe = vi.fn(async () => ({ kind: "unavailable" as const, checkedAt: 1, reason: "not entitled" }));
    const handler = createSetBackendHandler({
      store: { ...store, applySessionRuntimeConfigMutations: apply },
      availability: { probe },
      renameGroup,
      requestScheduledTaskReview,
      regenerateCatalog,
    });

    const result = await handler({ args: { name: "foo", backend: "codex" }, scope: "root", msg: msg("oc_root", "") });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(probe).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(renameGroup).toHaveBeenCalledWith(asLarkGroupId("oc_foo"), "codex");
    expect(requestScheduledTaskReview).toHaveBeenCalledTimes(1);
    expect(regenerateCatalog).toHaveBeenCalledTimes(1);
    expect(sessions.get("foo")).toMatchObject({ backend: "codex", model: null, effort: null, backendSessionId: null });
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

  test("dispatches an asynchronous scheduler review after a backend switch", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const requestScheduledTaskReview = vi.fn(async () => {});
    const handler = createSetBackendHandler({ store, requestScheduledTaskReview });

    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(requestScheduledTaskReview).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: "foo",
      previousBackend: "claude",
      newBackend: "codex",
      backendSwitchAuditId: expect.stringMatching(/^cfg_/u),
    }));
    expect(result.replyText).toContain("已交 scheduler 自动核查相关定时任务");
  });

  test("binds the scheduler review id to the committed backend-switch audit", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const applySessionRuntimeConfigMutations = vi.fn(store.applySessionRuntimeConfigMutations);
    const requestScheduledTaskReview = vi.fn(async () => {});
    const handler = createSetBackendHandler({
      store: { ...store, applySessionRuntimeConfigMutations },
      requestScheduledTaskReview,
    });

    await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });

    const auditId = applySessionRuntimeConfigMutations.mock.calls[0]![0][0]!.audit.id;
    const auditCreatedAt = applySessionRuntimeConfigMutations.mock.calls[0]![0][0]!.audit.createdAt;
    expect(requestScheduledTaskReview).toHaveBeenCalledWith(expect.objectContaining({
      backendSwitchAuditId: auditId,
      backendSwitchAuditCreatedAt: auditCreatedAt,
    }));
  });

  test("dispatches the scheduler review before other best-effort post-commit side effects", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow, binding: asLarkGroupId("oc_foo") });
    const calls: string[] = [];
    const handler = createSetBackendHandler({
      store,
      requestScheduledTaskReview: async () => { calls.push("scheduler-review"); },
      renameGroup: async () => { calls.push("rename-group"); },
      listScheduledTasks: async () => {
        calls.push("list-tasks");
        return [];
      },
    });

    await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });

    expect(calls).toEqual(["scheduler-review", "rename-group", "list-tasks"]);
  });

  test("labels the task list as an automatic scheduler review", async () => {
    const { store } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({
      store,
      requestScheduledTaskReview: async () => {},
      listScheduledTasks: async () => [
        { id: "task-1", cronExpression: "0 8 * * *", prompt: "daily check" },
      ],
    });

    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("相关定时任务（scheduler 将自动核查 prompt 是否仍适用新 backend）");
    expect(result.replyText).not.toContain("请自行检查 prompt");
  });

  test("scheduler review dispatch failure is a warning after the backend has switched", async () => {
    const { store, sessions } = fakeStore({ name: "foo", row: baseRow });
    const handler = createSetBackendHandler({
      store,
      requestScheduledTaskReview: async () => { throw new Error("spawn down"); },
    });

    const result = await handler({
      args: { name: "foo", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend foo codex"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(sessions.get("foo")?.backend).toBe("codex");
    expect(result.replyText).toContain("定时任务自动核查派发失败：spawn down");
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

describe("backend aliases", () => {
  test("resolveBackendAlias folds case/NFKC and curated aliases", () => {
    expect(resolveBackendAlias("CODEX")).toBe("codex");
    expect(resolveBackendAlias("ＣＬＡＵＤＥ")).toBe("claude");
    expect(resolveBackendAlias("claude-code")).toBe("claude");
    expect(resolveBackendAlias("codex-cli")).toBe("codex");
    expect(resolveBackendAlias("k2")).toBe("kimi");
    expect(resolveBackendAlias("nonsense")).toBeNull();
  });

  test("/backend accepts CODEX / codex-cli / k2", async () => {
    for (const [arg, expected] of [["CODEX", "codex"], ["codex-cli", "codex"], ["k2", "kimi"]] as const) {
      const { store } = fakeStore({ name: "foo", row: { ...baseRow } });
      const handler = createSetBackendHandler({ store });
      const r = await handler({ scope: "root", args: { name: "foo", backend: arg }, msg: msg("oc_root", `/backend foo ${arg}`) });
      if (!("replyText" in r)) throw new Error("expected replyText");
      expect(r.replyText).toContain(`已从 claude 切换为 ${expected}`);
    }
  });

  test("/new backend enum is wired to the shared BACKEND_ALIASES map", () => {
    const reg = buildCommandRegistry();
    const backendParam = reg.new.command.params.find((p) => p.name === "backend");
    expect(backendParam?.enumAliases).toBe(BACKEND_ALIASES);
  });

  test("/new parses backend aliases through the real command registry", () => {
    const commandsForParser = Object.fromEntries(
      Object.entries(buildCommandRegistry()).map(([name, entry]) => [name, entry.command]),
    );

    expect(parseCommand("/new CODEX foo", commandsForParser, "root")).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "codex", name: "foo" },
    });
    expect(parseCommand("/new codex-cli foo", commandsForParser, "root")).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "codex", name: "foo" },
    });
    expect(parseCommand("/new k2 foo", commandsForParser, "root")).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "kimi", name: "foo" },
    });

    const unknown = parseCommand("/new nonsense foo", commandsForParser, "root");
    expect(unknown.kind).toBe("error");
    if (unknown.kind === "error") {
      expect(unknown.message).toContain("参数 backend 必须是以下之一：claude|codex|kimi");
    }
  });

  test("/new clone preserves source, target backend, and required new name", () => {
    const commandsForParser = Object.fromEntries(
      Object.entries(buildCommandRegistry()).map(([name, entry]) => [name, entry.command]),
    );

    expect(
      parseCommand("/new clone codexroot kimi kimi-reviewer", commandsForParser, "root"),
    ).toEqual({
      kind: "ok",
      name: "new",
      args: {
        backend: "clone",
        name: "codexroot",
        purpose: "kimi kimi-reviewer",
      },
    });
  });

  test("/clone parses target backend and new name in user scope", () => {
    const commandsForParser = Object.fromEntries(
      Object.entries(buildCommandRegistry()).map(([name, entry]) => [name, entry.command]),
    );

    expect(parseCommand("/clone k2 codexkim", commandsForParser, "user")).toEqual({
      kind: "ok",
      name: "clone",
      args: {
        backend: "kimi",
        name: "codexkim",
      },
    });
  });
});

describe("外部 category × kimi backend guard", () => {
  test("rejects switching an 外部 session to kimi", async () => {
    const { store } = fakeStore({ name: "ext", row: { ...baseRow, category: "外部" } });
    const handler = createSetBackendHandler({ store });
    await expect(
      handler({
        args: { name: "ext", backend: "kimi" },
        scope: "root",
        msg: msg("oc_root", "/backend ext kimi"),
      }),
    ).rejects.toThrow(/外部 session 不支持 kimi/);
  });

  test("外部 session can still switch to codex", async () => {
    const { store, sessions } = fakeStore({ name: "ext", row: { ...baseRow, category: "外部" } });
    const handler = createSetBackendHandler({ store });
    const r = await handler({
      args: { name: "ext", backend: "codex" },
      scope: "root",
      msg: msg("oc_root", "/backend ext codex"),
    });
    if (!("replyText" in r)) throw new Error("expected replyText");
    expect(r.replyText).toContain("已从 claude 切换为 codex");
    expect(sessions.get("ext")?.backend).toBe("codex");
  });

  test("non-外部 session can switch to kimi", async () => {
    const { store, sessions } = fakeStore({ name: "plain", row: { ...baseRow } });
    const handler = createSetBackendHandler({ store });
    const r = await handler({
      args: { name: "plain", backend: "kimi" },
      scope: "root",
      msg: msg("oc_root", "/backend plain kimi"),
    });
    if (!("replyText" in r)) throw new Error("expected replyText");
    expect(sessions.get("plain")?.backend).toBe("kimi");
  });
});
