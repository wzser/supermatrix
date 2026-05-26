import { describe, expect, test } from "vitest";
import { createSessionLifecycle } from "../../src/app/sessionLifecycle.ts";
import { UserError } from "../../src/domain/errors.ts";
import { asAbsolutePath, asTimestamp } from "../../src/domain/ids.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
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
  const clock = { now: () => asTimestamp(1_700_000_000_000) };
  const cancelCalls: string[] = [];
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
    ownerUserId: "u",
    cancelBackend: async (sessionId: string) => {
      cancelCalls.push(sessionId);
    },
  });
  return { store, lifecycle, cancelCalls };
}

describe("reset + restart", () => {
  test("reset clears backendSessionId and returns to idle", async () => {
    const { store, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionBackendSessionId(session.id, "bks-1");
    await store.updateSessionStatus(session.id, "idle", asTimestamp(1_700_000_001_000));
    await lifecycle.reset({ name: "foo" });
    const s = await store.findSessionById(session.id);
    expect(s?.backendSessionId).toBeNull();
    expect(s?.status).toBe("idle");
  });

  test("reset on busy session rejects", async () => {
    const { store, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionStatus(session.id, "busy", asTimestamp(1_700_000_001_000));
    await expect(lifecycle.reset({ name: "foo" })).rejects.toThrow(UserError);
  });

  test("restart on busy session cancels backend then clears", async () => {
    const { store, lifecycle, cancelCalls } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionBackendSessionId(session.id, "bks-1");
    await store.updateSessionStatus(session.id, "busy", asTimestamp(1_700_000_001_000));
    await lifecycle.restart({ name: "foo" });
    expect(cancelCalls).toContain(session.id);
    const s = await store.findSessionById(session.id);
    expect(s?.status).toBe("idle");
    expect(s?.backendSessionId).toBeNull();
  });

  test("restart on idle session behaves like reset", async () => {
    const { store, lifecycle, cancelCalls } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionBackendSessionId(session.id, "bks-1");
    await store.updateSessionStatus(session.id, "idle", asTimestamp(1_700_000_001_000));
    await lifecycle.restart({ name: "foo" });
    expect(cancelCalls).toHaveLength(0);
    expect((await store.findSessionById(session.id))?.backendSessionId).toBeNull();
  });
});
