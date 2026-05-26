import { describe, expect, test } from "vitest";
import { createSessionLifecycle } from "../../src/app/sessionLifecycle.ts";
import { UserError } from "../../src/domain/errors.ts";
import { asAbsolutePath, asTimestamp } from "../../src/domain/ids.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeEventBus } from "../fakes/fakeEventBus.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";
import { createFakeWorkspaceFs } from "../fakes/fakeWorkspaceFs.ts";

function mkDeps() {
  const store = createFakeBindingStore();
  const fs = createFakeWorkspaceFs({
    "/tpl/gitignore.default": "",
    "/tpl/claude-md-base.md": "# {{name}}\n",
    "/tpl/agents-md-base.md": "# {{name}}\n",
  });
  const lark = createFakeLarkGateway();
  const eventBus = createFakeEventBus();
  const clock = { now: () => asTimestamp(1_700_000_000_000) };
  const lifecycle = createSessionLifecycle({
    store,
    fs,
    lark,
    clock,
    workspaceRoot: asAbsolutePath("/ws"),
    catalogPath: asAbsolutePath("/ws/session-catalog.json"),
    principlesTemplatesDir: asAbsolutePath("/ws/first-principle/templates"),
    claudeMdTemplatePath: asAbsolutePath("/tpl/claude-md-base.md"),
    agentsMdTemplatePath: asAbsolutePath("/tpl/agents-md-base.md"),
    gitignorePath: asAbsolutePath("/tpl/gitignore.default"),
    ownerUserId: "u-owner",
    eventBus,
  });
  return { store, fs, lark, eventBus, lifecycle };
}

describe("sessionLifecycle.delete", () => {
  test("happy path dissolves group and soft-deletes session", async () => {
    const { store, lark, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await lifecycle.delete({ name: "foo" });
    const after = await store.findSessionByName("foo");
    expect(after?.status).toBe("deleted");
    expect(lark.dissolvedGroups).toHaveLength(1);
  });

  test("delete publishes session_deleted event", async () => {
    const { eventBus, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    eventBus.published.length = 0;

    await lifecycle.delete({ name: "foo" });
    const deleted = eventBus.published.find((e) => e.kind === "session_deleted");
    expect(deleted).toBeTruthy();
    expect(deleted!.kind === "session_deleted" && deleted!.sessionId).toBe(session.id);
  });

  test("delete on missing session throws UserError", async () => {
    const { lifecycle } = mkDeps();
    await expect(lifecycle.delete({ name: "nope" })).rejects.toThrow(UserError);
  });

  test("delete on busy session throws UserError", async () => {
    const { store, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionStatus(session.id, "busy", asTimestamp(1_700_000_001_000));
    await expect(lifecycle.delete({ name: "foo" })).rejects.toThrow(/正在运行/);
  });
});
