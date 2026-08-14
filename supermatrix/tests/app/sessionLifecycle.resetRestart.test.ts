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

  test("reset clears only the active branch context", async () => {
    const { store, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionBranchBackendSessionId(
      session.id,
      "main",
      "bks-main",
      asTimestamp(1_700_000_001_000),
    );
    await store.createSessionBranch({
      sessionId: session.id,
      name: "plan-a",
      sourceBranchName: "main",
      sourceBackendSessionId: "bks-main",
      forkPending: true,
      createdAt: asTimestamp(1_700_000_002_000),
    });
    await store.updateSessionBranchBackendSessionId(
      session.id,
      "plan-a",
      "bks-plan-a",
      asTimestamp(1_700_000_003_000),
    );
    await store.setActiveBranch(session.id, "plan-a", asTimestamp(1_700_000_004_000));

    await lifecycle.reset({ name: "foo" });

    expect((await store.findSessionById(session.id))?.backendSessionId).toBe("bks-main");
    const branch = await store.findSessionBranch(session.id, "plan-a");
    expect(branch?.backendSessionId).toBeNull();
    expect(branch?.sourceBackendSessionId).toBeNull();
    expect(branch?.forkPending).toBe(false);
    expect((await store.getActiveBranch(session.id)).name).toBe("plan-a");
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

  test("restart clears only the active branch after canceling busy backend", async () => {
    const { store, lifecycle, cancelCalls } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionBranchBackendSessionId(
      session.id,
      "main",
      "bks-main",
      asTimestamp(1_700_000_001_000),
    );
    await store.createSessionBranch({
      sessionId: session.id,
      name: "plan-a",
      sourceBranchName: "main",
      sourceBackendSessionId: "bks-main",
      forkPending: true,
      createdAt: asTimestamp(1_700_000_002_000),
    });
    await store.updateSessionBranchBackendSessionId(
      session.id,
      "plan-a",
      "bks-plan-a",
      asTimestamp(1_700_000_003_000),
    );
    await store.setActiveBranch(session.id, "plan-a", asTimestamp(1_700_000_004_000));
    await store.updateSessionStatus(session.id, "busy", asTimestamp(1_700_000_005_000));

    await lifecycle.restart({ name: "foo" });

    expect(cancelCalls).toContain(session.id);
    expect((await store.findSessionById(session.id))?.backendSessionId).toBe("bks-main");
    const branch = await store.findSessionBranch(session.id, "plan-a");
    expect(branch?.backendSessionId).toBeNull();
    expect(branch?.sourceBackendSessionId).toBeNull();
    expect(branch?.forkPending).toBe(false);
    expect((await store.findSessionById(session.id))?.status).toBe("idle");
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
