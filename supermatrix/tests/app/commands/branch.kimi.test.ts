import { describe, it, expect, vi } from "vitest";
import { createBranchHandler } from "../../../src/app/commands/branch.ts";
import { UserError } from "../../../src/domain/errors.ts";
import type { SessionId, AbsolutePath, LarkGroupId, Timestamp } from "../../../src/domain/ids.ts";

function makeDeps(opts: {
  backend: "claude" | "codex" | "kimi";
  activeBackendSessionId: string | null;
  activeSourceBackendSessionId?: string | null;
  branchExists?: boolean;
}) {
  const sessionRow = {
    id: "sess-1" as SessionId,
    name: "demo",
    backend: opts.backend,
    status: "idle" as const,
    workdir: "/tmp/wd" as AbsolutePath,
    model: null,
    effort: null,
    backendSessionId: opts.activeBackendSessionId,
  };
  return {
    sessionRow,
    deps: {
      store: {
        findByGroup: vi.fn(),
        findSessionById: vi.fn(),
        findSessionByName: vi.fn(async () => sessionRow),
        findSessionBranch: vi.fn(async () => opts.branchExists ? { name: "newbr" } : null),
        getActiveBranch: vi.fn(async () => ({
          name: "main",
          backendSessionId: opts.activeBackendSessionId,
          sourceBackendSessionId: opts.activeSourceBackendSessionId ?? null,
        })),
        applySessionRuntimeConfigMutations: vi.fn(async () => ({ updated: 1 })),
        guardIdleSessionRuntimeConfig: vi.fn(async (_sessionId, expected) => expected),
      },
      branchService: {
        createBranchFromActive: vi.fn(async () => ({ name: "newbr", sourceBranchName: "main" })),
        switchBranch: vi.fn(async () => ({ name: "newbr" })),
        listBranches: vi.fn(async () => []),
      },
      clock: { now: () => 1700000000000 as Timestamp },
      codexForkInitializer: vi.fn(async () => "codex-fork-id"),
    } as any,
  };
}

const baseMsg = { groupId: "oc_x" as LarkGroupId } as any;

describe("/branch on kimi backend", () => {
  it("refuses to fork a kimi session that has existing conversation context", async () => {
    const { deps } = makeDeps({
      backend: "kimi",
      activeBackendSessionId: "kimi-sess-abc",
    });
    const handler = createBranchHandler(deps);
    const call = () =>
      handler({ args: { session: "demo", name: "newbr" }, scope: "root", msg: baseMsg });
    await expect(call()).rejects.toBeInstanceOf(UserError);
    await expect(call()).rejects.toThrow(/ACP 协议未提供 fork RPC/u);
  });

  it("allows /branch on a fresh kimi session that has no conversation yet", async () => {
    const { deps } = makeDeps({
      backend: "kimi",
      activeBackendSessionId: null,
      activeSourceBackendSessionId: null,
    });
    const handler = createBranchHandler(deps);
    const result = await handler({
      args: { session: "demo", name: "newbr" },
      scope: "root",
      msg: baseMsg,
    });
    if (!("replyText" in result)) throw new Error("expected replyText result");
    expect(result.replyText).toContain("已创建并切换到 branch");
  });

  it("still allows switching to an existing kimi branch (no fork needed)", async () => {
    const { deps } = makeDeps({
      backend: "kimi",
      activeBackendSessionId: "kimi-sess-abc",
      branchExists: true,
    });
    const handler = createBranchHandler(deps);
    const result = await handler({
      args: { session: "demo", name: "newbr" },
      scope: "root",
      msg: baseMsg,
    });
    if (!("replyText" in result)) throw new Error("expected replyText result");
    expect(result.replyText).toContain("已切换到 branch");
  });

  it("does not regress claude /branch with active backendSessionId", async () => {
    const { deps } = makeDeps({
      backend: "claude",
      activeBackendSessionId: "claude-sess-abc",
    });
    const handler = createBranchHandler(deps);
    const result = await handler({
      args: { session: "demo", name: "newbr" },
      scope: "root",
      msg: baseMsg,
    });
    if (!("replyText" in result)) throw new Error("expected replyText result");
    expect(result.replyText).toContain("已创建并切换");
  });

  it("does not regress codex /branch — still calls codexForkInitializer", async () => {
    const { deps } = makeDeps({
      backend: "codex",
      activeBackendSessionId: "codex-sess-abc",
    });
    const handler = createBranchHandler(deps);
    await handler({
      args: { session: "demo", name: "newbr" },
      scope: "root",
      msg: baseMsg,
    });
    expect(deps.codexForkInitializer).toHaveBeenCalledOnce();
  });
});
